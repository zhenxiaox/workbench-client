// idb-backup.js - 千牛采集宝工作台：IndexedDB 静默实时镜像同步（Mirror Sync）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序建议放在 workbench.js 之前：
// db.js → workbench-utils.js → workbench-store.js → ... → idb-backup.js → workbench.js。
// 依赖：workbench-utils.js 的 todayStr() / pad2()（全局）。
//
// 2026-08-25 重构：双轨制镜像同步。
//   轨道 A（后台沙盒，快/内部读取）：写入 chrome.storage.local['qn_idb_sync_mirror']（小数据单键），
//     超过 10MB 时自动分块（qn_idb_sync_mirror_chunks）或静默存入扩展源沙盒 IndexedDB（QianniuMirrorDB）。
//   轨道 B（物理文件兜底，抗数据丢失）：关闭工作台标签页 / 刷新页面时，静默下载固定文件名
//     qn_idb_sync_mirror.json 到「下载/${subFolder}/」目录，conflictAction:'overwrite' 直接覆盖、不堆积副本。
//   5 分钟定时器与采集落库脏标记只写轨道 A（保证内部读取速度）；beforeunload/unload 与手动「立即同步」走双轨。
//
// 关于库/表名：需求示例写的是 dbName:'QianniuDataDB' / storeName:'eval_records'（"如"=例如）。
//   当前扩展真实 IndexedDB 为 QianniuCollectorDB（version 2），评价记录表为 evalData（autoIncrement 自增主键）。
//   本模块默认同步真实库的真实评价表，可通过参数覆盖 dbName / storeName 以同步任意库任意表。
//
// ===== 同步模型（双轨制镜像）=====
//  • 轨道 A（后台沙盒，内部读取快）：写入 chrome.storage.local + 沙盒 IndexedDB。触发时机：
//      a) 定时器：页面加载后每 5 分钟全量覆盖一次；
//      b) 批量采集落库：db.js 的 saveItemsToDB 置 chrome.storage.local['qn_idb_dirty']，工作台监听后防抖触发。
//   存储层级：
//      1) 序列化 JSON ≤ 10MB → chrome.storage.local['qn_idb_sync_mirror']（单键直写）；
//      2) 序列化 JSON > 10MB  → 自动分块写入 qn_idb_sync_mirror_chunks（每块 ≤ 8MB）；
//      3) 无论如何，另写一份到扩展源沙盒 IndexedDB（QianniuMirrorDB/mirror_store，key='latest'）作为大容量兜底。
//  • 轨道 B（物理文件兜底）：关闭 / 刷新标签页（beforeunload / unload）静默下载固定文件名
//     qn_idb_sync_mirror.json 到「下载/${subFolder}/」；conflictAction:'overwrite' 直接覆盖、不堆积副本。
//     手动「立即同步/覆写」也走双轨（既写后台、也落本地文件）。
//  • 读（后台镜像 -> IDB）：每天首次打开工作台时，读取后台镜像（storage 单键/分块 → 沙盒 IDB），
//    与当前 IDB 比对，采用「以最新数据为准」合并：主键不存在 -> 追加插入；主键已存在 ->
//    比对 updatedAt/time，用较新数据 store.put() 覆盖。

// ========= 配置 =========
var IDB_BACKUP_DB = 'QianniuCollectorDB';   // 真实 IndexedDB 库名
var IDB_BACKUP_STORE = 'evalData';          // 默认同步的评价记录表（对应需求示例的 eval_records）
var PLUGIN_NAME = 'qianniu-collector';

// 后台静默镜像存储键
var STORAGE_MIRROR_KEY = 'qn_idb_sync_mirror';          // chrome.storage.local 单键镜像
var STORAGE_CHUNKS_KEY = 'qn_idb_sync_mirror_chunks';   // 超限分块键（数组，每块 ≤ 8MB）
var MIRROR_IDB_NAME = 'QianniuMirrorDB';                // 扩展源沙盒 IndexedDB（大镜像兜底）
var MIRROR_IDB_STORE = 'mirror_store';
var MIRROR_IDB_KEY = 'latest';
var DIRTY_KEY = 'qn_idb_dirty';                         // 采集落库脏数据标记键

// 物理文件兜底（轨道 B）配置
var MIRROR_FILE_NAME = 'qn_idb_sync_mirror.json';       // 固定文件名（覆盖写、不堆积副本）
var DEFAULT_SUBFOLDER = 'QN_Backups';                  // 默认子目录

// localStorage 键（与需求一致，复用既有偏好键避免清掉用户设置）
var LS_MIRROR_ENABLED = 'auto_backup_enabled';   // 自动镜像同步开关
var LS_MIRROR_SUBFOLDER = 'backup_subfolder';   // 镜像存放子目录（相对下载目录）
var LS_LAST_MIRROR_MERGE = 'last_idb_mirror_merge_date'; // 上次冷启动合并日期

// 读取镜像子目录（空/异常时回退默认）
function getMirrorSubfolder() {
  try {
    var v = localStorage.getItem(LS_MIRROR_SUBFOLDER);
    return (v && v.trim()) ? v.trim().replace(/\/+$/, '') : DEFAULT_SUBFOLDER;
  } catch (e) { return DEFAULT_SUBFOLDER; }
}

var MIRROR_INTERVAL_MS = 5 * 60 * 1000;  // 5 分钟自动镜像写
var DIRTY_DEBOUNCE_MS = 3000;            // 脏数据防抖窗口
var STORAGE_SINGLE_MAX = 10 * 1024 * 1024; // 单键直写上限（字符数，约 10MB 字符串）
var CHUNK_MAX_LEN = 8 * 1024 * 1024;       // 分块每块最大字符数（避免超 storage 单键配额）

// ========= 内部工具 =========

// 读取整表：以游标取出 {key, value}，便于导入/合并时通过 store.put(value, key) 精准覆写
function readAllEntries(dbName, storeName) {
  return new Promise(function (resolve, reject) {
    var openReq = indexedDB.open(dbName);
    openReq.onsuccess = function () {
      var db = openReq.result;
      try {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve({ records: [], storeMissing: true });
          return;
        }
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var out = [];
        var cursorReq = store.openCursor();
        cursorReq.onsuccess = function (ev) {
          var cur = ev.target.result;
          if (cur) {
            out.push({ key: cur.key, value: cur.value });
            cur.continue();
          } else {
            resolve({ records: out, storeMissing: false });
          }
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      } catch (e) {
        reject(e);
      } finally {
        try { db.close(); } catch (e2) {}
      }
    };
    openReq.onerror = function () { reject(openReq.error); };
  });
}

// 整表写入：store.put(value, key) 批量导入/覆写，返回成功条数（用于手动全量恢复）
function writeAllEntries(dbName, storeName, entries) {
  return new Promise(function (resolve, reject) {
    var openReq = indexedDB.open(dbName);
    openReq.onsuccess = function () {
      var db = openReq.result;
      if (!db.objectStoreNames.contains(storeName)) {
        try { db.close(); } catch (e2) {}
        reject(new Error('store-missing:' + storeName));
        return;
      }
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      var count = 0;
      entries.forEach(function (entry) {
        var val = (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) ? entry.value : entry;
        var key = (entry && Object.prototype.hasOwnProperty.call(entry, 'key')) ? entry.key : undefined;
        store.put(val, key);
        count++;
      });
      tx.oncomplete = function () { try { db.close(); } catch (e2) {} resolve(count); };
      tx.onerror = function () { try { db.close(); } catch (e2) {} reject(tx.error); };
      tx.onabort = function () { try { db.close(); } catch (e2) {} reject(tx.error || new Error('aborted')); };
    };
    openReq.onerror = function () { reject(openReq.error); };
  });
}

// 取记录的时间戳（用于 newer-wins 合并）：优先 updatedAt，其次 time
function getRecTs(value) {
  if (!value || typeof value !== 'object') return 0;
  var t = (value.updatedAt != null) ? value.updatedAt : value.time;
  if (t == null) return 0;
  var n = (typeof t === 'number') ? t : Date.parse(t);
  return isNaN(n) ? 0 : n;
}

// ========= 后台静默镜像存储（无下载、无弹窗） =========

// 打开扩展源沙盒 IndexedDB（QianniuMirrorDB）——大镜像兜底仓库
function openMirrorIDB() {
  return new Promise(function (resolve, reject) {
    try {
      var openReq = indexedDB.open(MIRROR_IDB_NAME, 1);
      openReq.onupgradeneeded = function () {
        var db = openReq.result;
        if (!db.objectStoreNames.contains(MIRROR_IDB_STORE)) {
          db.createObjectStore(MIRROR_IDB_STORE);
        }
      };
      openReq.onsuccess = function () { resolve(openReq.result); };
      openReq.onerror = function () { reject(openReq.error); };
    } catch (e) { reject(e); }
  });
}

// 把 JSON 字符串写入沙盒 IDB（key='latest'）
function writeMirrorToIDB(jsonStr) {
  return new Promise(function (resolve) {
    openMirrorIDB().then(function (db) {
      try {
        var tx = db.transaction(MIRROR_IDB_STORE, 'readwrite');
        tx.objectStore(MIRROR_IDB_STORE).put(jsonStr, MIRROR_IDB_KEY);
        tx.oncomplete = function () { try { db.close(); } catch (e2) {} resolve(true); };
        tx.onerror = function () { try { db.close(); } catch (e2) {} resolve(false); };
        tx.onabort = function () { try { db.close(); } catch (e2) {} resolve(false); };
      } catch (e) { try { db.close(); } catch (e2) {} resolve(false); }
    }).catch(function () { resolve(false); });
  });
}

// 从沙盒 IDB 读取最新镜像 JSON 字符串
function readMirrorFromIDB() {
  return new Promise(function (resolve) {
    openMirrorIDB().then(function (db) {
      try {
        var tx = db.transaction(MIRROR_IDB_STORE, 'readonly');
        var req = tx.objectStore(MIRROR_IDB_STORE).get(MIRROR_IDB_KEY);
        req.onsuccess = function () {
          var v = req.result;
          try { db.close(); } catch (e2) {}
          resolve(typeof v === 'string' ? v : null);
        };
        req.onerror = function () { try { db.close(); } catch (e2) {} resolve(null); };
      } catch (e) { try { db.close(); } catch (e2) {} resolve(null); }
    }).catch(function () { resolve(null); });
  });
}

// 静默写入镜像：优先 storage.local 单键（≤10MB），超限自动分块；同时写沙盒 IDB 兜底。
// 返回 Promise<{ single, chunked, idb }>（各通道是否成功）
function writeMirrorSilent(mirrorObj) {
  return new Promise(function (resolve) {
    var jsonStr;
    try { jsonStr = JSON.stringify(mirrorObj); } catch (e) { resolve({ single: false, chunked: false, idb: false }); return; }
    var result = { single: false, chunked: false, idb: false };
    var setDone = function () {
      writeMirrorToIDB(jsonStr).then(function (ok) {
        result.idb = ok;
        resolve(result);
      });
    };
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        setDone(); // 无扩展环境：仅尝试沙盒 IDB
        return;
      }
      var patch = {};
      if (jsonStr.length <= STORAGE_SINGLE_MAX) {
        // 单键直写
        patch[STORAGE_MIRROR_KEY] = jsonStr;
        patch[STORAGE_CHUNKS_KEY] = null; // 清理旧分块
        chrome.storage.local.set(patch, function () {
          if (chrome.runtime && chrome.runtime.lastError) { result.single = false; }
          else { result.single = true; }
          setDone();
        });
      } else {
        // 超 10MB：自动分块（每块 ≤ 8MB 字符），存入 chunks 数组键
        var chunks = [];
        for (var i = 0; i < jsonStr.length; i += CHUNK_MAX_LEN) {
          chunks.push(jsonStr.slice(i, i + CHUNK_MAX_LEN));
        }
        patch[STORAGE_MIRROR_KEY] = null; // 清理旧单键
        patch[STORAGE_CHUNKS_KEY] = chunks;
        chrome.storage.local.set(patch, function () {
          if (chrome.runtime && chrome.runtime.lastError) { result.chunked = false; }
          else { result.chunked = true; }
          setDone();
        });
      }
    } catch (e) {
      setDone();
    }
  });
}

// 读取后台镜像：storage 单键 → 分块拼接 → 沙盒 IDB
// 返回 Promise<object|null>（解析后的镜像对象）
function readMirrorSilent() {
  return new Promise(function (resolve) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        readMirrorFromIDB().then(function (s) {
          if (!s) return resolve(null);
          try { resolve(JSON.parse(s)); } catch (e) { resolve(null); }
        });
        return;
      }
      chrome.storage.local.get([STORAGE_MIRROR_KEY, STORAGE_CHUNKS_KEY], function (res) {
        try {
          var single = res && res[STORAGE_MIRROR_KEY];
          if (typeof single === 'string' && single.length) {
            return resolve(JSON.parse(single));
          }
          var chunks = res && res[STORAGE_CHUNKS_KEY];
          if (Array.isArray(chunks) && chunks.length) {
            return resolve(JSON.parse(chunks.join('')));
          }
        } catch (e) {}
        // storage 无镜像 → 沙盒 IDB
        readMirrorFromIDB().then(function (s) {
          if (!s) return resolve(null);
          try { resolve(JSON.parse(s)); } catch (e2) { resolve(null); }
        });
      });
    } catch (e) {
      readMirrorFromIDB().then(function (s) {
        if (!s) return resolve(null);
        try { resolve(JSON.parse(s)); } catch (e2) { resolve(null); }
      });
    }
  });
}

// 把工作台整库状态（含心情记录 / 待办 / 时光轴等）附加进镜像对象，
// 使 5 分钟定时、脏数据触发、beforeunload 关页兜底（双轨）都能覆盖工作台数据。
// 仅读取 key='state' 的记录；缺失则不动 mirror。
function attachWorkbenchSnapshot(mirror) {
  return getAllFromDB('workbench').then(function (rows) {
    var rec = (rows || []).filter(function (r) { return r.key === 'state'; })[0];
    if (rec) {
      // 复制必要字段，避免镜像体积无谓膨胀（保留完整 state 以便整库恢复）
      mirror.workbench = rec;
    }
    return mirror;
  }).catch(function () { return mirror; });
}

// 冷启动恢复：若本地工作台状态缺失（如 IndexedDB 丢失 / 全新安装），用镜像快照恢复（含心情记录）。
// 仅当本地无 state 时写入，避免覆盖正在使用的较新数据。
function restoreWorkbenchFromMirror(mirror) {
  if (!mirror || !mirror.workbench) return Promise.resolve({ skipped: 'no-snapshot' });
  return getAllFromDB('workbench').then(function (rows) {
    var hasState = (rows || []).some(function (r) { return r.key === 'state'; });
    if (hasState) return { skipped: 'local-exists' };
    return saveItemsToDB('workbench', [mirror.workbench]).then(function () {
      return { restored: true };
    });
  }).catch(function () { return { skipped: 'error' }; });
}

// ========= 对外 API =========

// 静默同步 IndexedDB 整表 → 后台镜像（storage.local 单键/分块 + 沙盒 IDB，全程无下载）
//   options: { dbName, storeName } 可覆盖目标库/表
// 返回 Promise<{ totalRecords, single, chunked, idb }>
function syncMirrorSilent(options) {
  options = options || {};
  var dbName = options.dbName || IDB_BACKUP_DB;
  var storeName = options.storeName || IDB_BACKUP_STORE;
  return readAllEntries(dbName, storeName).then(function (res) {
    if (res.storeMissing) {
      return Promise.reject(new Error('store-missing:' + storeName));
    }
    var mirror = {
      plugin: PLUGIN_NAME,
      mirror: true,
      backupType: storeName,
      dbName: dbName,
      exportTime: new Date().toISOString(),
      totalRecords: res.records.length,
      data: res.records
    };
    return attachWorkbenchSnapshot(mirror).then(function (m) {
      return writeMirrorSilent(m).then(function (r) {
        if (window.QNLogger) {
          QNLogger.info('[IDB镜像] 后台静默覆写完成：' + res.records.length + ' 条（单键=' + (r.single ? 'ok' : '-') + ' 分块=' + (r.chunked ? 'ok' : '-') + ' IDB=' + (r.idb ? 'ok' : '-') + '）');
        }
        return {
          totalRecords: res.records.length,
          single: r.single,
          chunked: r.chunked,
          idb: r.idb
        };
      });
    });
  });
}

// 轨道 B：把已组装好的镜像对象下载为固定文件名 JSON 文件（覆盖写，不堆积副本）
//   subFolder: 相对「下载」目录的子目录（默认 QN_Backups），实际路径 = ${subFolder}/qn_idb_sync_mirror.json
//   mirror:    已组装的镜像对象（{plugin, mirror, backupType, dbName, exportTime, totalRecords, data}）
// 返回 Promise<boolean>（是否成功发起下载）
function syncMirrorDownload(subFolder, mirror) {
  return new Promise(function (resolve) {
    try {
      if (typeof chrome === 'undefined' || !chrome.downloads || typeof chrome.downloads.download !== 'function') {
        resolve(false); return;
      }
      var jsonStr;
      try { jsonStr = JSON.stringify(mirror); } catch (e) { resolve(false); return; }
      var folder = (subFolder && subFolder.trim()) ? subFolder.trim().replace(/\/+$/, '') : DEFAULT_SUBFOLDER;
      var filename = folder + '/' + MIRROR_FILE_NAME;
      // 用 data: URL 承载生成内容（无临时文件、无需服务器）；encodeURIComponent 保证中文/特殊字符安全
      var dataUrl = 'data:application/json;charset=UTF-8,' + encodeURIComponent(jsonStr);
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        conflictAction: 'overwrite',
        saveAs: false
      }, function () {
        var ok = !(chrome.runtime && chrome.runtime.lastError);
        if (!ok && window.QNLogger) {
          QNLogger.warn('[IDB镜像] 物理文件下载未成功：' + (chrome.runtime.lastError && chrome.runtime.lastError.message || 'unknown'));
        }
        resolve(ok);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

// 双轨聚合：先写后台沙盒（轨道 A，内部读取快），再下载物理文件（轨道 B，抗丢失）
//   options: { dbName, storeName }
// 返回 Promise<{ totalRecords, single, chunked, idb, downloaded }>
function syncMirrorFull(options) {
  options = options || {};
  var dbName = options.dbName || IDB_BACKUP_DB;
  var storeName = options.storeName || IDB_BACKUP_STORE;
  return readAllEntries(dbName, storeName).then(function (res) {
    if (res.storeMissing) {
      return Promise.reject(new Error('store-missing:' + storeName));
    }
    var mirror = {
      plugin: PLUGIN_NAME,
      mirror: true,
      backupType: storeName,
      dbName: dbName,
      exportTime: new Date().toISOString(),
      totalRecords: res.records.length,
      data: res.records
    };
    return attachWorkbenchSnapshot(mirror).then(function (m) {
      return writeMirrorSilent(m).then(function (r) {
        var sub = getMirrorSubfolder();
        return syncMirrorDownload(sub, m).then(function (dl) {
          if (window.QNLogger) {
            var backOk = (r.single || r.chunked || r.idb) ? 'ok' : '-';
            QNLogger.info('[IDB镜像] 双轨同步完成：' + res.records.length + ' 条（后台=' + backOk + ' 下载=' + (dl ? 'ok' : '-') + ' 路径=' + sub + '/' + MIRROR_FILE_NAME + '）');
          }
          return {
            totalRecords: res.records.length,
            single: r.single,
            chunked: r.chunked,
            idb: r.idb,
            downloaded: dl
          };
        });
      });
    });
  });
}

// 合并镜像数据到 IndexedDB（newer-wins 策略）——用于冷启动自动同步
//   entries: 与 data:[{key,value}] 同构的数组
//   options: { dbName, storeName }
// 返回 Promise<{ inserted, updated, skipped }>
function mergeMirrorToIDB(entries, options) {
  options = options || {};
  var dbName = options.dbName || IDB_BACKUP_DB;
  var storeName = options.storeName || IDB_BACKUP_STORE;
  if (!Array.isArray(entries)) return Promise.reject(new Error('invalid-entries'));
  return readAllEntries(dbName, storeName).then(function (res) {
    var existing = {};
    res.records.forEach(function (e) { existing[e.key] = e.value; });
    var toPut = [];
    var inserted = 0, updated = 0;
    entries.forEach(function (entry) {
      var val = (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) ? entry.value : entry;
      var key = (entry && Object.prototype.hasOwnProperty.call(entry, 'key')) ? entry.key : undefined;
      if (key === undefined || key === null) return; // 无主键无法合并，跳过
      if (!Object.prototype.hasOwnProperty.call(existing, key)) {
        // 主键在 IDB 不存在 -> 追加插入
        toPut.push({ key: key, value: val });
        inserted++;
      } else {
        // 主键已存在 -> 比对时间戳，用较新数据覆盖
        var tsMirror = getRecTs(val);
        var tsIdb = getRecTs(existing[key]);
        if (tsMirror === 0 && tsIdb === 0) {
          // 双方均无时间戳：保留 IDB 现有数据，不覆盖，避免误伤
          return;
        }
        if (tsMirror >= tsIdb) {
          toPut.push({ key: key, value: val });
          updated++;
        }
      }
    });
    if (toPut.length === 0) return { inserted: 0, updated: 0, skipped: entries.length };
    return writeAllEntries(dbName, storeName, toPut).then(function () {
      return { inserted: inserted, updated: updated, skipped: entries.length - inserted - updated };
    });
  });
}

// 从备份文件/对象全量恢复（覆盖写）到 IndexedDB —— 手动“导入备份”使用
//   jsonInput: File/Blob / JSON 字符串 / 已解析对象
//   options:   { dbName, storeName } 可覆盖（缺省则用备份内记录的库/表）
// 返回 Promise<number>（成功导入条数）
function restoreIDBFromJSON(jsonInput, options) {
  options = options || {};
  return readBackupObject(jsonInput).then(function (backup) {
    if (!backup || !Array.isArray(backup.data)) {
      throw new Error('invalid-backup');
    }
    var dbName = options.dbName || backup.dbName || IDB_BACKUP_DB;
    var storeName = options.storeName || backup.storeName || backup.backupType || IDB_BACKUP_STORE;
    return writeAllEntries(dbName, storeName, backup.data);
  });
}

// 解析输入：File/Blob / JSON 字符串 / 已解析对象
function readBackupObject(jsonInput) {
  if (jsonInput && typeof jsonInput === 'object' && !(jsonInput instanceof Blob) && typeof jsonInput.text !== 'function') {
    return Promise.resolve(jsonInput);
  }
  if (jsonInput instanceof Blob || (jsonInput && typeof jsonInput.text === 'function')) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try { resolve(JSON.parse(reader.result)); } catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(jsonInput, 'UTF-8');
    });
  }
  if (typeof jsonInput === 'string') {
    return Promise.resolve(JSON.parse(jsonInput));
  }
  return Promise.reject(new Error('unsupported-input'));
}

// 每天首次打开工作台时：读取后台镜像（storage/分块/沙盒 IDB），与当前 IDB 比对并按 newer-wins 合并
// 返回 Promise<{ skipped | done | error }>
function checkAndAutoMirrorSync() {
  try {
    if (localStorage.getItem(LS_MIRROR_ENABLED) !== 'true') return Promise.resolve({ skipped: 'disabled' });
    var today = todayStr();
    var last = localStorage.getItem(LS_LAST_MIRROR_MERGE);
    if (last === today) return Promise.resolve({ skipped: 'already-today' });
    return readMirrorSilent().then(function (mirror) {
      if (!mirror) {
        return { skipped: 'no-mirror' };
      }
      var tasks = [];
      if (Array.isArray(mirror.data) && mirror.data.length) {
        tasks.push(mergeMirrorToIDB(mirror.data).then(function (r) {
          if (window.QNLogger) QNLogger.info('[IDB镜像] 冷启动静默合并完成：新增 ' + r.inserted + ' / 更新 ' + r.updated + ' / 跳过 ' + r.skipped);
          return { eval: r };
        }));
      } else {
        tasks.push(Promise.resolve({ eval: { skipped: 'no-eval' } }));
      }
      // 工作台状态（含心情记录）恢复：仅当本地缺失时写入，避免覆盖正在使用的较新数据
      tasks.push(restoreWorkbenchFromMirror(mirror).then(function (r) {
        if (r && r.restored && window.QNLogger) QNLogger.info('[IDB镜像] 已用镜像恢复工作台状态（含心情记录）');
        return { workbench: r };
      }));
      return Promise.all(tasks).then(function (res) {
        localStorage.setItem(LS_LAST_MIRROR_MERGE, today);
        return { done: true, eval: res[0].eval, workbench: res[1].workbench };
      });
    });
  } catch (e) {
    return Promise.resolve({ skipped: 'error', error: String(e) });
  }
}

// ========= 自动同步调度（5 分钟定时器 / 关页兜底 / 脏数据监听） =========
var _mirrorTimer = null;
var _dirtyTimer = null;
var _dirtyPending = false;

// 判断当前是否开启自动镜像同步
function isMirrorEnabled() {
  try { return localStorage.getItem(LS_MIRROR_ENABLED) === 'true'; } catch (e) { return false; }
}

function startMirrorAutoSync() {
  // 1) 存储脏数据监听：采集落库（evalData/chatData）跨上下文置位后，防抖触发镜像写
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[DIRTY_KEY]) return;
        if (!isMirrorEnabled()) return;
        if (_dirtyPending) return;
        _dirtyPending = true;
        if (_dirtyTimer) clearTimeout(_dirtyTimer);
        _dirtyTimer = setTimeout(function () {
          _dirtyPending = false;
          syncMirrorSilent().catch(function (e) {
            if (window.QNLogger) QNLogger.warn('[IDB镜像] 脏数据触发同步失败：' + String((e && e.message) || e));
          });
        }, DIRTY_DEBOUNCE_MS);
      });
    }
  } catch (e) {}

  // 2) 每 5 分钟全量覆盖写入后台镜像
  if (_mirrorTimer) clearInterval(_mirrorTimer);
  _mirrorTimer = setInterval(function () {
    if (!isMirrorEnabled()) return;
    syncMirrorSilent().catch(function (e) {
      if (window.QNLogger) QNLogger.warn('[IDB镜像] 定时同步失败：' + String((e && e.message) || e));
    });
  }, MIRROR_INTERVAL_MS);

  // 3) 关页（关闭/刷新标签页）兜底：双轨同步——写后台沙盒 + 静默下载物理文件覆盖固定 JSON
  //    下载由浏览器进程接管（不受页面卸载影响），file 路径固定 + conflictAction:'overwrite' 不堆积副本
  var onUnload = function () {
    if (!isMirrorEnabled()) return;
    try { syncMirrorFull().catch(function () {}); } catch (e) {}
  };
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('unload', onUnload);
}

// ========= UI：同步设置弹窗 =========
// 在 workbench.html 中调用：将自动同步勾选、子目录、立即同步、导入按钮与 localStorage 联动
function initIDBSyncUI() {
  var autoEl = document.getElementById('idb-auto-backup');
  var subEl = document.getElementById('idb-subfolder');
  var syncBtn = document.getElementById('idb-backup-now');
  var importBtn = document.getElementById('idb-import');
  var fileEl = document.getElementById('idb-import-file');
  if (!autoEl || !syncBtn) return; // 控件不存在则跳过

  // 初始化控件状态
  autoEl.checked = localStorage.getItem(LS_MIRROR_ENABLED) === 'true';
  if (subEl) {
    subEl.value = getMirrorSubfolder();
    var previewEl = document.getElementById('idb-subfolder-preview');
    var syncPreview = function () {
      if (previewEl) previewEl.textContent = getMirrorSubfolder();
    };
    subEl.addEventListener('input', syncPreview);
    subEl.addEventListener('change', function () {
      localStorage.setItem(LS_MIRROR_SUBFOLDER, (subEl.value.trim() || DEFAULT_SUBFOLDER));
      syncPreview();
      toast('镜像子目录已更新：' + getMirrorSubfolder());
    });
  }

  autoEl.addEventListener('change', function () {
    localStorage.setItem(LS_MIRROR_ENABLED, autoEl.checked ? 'true' : 'false');
    toast(autoEl.checked ? '已开启 5分钟/关页 自动实时镜像同步' : '已关闭自动镜像同步');
    if (autoEl.checked) {
      // 开启即做一次双轨镜像，立即可见效果（后台 + 物理文件）
      syncMirrorFull().catch(function () {});
    }
  });

  syncBtn.addEventListener('click', function () {
    syncBtn.disabled = true;
    syncMirrorFull().then(function (r) {
      toast('镜像已实时覆写完成（' + r.totalRecords + ' 条，本地文件 + 后台双写）');
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      if (msg.indexOf('store-missing') === 0) toast('同步失败：当前数据库暂无评价记录表');
      else toast('同步失败：' + msg);
    }).then(function () { syncBtn.disabled = false; });
  });

  if (importBtn && fileEl) {
    importBtn.addEventListener('click', function () { fileEl.click(); });
    fileEl.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!window.confirm('导入备份将覆盖 IndexedDB 中对应表的现有数据，确定继续吗？')) {
        e.target.value = '';
        return;
      }
      restoreIDBFromJSON(f).then(function (n) {
        toast('导入完成：已写入 ' + n + ' 条记录');
        // 导入后立即让后台镜像与 IDB 保持一致
        return syncMirrorSilent().catch(function () {});
      }).catch(function (err) {
        toast('导入失败：' + String((err && err.message) || err));
      }).then(function () { e.target.value = ''; });
    });
  }
}

// 轻量 Toast 状态提示（工作台无现成 toast 组件，独立实现）
function toast(msg, ms) {
  ms = ms || 2600;
  var el = document.getElementById('idb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'idb-toast';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'top:18px', 'transform:translateX(-50%)',
      'z-index:9999', 'background:rgba(31,41,55,.92)', 'color:#fff',
      'padding:10px 16px', 'border-radius:10px', 'font-size:13px',
      'font-family:inherit', 'box-shadow:0 6px 20px rgba(0,0,0,.18)',
      'max-width:80vw', 'transition:opacity .25s', 'pointer-events:none',
      'text-align:center', 'line-height:1.4'
    ].join(';') + ';';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.style.opacity = '0'; }, ms);
}
