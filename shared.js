/* shared.js - 内容脚本与后台共用的工具函数（原图链接推导等） */
(function (root) {
  'use strict';

  // pbs.twimg.com 媒体图 ID
  var MEDIA_RE = /pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/i;

  function mediaIdOf(url) {
    var m = MEDIA_RE.exec(String(url || ''));
    return m ? m[1] : null;
  }

  // 从缩略图链接推断原始格式（jpg/png/webp/...）
  function formatOf(url) {
    try {
      var u = new URL(String(url || ''), 'https://x.com');
      var fmt = u.searchParams.get('format');
      if (!fmt) {
        // 先去掉旧式尺寸后缀（ID.jpg:small / ID.jpg:orig），再取扩展名
        var path = u.pathname.replace(/:[a-z0-9]+$/i, '');
        var m = /\.(jpe?g|png|webp|gif|avif)$/i.exec(path);
        if (m) fmt = m[1];
      }
      return fmt ? fmt.toLowerCase().replace('jpeg', 'jpg') : null;
    } catch (e) {
      return null;
    }
  }

  /* 缩略图链接 -> 原图候选地址（按优先级排列，运行时用 HEAD 探测选最优）
   * 实测规则（2026-11 用真实媒体 ID 逐条 GET 验证）：
   *   ID.{fmt}?name=orig         = 上传原图（2221x4096 / 795KB）
   *   ID?format={fmt}&name=orig  = 同上
   *   ID.{fmt}:orig              = 同上（旧式）
   *   ID?name=orig（无 format）   = 404，不可用，已从候选剔除
   *   name=large                 = 2048px 中档图，仅作兜底
   */
  function originalCandidates(url) {
    var id = mediaIdOf(url);
    if (!id) return [];
    var fmt = formatOf(url);
    var base = 'https://pbs.twimg.com/media/' + id;
    var cands = [];
    if (fmt) {
      cands.push(base + '.' + fmt + '?name=orig');
      cands.push(base + '?format=' + fmt + '&name=orig');
      cands.push(base + '.' + fmt + ':orig');
    }
    if (!fmt || fmt !== 'jpg') cands.push(base + '?format=jpg&name=orig');
    if (fmt) {
      cands.push(base + '.' + fmt + '?name=large');
      cands.push(base + '?format=' + fmt + '&name=large');
    } else {
      cands.push(base + '?name=large');
    }
    // 去重
    return cands.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  function sanitize(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function buildName(pattern, vars) {
    vars = vars || {};
    return String(pattern || '{user}_{id}')
      .replace(/\{user\}/g, vars.user || '')
      .replace(/\{id\}/g, vars.id || '')
      .replace(/\{index\}/g, String(vars.index || 0).padStart(4, '0'));
  }

  var EXT_BY_CT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif'
  };

  function extOf(ct, url) {
    var key = String(ct || '').toLowerCase().split(';')[0].trim();
    if (EXT_BY_CT[key]) return EXT_BY_CT[key];
    return formatOf(url) || 'jpg';
  }

  root.XMD = {
    MEDIA_RE: MEDIA_RE,
    mediaIdOf: mediaIdOf,
    formatOf: formatOf,
    originalCandidates: originalCandidates,
    sanitize: sanitize,
    buildName: buildName,
    extOf: extOf,
    EXT_BY_CT: EXT_BY_CT
  };
})(typeof self !== 'undefined' ? self : window);
