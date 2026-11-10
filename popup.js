/* popup.js - X 媒体原图抓取器 · 弹窗逻辑 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var DEFAULT_OPTS = {
    dirPrefix: 'x_media',   // 总文件夹；留空 = 不套，直接放下载目录
    namePattern: '{user}_{id}',
    userDir: true,          // 作者子文件夹（按用户名分文件夹）
    skipDownloaded: true,
    concurrency: 3
  };
  var opts = Object.assign({}, DEFAULT_OPTS);

  var state = {
    tabId: null,
    user: '',
    listUser: '',
    images: new Map(),
    hist: {},          // 持久化下载记录：id -> {t, file}
    lastDl: {},        // 各用户上次下载时间：user -> ts（仅针对当前用户显示）
    pageTotal: 0,
    dl: { ok: 0, skip: 0, fail: 0, total: 0 },
    busy: false
  };
  var port = null;

  /* ---------------- 初始化 ---------------- */
  async function init() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0] || null;
    state.tabId = tab ? tab.id : null;
    var isX = !!tab && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(tab.url || '');
    $('ctx').textContent = isX ? (tab.url || '') : '当前标签页不是 x.com / twitter.com，请先打开目标页面';
    if (!isX) enableActions(false);

    port = chrome.runtime.connect({ name: 'xmd-ui' });
    port.onMessage.addListener(onMessage);

    var loc = await chrome.storage.local.get(['downloaded', 'lastImages', 'lastDl']);
    state.hist = loc.downloaded || {};
    state.lastDl = loc.lastDl || {};
    var li = loc.lastImages;
    if (li && li.items && li.items.length) {
      state.listUser = li.user || '';
      li.items.forEach(function (im) { if (im && im.id) state.images.set(im.id, im); });
      renderWho();
      updateCount();
      setStatus('已恢复上次清单 ' + state.images.size + ' 张（ID 持久缓存）');
    }

    var saved = await chrome.storage.sync.get(DEFAULT_OPTS);
    Object.assign(opts, saved);
    $('optDir').value = opts.dirPrefix;
    $('optName').value = opts.namePattern;
    $('optUserDir').checked = opts.userDir !== false;
    $('optSkip').checked = opts.skipDownloaded !== false;
    $('optConc').value = String(opts.concurrency || 3);

    ['optDir', 'optName', 'optUserDir', 'optSkip', 'optConc'].forEach(function (id) {
      $(id).addEventListener('change', saveOptions);
    });

    // 滚动与扫描合一：打开即扫描当前页；按钮滚动加载并全程收集
    $('btnScroll').addEventListener('click', function () {
      setStatus('滚动加载中…（慢速逐屏滚动，图片多时需要几分钟）');
      send({ type: 'autoscroll', tabId: state.tabId });
    });
    $('btnDownload').addEventListener('click', startDownload);
    $('btnExport').addEventListener('click', exportList);
    $('btnExpHist').addEventListener('click', exportHist);
    $('btnImpHist').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      importHistFile(this.files && this.files[0]);
      this.value = '';
    });
    $('btnReset').addEventListener('click', confirmReset);

    if (isX) send({ type: 'scan', tabId: state.tabId }); // 打开即扫描一次
  }

  function saveOptions() {
    opts.dirPrefix = $('optDir').value.trim();      // 允许留空 = 不套总文件夹
    opts.namePattern = $('optName').value;
    opts.userDir = $('optUserDir').checked;
    opts.skipDownloaded = $('optSkip').checked;
    opts.concurrency = Number($('optConc').value) || 3;
    chrome.storage.sync.set(opts);
  }

  function enableActions(on) {
    ['btnScroll', 'btnDownload', 'btnExport'].forEach(function (id) {
      $(id).disabled = !on;
    });
  }

  /* ---------------- 消息 ---------------- */
  function send(msg) {
    try { port.postMessage(msg); } catch (e) { log('发送失败：' + e.message, 'err'); }
  }

  function onMessage(msg) {
    if (!msg || !msg.evt) return;
    switch (msg.evt) {
      case 'scan-result':
        if (state.listUser && msg.user && state.listUser !== msg.user) {
          state.images.clear();
          log('页面用户变化，已清空旧清单');
        }
        if (msg.user) state.listUser = msg.user;
        mergeImages(msg.images || []);
        state.user = msg.user || state.user;
        if (msg.total) state.pageTotal = msg.total;
        renderWho();
        updateCount();
        setStatus('扫描完成，共 ' + state.images.size + ' 张图片（含滚动加载）' + (state.pageTotal ? ' · 页面标称 ' + state.pageTotal + ' 张' : ''));
        log('扫描完成：' + (msg.images || []).length + ' 张');
        crossCheck();
        persistList();
        break;
      case 'progress':
        if (msg.total) state.pageTotal = msg.total;
        var seenNow = Math.max(msg.count || 0, state.images.size);
        updateCount();
        setStatus('滚动加载中…已发现 ' + seenNow + (state.pageTotal ? ' / ' + state.pageTotal : '') + ' 张' + (msg.note ? '（' + msg.note + '）' : ''));
        break;
      case 'dl-start':
        state.busy = true;
        state.dl = { ok: 0, skip: msg.skip || 0, fail: 0, total: msg.total || 0 };
        state.user = msg.user || state.user;
        renderWho();
        setStatus('开始下载原图…（共 ' + (msg.total || 0) + ' 张，跳过 ' + (msg.skip || 0) + '）');
        break;
      case 'dl-progress':
        state.dl = { ok: msg.ok, skip: msg.skip, fail: msg.fail, total: msg.total };
        setBar(msg.done / Math.max(1, msg.total));
        setStatus('下载中 ' + msg.done + '/' + msg.total + ' · 成功 ' + msg.ok + ' 跳过 ' + msg.skip + ' 失败 ' + msg.fail);
        if (msg.status === 'ok') log('✓ ' + (msg.filename || msg.id), 'ok');
        else log('✗ ' + msg.id + (msg.note ? '：' + msg.note : ''), 'err');
        break;
      case 'dl-done':
        state.busy = false;
        setBar(1);
        setStatus('完成：成功 ' + msg.ok + '，跳过 ' + msg.skip + '，失败 ' + msg.fail);
        refreshHist();
        refreshLastDl();
        break;
      case 'log':
        log(msg.text);
        break;
      case 'error':
        log(msg.text, 'err');
        state.busy = false;
        break;
    }
  }

  function mergeImages(list) {
    list.forEach(function (im) {
      if (im && im.id && !state.images.has(im.id)) state.images.set(im.id, im);
    });
    updateCount();
  }

  /* 页面标称总数（如“47 照片和视频”）与已收集数量的核对 */
  function crossCheck() {
    if (!state.pageTotal) return;
    var n = state.images.size, t = state.pageTotal;
    if (n === t) log('✓ 核对一致：已收集 ' + n + ' 张 = 页面标称 ' + t + ' 张', 'ok');
    else if (n < t) log('核对：已收集 ' + n + ' 张 < 页面标称 ' + t + ' 张（标称含视频时不一致属正常，可再点滚动）');
    else log('核对：已收集 ' + n + ' 张 > 页面标称 ' + t + ' 张（正常，页面还含其他配图）', 'ok');
  }

  /* 清单持久化：按 ID 去重后落盘，重开弹窗可恢复 */
  var saveTimer = null;
  function persistList() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      chrome.storage.local.set({
        lastImages: { user: state.listUser, ts: Date.now(), items: Array.from(state.images.values()) }
      });
    }, 500);
  }

  function refreshHist() {
    chrome.storage.local.get('downloaded', function (l) {
      state.hist = l.downloaded || {};
      updateCount();
    });
  }

  function refreshLastDl() {
    chrome.storage.local.get('lastDl', function (l) {
      state.lastDl = l.lastDl || {};
      renderWho();
    });
  }

  /* ---------------- 动作 ---------------- */
  function startDownload() {
    if (state.busy) return;
    saveOptions();
    if (!state.images.size) {
      log('还没有图片，请先点击“① 滚动加载全部”', 'err');
      return;
    }
    state.busy = true;
    setBar(0);
    send({
      type: 'download',
      tabId: state.tabId,
      options: {
        user: state.user,
        images: Array.from(state.images.values()),
        dirPrefix: opts.dirPrefix,
        namePattern: opts.namePattern,
        userDir: opts.userDir,
        skipDownloaded: opts.skipDownloaded,
        concurrency: opts.concurrency
      }
    });
  }

  function exportList() {
    if (!state.images.size) {
      log('还没有图片可导出', 'err');
      return;
    }
    var rows = ['index,media_id,downloaded,thumbnail,original_candidates'];
    Array.from(state.images.values()).forEach(function (im, i) {
      rows.push([i + 1, im.id, state.hist[im.id] ? 1 : 0, '"' + im.thumb + '"', '"' + (im.origs || []).join(' | ') + '"'].join(','));
    });
    var csv = '\ufeff' + rows.join('\r\n');
    var url = 'data:text/csv;base64,' + btoa(unescape(encodeURIComponent(csv)));
    chrome.downloads.download({
      url: url,
      filename: (opts.dirPrefix ? opts.dirPrefix + '/' : '') + (state.user || 'x') + '_links.csv',
      conflictAction: 'uniquify'
    });
    log('已导出链接清单 CSV');
  }

  /* ---------------- 下载记录导入 / 导出（JSON） ---------------- */
  function exportHist() {
    var ids = Object.keys(state.hist);
    if (!ids.length) {
      log('下载记录为空，没有可导出的', 'err');
      return;
    }
    var data = JSON.stringify({
      app: 'x-media-downloader',
      type: 'download-history',
      exported: Date.now(),
      downloaded: state.hist
    }, null, 2);
    var url = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(data)));
    chrome.downloads.download({
      url: url,
      filename: (opts.dirPrefix ? opts.dirPrefix + '/' : '') + 'xmd_download_history.json',
      conflictAction: 'uniquify'
    });
    log('已导出下载记录：' + ids.length + ' 个 ID', 'ok');
  }

  function importHistFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result || ''));
        var inc = (data && typeof data === 'object' && !Array.isArray(data)) ? (data.downloaded || data) : null;
        if (!inc || typeof inc !== 'object' || Array.isArray(inc)) throw new Error('不是有效的下载记录 JSON');
        var merged = Object.assign({}, inc, state.hist); // 已有记录优先，按 ID 合并去重
        var added = Object.keys(inc).filter(function (id) { return !state.hist[id]; }).length;
        state.hist = merged;
        chrome.storage.local.set({ downloaded: merged }, function () {
          updateCount();
          log('导入完成：新增 ' + added + ' 个 ID，合并后共 ' + Object.keys(merged).length + ' 个', 'ok');
        });
      } catch (e) {
        log('导入失败：' + e.message, 'err');
      }
    };
    reader.onerror = function () { log('读取文件失败', 'err'); };
    reader.readAsText(file);
  }

  /* 清空已下载记录：二次确认（3 秒内再点一次才执行） */
  var resetArmed = false, resetTimer = null;
  function confirmReset() {
    if (!resetArmed) {
      resetArmed = true;
      $('btnReset').textContent = '确认清空？再点一次';
      $('btnReset').classList.add('danger');
      resetTimer = setTimeout(function () {
        resetArmed = false;
        $('btnReset').textContent = '清空已下载记录';
        $('btnReset').classList.remove('danger');
      }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetArmed = false;
    $('btnReset').textContent = '清空已下载记录';
    $('btnReset').classList.remove('danger');
    resetHistory();
  }

  function resetHistory() {
    chrome.storage.local.remove('downloaded', function () {
      state.hist = {};
      updateCount();
      log('已清空下载记录，下次下载不会跳过任何图片');
    });
  }

  /* ---------------- 渲染 ---------------- */
  /* 用户行：@用户 · 上次下载 yyyy:mm:dd（仅针对当前用户） */
  function renderWho() {
    var u = state.user || state.listUser;
    if (!u) { $('who').textContent = ''; return; }
    var ts = state.lastDl[u];
    $('who').textContent = '用户：@' + u + (ts ? ' · 上次下载 ' + fmtTime(ts) : ' · 尚未下载');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + ':' + p(d.getMonth() + 1) + ':' + p(d.getDate());
  }

  function updateCount() {
    var done = 0;
    state.images.forEach(function (im) { if (state.hist[im.id]) done++; });
    $('histInfo').textContent = 'ID 持久缓存 ' + Object.keys(state.hist).length + ' 个（已下载）' +
      (done ? ' · 本清单命中 ' + done + ' 张将跳过' : '');
  }

  function setBar(ratio) {
    $('bar').style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  }

  function setStatus(text) { $('status').textContent = text; }

  function log(text, cls) {
    var li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    var ul = $('log');
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 300) ul.removeChild(ul.lastChild);
  }

  init();
})();
