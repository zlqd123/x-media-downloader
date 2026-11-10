/* background.js - X 媒体原图抓取器 · 后台服务
 * 职责：popup <-> content 消息中转；探测原图地址（HEAD 比大小取最优）；批量下载
 */
importScripts('shared.js');
var XMD = self.XMD;

var contentPorts = new Map(); // tabId -> content port
var uiPorts = new Set();      // popup 端口
var reqSeq = 0;
var reqWaiters = new Map();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function broadcast(msg) {
  uiPorts.forEach(function (p) {
    try { p.postMessage(msg); } catch (e) { /* popup 已关闭 */ }
  });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'xmd-ui') {
    uiPorts.add(port);
    port.onDisconnect.addListener(function () { uiPorts.delete(port); });
    port.onMessage.addListener(function (msg) {
      handleUi(msg).catch(function (e) {
        broadcast({ evt: 'error', text: String(e && e.message || e) });
      });
    });
  } else if (port.name === 'xmd-cs') {
    var tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (tabId == null) return;
    contentPorts.set(tabId, port);
    port.onDisconnect.addListener(function () {
      if (contentPorts.get(tabId) === port) contentPorts.delete(tabId);
    });
    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.reqId && reqWaiters.has(msg.reqId)) {
        var w = reqWaiters.get(msg.reqId);
        reqWaiters.delete(msg.reqId);
        w.resolve(msg);
      } else if (msg.evt) {
        broadcast(Object.assign({ tabId: tabId }, msg));
      }
    });
  }
});

/* ---------------- 与内容脚本通信 ---------------- */
async function ensureContent(tabId) {
  if (contentPorts.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['shared.js', 'content.js'] });
  } catch (e) {
    throw new Error('无法注入内容脚本（请确认是 x.com / twitter.com 页面）：' + e.message);
  }
  for (var i = 0; i < 30 && !contentPorts.has(tabId); i++) await sleep(100);
  if (!contentPorts.has(tabId)) throw new Error('内容脚本未连接，请刷新页面后重试');
}

function callContent(tabId, cmd, payload) {
  var port = contentPorts.get(tabId);
  if (!port) return Promise.reject(new Error('内容脚本未连接'));
  var reqId = ++reqSeq;
  return new Promise(function (resolve, reject) {
    reqWaiters.set(reqId, { resolve: resolve, reject: reject });
    try {
      port.postMessage({ reqId: reqId, cmd: cmd, payload: payload || {} });
    } catch (e) {
      reqWaiters.delete(reqId);
      reject(e);
      return;
    }
    setTimeout(function () {
      if (reqWaiters.has(reqId)) {
        reqWaiters.delete(reqId);
        reject(new Error('内容脚本响应超时'));
      }
    }, 240000);
  });
}

/* ---------------- UI 命令 ---------------- */
async function handleUi(msg) {
  if (!msg || !msg.type) return;
  var tabId = msg.tabId;
  if (msg.type === 'scan') {
    await ensureContent(tabId);
    var res = await callContent(tabId, 'scan');
    broadcast({ evt: 'scan-result', tabId: tabId, user: res.user, url: res.url, total: res.total || 0, images: res.images || [] });
  } else if (msg.type === 'autoscroll') {
    await ensureContent(tabId);
    var res2 = await callContent(tabId, 'autoscroll');
    broadcast({ evt: 'scan-result', tabId: tabId, user: res2.user, url: res2.url, total: res2.total || 0, images: res2.images || [] });
  } else if (msg.type === 'download') {
    await doDownload(tabId, msg.options || {});
  }
}

/* ---------------- 原图探测 + 下载 ---------------- */
function probeBest(cands) {
  var best = null;
  var jobs = cands.map(function (url) {
    return fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return null;
        var ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
        if (ct.indexOf('image/') !== 0) return null;
        return { url: url, ct: ct, len: Number(r.headers.get('content-length') || 0) };
      })
      .catch(function () { return null; });
  });
  return Promise.all(jobs).then(function (items) {
    items.forEach(function (it) {
      if (!it) return;
      if (!best || it.len > best.len) best = it;
    });
    return best;
  });
}

function downloadOne(url, filename) {
  return new Promise(function (resolve) {
    chrome.downloads.download(
      { url: url, filename: filename, conflictAction: 'uniquify', saveAs: false },
      function (id) {
        if (chrome.runtime.lastError || !id) resolve(false);
        else resolve(true);
      }
    );
  });
}

async function runPool(items, limit, worker) {
  var queue = items.slice();
  async function runner() {
    while (queue.length) {
      var it = queue.shift();
      try { await worker(it); } catch (e) { /* 单个失败不影响整体 */ }
    }
  }
  var n = Math.max(1, Math.min(limit, items.length || 1));
  var ps = [];
  for (var i = 0; i < n; i++) ps.push(runner());
  await Promise.all(ps);
}

async function doDownload(tabId, options) {
  var dirPrefix = XMD.sanitize(options.dirPrefix || '');   // 留空 = 不套总文件夹
  var namePattern = options.namePattern || '{user}_{id}';
  var concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 3));
  var skipDownloaded = options.skipDownloaded !== false;
  var useUserDir = options.userDir !== false;               // 作者子文件夹可选

  // 现场扫描拿用户与最新清单（含原图候选），与 popup 传来的清单按 id 合并
  await ensureContent(tabId);
  var scan = await callContent(tabId, 'scan');
  var user = XMD.sanitize(scan.user || options.user || 'x');
  var byId = new Map();
  (scan.images || []).forEach(function (im) { byId.set(im.id, im); });
  (options.images || []).forEach(function (im) { if (im && im.id && !byId.has(im.id)) byId.set(im.id, im); });
  var images = Array.from(byId.values());
  if (!images.length) {
    broadcast({ evt: 'log', text: '没有发现图片，请先在媒体页点击“滚动加载全部”' });
    broadcast({ evt: 'dl-done', ok: 0, skip: 0, fail: 0 });
    return;
  }

  var histObj = (await chrome.storage.local.get('downloaded')).downloaded || {};
  var targets = [];
  var preSkip = 0;
  images.forEach(function (im, i) {
    if (skipDownloaded && histObj[im.id]) preSkip++;
    else targets.push({ img: im, index: i + 1 });
  });

  var done = 0, ok = 0, skip = preSkip, fail = 0;
  var total = targets.length + preSkip;
  broadcast({ evt: 'dl-start', total: total, skip: preSkip, user: user });
  if (preSkip) broadcast({ evt: 'log', text: '跳过已下载 ' + preSkip + ' 张' });

  await runPool(targets, concurrency, async function (t) {
    var im = t.img;
    var cands = (im.origs && im.origs.length) ? im.origs : XMD.originalCandidates(im.thumb);
    var best = await probeBest(cands);
    if (!best) {
      fail++;
      done++;
      broadcast({ evt: 'dl-progress', done: done, total: total, ok: ok, skip: skip, fail: fail, id: im.id, status: 'fail', note: '原图探测失败' });
      return;
    }
    var ext = XMD.extOf(best.ct, best.url);
    var base = XMD.buildName(namePattern, { user: user, id: im.id, index: t.index });
    var pathParts = [];
    if (dirPrefix) pathParts.push(dirPrefix);
    if (useUserDir) pathParts.push(user);
    pathParts.push(XMD.sanitize(base) + '.' + ext);
    var filename = pathParts.join('/');
    var ok1 = await downloadOne(best.url, filename);
    if (ok1) {
      ok++;
      histObj[im.id] = { t: Date.now(), file: filename };
      chrome.storage.local.set({ downloaded: histObj });
    } else {
      fail++;
    }
    done++;
    broadcast({
      evt: 'dl-progress', done: done, total: total, ok: ok, skip: skip, fail: fail,
      id: im.id, status: ok1 ? 'ok' : 'fail', filename: ok1 ? filename : '', src: best.url
    });
  });

  if (ok > 0) {
    try {
      var lds = (await chrome.storage.local.get('lastDl')).lastDl || {};
      lds[user] = Date.now();
      chrome.storage.local.set({ lastDl: lds });
    } catch (e) { /* 记录失败不影响下载结果 */ }
  }
  broadcast({ evt: 'dl-done', ok: ok, skip: skip, fail: fail });
  broadcast({ evt: 'log', text: '下载完成：成功 ' + ok + '，跳过 ' + skip + '，失败 ' + fail });
}
