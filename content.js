/* content.js - X 媒体原图抓取器 · 内容脚本
 * 负责：扫描页面 DOM 收集 pbs.twimg.com 媒体图；自动滚动加载；通过端口回传清单
 */
(function () {
  'use strict';

  // 重复注入时只重连端口
  if (window.__XMD_LOADED__) {
    if (window.__XMD_RECONNECT__) window.__XMD_RECONNECT__();
    return;
  }
  window.__XMD_LOADED__ = true;

  var XMD = (typeof self !== 'undefined' ? self : window).XMD;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------------- 端口通信 ---------------- */
  function ensurePort() {
    if (window.__XMD_PORT__) return window.__XMD_PORT__;
    try {
      var port = chrome.runtime.connect({ name: 'xmd-cs' });
      window.__XMD_PORT__ = port;
      port.onDisconnect.addListener(function () { window.__XMD_PORT__ = null; });
      port.onMessage.addListener(onPortMessage);
      return port;
    } catch (e) {
      window.__XMD_PORT__ = null;
      return null;
    }
  }

  function post(msg) {
    var p = ensurePort();
    if (p) { try { p.postMessage(msg); } catch (e) { /* 扩展重载等情况 */ } }
  }

  async function onPortMessage(msg) {
    if (!msg || !msg.cmd) return;
    var reply = function (data) { post(Object.assign({ reqId: msg.reqId }, data)); };
    try {
      if (msg.cmd === 'ping') {
        reply({ ok: true });
      } else if (msg.cmd === 'scan') {
        reply({ ok: true, user: currentUser(), url: location.href, total: pageTotal(), images: collect() });
      } else if (msg.cmd === 'autoscroll') {
        var images = await autoScroll();
        reply({ ok: true, user: currentUser(), url: location.href, total: pageTotal(), images: images });
      }
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  }

  /* ---------------- DOM 扫描 ---------------- */
  function currentUser() {
    var seg = location.pathname.split('/').filter(Boolean);
    return seg[0] || 'x';
  }

  function collect() {
    var map = new Map();
    var add = function (raw) {
      if (!raw) return;
      var url = String(raw).trim();
      if (!/^https?:\/\//i.test(url)) return;
      var id = XMD.mediaIdOf(url);
      if (!id || map.has(id)) return;
      map.set(id, { id: id, thumb: url, origs: XMD.originalCandidates(url) });
    };

    document.querySelectorAll('img').forEach(function (img) {
      add(img.currentSrc);
      add(img.getAttribute('src'));
      var ss = img.getAttribute('srcset');
      if (ss) {
        ss.split(',').forEach(function (part) { add(part.trim().split(/\s+/)[0]); });
      }
    });
    document.querySelectorAll('video[poster]').forEach(function (v) { add(v.getAttribute('poster')); });
    document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[name="twitter:image:src"]')
      .forEach(function (m) { add(m.getAttribute('content')); });

    return Array.from(map.values());
  }

  /* 页面标题行的媒体总数（如“47 照片和视频”），用于核对收集是否齐全 */
  function pageTotal() {
    try {
      var MEDIA_WORDS = /照片和视频|照片與影片|图片和视频|photos?\s*(and|&)\s*videos?|写真と動画|사진 및 동영상|фото|foto/i;
      var els = document.querySelectorAll('div,span');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim();
        if (t.length > 30) continue;
        var m = /^([\d,]+)\s*(\S+)/.exec(t);
        if (!m) continue;
        if (!MEDIA_WORDS.test(t.slice(m[0].length - m[2].length))) continue;
        var n = parseInt(m[1].replace(/,/g, ''), 10);
        if (n > 0) return n;
      }
    } catch (e) { /* 解析失败不影响主流程 */ }
    return 0;
  }

  /* ---------------- 自动滚动加载 ----------------
   * 策略：小步逐屏滚动，每屏等待 3 秒（慢速让懒加载从容触发）；
   * 到底后上下抖动重新触发加载观察器并给足网络等待；
   * 连续 8 轮（约 40 秒）无新增才判定真正到底；
   * 过程中持续累积 seen 清单，DOM 回收节点也不丢 ID。
   */
  async function autoScroll() {
    var seen = new Map();
    var snapshot = function () {
      collect().forEach(function (im) { seen.set(im.id, im); });
      return seen.size;
    };
    var se = document.scrollingElement || document.documentElement;
    var bottomStable = 0, rounds = 0, t0 = Date.now();
    var last = snapshot();
    var total = pageTotal();
    post({ evt: 'progress', count: last, rounds: 0, total: total, note: '开始滚动…' });

    while (rounds < 800 && Date.now() - t0 < 10 * 60 * 1000) {
      window.scrollBy(0, Math.max(400, Math.round(window.innerHeight * 0.8)));
      await sleep(3000);
      rounds++;
      var n = snapshot();
      var atBottom = (window.innerHeight + window.scrollY) >= (se.scrollHeight - 16);

      if (n > last) {
        last = n;
        bottomStable = 0;
        post({ evt: 'progress', count: n, rounds: rounds, total: total, note: '继续滚动…' });
        continue;
      }
      if (!atBottom) {
        post({ evt: 'progress', count: n, rounds: rounds, total: total, note: '滚动中…' });
        continue;
      }

      // 到底：上移再回底（重新触发懒加载观察器），并等待网络渲染
      window.scrollBy(0, -Math.round(window.innerHeight * 0.6));
      await sleep(800);
      window.scrollTo(0, se.scrollHeight);
      await sleep(1500);
      rounds++;
      var n2 = snapshot();
      if (n2 > last) {
        last = n2;
        bottomStable = 0;
        post({ evt: 'progress', count: n2, rounds: rounds, note: '加载到新图，继续…' });
        continue;
      }
      bottomStable++;
      var need = (total > 0 && n2 >= total) ? 2 : 8;
      post({
        evt: 'progress', count: n2, rounds: rounds, total: total,
        note: '到底部，等待加载（' + bottomStable + '/' + need + '）' + (total > 0 ? '，已收集 ' + n2 + '/' + total : '')
      });
      if (bottomStable >= need) break;
    }
    snapshot();
    post({ evt: 'progress', count: seen.size, rounds: rounds, total: total, note: '滚动结束' });
    return Array.from(seen.values());
  }

  window.__XMD_RECONNECT__ = ensurePort;
  ensurePort();
})();
