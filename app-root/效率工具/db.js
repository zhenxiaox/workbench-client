// db.js - IndexedDB 数据库与断点管理
const DB_NAME = 'QianniuCollectorDB';
const DB_VERSION = 2;

// 连接池：缓存 Promise 复用同一连接，避免每次 openDB() 重开连接
let dbPromise = null;
function openDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('chatData')) {
                    db.createObjectStore('chatData', { keyPath: 'name' });
                }
                if (!db.objectStoreNames.contains('evalData')) {
                    // evalData 一行对应一条评价，orderId 不唯一（同订单多商品/追加评价），用自增主键避免覆盖丢数据
                    db.createObjectStore('evalData', { autoIncrement: true });
                }
                // 记录当前采集进度的表
                if (!db.objectStoreNames.contains('progress')) {
                    db.createObjectStore('progress', { keyPath: 'taskType' });
                }
                // 工作聚合工作台的状态表
                if (!db.objectStoreNames.contains('workbench')) {
                    db.createObjectStore('workbench', { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                dbPromise = null; // 打开失败允许下次重试
                reject(request.error);
            };
        });
    }
    return dbPromise;
}

// 增量/更新保存数据
async function saveItemsToDB(storeName, itemsArray) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        itemsArray.forEach(item => store.put(item));
        tx.oncomplete = () => {
            // 采集类数据落库后标记脏数据，跨上下文触发工作台镜像同步（仅 evalData/chatData）
            try {
                if ((storeName === 'evalData' || storeName === 'chatData') &&
                    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ qn_idb_dirty: Date.now() });
                }
            } catch (e) {}
            resolve(true);
        };
        tx.onerror = () => reject(tx.error);
    });
}

// 获取已存储的全部数据
async function getAllFromDB(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// 保存断点（记录当前处理到了第几个索引或第几页）
async function saveProgress(taskType, currentIndex, totalIndex = 0) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('progress', 'readwrite');
        tx.objectStore('progress').put({ taskType, currentIndex, totalIndex, updateTime: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// 读取断点
async function getProgress(taskType) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').get(taskType);
        req.onsuccess = () => resolve(req.result || { currentIndex: 0, totalIndex: 0 });
        req.onerror = () => reject(req.error);
    });
}

// 清空缓存
async function clearStoreDB(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName, 'progress'], 'readwrite');
        tx.objectStore(storeName).clear();
        tx.objectStore('progress').delete(storeName === 'chatData' ? 'chat' : 'eval');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// 抗后台休眠：Web Worker 独立线程计时器（blob worker 被页面 CSP 拦截时回退 setTimeout）
const workerTimerScript = `
    let timer = null;
    self.onmessage = function(e) {
        if (e.data.action === 'start') {
            timer = setInterval(() => {
                self.postMessage('tick');
            }, e.data.interval || 1000);
        } else if (e.data.action === 'stop') {
            clearInterval(timer);
        }
    };
`;

// 懒创建：首次调用 backgroundSleep 时才生成 Blob URL，避免模块加载即占资源
let workerTimerUrl = null;
function getWorkerTimerUrl() {
    if (workerTimerUrl === null) {
        try {
            workerTimerUrl = URL.createObjectURL(new Blob([workerTimerScript], { type: 'application/javascript' }));
        } catch (e) {
            workerTimerUrl = undefined; // 不支持则回退 setTimeout
        }
    }
    return workerTimerUrl;
}

// 后台不休眠的延迟函数
function backgroundSleep(ms) {
    return new Promise((resolve) => {
        const url = getWorkerTimerUrl();
        if (!url) {
            setTimeout(resolve, ms);
            return;
        }
        let worker;
        try {
            worker = new Worker(url);
        } catch (e) {
            setTimeout(resolve, ms);
            return;
        }
        worker.postMessage({ action: 'start', interval: ms });
        worker.onmessage = () => {
            worker.postMessage({ action: 'stop' });
            worker.terminate();
            resolve();
        };
        worker.onerror = () => {
            worker.terminate();
            setTimeout(resolve, ms);
        };
    });
}