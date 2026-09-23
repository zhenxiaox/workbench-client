/**
 * 运营工作台 本地服务（安全加固版）
 *
 * 职责：
 *   1. 把「运营工作台」文件夹当作网站托管起来（http://127.0.0.1:8787/工作台.html）
 *   2. 把页面发来的模型请求转发给白名单内的服务商（智谱 / OpenAI / DeepSeek 等）
 *
 * 安全设计（交付给客户前必须保留）：
 *   - 仅监听本机回环地址 127.0.0.1，不暴露到局域网 / 公网。
 *   - /px/ 代理只允许访问「已知服务商域名」或「解析后为公网 IP」的目标；
 *     禁止访问私有网段（127/8、10/8、172.16/12、192.168/16、169.254/16 含云元数据、
 *     ::1、fc00::/7、fe80::/10 等），从根上杜绝 SSRF。
 *   - 不返回 Access-Control-Allow-Origin: *；仅当请求来源是 localhost 时才回显该来源，
 *     避免被第三方网页跨站读取响应。
 *
 * 用法：双击同目录下的「启动工作台.bat」即可，无需手动敲命令。
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var dns = require('dns');
var net = require('net');
var PassThrough = require('stream').PassThrough;
var zlib = require('zlib');
var crypto = require('crypto');
var os = require('os');
var execFile = require('child_process').execFile;

var PORT = parseInt(process.env.WB_PORT, 10) || 8787;
var ROOT = __dirname;

/* ---------- 数据备份目录（脱离浏览器 C 盘 / 突破 5MB 限制）----------
 * 优先级：环境变量 WB_DATA_DIR > 同目录 wb-datadir.txt（单行绝对路径）> 默认 <ROOT>/data
 * 该服务仅监听 127.0.0.1，备份文件只可由本机页面写入，不会暴露到局域网/公网。 */
/* wb-config.json 的落盘路径。
 * ★ 2026-09-15 事故：测试套件调 POST /api/config（界面「数据存储位置」的写接口），
 *   而这里原来硬编码 `path.join(ROOT, 'wb-config.json')` —— 测试的服务实例虽然用
 *   WB_DATA_DIR 指向临时目录，**写配置文件却仍落在真实仓库根** →
 *   跑一次测试就把运行中的工作台数据目录改到 C:\...\Temp\wb-test-xxx\moved，
 *   全站表现为「页面能打开、接口全 200，但一条数据都没有」。
 * 现在允许用 WB_CONFIG_FILE 覆盖（测试写临时文件），生产环境不设该变量 → 行为不变。 */
function _configFilePath() {
  return process.env.WB_CONFIG_FILE || path.join(ROOT, 'wb-config.json');
}

/* 读取 wb-config.json 里的 dataDir（界面「设置 → 数据存储位置」写入） */
function _readConfigFile() {
  try {
    var cf = _configFilePath();
    if (fs.existsSync(cf)) {
      var j = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (j && typeof j.dataDir === 'string' && j.dataDir) return j.dataDir;
    }
  } catch (e) {}
  return null;
}
/* 数据目录优先级：环境变量 WB_DATA_DIR > wb-config.json(dataDir) > wb-datadir.txt(单行)
 *                   > ★ 客户端数据目录（若存在）> 默认 <ROOT>/data
 * 每次备份请求都实时解析，因此通过界面改了存储位置后无需重启服务即可生效。
 *
 * ★★ 2026-09-23 事故与修复：以前没有「客户端数据目录」这一层，兜底是 <ROOT>/data，
 *   而 ROOT = __dirname（服务端脚本所在目录）。于是**从哪个目录启动就写哪份数据**：
 *     · 双击项目根 `启动工作台.bat`   → Desktop\运营工作台\data\
 *     · 双击安装目录的 .bat           → ...\运营工作台\app\data\
 *     · 客户端（带 WB_DATA_DIR）      → %LOCALAPPDATA%\com.workbench.client\data\
 *   三个目录并存 → 用户看到「数据时有时无 / 手填的丢了」。
 *   现在兜底前先探客户端数据目录：存在就用它，让所有启动方式收敛到同一份。 */
function _clientDataDir() {
  try {
    var la = process.env.LOCALAPPDATA;
    if (!la) return null;
    var d = path.join(la, 'com.workbench.client', 'data');
    return fs.existsSync(d) ? d : null;
  } catch (e) { return null; }
}
function _resolveDataDir() {
  if (process.env.WB_DATA_DIR) return process.env.WB_DATA_DIR;
  var cfg = _readConfigFile();
  if (cfg) return cfg;
  try {
    var p = path.join(ROOT, 'wb-datadir.txt');
    if (fs.existsSync(p)) {
      var line = fs.readFileSync(p, 'utf8').split('\n')[0].trim();
      if (line) return line;
    }
  } catch (e) {}
  var cd = _clientDataDir();
  if (cd) return cd;
  return path.join(ROOT, 'data');
}
var DATA_DIR = _resolveDataDir();
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

/* ---------- 数据目录自检（启动告警，只提示不改行为）----------
 * ★ 2026-09-15 真实事故：wb-server.test.js 的 [7] 用例调 POST /api/config，
 *   而该接口把 wb-config.json 写在 **ROOT（真实仓库根）** 而不是测试的临时目录 →
 *   跑一次测试就把正在运行的工作台数据目录改到 C:\...\Temp\wb-test-xxx\moved。
 *   表现极具误导性：所有页面都能打开、接口全 200，只是 /api/store 恒返回
 *   {"ok":true,"stores":[]}（serveStoreData 读不到文件时就是这么写的）。
 * 为什么只告警不自动回退：用户确实可能主动把数据挪到别的盘（界面「数据存储位置」），
 * 静默回退会让「刚挪过去的数据看不见」，比告警更糟。 */
function _dataDirSelfCheck() {
  var def = path.resolve(path.join(ROOT, 'data'));
  var cur = path.resolve(DATA_DIR);
  if (cur === def) return;
  function gzCount(dir) {
    try { return fs.readdirSync(dir).filter(function (n) { return /\.json\.gz$/.test(n); }).length; }
    catch (e) { return 0; }
  }
  var curN = gzCount(cur);
  if (curN > 0) return;          /* 当前目录里有数据 → 视为正常配置 */
  var defN = gzCount(def);
  if (defN > 0) {
    console.log('');
    console.log('  ⚠️  数据目录可疑：当前解析到 ' + DATA_DIR + '（0 个 .json.gz）');
    console.log('      但默认目录 ' + def + ' 下有 ' + defN + ' 个数据文件。');
    console.log('      排查：wb-config.json / 环境变量 WB_DATA_DIR / wb-datadir.txt。');
    console.log('      确认要用默认目录 → 删掉 wb-config.json 后重启本服务。');
    console.log('');
  }
}
_dataDirSelfCheck();

/* 自动导入文件夹：把导出的 Excel 放到对应子文件夹，店铺分析页轮询后自动导入 */
var AUTO_IMPORT_DIR = path.join(ROOT, '自动导入');
/* 2026-09-20 新增「推广-报表数据」：淘宝推广后台导出的 5 类报表
   （计划 / 关键词 / 营销场景 / 商品 / 人群）丢进这个文件夹即可自动导入到「店铺推广」页。
   这 5 类是同一批数据的不同维度，页面会**合并**成一份分析报告（不是互相覆盖）。 */
var AUTO_IMPORT_SUBS = ['店铺-整体数据', '店铺-订单数据', '店铺-搜索词数据', '店铺-全店商品数据', '单品-商品数据', '单品-搜索词数据', '推广-报表数据'];
var AUTO_IMPORT_DONE_DIR = path.join(AUTO_IMPORT_DIR, '已导入');
function _ensureAutoImportDirs() {
  try { fs.mkdirSync(AUTO_IMPORT_DONE_DIR, { recursive: true }); } catch (e) {}
  AUTO_IMPORT_SUBS.forEach(function (s) {
    try { fs.mkdirSync(path.join(AUTO_IMPORT_DIR, s), { recursive: true }); } catch (e) {}
  });
}
/* ★ 启动时就建好子文件夹 —— 不能只靠接口调用时才建：
   用户第一次用「自动导入」时，得能直接看到「推广-报表数据」这个文件夹在哪、往哪放文件。
   （2026-09-20 发现：原来只有调了 /api/auto-import/list 才建，目录会“凭空出现”。） */
_ensureAutoImportDirs();

/* 仅允许白名单内的 app 名，杜绝路径穿越。
   键名为磁盘文件名 <app>.json.gz；值为对应的「旧 localStorage 键」（仅用于文档/语义，落盘本身不再依赖 localStorage）。 */
var BACKUP_APPS = {
  item: 'taobao_analytics_data',
  store: 'store_analytics_data',
  todo: 'wb_todo',        // 待办事项（首页今日待办）
  ctodo: 'wb_ctodo',      // 客户待办（加急 / 延期 / 截图识别），独立实现
  worklog: 'wb_worklog',  // 复盘（原「工作总结 / 工作日志」，此前漏登记导致只存 localStorage）
  notes: 'wb_notes',      // 灵感速记
  kb: 'wb_kb',            // 个人知识库
  kbp: 'wb_kbp',          // 产品知识库
  qchat: 'qianniu_chat_records',  // 千牛聊天记录（由浏览器扩展 POST 导入）
  sku: 'qianniu_sku_export',        // 千牛SKU导出（由浏览器扩展 POST 导入）
  skumeta: 'wb_sku_manual',         // 千牛SKU页手动填写的扩展字段（供应商/成本/运费等），按 店铺||商品ID 索引
  product: 'qianniu_product_export', // 千牛商品导出（由浏览器扩展 POST 导入）
  review: 'qianniu_review_export',  // 千牛评价导出（由浏览器扩展 POST 导入）
  ask: 'qianniu_ask_export',        // 千牛「问大家」导出（由浏览器扩展 POST 导入）
  itemcollect: 'qianniu_item_collect', // 商品详情页信息采集（竞品分析，由浏览器扩展 v1.2.33+ POST 导入）
  promo: 'wb_promo'   // 店铺推广数据（淘宝「店铺推广数据汇总」xlsx，页面内解析后落盘；2026-09-20 新增）
};
function _backupFile(app) {
  if (!BACKUP_APPS[app]) return null;
  return path.join(_resolveDataDir(), app + '.json.gz');
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.exe': 'application/octet-stream'
};

function ts() {
  return '[' + new Date().toLocaleTimeString() + '] ';
}

/* 仅当来源是 localhost 时才回显，杜绝跨站读取 */
function setRestrictedCORS(res, req) {
  var o = req && req.headers && req.headers.origin;
  if (!o) return;
  /* http(s) localhost：精确回显（安全策略不变） */
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
  }
  /* ★ 2026-09-21：桌面客户端（Tauri / Electron）用 file:// / tauri:// / app:// 加载页面 → 跨域被挡。
     非 http origin 在浏览器里设 '*' 不通过，但设 'null' 合法（CORS 规范允许特殊 origin）。
     → 客户端集成：浏览器直接访问 http://localhost 仍走第一条规则；客户端内嵌页面走第二条。 */
  else if (/^(file|tauri|app):\/\//i.test(o) || o === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

/* 判断 IP 是否为私有 / 保留网段 */
function isPrivateIP(ip) {
  if (!ip) return true;
  ip = String(ip).toLowerCase().trim();
  if (ip === '::1' || ip === '0.0.0.0' || ip === 'localhost') return true;
  if (ip.indexOf('fe80:') === 0 || ip.indexOf('fc') === 0 || ip.indexOf('fd') === 0) return true; // IPv6 链路本地 / 唯一本地
  var p = ip.split('.');
  if (p.length !== 4) return false;
  var a = parseInt(p[0], 10), b = parseInt(p[1], 10);
  if (isNaN(a)) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;            // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  return false;
}

/* 已知服务商域名后缀（自定义域名也允许，但必须解析为公网 IP，见下） */
var ALLOWED_SUFFIX = [
  '.openai.com',
  'api.deepseek.com',
  '.aliyuncs.com',
  '.volces.com',
  '.bigmodel.cn',
  '.moonshot.cn',
  '.googleapis.com'
];

/**
 * 校验代理目标是否允许访问。
 * 返回 { ok:true } 或 { ok:false, reason:'...' }
 */
function checkTarget(host) {
  if (!host || host.indexOf('/') >= 0 || host.indexOf('@') >= 0) {
    return { ok: false, reason: '非法主机' };
  }
  var m = /^([^:]+)(?::(\d+))?$/.exec(host);
  if (!m) return { ok: false, reason: '主机格式错误' };
  var h = m[1].toLowerCase();
  var port = m[2];

  /* Ollama 本地模型特例：仅允许本机 11434 端口 */
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    if (port === '11434') return { ok: true, local: true };
    return { ok: false, reason: '仅允许本机 Ollama(127.0.0.1:11434)' };
  }

  /* 已知服务商后缀：直接放行（避免临时 DNS 故障误杀；这些域名均为公开服务） */
  var known = ALLOWED_SUFFIX.some(function (s) { return h === s || h.endsWith(s); });
  if (known) return { ok: true };

  /* 自定义域名：必须能解析，且解析结果不能是私有/保留网段（防 SSRF / DNS rebinding） */
  var addrs;
  try {
    addrs = dns.lookupSync(h, { all: true }).map(function (x) { return x.address; });
  } catch (e) {
    return { ok: false, reason: '域名解析失败: ' + h };
  }
  if (!addrs.length) return { ok: false, reason: '域名无可用地址: ' + h };
  for (var i = 0; i < addrs.length; i++) {
    if (isPrivateIP(addrs[i])) {
      return { ok: false, reason: '目标解析到私有/保留地址已拒绝: ' + addrs[i] };
    }
  }
  return { ok: true, custom: true };
}

function forward(req, res, upstreamProto, upstreamHost, upstreamPath) {
  var chk = checkTarget(upstreamHost);
  if (!chk.ok) {
    console.error(ts() + '    拒绝代理(安全策略): ' + upstreamHost + ' -> ' + chk.reason);
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '本地服务已拒绝该目标（安全策略）：' + chk.reason } }));
    return;
  }

  var mod = upstreamProto === 'http' ? http : https;

  /* 先完整收下请求体，便于 429/5xx 重试时原样重放（req 流只能读一次） */
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var bodyBuf = Buffer.concat(chunks);

    var fwdHeaders = Object.assign({}, req.headers, { host: upstreamHost });
    delete fwdHeaders.origin;
    delete fwdHeaders.referer;
    delete fwdHeaders['sec-fetch-mode'];
    delete fwdHeaders['sec-fetch-site'];
    delete fwdHeaders['sec-fetch-dest'];
    delete fwdHeaders['accept-encoding'];
    delete fwdHeaders['content-length']; /* 重算，避免重放时长度不一致 */
    if (bodyBuf.length) fwdHeaders['content-length'] = Buffer.byteLength(bodyBuf);

    var MAX_RETRY = 5; /* 429/5xx 自动重试次数（首次外再重试 5 次） */

    function doAttempt(attempt) {
      console.log(ts() + 'API -> ' + upstreamProto + '://' + upstreamHost + upstreamPath
        + (chk.local ? ' (本地Ollama)' : (chk.custom ? ' (自定义公网)' : ''))
        + (attempt > 0 ? (' [retry ' + attempt + ']') : ''));

      var proxyReq = mod.request({
        hostname: upstreamHost.split(':')[0],
        port: upstreamHost.split(':')[1] || (upstreamProto === 'http' ? 80 : 443),
        path: upstreamPath,
        method: req.method,
        headers: fwdHeaders
      }, function (proxyRes) {
        var status = proxyRes.statusCode;
        console.log(ts() + '    upstream ' + status);
        /* 可重试：429 限流 / 500 502 503 网关类，且还有重试次数 */
        var is429 = (status === 429);
        var retryable = (is429 || status === 500 || status === 502 || status === 503) && attempt < MAX_RETRY;
        if (retryable) {
          proxyRes.resume(); /* 排空上游响应体，释放连接 */
          /* 429 限流通常持续更久，用更长的指数退避（2s→4s→8s→16s→30s 封顶）；5xx 用短退避 */
          var base = is429 ? 2000 : 500;
          var cap = is429 ? 30000 : 8000;
          var wait = Math.min(cap, base * Math.pow(2, attempt));
          console.log(ts() + '    上游 ' + status + '，' + wait + 'ms 后重试 (' + (attempt + 1) + '/' + MAX_RETRY + ')');
          setTimeout(function () { doAttempt(attempt + 1); }, wait);
          return;
        }
        /* 非重试或已用尽次数：原样透传给浏览器 */
        /* 出错时把上游返回内容也打出来，便于在黑窗口直接看到厂商到底回了什么 */
        var tee = new PassThrough();
        var logBody = '';
        tee.on('data', function (d) { if (logBody.length < 300) logBody += d.toString('utf8'); });
        tee.on('end', function () { if (status >= 400 && logBody) console.log(ts() + '    upstream body: ' + logBody.slice(0, 300)); });
        var outHeaders = Object.assign({}, proxyRes.headers);
        outHeaders['access-control-allow-origin'] = req.headers.origin || '';
        delete outHeaders['content-security-policy'];
        setRestrictedCORS(res, req);
        res.writeHead(status, outHeaders);
        proxyRes.pipe(tee);
        tee.pipe(res);
      });

      proxyReq.on('error', function (err) {
        if (attempt < MAX_RETRY) {
          var wait = Math.min(8000, 500 * Math.pow(2, attempt));
          console.log(ts() + '    转发失败 ' + err.message + '，' + wait + 'ms 后重试 (' + (attempt + 1) + '/' + MAX_RETRY + ')');
          setTimeout(function () { doAttempt(attempt + 1); }, wait);
          return;
        }
        console.error(ts() + '    转发失败: ' + err.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '本地服务无法连接上游接口：' + err.message } }));
      });

      if (bodyBuf.length) proxyReq.write(bodyBuf);
      proxyReq.end();
    }

    doAttempt(0);
  });
}

function serveStatic(req, res, pathname) {
  var rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = _isMobileUA(req) ? '/手机工作台.html' : '/工作台.html';
  var filePath = path.join(ROOT, rel);

  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ============ 每日实时热点：服务端代理 AI Hot 匿名 API ============
 * AI Hot（aihot.virxact.com）提供免 Key 的公开 REST API，本机服务代抓后
 * 回传给前端，既绕开浏览器 CORS，也集中做缓存与容错。 */
function sendJson(res, req, obj) {
  setRestrictedCORS(res, req);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

function fetchJson(opts, cb) {
  var req = https.request({
    host: opts.host,
    path: opts.path,
    method: opts.method || 'GET',
    timeout: opts.timeout || 15000,
    headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 WorkbenchNews/1.0',
      'Accept': 'application/json'
    }, opts.headers || {})
  }, function (r) {
    var chunks = [];
    r.on('data', function (c) { chunks.push(c); });
    r.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (r.statusCode < 200 || r.statusCode >= 300) { cb(new Error('upstream ' + r.statusCode)); return; }
      try { cb(null, JSON.parse(body)); } catch (e) { cb(new Error('bad json')); }
    });
  });
  req.on('error', function (e) { cb(e); });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  if (opts.body) req.write(opts.body);
  req.end();
}

var newsCache = { ts: 0, data: null };
var NEWS_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

function serveNews(req, res) {
  var now = Date.now();
  if (newsCache.data && (now - newsCache.ts) < NEWS_CACHE_TTL) {
    var cached = JSON.parse(JSON.stringify(newsCache.data));
    cached.cached = true;
    sendJson(res, req, cached);
    return;
  }
  var since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  var apiPath = '/api/public/items?mode=selected&take=30&since=' + encodeURIComponent(since);
  fetchJson({ host: 'aihot.virxact.com', path: apiPath }, function (err, json) {
    if (err || !json || !Array.isArray(json.items)) {
      if (newsCache.data) { var c = JSON.parse(JSON.stringify(newsCache.data)); c.cached = true; c.stale = true; sendJson(res, req, c); return; }
      sendJson(res, req, { ok: false, error: (err && err.message) || 'empty', source: 'AI Hot' });
      return;
    }
    var items = json.items.map(function (it) {
      return {
        title: it.title || '',
        url: it.url || it.permalink || '',
        src: it.source || 'AI Hot',
        summary: it.summary || '',
        category: it.category || '',
        time: it.publishedAt || it.discoveredAt || ''
      };
    });
    var payload = { ok: true, source: 'AI Hot', count: items.length, updatedAt: new Date().toISOString(), items: items };
    newsCache = { ts: now, data: payload };
    sendJson(res, req, payload);
  });
}

/* ---------- ★★ 变更广播（SSE）：让独立悬浮球窗口做到「实时」同步 ----------
 * 2026-09-23：待办悬浮球是**独立窗口**（悬浮球.html），主窗口的 postMessage 到不了它，
 * 原先只能 60 秒轮询一次 → 用户改完待办要等十几秒到一分钟。
 * 压到 1 秒轮询后够快了，但本质仍是「定时去问」。
 * 这里加一条真正的推送通道：任何数据被 POST 写入后，立刻通知所有订阅者。
 *
 * 用 SSE（Server-Sent Events）而不是 WebSocket：
 *   · 服务端零依赖（就是一条长连的 HTTP 响应），不用引入 ws 库
 *   · 浏览器端一行 `new EventSource(url)` 即可，断线自动重连（内置）
 *   · 单向推送正好符合需求（服务端 → 页面）
 */
var _sseClients = [];   /* [{ res, app }] —— app 为 null 表示订阅全部 */

function _sseHandler(req, res) {
  var q = url.parse(req.url, true).query;
  var wantApp = (q && typeof q.app === 'string' && q.app) ? q.app : null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  /* 首包：告诉客户端已连上（EventSource 收到任意数据才触发 onopen 语义） */
  res.write(': connected\n\n');

  var client = { res: res, app: wantApp };
  _sseClients.push(client);

  /* 心跳：每 25 秒一个注释包，防止代理/系统把长连接掐掉 */
  var hb = setInterval(function () {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);

  function cleanup() {
    clearInterval(hb);
    var i = _sseClients.indexOf(client);
    if (i >= 0) _sseClients.splice(i, 1);
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* 广播「某个 app 的数据变了」。app 为 null 时发给所有订阅者 */
function _sseBroadcast(app, extra) {
  var payload = JSON.stringify(Object.assign({ app: app, at: Date.now() }, extra || {}));
  var dead = [];
  _sseClients.forEach(function (c) {
    if (c.app && app && c.app !== app) return;      /* 订阅了特定 app 的，只收自己那份 */
    try {
      c.res.write('event: change\ndata: ' + payload + '\n\n');
    } catch (e) { dead.push(c); }
  });
  /* 写失败的连接顺手清掉 */
  dead.forEach(function (c) {
    var i = _sseClients.indexOf(c);
    if (i >= 0) _sseClients.splice(i, 1);
  });
}

function serveBackup(req, res) {
  setRestrictedCORS(res, req);
  var q = url.parse(req.url, true).query;
  var file = _backupFile(q.app);
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'bad app' }));
    return;
  }  if (req.method === 'GET') {
    fs.stat(file, function (err, st) {
      if (err || !st.isFile()) {
        // 用 204 而非 404，避免浏览器在「首次启动、尚无备份」时打印 404 报错
        res.writeHead(204, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': st.size,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
    });
  } else if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 1024 * 1024 * 1024; // 1GB 上限，防内存打爆
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); return; }
      var raw = Buffer.concat(chunks).toString('utf8');
      zlib.gzip(raw, function (gerr, gz) {
        if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'gzip failed' })); return; }
        /* ★ 覆盖前先留一份「上一版」到 data/.prev/（2026-09-15 加的保险）。
           起因：店铺分析页在「读不到备份」时会 seedDefaultStore() 并用示例数据 saveState()，
           把真实数据**原地覆盖**，且没有任何留档 → 用户 133 个商品直接蒸发。
           这份 .prev 是**每次写入前**的旧内容，所以「第一次误覆盖」时它正好是真实数据。
           best-effort：备份失败绝不阻断正常保存。 */
        try {
          var prevDir = path.join(_resolveDataDir(), '.prev');
          fs.mkdirSync(prevDir, { recursive: true });
          if (fs.existsSync(file)) fs.copyFileSync(file, path.join(prevDir, q.app + '.json.gz'));
        } catch (be) { console.warn('[backup] 上一版留档失败(不影响保存):', be && be.message); }
        fs.writeFile(file, gz, function (werr) {
          if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'write failed' })); return; }
          /* ★ 落盘成功 → 立刻广播，让订阅者（独立悬浮球窗口）零延迟同步 */
          try { _sseBroadcast(q.app, { mtime: Date.now() }); } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, bytes: raw.length }));
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
  } else if (req.method === 'DELETE') {
    fs.unlink(file, function () {
      try { _sseBroadcast(q.app, { mtime: Date.now() }); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
  }
}

/* 数据存储位置配置：GET 读当前位置 + 文件列表；POST 设置新位置（自动迁移已有备份） */
function serveConfig(req, res) {
  setRestrictedCORS(res, req);
  if (req.method === 'GET') {
    var dir = _resolveDataDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    var items = [];
    Object.keys(BACKUP_APPS).forEach(function (app) {
      var f = path.join(dir, app + '.json.gz');
      try {
        var st = fs.statSync(f);
        if (st.isFile()) items.push({ app: app, file: app + '.json.gz', size: st.size, mtime: st.mtimeMs });
      } catch (e) {}
    });
    sendJson(res, req, { ok: true, dataDir: dir, items: items });
    return;
  }
  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413); res.end(''); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400); res.end(''); return; }
      var newDir = (body && typeof body.dataDir === 'string') ? body.dataDir.trim() : '';
      // 防御：空、含空字节、含路径穿越
      if (!newDir || /[\0]/.test(newDir) || newDir.indexOf('..') >= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid path' }));
        return;
      }
      var abs;
      try { abs = path.resolve(newDir); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad path' })); return; }
      // Windows 要求带盘符的绝对路径；其它平台要求以 / 开头
      if (process.platform === 'win32') {
        if (!/^[A-Za-z]:[\\/]/.test(abs)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '必须是带盘符的绝对路径，例如 D:\\运营数据备份' }));
          return;
        }
      } else if (abs[0] !== '/') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '必须是绝对路径，例如 /data/backup' }));
        return;
      }
      try { fs.mkdirSync(abs, { recursive: true }); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '无法创建该目录：' + e.message }));
        return;
      }
      // 迁移已有备份到新目录（跨设备则复制后删除原文件）
      var moved = [];
      try {
        var oldDir = _resolveDataDir();
        if (oldDir && path.resolve(oldDir) !== abs) {
          Object.keys(BACKUP_APPS).forEach(function (app) {
            var of = path.join(oldDir, app + '.json.gz');
            var nf = path.join(abs, app + '.json.gz');
            if (fs.existsSync(of) && !fs.existsSync(nf)) {
              try { fs.renameSync(of, nf); moved.push(app); }
              catch (e1) { try { fs.copyFileSync(of, nf); fs.unlinkSync(of); moved.push(app); } catch (e2) {} }
            }
          });
        }
      } catch (e) {}
      try {
        fs.writeFileSync(_configFilePath(), JSON.stringify({ dataDir: abs }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '写入配置失败：' + e.message }));
        return;
      }
      sendJson(res, req, { ok: true, dataDir: abs, moved: moved });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }
  res.writeHead(405); res.end('');
}

/* 千牛聊天记录导入：接收浏览器扩展 POST 的记录，与已有记录合并去重后落盘。
   数据文件 <DATA_DIR>/qchat.json.gz，格式 { records:[...], meta:{...}, updatedAt }。
   每条记录带 store 字段（多店铺区分），未指定时归入「默认店铺」。 */
/* ============ 离线 OCR（POST /api/ocr）============
   为什么做（2026-09-18 用户诉求）：希望「没配视觉大模型也能识别截图」。
   Windows 10/11 自带 Windows.Media.Ocr，纯离线、不要 Key、实测 250ms 左右（1440x900 截图）。
   为什么放服务端而不是浏览器：① 浏览器拿不到 WinRT OCR；② 网页版和客户端都连这个服务，
   一处实现两边都能用。

   请求：{ image: 'data:image/png;base64,...' }
   响应：{ ok: true, text: '识别出的纯文本' } / { ok: false, error: '...' }

   ⚠️ 只在系统临时目录写一个输入文件 + 一个输出文件，跑完立刻删；**绝不碰 data/**。
   ⚠️ 非 Windows 直接返回不支持，由前端回落到「提示用户配置模型」。 */
function serveOcr(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }

  var script = path.join(__dirname, 'wb-ocr.ps1');
  if (process.platform !== 'win32' || !fs.existsSync(script)) {
    sendJson(res, req, { ok: false, error: '本机不支持离线 OCR（依赖 Windows 自带的 OCR 引擎）' });
    return;
  }

  var chunks = [], size = 0, MAX = 16 * 1024 * 1024;   // 截图 base64 可能好几 MB
  req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
  req.on('end', function () {
    if (size > MAX) { res.writeHead(413); res.end(''); return; }
    var body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}; } catch (e) { body = {}; }
    var dataUrl = (body && typeof body.image === 'string') ? body.image : '';
    var m = /^data:image\/(png|jpeg|jpg|bmp|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!m) { sendJson(res, req, { ok: false, error: '需要 data:image/<png|jpeg|bmp>;base64,... 形式的图片' }); return; }
    var ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';

    var stamp = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var tmpIn = path.join(os.tmpdir(), 'wb-ocr-in-' + stamp + '.' + ext);
    var tmpOut = path.join(os.tmpdir(), 'wb-ocr-out-' + stamp + '.txt');

    try { fs.writeFileSync(tmpIn, Buffer.from(m[2].replace(/\s+/g, ''), 'base64')); }
    catch (e) { sendJson(res, req, { ok: false, error: '临时文件写入失败：' + e.message }); return; }

    function cleanup() {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      try { fs.unlinkSync(tmpOut); } catch (e) {}
    }

    var args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Image', tmpIn, '-OutFile', tmpOut];
    execFile('powershell.exe', args, { timeout: 45000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout, stderr) {
        var text = '';
        try { text = fs.readFileSync(tmpOut, 'utf8'); } catch (e) { text = ''; }
        cleanup();
        if (/^OCR_ERROR:/.test(text)) { sendJson(res, req, { ok: false, error: text.replace(/^OCR_ERROR:\s*/, '') }); return; }
        if (!text && err) {
          sendJson(res, req, { ok: false, error: 'OCR 执行失败：' + String(stderr || err.message || '').slice(0, 300) });
          return;
        }
        sendJson(res, req, { ok: true, text: text });
      });
  });
}

function serveQianniuChat(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('qchat');
  var DEFAULT_STORE = '默认店铺';

  function normStore(r) {
    if (r && typeof r === 'object' && !r.store) r.store = DEFAULT_STORE;
  }
  function uniqStores(records) {
    var seen = {}, out = [];
    (records || []).forEach(function (r) {
      var s = (r && r.store) || DEFAULT_STORE;
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out.sort();
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) {
        sendJson(res, req, { ok: true, records: [], stores: [], count: 0 });
        return;
      }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取已存数据失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          records.forEach(normStore);
          sendJson(res, req, { ok: true, records: records, stores: uniqStores(records), meta: d.meta || {}, count: records.length });
        } catch (e) { sendJson(res, req, { ok: false, error: '已存数据格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024 * 1024; // 64MB 上限
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : DEFAULT_STORE;
      var meta = (body && body.meta && typeof body.meta === 'object') ? body.meta : {};
      incoming.forEach(function (r) { if (r && typeof r === 'object' && !r.store) r.store = store; });

      fs.readFile(file, function (err, gz) {
        var existing = [];
        function finish() {
          var seen = {};
          existing.forEach(function (r) { normStore(r); try { seen[JSON.stringify(r)] = true; } catch (e) {} });
          var added = 0;
          incoming.forEach(function (r) {
            try {
              var k = JSON.stringify(r);
              if (!seen[k]) { seen[k] = true; existing.push(r); added++; }
            } catch (e) {}
          });
          var MAX_RECORDS = 200000; // 上限保护
          if (existing.length > MAX_RECORDS) existing = existing.slice(existing.length - MAX_RECORDS);
          var payload = { records: existing, meta: meta, updatedAt: new Date().toISOString() };
          zlib.gzip(JSON.stringify(payload), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              var storeTotal = existing.filter(function (r) { return r.store === store; }).length;
              sendJson(res, req, { ok: true, received: incoming.length, added: added, store: store, storeTotal: storeTotal, total: existing.length });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) {
            try {
              var d = JSON.parse(raw.toString('utf8'));
              if (Array.isArray(d.records)) existing = d.records;
            } catch (e) {}
          }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

/* ---------- 首页汇总（2026-09-15 新增）----------
   为什么要有它：首页要显示「评价待回复 / 问大家待答 / 资料待补 / 数据新鲜度」这些数字。
   如果让页面自己去拉 /api/qianniu-sku（2387 条）+ /api/qianniu-chat（13458 条）再算，
   首屏要传约 400KB 并等前端解析；服务端一次算好只要几毫秒，所以汇总放服务端。
   ⚠️ 本接口**只读**：只 stat/读文件，绝不写任何数据文件。
   ⚠️ 判「过期」用**文件 mtime**（= 最后一次导入时间），不是 records 里的时间字段 ——
      时间字段格式各页不统一，mtime 是唯一可靠的口径。 */
function readGzJson(app) {
  var file = _backupFile(app);
  if (!file) return { data: null, mtime: 0 };
  try {
    var st = fs.statSync(file);
    var raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    return { data: JSON.parse(raw), mtime: st.mtimeMs };
  } catch (e) { return { data: null, mtime: 0 }; }
}
function arrOf(j, key) {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (key && Array.isArray(j[key])) return j[key];
  return [];
}
/* 去重计数：空值不计（'' / null / undefined 都不算一个「店铺」） */
function uniqN(list) {
  var s = {}, n = 0;
  (list || []).forEach(function (v) {
    var k = String(v == null ? '' : v).trim();
    if (k && !s[k]) { s[k] = 1; n++; }
  });
  return n;
}

/* ---------- 待办数量（轻量接口，供桌面悬浮球轮询）----------
   为什么单独做：悬浮球每 60s 轮询一次，不能每次拉 /api/backup?app=ctodo
   整份数组再在前端数；服务端读 gz 数一次只要几毫秒。口径与工作台.html 的
   wbTodoFabCounts() **完全一致**：今日 / 进行中 / 逾期，否则球上数字对不上。
   ⚠️ 只读：只 stat / 读文件，绝不写任何数据文件。 */
function serveTodoCount(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  var f = readGzJson('ctodo');
  var list = Array.isArray(f.data) ? f.data : [];
  var now = new Date();
  var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var today = 0, doing = 0, overdue = 0;
  list.forEach(function (t) {
    if (!t || t.done) return;
    if (t.status === 'doing') {
      doing++;
      if (t.dueAt) {
        var dd = new Date(t.dueAt);
        if (!isNaN(dd.getTime()) && new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()) < t0) overdue++;
      }
      return; // 进行中不参与「今日待办」计数，但仍可能逾期
    }
    var inToday;
    if (t.urgent) inToday = true;
    else if (!t.dueAt) inToday = true;
    else {
      var d = new Date(t.dueAt);
      inToday = isNaN(d.getTime()) ? true
        : (new Date(d.getFullYear(), d.getMonth(), d.getDate()) <= t0);
    }
    if (inToday) today++;
    if (t.dueAt) {
      var dd2 = new Date(t.dueAt);
      if (!isNaN(dd2.getTime()) && new Date(dd2.getFullYear(), dd2.getMonth(), dd2.getDate()) < t0) overdue++;
    }
  });
  sendJson(res, req, { ok: true, today: today, doing: doing, overdue: overdue, total: list.length, mtime: f.mtime });
}

/* ---------- 待办明细（悬浮球「单击展开」卡片用，只读）----------
   给桌面悬浮球单击时短名单：今日待办 + 进行中，最多取前 N 条，
   每条给 标题/优先级/是否紧急/截止/Done/status。口径与 serveTodoCount 一致。 */
function serveTodoMini(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  var f = readGzJson('ctodo');
  var list = Array.isArray(f.data) ? f.data : [];
  var now = new Date();
  var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var items = [], doingCount = 0, overdueCount = 0;
  // 先做进行中（置顶），再作今日待办；两段都各自按 紧急>截止>标题 排序。
  var pick = function (arr) { return arr.map(function (t) {
    return {
      title: (t && t.title) || '(无标题)',
      done: !!(t && t.done),
      urgent: !!(t && t.urgent),
      priority: t && t.priority,
      dueAt: t && t.dueAt ? t.dueAt : null,
      status: (t && t.status) || null
    };
  }); };
  var doing = [], today = [];
  list.forEach(function (t) {
    if (!t || t.done) return;
    if (t.status === 'doing') {
      doingCount++;
      doing.push(t);
      var d = new Date(t.dueAt);
      if (t.dueAt && !isNaN(d.getTime()) && new Date(d.getFullYear(), d.getMonth(), d.getDate()) < t0) overdueCount++;
      return;
    }
    var inToday = t.urgent || !t.dueAt;
    if (!inToday) {
      var d2 = new Date(t.dueAt);
      inToday = isNaN(d2.getTime()) ? true : (new Date(d2.getFullYear(), d2.getMonth(), d2.getDate()) <= t0);
    }
    if (inToday) today.push(t);
    var d3 = new Date(t.dueAt);
    if (t.dueAt && !isNaN(d3.getTime()) && new Date(d3.getFullYear(), d3.getMonth(), d3.getDate()) < t0) overdueCount++;
  });
  var cmp = function (a, b) {
    if (!!b.urgent !== !!a.urgent) return (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0);
    var pa = (a.priority === undefined ? 2 : Number(a.priority) || 2);
    var pb = (b.priority === undefined ? 2 : Number(b.priority) || 2);
    if (pb !== pa) return pa - pb;
    return String(a.title || '').localeCompare(String(b.title || ''));
  };
  doing.sort(cmp); today.sort(cmp);
  items = items.concat(pick(doing), pick(today)).slice(0, 8);
  sendJson(res, req, {
    ok: true, items: items, today: today.length, doing: doingCount,
    overdue: overdueCount, total: list.length, mtime: f.mtime
  });
}

function serveOverview(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  var now = Date.now();
  var skuF = readGzJson('sku');
  var revF = readGzJson('review');
  var askF = readGzJson('ask');
  var chatF = readGzJson('qchat');
  var storeF = readGzJson('store');

  var skus = arrOf(skuF.data, 'records');
  var revs = arrOf(revF.data, 'records');
  var asks = arrOf(askF.data, 'records');
  var chats = arrOf(chatF.data, 'records');
  var storeList = (storeF.data && Array.isArray(storeF.data.stores)) ? storeF.data.stores : [];
  /* 「商品 / 店铺」这一行的条数报**商品数**（店铺数只有 1~2 个，报出来没信息量） */
  var storeItems = 0;
  storeList.forEach(function (s) { storeItems += (s && Array.isArray(s.items)) ? s.items.length : 0; });

  /* --- SKU：商家编码 / 主图都是**商品级**字段 → 按商品去重报数（比按 SKU 条数更有行动意义）--- */
  /* ★ 商品级商家编码兜底（2026-09-14）：与工作台 千牛SKU.html 的 codeOf() **同口径**。
     SKU 记录自己没编码时，拿「商品管理」里同一商品的编码顶上（插件 v1.2.29 起也这么做）。
     不做这一步的话，首页报的「缺编码」会比 SKU 页实际显示的多，用户点进去数量对不上。 */
  var codeByKey = {};
  storeList.forEach(function (s) {
    var nm = (s && (s.name || s.store)) || '';
    var its = (s && Array.isArray(s.items)) ? s.items : [];
    its.forEach(function (it) {
      var iid = String((it && (it.productId || it.itemId)) == null ? '' : (it.productId || it.itemId)).trim();
      var cd = String((it && it.merchantCode) == null ? '' : it.merchantCode).trim();
      if (iid && cd) { var kk = nm + '|' + iid; if (!codeByKey[kk]) codeByKey[kk] = cd; }
    });
  });
  function codeOfRow(r) {
    var own = String((r && r.merchantCode) == null ? '' : r.merchantCode).trim();
    if (own) return own;
    var kk = String((r && r.store) == null ? '' : r.store).trim() + '|' +
             String((r && r.itemId) == null ? '' : r.itemId).trim();
    return codeByKey[kk] || '';
  }

  var itemSeen = {}, itemCode = {}, itemImg = {}, missingCodeRows = 0, missingImgRows = 0;
  skus.forEach(function (r) {
    if (!r) return;
    var id = String(r.itemId == null ? '' : r.itemId).trim();
    var hasCode = codeOfRow(r) !== '';
    var hasImg = String(r.productImg == null ? '' : r.productImg).trim() !== '';
    if (!hasCode) missingCodeRows++;
    if (!hasImg) missingImgRows++;
    if (id) {
      itemSeen[id] = 1;
      if (hasCode) itemCode[id] = 1;
      if (hasImg) itemImg[id] = 1;
    }
  });
  var itemIds = Object.keys(itemSeen);
  var itemsMissingCode = itemIds.filter(function (k) { return !itemCode[k]; }).length;
  var itemsMissingImg = itemIds.filter(function (k) { return !itemImg[k]; }).length;

  /* --- 评价：好评/中评/差评归类（scoreType 可能是「好评 | 追评」，所以用包含判断）+ 未回复 --- */
  var good = 0, mid = 0, bad = 0, other = 0, unreplied = 0;
  revs.forEach(function (r) {
    if (!r) return;
    var t = String(r.scoreType || r.credit || '');
    if (t.indexOf('差评') >= 0) bad++;
    else if (t.indexOf('中评') >= 0) mid++;
    else if (t.indexOf('好评') >= 0) good++;
    else other++;
    if (!String(r.replyTime == null ? '' : r.replyTime).trim()) unreplied++;
  });

  /* --- 问大家：未回答（answerNum 与 answers 数组任一非空即算已答）--- */
  var askUnanswered = 0;
  asks.forEach(function (r) {
    if (!r) return;
    var n = Number(r.answerNum || 0) || 0;
    var ans = Array.isArray(r.answers) ? r.answers.length : 0;
    if (!(n > 0 || ans > 0)) askUnanswered++;
  });

  /* --- 数据新鲜度 --- */
  function mkSrc(key, name, tool, f, count) {
    var age = f.mtime ? Math.round((now - f.mtime) / 3600000) : null;
    return {
      key: key, name: name, tool: tool,
      updatedAt: f.mtime ? new Date(f.mtime).toISOString() : '',
      ageHours: age,
      stale: (age != null && age >= 24),
      count: count || 0,
      hasData: !!f.mtime
    };
  }
  var sources = [
    mkSrc('store', '商品 / 店铺', 'store', storeF, storeItems),
    mkSrc('sku', 'SKU 明细', 'sku', skuF, skus.length),
    mkSrc('review', '评价', 'review', revF, revs.length),
    mkSrc('ask', '问大家', 'ask', askF, asks.length),
    mkSrc('qchat', '聊天记录', 'qchat', chatF, chats.length)
  ];
  var staleSources = sources.filter(function (s) { return s.stale; }).length;
  var covered = itemIds.length - itemsMissingCode;
  var imgCovered = itemIds.length - itemsMissingImg;

  var payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    tasks: {
      reviewUnreplied: unreplied,
      reviewBad: bad,
      askUnanswered: askUnanswered,
      askTotal: asks.length,
      itemsMissingCode: itemsMissingCode,
      missingCodeRows: missingCodeRows,
      itemsMissingImg: itemsMissingImg,
      missingImgRows: missingImgRows,
      staleSources: staleSources
    },
    sources: sources,
    stats: {
      stores: uniqN(skus.map(function (r) { return r && r.store; })) || storeList.length,
      items: itemIds.length,
      skus: skus.length,
      reviews: { total: revs.length, good: good, mid: mid, bad: bad, other: other },
      chat: {
        sessions: uniqN(chats.map(function (r) { return r && r.conversationId; })),
        messages: chats.length,
        agents: uniqN(chats.map(function (r) { return r && r.agent; }))
      },
      codeCovered: covered,
      codeCoverage: itemIds.length ? Math.round(covered * 100 / itemIds.length) : 0,
      imgCovered: imgCovered,
      imgCoverage: itemIds.length ? Math.round(imgCovered * 100 / itemIds.length) : 0
    }
  };
  var body = JSON.stringify(payload);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? '' : body);
}

/* 千牛SKU导出导入：接收浏览器扩展 POST 的 SKU 记录，按 SKU 唯一键覆盖更新后落盘。
   数据文件 <DATA_DIR>/sku.json.gz，格式 { records:[...], meta:{...}, updatedAt }。
   每条记录字段：title,itemId,merchantCode,skuDesc,skuId,status,imgUrl,searchTitle,price,stock,attrs,store。
   写入规则（2026-09-11 起，XZX 要求改为覆盖更新）：
   同一个 SKU 再次发送 = 覆盖更新为最新值（不再追加重复记录）；
   没有匹配到的新 SKU = 追加。已有记录不会被删除。 */
function serveQianniuSku(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('sku');
  var DEFAULT_STORE = '默认店铺';

  function normStore(r) {
    if (r && typeof r === 'object' && !r.store) r.store = DEFAULT_STORE;
  }
  /* SKU 唯一键：店铺 + 商品ID + SKU ID（逐级降级兜底）。
     加了 store 前缀，同一个 SKU 在不同店铺下互不干扰。
     没有 skuId 的（无规格商品）用 skuDesc 兜底，避免同一商品的多条无规格记录互相覆盖。
     三级都拿不到 → 返回空串，调用方按「新增」处理（宁可多存也不丢）。 */
  function skuKey(r) {
    if (!r || typeof r !== 'object') return '';
    var prefix = (r.store || DEFAULT_STORE) + '|';
    var item = String(r.itemId == null ? '' : r.itemId).trim();
    var sku = String(r.skuId == null ? '' : r.skuId).trim();
    if (item || sku) {
      return prefix + item + '|' + (sku || ('~' + String(r.skuDesc == null ? '' : r.skuDesc).trim()));
    }
    var mc = String(r.merchantCode == null ? '' : r.merchantCode).trim();
    if (mc) return prefix + '#mc|' + mc;
    return '';
  }
  /* 一条记录里「非空字段」的个数。用于自愈去重时判断哪条信息更全
     （例如带商家编码的那条 vs 编码为空的那条）。 */
  function filledCount(r) {
    var n = 0;
    for (var f in r) {
      if (!Object.prototype.hasOwnProperty.call(r, f)) continue;
      var v = r[f];
      if (v != null && String(v).trim() !== '') n++;
    }
    return n;
  }
  function uniqStores(records) {
    var seen = {}, out = [];
    (records || []).forEach(function (r) {
      var s = (r && r.store) || DEFAULT_STORE;
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out.sort();
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) {
        sendJson(res, req, { ok: true, records: [], stores: [], count: 0 });
        return;
      }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取已存数据失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          records.forEach(normStore);
          sendJson(res, req, { ok: true, records: records, stores: uniqStores(records), meta: d.meta || {}, count: records.length });
        } catch (e) { sendJson(res, req, { ok: false, error: '已存数据格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024 * 1024; // 64MB 上限
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : DEFAULT_STORE;
      var meta = (body && body.meta && typeof body.meta === 'object') ? body.meta : {};
      incoming.forEach(function (r) { if (r && typeof r === 'object' && !r.store) r.store = store; });

      fs.readFile(file, function (err, gz) {
        var existing = [];
        function finish() {
          /* 自愈去重（2026-09-11）：旧规则是「整条 JSON 去重后追加」，同一个 SKU 被发过两次就会残留两行
             （典型现场：先发一次没抓到商家编码的行，后来又发一次带编码的行，两行都留在库里）。
             这里按 skuKey 把已有数据先合并：保留字段更全的那条；一样全则保留较新的那条。 */
          var kept = {}, order = [], merged = 0;
          existing.forEach(function (r) {
            normStore(r);
            var dk = skuKey(r);
            if (!dk) { order.push(r); return; }
            var prev = kept[dk];
            if (!prev) { kept[dk] = r; order.push(r); return; }
            merged++;
            if (filledCount(r) >= filledCount(prev)) {
              kept[dk] = r;
              order[order.indexOf(prev)] = r;
            }
          });
          existing = order;
          /* 覆盖更新：按 skuKey 建「键 → 已有记录下标」索引。
             命中 → 逐字段覆盖为最新值；未命中 → 追加。用下标而非重建数组，保持原有顺序。 */
          var idx = {};
          existing.forEach(function (r, i) { var ik = skuKey(r); if (ik) idx[ik] = i; });
          var added = 0, updated = 0;
          incoming.forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var k = skuKey(r);
            if (k && idx[k] != null) {
              var old = existing[idx[k]];
              for (var fk in r) { if (r[fk] !== undefined) old[fk] = r[fk]; }
              updated++;
            } else {
              existing.push(r);
              if (k) idx[k] = existing.length - 1;
              added++;
            }
          });
          var MAX_RECORDS = 500000; // 上限保护
          if (existing.length > MAX_RECORDS) existing = existing.slice(existing.length - MAX_RECORDS);
          var payload = { records: existing, meta: meta, updatedAt: new Date().toISOString() };
          zlib.gzip(JSON.stringify(payload), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              var storeTotal = existing.filter(function (r) { return r.store === store; }).length;
              sendJson(res, req, { ok: true, received: incoming.length, added: added, updated: updated, deduped: merged, store: store, storeTotal: storeTotal, total: existing.length });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) {
            try {
              var d = JSON.parse(raw.toString('utf8'));
              if (Array.isArray(d.records)) existing = d.records;
            } catch (e) {}
          }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

/* 千牛商品导出导入：接收浏览器扩展 POST 的商品记录，与已有记录合并去重后落盘。
   数据文件 <DATA_DIR>/product.json.gz，格式 { records:[...], meta:{...}, updatedAt }。 */
function serveQianniuProduct(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('product');
  var DEFAULT_STORE = '默认店铺';

  function normStore(r) {
    if (r && typeof r === 'object' && !r.store) r.store = DEFAULT_STORE;
  }
  function uniqStores(records) {
    var seen = {}, out = [];
    (records || []).forEach(function (r) {
      var s = (r && r.store) || DEFAULT_STORE;
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out.sort();
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) { sendJson(res, req, { ok: true, records: [], stores: [], count: 0 }); return; }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取已存数据失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          records.forEach(normStore);
          sendJson(res, req, { ok: true, records: records, stores: uniqStores(records), meta: d.meta || {}, count: records.length });
        } catch (e) { sendJson(res, req, { ok: false, error: '已存数据格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024 * 1024;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : DEFAULT_STORE;
      var meta = (body && body.meta && typeof body.meta === 'object') ? body.meta : {};
      incoming.forEach(function (r) { if (r && typeof r === 'object' && !r.store) r.store = store; });

      fs.readFile(file, function (err, gz) {
        var existing = [];
        function finish() {
          var seen = {};
          existing.forEach(function (r) { normStore(r); try { seen[JSON.stringify(r)] = true; } catch (e) {} });
          var added = 0;
          incoming.forEach(function (r) {
            try {
              var k = JSON.stringify(r);
              if (!seen[k]) { seen[k] = true; existing.push(r); added++; }
            } catch (e) {}
          });
          var MAX_RECORDS = 500000;
          if (existing.length > MAX_RECORDS) existing = existing.slice(existing.length - MAX_RECORDS);
          var payload = { records: existing, meta: meta, updatedAt: new Date().toISOString() };
          zlib.gzip(JSON.stringify(payload), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              var storeTotal = existing.filter(function (r) { return r.store === store; }).length;
              sendJson(res, req, { ok: true, received: incoming.length, added: added, store: store, storeTotal: storeTotal, total: existing.length });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) {
            try {
              var d = JSON.parse(raw.toString('utf8'));
              if (Array.isArray(d.records)) existing = d.records;
            } catch (e) {}
          }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

/* 千牛商品导出 → 写入店铺分析「店铺商品总览」：
   接收 { storeName, items }，把商品合并进 store_analytics_data 的对应店铺 items[] 后落盘。
   store.json.gz 内是 appState = { stores:[{id,name,items,orders,dailyData,searchTerms,marketWords}], currentStoreId, reminderItems }。 */
function serveQianniuProductImport(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('store');
  if (!file) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '存储未配置' })); return; }
  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }

  var chunks = [], size = 0, MAX = 64 * 1024 * 1024;
  req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
  req.on('end', function () {
    if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
    var body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
    var storeName = (body && typeof body.storeName === 'string' && body.storeName.trim()) ? body.storeName.trim() : '默认店铺';
    var incoming = (body && Array.isArray(body.items)) ? body.items : [];
    if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的商品' })); return; }

    fs.readFile(file, function (err, gz) {
      var app = {};
      if (!err && gz && gz.length) {
        try { app = JSON.parse(zlib.gunzipSync(gz).toString('utf8')); } catch (e) { app = {}; }
      }
      if (!app || typeof app !== 'object') app = {};
      var stores = Array.isArray(app.stores) ? app.stores : [];
      var store = null;
      for (var i = 0; i < stores.length; i++) {
        if ((stores[i] && stores[i].name) === storeName) { store = stores[i]; break; }
      }
      if (!store) {
        store = { id: 'qnx_' + Date.now(), name: storeName, items: [], orders: [], dailyData: [], searchTerms: [], marketWords: [] };
        stores.push(store);
      }
      var itemMap = {};
      (Array.isArray(store.items) ? store.items : []).forEach(function (it) {
        var k = it && (it.productId || it.merchantCode || it.title);
        if (k) itemMap[k] = it;
      });
      var added = 0, skippedBlank = 0;
      /* ★ 空值不覆盖非空 —— 与 `/api/qianniu-*` 的 upsert 规则保持一致（本项目既有约定）。
         为什么这里必须补上：插件「商品导出」不抓「类目」「状态」，payload 里这两个字段恒为 ''，
         而下面原来是 `for (fk in nit)` **无条件覆盖** → 会把店铺分析 / Excel 导入来的
         类目、状态**抹成空**（2026-09-15 实测：一次商品导入后 category 变成 133/133 全空、
         status 只剩 1 条）。 */
      function isBlank(v) {
        if (v == null) return true;
        if (Array.isArray(v)) return v.length === 0;
        return String(v).trim() === '';
      }
      incoming.forEach(function (nit) {
        if (!nit || typeof nit !== 'object') return;
        var k = nit.productId || nit.merchantCode || nit.title;
        if (k && itemMap[k]) {
          for (var fk in nit) {
            if (!Object.prototype.hasOwnProperty.call(nit, fk)) continue;
            if (nit[fk] === undefined) continue;
            if (isBlank(nit[fk]) && !isBlank(itemMap[k][fk])) { skippedBlank++; continue; }
            itemMap[k][fk] = nit[fk];
          }
        }
        else if (k) { itemMap[k] = nit; added++; }
        else { itemMap['__new_' + Math.random()] = nit; added++; }
      });
      store.items = Object.keys(itemMap).map(function (k) { return itemMap[k]; });
      app.stores = stores;

      zlib.gzip(JSON.stringify(app), function (gerr, gz2) {
        if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
        fs.writeFile(file, gz2, function (werr) {
          if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
          sendJson(res, req, { ok: true, received: incoming.length, added: added, skippedBlank: skippedBlank, storeName: storeName, total: store.items.length });
        });
      });
    });
  });
  req.on('error', function () { res.writeHead(400); res.end(''); });
}

/* 删除某个店铺的数据：POST { store }，从 <app>.json.gz 的 records 里移除该店铺所有记录。 */
/* ============ 商品详情页信息采集（/api/qianniu-item-collect）============
   来源：浏览器扩展「千牛数据助手」v1.2.33+ —— 详情页浮窗上的「📥 采集本页商品」。
   用途：类目确认拿不到之后，详情页改做**商品信息采集**：标题/价格/SKU/主图/销量/参数，
        自家商品与竞品同表，供「竞品采集」页做横向对比。

   ★ 去重规则与 /api/qianniu-product 不同，别照抄那边：
     - qianniu-product 是列表页批量导入，每次数据一样 → 用整条 JSON 全等去重即幂等；
     - 这边是**单品刷新**，同一个商品第二次采（价格降了、销量涨了）必须**覆盖**旧值，
       不能用全等去重，否则永远只留第一次的旧数据。
     → 按 itemId upsert：命中则更新字段（保留 firstCollectedAt），未命中则追加。
   ★ 空值不覆盖非空：保留本项目既有约定（否则第二次页面没加载完就点采集，会把好数据洗成 0）。 */
function serveQianniuItemCollect(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('itemcollect');
  if (!file) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '存储未配置' })); return; }

  function uniqShops(records) {
    var seen = {}, out = [];
    (records || []).forEach(function (r) {
      var s = (r && r.store) || '未标记店铺';
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out.sort();
  }
  /* 「这条字段算不算没采到」—— 0 / 空串 / 空数组 / 空对象 都算 */
  function isEmptyVal(v) {
    if (v === '' || v === null || v === undefined || v === 0) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) { sendJson(res, req, { ok: true, records: [], shops: [], count: 0 }); return; }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取已存数据失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          sendJson(res, req, {
            ok: true, records: records, shops: uniqShops(records),
            count: records.length, updatedAt: d.updatedAt || ''
          });
        } catch (e) { sendJson(res, req, { ok: false, error: '已存数据格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 32 * 1024 * 1024;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      /* 归一化：工作台其它模块都按 `store` 分组（含 remove-store），这边统一补上 */
      incoming.forEach(function (r) {
        if (r && typeof r === 'object' && !r.store) r.store = r.shopName || '未标记店铺';
      });

      fs.readFile(file, function (err, gz) {
        var existing = [], meta = {};
        function finish() {
          var idx = {};
          existing.forEach(function (r, i) {
            var k = (r && r.itemId) ? String(r.itemId) : '';
            if (k) idx[k] = i;
          });
          var added = 0, updated = 0, now = new Date().toISOString();
          incoming.forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var k = r.itemId ? String(r.itemId) : '';
            if (k && idx[k] != null) {
              var old = existing[idx[k]] || {};
              /* 空值不覆盖非空：先把旧的有效值回填到新记录的空字段上 */
              Object.keys(old).forEach(function (f) {
                if (f === 'firstCollectedAt' || f === 'collectedAt') return;
                if (isEmptyVal(r[f]) && !isEmptyVal(old[f])) r[f] = old[f];
              });
              r.firstCollectedAt = old.firstCollectedAt || old.collectedAt || now;
              r.collectedAt = now;
              existing[idx[k]] = r;
              updated++;
            } else {
              r.firstCollectedAt = r.collectedAt || now;
              if (k) idx[k] = existing.length;
              existing.push(r);
              added++;
            }
          });
          var payload = { records: existing, meta: meta, updatedAt: now };
          zlib.gzip(JSON.stringify(payload), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              sendJson(res, req, {
                ok: true, received: incoming.length, added: added, updated: updated,
                total: existing.length, shops: uniqShops(existing)
              });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) {
            try {
              var d = JSON.parse(raw.toString('utf8'));
              if (Array.isArray(d.records)) existing = d.records;
              meta = d.meta || {};
            } catch (e) {}
          }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  /* DELETE：删记录 —— 支持三种粒度（body: {itemIds:[…]} / {store:'xx'} / {all:true}）。
     为什么需要：详情页采集是「逛到哪采到哪」，很容易采进不看好的竞品或误采自家重复品，
     没有删除就只能干看着脏数据。 */
  if (req.method === 'DELETE') {
    var dchunks = [], dsize = 0;
    req.on('data', function (c) { dsize += c.length; dchunks.push(c); if (dsize > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', function () {
      var body = {};
      try { body = JSON.parse(Buffer.concat(dchunks).toString('utf8') || '{}') || {}; } catch (e) { body = {}; }
      var ids = (body && Array.isArray(body.itemIds)) ? body.itemIds.map(String) : null;
      var store = (body && typeof body.store === 'string') ? body.store.trim() : '';
      var all = !!(body && body.all);
      if (!ids && !store && !all) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '没有指定要删除的范围（itemIds / store / all 至少给一个）' }));
        return;
      }
      fs.readFile(file, function (err, gz) {
        var d = { records: [], meta: {} };
        if (!err && gz && gz.length) {
          try {
            var parsed = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
            if (parsed && typeof parsed === 'object') {
              d.records = Array.isArray(parsed.records) ? parsed.records : [];
              d.meta = parsed.meta || {};
            }
          } catch (e) {}
        }
        var before = d.records.length;
        d.records = d.records.filter(function (r) {
          if (!r) return false;
          if (all) return false;
          if (store && ((r.store || '未标记店铺') === store || (r.shopName || '') === store)) return false;
          if (ids && ids.indexOf(String(r.itemId || '')) >= 0) return false;
          return true;
        });
        var removed = before - d.records.length;
        d.updatedAt = new Date().toISOString();
        zlib.gzip(JSON.stringify(d), function (gerr, gz2) {
          if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
          fs.writeFile(file, gz2, function (werr) {
            if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
            sendJson(res, req, { ok: true, removed: removed, total: d.records.length, shops: uniqShops(d.records) });
          });
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

function serveQianniuRemoveStore(app, req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile(app);
  if (!file) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '存储未配置' })); return; }
  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }

  var chunks = [], size = 0, MAX = 64 * 1024 * 1024;
  req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
  req.on('end', function () {
    if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
    var body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
    var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : '';
    if (!store) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '缺少 store' })); return; }

    fs.readFile(file, function (err, gz) {
      var d = { records: [], meta: {} };
      if (!err && gz && gz.length) {
        try {
          var parsed = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
          if (parsed && typeof parsed === 'object') {
            d.records = Array.isArray(parsed.records) ? parsed.records : [];
            d.meta = parsed.meta || {};
          }
        } catch (e) {}
      }
      var before = d.records.length;
      d.records = d.records.filter(function (r) { return !r || (r.store || '默认店铺') !== store; });
      var removed = before - d.records.length;
      d.updatedAt = new Date().toISOString();
      zlib.gzip(JSON.stringify(d), function (gerr, gz2) {
        if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
        fs.writeFile(file, gz2, function (werr) {
          if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
          sendJson(res, req, { ok: true, removed: removed, store: store, total: d.records.length });
        });
      });
    });
  });
  req.on('error', function () { res.writeHead(400); res.end(''); });
}

/* 读取店铺数据（GET /api/store）—— 把 store_analytics_data 的 stores 整个回吐，
   供 SKU 明细页消费 stores[].items[].supplier/onlinePurchase/addressMgmt/
   testOrderTime/collectTime/shipDuration 等手输字段（按 store + productId 关联）。
   不暴露任何敏感字段，只读，无副作用。 */
function serveStoreData(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  var file = _backupFile('store');
  if (!file) { sendJson(res, req, { ok: false, error: '存储未配置' }); return; }
  fs.readFile(file, function (err, gz) {
    if (err || !gz || !gz.length) {
      /* ★ 不要静默返回空数组：数据目录一旦指错，这里返回的 {ok:true,stores:[]}
         会让「商品页 / SKU 页 / 首页」全部表现为「能打开但没数据」，
         排查成本极高（2026-09-15 真实踩坑）。加服务端日志 + 响应里带 hint，
         前端只用 stores 字段，多一个 hint 不影响既有解析。 */
      console.warn('[warn] /api/store 读不到数据文件: ' + file +
        (err ? ('（' + (err.code || err.message) + '）') : '（文件为空）'));
      sendJson(res, req, { ok: true, stores: [], hint: '未找到数据文件: ' + file });
      return;
    }
    var app = {};
    try { app = JSON.parse(zlib.gunzipSync(gz).toString('utf8')); } catch (e) { app = {}; }
    var stores = (app && Array.isArray(app.stores)) ? app.stores : [];
    var out = stores.map(function (s) {
      return { name: s && s.name, items: Array.isArray(s && s.items) ? s.items : [] };
    });
    sendJson(res, req, { ok: true, stores: out });
  });
}

/* 自动导入：列出各子文件夹待导入文件 */
function serveAutoImportList(req, res) {
  setRestrictedCORS(res, req);
  _ensureAutoImportDirs();
  var out = {};
  var doneTotal = 0;
  try {
    try {
      var doneFiles = fs.readdirSync(AUTO_IMPORT_DONE_DIR);
      doneFiles.forEach(function (n) { if (/\.(xlsx|xls|csv)$/i.test(n)) doneTotal++; });
    } catch (e) {}
    AUTO_IMPORT_SUBS.forEach(function (sub) {
      var dir = path.join(AUTO_IMPORT_DIR, sub);
      var files = [];
      try {
        fs.readdirSync(dir).forEach(function (name) {
          var p = path.join(dir, name);
          try {
            var st = fs.statSync(p);
            if (st.isFile() && /\.(xlsx|xls|csv)$/i.test(name)) {
              files.push({ name: name, size: st.size, mtime: st.mtimeMs });
            }
          } catch (e) {}
        });
      } catch (e) {}
      out[sub] = files;
    });
    sendJson(res, req, { ok: true, files: out, doneTotal: doneTotal });
  } catch (e) {
    sendJson(res, req, { ok: false, error: '扫描自动导入文件夹失败' });
  }
}

/* 自动导入：读取指定文件原始字节（返回 ArrayBuffer 由前端 SheetJS 解析） */
function serveAutoImportFile(req, res) {
  setRestrictedCORS(res, req);
  var q = url.parse(req.url, true).query;
  var sub = q.sub || '';
  var name = q.name || '';
  if (AUTO_IMPORT_SUBS.indexOf(sub) < 0 || !/^[^\\/:*?"<>|]+$/.test(name)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '参数错误' }));
    return;
  }
  var p = path.join(AUTO_IMPORT_DIR, sub, name);
  fs.readFile(p, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '文件不存在' })); return; }
    var ext = path.extname(name).toLowerCase();
    var ct = ext === '.csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* 自动导入：标记完成，把文件移入「已导入」 */
function serveAutoImportDone(req, res) {
  setRestrictedCORS(res, req);
  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
  var chunks = [], size = 0;
  req.on('data', function (c) { size += c.length; chunks.push(c); if (size > 10 * 1024 * 1024) req.destroy(); });
  req.on('end', function () {
    var body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
    var sub = body.sub || '';
    var name = body.name || '';
    if (AUTO_IMPORT_SUBS.indexOf(sub) < 0 || !/^[^\\/:*?"<>|]+$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '参数错误' }));
      return;
    }
    var src = path.join(AUTO_IMPORT_DIR, sub, name);
    var dst = path.join(AUTO_IMPORT_DONE_DIR, Date.now() + '_' + name);
    _ensureAutoImportDirs();
    fs.rename(src, dst, function (err) {
      if (err) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '移动失败：' + err.message })); return; }
      sendJson(res, req, { ok: true, name: name, sub: sub });
    });
  });
  req.on('error', function () { res.writeHead(400); res.end(''); });
}

/* 千牛评价导出导入：接收浏览器扩展 POST 的评价记录，与已有记录合并去重后落盘。 */
function serveQianniuReview(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('review');
  var DEFAULT = '默认店铺';
  function norm(r) { if (r && typeof r === 'object' && !r.store) r.store = DEFAULT; }
  function uniq(records) { var s = {}, o = []; (records || []).forEach(function (r) { var n = (r && r.store) || DEFAULT; if (!s[n]) { s[n] = 1; o.push(n); } }); return o.sort(); }

  /* 评价唯一键（对齐 SKU 页的 skuKey 思路）。
     层级：店铺 + 订单号 → 最可靠；
           没有订单号时退到 店铺 + 主评ID(feedId)；
           再没有就退到 店铺 + 商品 + 评价内容前 40 字。
     全部拿不到 → 返回空串，调用方按「新增」处理（宁可多存也不丢）。 */
  function reviewKey(r) {
    if (!r || typeof r !== 'object') return '';
    var prefix = (r.store || DEFAULT) + '|';
    var oid = String(r.orderId == null ? '' : r.orderId).trim();
    if (oid) return prefix + 'o|' + oid;
    var fid = String(r.feedId == null ? '' : r.feedId).trim();
    if (fid) return prefix + 'f|' + fid;
    var c = String(r.content == null ? '' : r.content).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (c) return prefix + 'c|' + String(r.product == null ? '' : r.product).trim().slice(0, 20) + '|' + c;
    return '';
  }
  /* 非空字段计数：自愈去重时保留信息更全的那条（典型：带晒图/商家回复的 vs 空的）。 */
  function filledCount(r) {
    var n = 0;
    for (var f in r) {
      if (!Object.prototype.hasOwnProperty.call(r, f)) continue;
      var v = r[f];
      if (v == null) continue;
      if (Array.isArray(v)) { if (v.length) n++; continue; }
      if (String(v).trim() !== '') n++;
    }
    return n;
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) { sendJson(res, req, { ok: true, records: [], stores: [], count: 0 }); return; }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          records.forEach(norm);
          sendJson(res, req, { ok: true, records: records, stores: uniq(records), meta: d.meta || {}, count: records.length });
        } catch (e) { sendJson(res, req, { ok: false, error: '格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024 * 1024;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : DEFAULT;
      incoming.forEach(function (r) { if (r && typeof r === 'object' && !r.store) r.store = store; });

      fs.readFile(file, function (err, gz) {
        var existing = [];
        function finish() {
          /* 自愈去重（2026-09-13）：旧规则是「整条 JSON 去重后追加」。
             插件这次给评价记录补了 images / productId 两个字段，导致同一条评价
             新旧 JSON 不同 → 会各存一行（历史数据会产生成倍重复行）。
             这里按 reviewKey 先合并已有数据：保留字段更全的那条；一样全则保留较新的。 */
          var kept = {}, order = [], merged = 0;
          existing.forEach(function (r) {
            norm(r);
            var dk = reviewKey(r);
            if (!dk) { order.push(r); return; }
            var prev = kept[dk];
            if (!prev) { kept[dk] = r; order.push(r); return; }
            merged++;
            if (filledCount(r) >= filledCount(prev)) {
              kept[dk] = r;
              order[order.indexOf(prev)] = r;
            }
          });
          existing = order;
          /* 覆盖更新：按 reviewKey 建「键 → 已有记录下标」索引。
             命中 → 合并字段；未命中 → 追加。用下标而非重建数组，保持原有顺序。
             合并策略（2026-09-13）：**空值不覆盖已有非空值**。
             原因：插件不同批次的采集完整度不同（例如某次没抓到卖家回复时间 / 晒图），
             若无条件覆盖，重发一次就会把「卖家回复时间」「买家晒图」这类已有内容抹掉；
             而补上新采到的 images 又必须能写进去 —— 所以规则是「非空才覆盖」。
             注意：数组以长度非空为准；空数组 [] 不覆盖已有非空数组。 */
          var idx = {};
          existing.forEach(function (r, i) { var ik = reviewKey(r); if (ik) idx[ik] = i; });
          function isBlank(v) {
            if (v == null) return true;
            if (Array.isArray(v)) return v.length === 0;
            return String(v).trim() === '';
          }
          var added = 0, updated = 0;
          incoming.forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var k = reviewKey(r);
            if (k && idx[k] != null) {
              var old = existing[idx[k]];
              for (var fk in r) {
                if (!Object.prototype.hasOwnProperty.call(r, fk)) continue;
                var nv = r[fk];
                if (nv === undefined) continue;
                if (isBlank(nv) && !isBlank(old[fk])) continue; // 空值不覆盖已有非空
                old[fk] = nv;
              }
              updated++;
            } else {
              existing.push(r);
              if (k) idx[k] = existing.length - 1;
              added++;
            }
          });
          var MAX_RECORDS = 500000;
          if (existing.length > MAX_RECORDS) existing = existing.slice(existing.length - MAX_RECORDS);
          zlib.gzip(JSON.stringify({ records: existing, meta: body.meta || {}, updatedAt: new Date().toISOString() }), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              var storeTotal = existing.filter(function (r) { return r.store === store; }).length;
              sendJson(res, req, { ok: true, received: incoming.length, added: added, updated: updated, deduped: merged, store: store, storeTotal: storeTotal, total: existing.length });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) { try { var d = JSON.parse(raw.toString('utf8')); if (Array.isArray(d.records)) existing = d.records; } catch (e) {} }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

/* ============ 千牛「问大家」导出（/api/qianniu-ask）============
   来源：千牛卖家中心 评价管理 → 「问大家」tab
        （myseller.taobao.com/home.htm/comment-manage/ask-all）。
   记录字段（由浏览器扩展采集）：
     store       店铺名（用户在插件里手填）
     question    问题正文
     asker       提问人（昵称已脱敏，如 n**y）
     askTime     提问时间（如 2026-09-13 23:28:45）
     answerNum   回答数量（页面显示的数字）
     product     商品标题
     productId   商品ID（从 a.link 的 id= 参数取）
     answerDays  剩余可回答天数文案（如「还有180天可回答」）
     answers     回答数组：[{ content, answerer, answerTime, isSeller }]
     answerCount 实际抓到的回答条数（= answers.length）

   去重键 askKey（对齐 reviewKey 思路：锚定业务主键，不用整行 JSON）：
     层级：店铺 + 提问人 + 问题前 40 字
       → 无提问人时退到 店铺 + 商品ID + 问题前 40 字
       → 再退到 店铺 + 问题前 40 字
     拿不到任何有效内容 → 返回空串，调用方按「新增」处理（宁多存不丢）。
   注：问大家没有订单号 / 主评ID 这类稳定 ID，只能以「问题正文 + 提问人」作主键。
      问题由用户手打、同商品下几乎不重复，加提问人后足够唯一。 */
function serveQianniuAsk(req, res) {
  setRestrictedCORS(res, req);
  var file = _backupFile('ask');
  if (!file) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '存储未配置' })); return; }
  var DEFAULT = '默认店铺';
  function norm(r) { if (r && typeof r === 'object' && !r.store) r.store = DEFAULT; }
  function uniq(records) { var s = {}, o = []; (records || []).forEach(function (r) { var n = (r && r.store) || DEFAULT; if (!s[n]) { s[n] = 1; o.push(n); } }); return o.sort(); }
  function qtext(r) { return String((r && r.question) || '').replace(/\s+/g, ' ').trim().slice(0, 40); }

  function askKey(r) {
    if (!r || typeof r !== 'object') return '';
    var prefix = (r.store || DEFAULT) + '|';
    var q = qtext(r);
    if (!q) return '';
    /* ★ 问题ID 最优（弹窗里的 stepper 有个 reset 同款问题，全局唯一且永久稳定）。
       列表页拿不到它，只有抓过回答正文的记录才有 —— 所以放在第一优先级，
       没有时再退到「提问人+问题」「商品ID+问题」。
       注意：降级链各层的键前缀不同（i|/a|/p|/q|），不会互相碰撞。 */
    var qid = String(r.questionId == null ? '' : r.questionId).trim();
    if (qid) return prefix + 'i|' + qid;
    var asker = String(r.asker == null ? '' : r.asker).trim();
    if (asker) return prefix + 'a|' + asker + '|' + q;
    var pid = String(r.productId == null ? '' : r.productId).trim();
    if (pid) return prefix + 'p|' + pid + '|' + q;
    return prefix + 'q|' + q;
  }
  /* 非空字段计数：自愈去重时保留信息更全的那条
     （典型：一条只有问题，另一条问题+回答正文 → 必须留后者）。 */
  function filledCount(r) {
    var n = 0;
    for (var f in r) {
      if (!Object.prototype.hasOwnProperty.call(r, f)) continue;
      var v = r[f];
      if (v == null) continue;
      if (Array.isArray(v)) { if (v.length) n++; continue; }
      if (String(v).trim() !== '') n++;
    }
    return n;
  }

  if (req.method === 'GET') {
    fs.readFile(file, function (err, gz) {
      if (err || !gz || !gz.length) { sendJson(res, req, { ok: true, records: [], stores: [], count: 0 }); return; }
      zlib.gunzip(gz, function (gerr, raw) {
        if (gerr) { sendJson(res, req, { ok: false, error: '读取失败' }); return; }
        try {
          var d = JSON.parse(raw.toString('utf8'));
          var records = Array.isArray(d.records) ? d.records : [];
          records.forEach(norm);
          sendJson(res, req, { ok: true, records: records, stores: uniq(records), meta: d.meta || {}, count: records.length });
        } catch (e) { sendJson(res, req, { ok: false, error: '格式错误' }); }
      });
    });
    return;
  }

  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 64 * 1024 * 1024;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); return; }
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'JSON 解析失败' })); return; }
      var incoming = (body && Array.isArray(body.records)) ? body.records : [];
      if (!incoming.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '没有可导入的记录' })); return; }
      var store = (body && typeof body.store === 'string' && body.store.trim()) ? body.store.trim() : DEFAULT;
      incoming.forEach(function (r) { if (r && typeof r === 'object' && !r.store) r.store = store; });

      fs.readFile(file, function (err, gz) {
        var existing = [];
        function finish() {
          /* ① 自愈去重：已有数据里同键多条先合并，保留字段更全的那条。
             插件分批补采（先抓列表 → 后点开弹窗补回答正文）会让同一问题
             payload 结构变化；若按整行 JSON 去重会越存越多。 */
          var kept = {}, order = [], merged = 0;
          existing.forEach(function (r) {
            norm(r);
            var dk = askKey(r);
            if (!dk) { order.push(r); return; }
            var prev = kept[dk];
            if (!prev) { kept[dk] = r; order.push(r); return; }
            merged++;
            if (filledCount(r) >= filledCount(prev)) {
              kept[dk] = r;
              order[order.indexOf(prev)] = r;
            }
          });
          existing = order;
          /* ② 覆盖更新：命中 askKey → 合并字段；未命中 → 追加。
             合并策略：**空值不覆盖已有非空值**（空 answers 数组同样不覆盖已有回答）。
             原因：某批次没点开「查看回答」（或弹窗慢没抓到），
             若无条件覆盖就会把先前抓到的回答正文抹掉。 */
          var idx = {};
          existing.forEach(function (r, i) { var ik = askKey(r); if (ik) idx[ik] = i; });
          function isBlank(v) {
            if (v == null) return true;
            if (Array.isArray(v)) return v.length === 0;
            return String(v).trim() === '';
          }
          var added = 0, updated = 0, skipped = 0;
          incoming.forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            var k = askKey(r);
            /* 键为空 = 连问题正文都没有，这条既无法去重也无法展示 —— 直接丢弃。
               与 SKU / 评价的最大区别：**这层判断不能放在问大家页面上做**，
               因为插件本身也不会发这种记录；放这里是为了防止脚本/联调
               直接把垃圾数据灌进库（历史上出现过 tbody 空白排查耗时很久）。 */
            if (!k) { skipped++; return; }
            if (idx[k] != null) {
              var old = existing[idx[k]];
              for (var fk in r) {
                if (!Object.prototype.hasOwnProperty.call(r, fk)) continue;
                var nv = r[fk];
                if (nv === undefined) continue;
                if (isBlank(nv) && !isBlank(old[fk])) continue; // 空值不覆盖已有非空
                old[fk] = nv;
              }
              updated++;
            } else {
              existing.push(r);
              idx[k] = existing.length - 1;
              added++;
            }
          });
          var MAX_RECORDS = 500000;
          if (existing.length > MAX_RECORDS) existing = existing.slice(existing.length - MAX_RECORDS);
          zlib.gzip(JSON.stringify({ records: existing, meta: body.meta || {}, updatedAt: new Date().toISOString() }), function (gerr, gz2) {
            if (gerr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '压缩失败' })); return; }
            fs.writeFile(file, gz2, function (werr) {
              if (werr) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '写入失败' })); return; }
              var storeTotal = existing.filter(function (r) { return r.store === store; }).length;
              sendJson(res, req, { ok: true, received: incoming.length, added: added, updated: updated, deduped: merged, skipped: skipped, store: store, storeTotal: storeTotal, total: existing.length });
            });
          });
        }
        if (err || !gz || !gz.length) { finish(); return; }
        zlib.gunzip(gz, function (gerr, raw) {
          if (!gerr) { try { var d = JSON.parse(raw.toString('utf8')); if (Array.isArray(d.records)) existing = d.records; } catch (e) {} }
          finish();
        });
      });
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

/* ============ 移动端 / 公网访问鉴权 ============
 * 用途：工作台经内网穿透(隧道)暴露到公网后，手机等外部设备访问需密码。
 *   - 本机 127.0.0.1 / localhost 访问：免密（保持桌面体验；且服务仅监听回环，外部不可直连）。
 *   - 非本机来源（手机经隧道）：必须携带有效 wb_token Cookie，否则跳登录 / API 返回 401。
 * 安全要点：
 *   - 隧道程序运行在本机，转发到 http://127.0.0.1:8787，故本服务仍只听回环，安全模型不变。
 *   - 密码以 token 哈希形式存于 wb-auth.json（不存明文）；首次须在本机 /login 设置，远程禁止设置，避免被抢先设密。
 *   - 同源(隧道域名)请求自动携带 Cookie，现有前端 fetch 无需改动。 */
var AUTH_FILE = path.join(ROOT, 'wb-auth.json');
var AUTH_PEPPER = 'wb-mobile-gate-v1';
function _tokenOf(pw) { return crypto.createHash('sha256').update(pw + '|' + AUTH_PEPPER).digest('hex'); }
function _readToken() {
  try { if (fs.existsSync(AUTH_FILE)) { var j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); if (j && typeof j.token === 'string' && j.token) return j.token; } } catch (e) {}
  return '';
}
function _writeToken(t) { try { fs.writeFileSync(AUTH_FILE, JSON.stringify({ token: t }, null, 2)); return true; } catch (e) { return false; } }
function _noPwSet() { return !_readToken(); }
function _isLocalHost(req) {
  var h = (req.headers && req.headers.host) || '';
  return /^127\.0\.0\.1(:\d+)?$/i.test(h) || /^localhost(:\d+)?$/i.test(h);
}
function _isMobileUA(req) {
  var ua = (req.headers && req.headers['user-agent']) || '';
  return /Mobile|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini/i.test(ua);
}
function _cookieToken(req) {
  var c = req.headers.cookie || '';
  var m = /(?:^|;\s*)wb_token=([a-f0-9]{64})/.exec(c);
  return m ? m[1] : '';
}
function _authOK(req) {
  var t = _readToken();
  if (!t) return false;          // 尚未设置密码
  return _cookieToken(req) === t; // 比对哈希，不存明文
}
function _setTokenCookie(res) {
  var t = _readToken();
  if (t) res.setHeader('Set-Cookie', 'wb_token=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
}

function _loginPage(mode, next, err) {
  var title = mode === 'setup' ? '设置访问密码' : (mode === 'locked' ? '尚未设置密码' : '登录运营工作台');
  var hint, confirmField = '';
  if (mode === 'setup') {
    hint = '首次设置：请设定一个访问密码，手机与电脑将用它登录。密码仅以哈希形式保存在你电脑上，不会上传。';
    confirmField = '<input class="inp" type="password" name="confirm" placeholder="再次输入密码确认" autocomplete="new-password">';
  } else if (mode === 'locked') {
    hint = '请先在电脑端浏览器打开 http://127.0.0.1:8787/login 设置访问密码，再用手机经隧道登录。';
  } else {
    hint = '请输入电脑端设置的访问密码。';
  }
  var errHtml = err ? '<div class="err">' + err + '</div>' : '';
  var formHtml = (mode === 'locked')
    ? ''
    : '<form method="post" action="/login">'
      + '<input type="hidden" name="next" value="' + (next || '/工作台.html') + '">'
      + '<input class="inp" type="password" name="password" placeholder="访问密码" autocomplete="current-password" autofocus>'
      + confirmField
      + '<button class="btn" type="submit">' + (mode === 'setup' ? '设置并进入' : '进入工作台') + '</button>'
      + '</form>';
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>'
    + '*{box-sizing:border-box}html,body{margin:0;height:100%}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#0B1120;color:#F1F5F9;display:flex;align-items:center;justify-content:center;padding:20px;}'
    + '.box{width:min(380px,100%);background:#111827;border:1px solid #334155;border-radius:16px;padding:26px 22px;box-shadow:0 20px 50px rgba(0,0,0,.4)}'
    + '.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,#F59E0B,#FBBF24);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:14px}'
    + 'h1{font-size:19px;margin:0 0 6px}.hint{font-size:13px;color:#94A3B8;line-height:1.6;margin-bottom:18px}'
    + 'form{display:flex;flex-direction:column;gap:12px}'
    + '.inp{width:100%;padding:12px 13px;border-radius:11px;border:1px solid #334155;background:#0F172A;color:#F1F5F9;font-size:15px;outline:none}'
    + '.inp:focus{border-color:#F59E0B}'
    + '.btn{width:100%;padding:12px;border-radius:11px;border:0;background:linear-gradient(135deg,#F59E0B,#F97316);color:#1a1206;font-size:15px;font-weight:700;cursor:pointer}'
    + '.err{color:#F87171;font-size:13px;margin-bottom:4px}'
    + '</style></head><body><div class="box">'
    + '<div class="logo">🐾</div>'
    + '<h1>' + title + '</h1><div class="hint">' + hint + '</div>'
    + errHtml + formHtml
    + '</div></body></html>';
}

function serveLogin(req, res) {
  var q = url.parse(req.url, true).query;
  var next = (q && typeof q.next === 'string' && q.next) ? q.next : (_isMobileUA(req) ? '/手机工作台.html' : '/工作台.html');
  if (req.method === 'GET') {
    var mode = _noPwSet() ? (_isLocalHost(req) ? 'setup' : 'locked') : 'login';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(_loginPage(mode, next, ''));
    return;
  }
  if (req.method === 'POST') {
    var chunks = [], size = 0, MAX = 8192;
    req.on('data', function (c) { size += c.length; chunks.push(c); if (size > MAX) req.destroy(); });
    req.on('end', function () {
      if (size > MAX) { res.writeHead(413); res.end(''); return; }
      var raw = Buffer.concat(chunks).toString('utf8');
      var body = {};
      try { body = JSON.parse(raw); } catch (e) { try { body = Object.fromEntries(new URLSearchParams(raw)); } catch (e2) { body = {}; } }
      var pw = (body && typeof body.password === 'string') ? body.password : '';
      var confirm = (body && typeof body.confirm === 'string') ? body.confirm : '';
      next = (body && typeof body.next === 'string' && /^\//.test(body.next)) ? body.next : '/工作台.html';
      if (_noPwSet()) {
        if (!_isLocalHost(req)) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(_loginPage('locked', next, '请先在电脑端设置密码')); return; }
        if (pw.length < 4) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(_loginPage('setup', next, '密码至少 4 位')); return; }
        if (pw !== confirm) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(_loginPage('setup', next, '两次输入不一致')); return; }
        _writeToken(_tokenOf(pw));
        _setTokenCookie(res);
        res.writeHead(302, { 'Location': encodeURI(next) }); res.end(); return;
      }
      if (_tokenOf(pw) !== _readToken()) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(_loginPage('login', next, '密码错误')); return; }
      _setTokenCookie(res);
      res.writeHead(302, { 'Location': encodeURI(next) }); res.end(); return;
    });
    req.on('error', function () { res.writeHead(400); res.end(''); });
    return;
  }
  res.writeHead(405); res.end('');
}

var server = http.createServer(function (req, res) {
  setRestrictedCORS(res, req);
  var pathname = url.parse(req.url).pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* 登录 / 登出：本机与远程均可访问（首次设密须在本机 /login） */
  if (pathname === '/login') { serveLogin(req, res); return; }
  if (pathname === '/logout') { res.setHeader('Set-Cookie', 'wb_token=; Path=/; Max-Age=0'); res.writeHead(302, { 'Location': '/login' }); res.end(); return; }

  /* 鉴权网关：本机(127.0.0.1/localhost)免密；手机经隧道等外部来源必须登录 */
  if (!_isLocalHost(req)) {
    var _public = (pathname === '/favicon.ico' || pathname === '/__wb');
    if (!_public && !_authOK(req)) {
      if (/^\/(api|px|news)(\/|$)/.test(pathname)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized', login: '/login' }));
        return;
      }
      res.writeHead(302, { 'Location': '/login?next=' + encodeURIComponent(req.url) });
      res.end();
      return;
    }
  }

  /* 浏览器会自动请求 /favicon.ico，这里直接返回 204 避免控制台 404 噪音 */
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Content-Type': 'image/x-icon' });
    res.end();
    return;
  }

  /* 代理能力标记：工作台页面据此判断当前是否运行在「专用本地服务(wb-server)」下。
     其它 localhost（如 IDE 内置预览）没有这个接口，会被正确排除。 */
  if (pathname === '/__wb') {
    setRestrictedCORS(res, req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ server: 'workbench', proxy: true, ok: true }));
    return;
  }

  /* 每日实时热点：服务端代理 AI Hot 匿名 API（绕开 CORS + 缓存容错） */
  if (pathname === '/news') {
    serveNews(req, res);
    return;
  }

  /* 数据备份：服务端落盘到 DATA_DIR（可指向 D:/E: 任意盘），突破浏览器 5MB 上限 */
  if (pathname === '/api/backup') {
    serveBackup(req, res);
    return;
  }

  /* 离线 OCR：用 Windows 自带引擎识别截图里的文字，不联网、不需要 API Key */
  if (pathname === '/api/ocr') {
    serveOcr(req, res);
    return;
  }

  /* 数据存储位置配置（界面「设置 → 数据存储位置」写入，实时生效无需重启） */
  if (pathname === '/api/config') {
    serveConfig(req, res);
    return;
  }

  /* 千牛聊天记录导入/读取（由浏览器扩展 POST 到本机） */
  if (pathname === '/api/qianniu-chat') {
    serveQianniuChat(req, res);
    return;
  }

  if (pathname === '/api/qianniu-chat/remove-store') {
    serveQianniuRemoveStore('qchat', req, res);
    return;
  }

  /* 待办数量（桌面悬浮球轮询用，只读：今日 / 进行中 / 逾期） */
  /* ★★ 变更推送（SSE）——独立悬浮球窗口订阅它做实时同步，无需轮询 */
  if (pathname === '/api/events') {
    _sseHandler(req, res);
    return;
  }

  if (pathname === '/api/todo-count') {
    serveTodoCount(req, res);
    return;
  }

  /* 待办明细（悬浮球「单击展开」卡片用，只读） */
  if (pathname === '/api/todo-mini') {
    serveTodoMini(req, res);
    return;
  }

  /* 首页汇总：待处理数字 + 数据新鲜度 + 经营速览（只读，一次算好） */
  if (pathname === '/api/overview') {
    serveOverview(req, res);
    return;
  }

  /* 千牛SKU导出导入/读取（由浏览器扩展 POST 到本机） */
  if (pathname === '/api/qianniu-sku') {
    serveQianniuSku(req, res);
    return;
  }

  if (pathname === '/api/qianniu-sku/remove-store') {
    serveQianniuRemoveStore('sku', req, res);
    return;
  }

  /* 千牛商品导出导入/读取（由浏览器扩展 POST 到本机） */
  if (pathname === '/api/qianniu-product') {
    serveQianniuProduct(req, res);
    return;
  }

  /* 千牛商品导出 → 直接写入店铺分析「店铺商品总览」（合并进 store_analytics_data） */
  if (pathname === '/api/qianniu-product-import') {
    serveQianniuProductImport(req, res);
    return;
  }

  /* 读取店铺数据（SKU 明细页消费 stores[].items[].supplier/onlinePurchase/... 等手输字段） */
  if (pathname === '/api/store') {
    serveStoreData(req, res);
    return;
  }

  /* 千牛评价导出导入/读取（由浏览器扩展 POST 到本机） */
  if (pathname === '/api/qianniu-review') {
    serveQianniuReview(req, res);
    return;
  }

  /* 删除某店铺的全部评价（评价管理页「删除店铺」按钮调用） */
  if (pathname === '/api/qianniu-review/remove-store') {
    serveQianniuRemoveStore('review', req, res);
    return;
  }

  /* 千牛「问大家」导出导入/读取（由浏览器扩展 POST 到本机） */
  if (pathname === '/api/qianniu-ask') {
    serveQianniuAsk(req, res);
    return;
  }

  /* 删除某店铺的全部问大家记录 */
  if (pathname === '/api/qianniu-ask/remove-store') {
    serveQianniuRemoveStore('ask', req, res);
    return;
  }

  /* 商品详情页信息采集（竞品分析，由浏览器扩展 v1.2.33+ POST 导入） */
  if (pathname === '/api/qianniu-item-collect') {
    serveQianniuItemCollect(req, res);
    return;
  }

  /* 删除某店铺的全部详情页采集记录 */
  if (pathname === '/api/qianniu-item-collect/remove-store') {
    serveQianniuRemoveStore('itemcollect', req, res);
    return;
  }

  /* 自动导入文件夹：列表 / 读取 / 标记完成 */
  if (pathname === '/api/auto-import/list') {
    serveAutoImportList(req, res);
    return;
  }
  if (pathname === '/api/auto-import/file') {
    serveAutoImportFile(req, res);
    return;
  }
  if (pathname === '/api/auto-import/done') {
    serveAutoImportDone(req, res);
    return;
  }

  /* 通用代理入口：/px/<proto>/<host>/<剩余路径> */
  if (pathname.indexOf('/px/') === 0) {
    var rest = pathname.slice(4);
    var slash1 = rest.indexOf('/');
    if (slash1 < 0) { res.writeHead(400); res.end('bad proxy path'); return; }
    var proto = rest.slice(0, slash1);
    var rest2 = rest.slice(slash1 + 1);
    var slash2 = rest2.indexOf('/');
    var host = slash2 < 0 ? rest2 : rest2.slice(0, slash2);
    var upPath = slash2 < 0 ? '/' : rest2.slice(slash2);
    forward(req, res, proto === 'http' ? 'http' : 'https', host, upPath);
    return;
  }

  /* 兼容旧版配置：/api/paas/v4/... 直接映射到智谱（仍受 checkTarget 约束） */
  if (pathname.indexOf('/api/paas/v4') === 0) {
    forward(req, res, 'https', 'open.bigmodel.cn', pathname);
    return;
  }

  serveStatic(req, res, url.parse(req.url).pathname);
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，可能已有一个工作台服务在运行。');
    console.error('请先关闭旧的黑窗口，或直接访问 http://127.0.0.1:' + PORT + '/工作台.html');
  } else {
    console.error('服务启动失败：' + err.message);
  }
  process.exit(1);
});

/* 仅监听本机回环，避免暴露到局域网 */
server.listen(PORT, '127.0.0.1', function () {
  console.log('');
  console.log('  运营工作台已启动（仅本机 127.0.0.1，安全模式）');
  console.log('  数据存储目录: ' + DATA_DIR + '  (可在「工作台 → 设置 → 数据存储位置」界面改存任意盘)');
  console.log('  请在浏览器访问： http://127.0.0.1:' + PORT + '/工作台.html');
  console.log('');
  console.log('  AI 功能已自动就绪，设置里的 Base URL 保持服务商官方地址即可。');
  console.log('  使用期间请勿关闭本窗口；用完直接关掉即可。');
  console.log('');
});
