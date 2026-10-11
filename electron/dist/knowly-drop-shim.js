/*!
 * Knowly 重建版 · 对话窗口拖拽附件桥接（knowly-drop-shim）
 *
 * 原版渲染层仅在百宝箱图像工具页有 drop 处理，聊天输入框无此能力。
 * 本脚本在不修改 bundle.js 的前提下注入：
 *   1. 拖拽文件到对话窗口 → 取本地路径（webUtils.getPathForFile）→ 渲染「指定文件」附件条
 *   2. fetch 包装：发送消息时把附件路径合并进 /qa/chat/stream、/qa/task/executions、
 *      /qa/task/stream 请求体的 selected_files（与渲染层「附件」按钮产生的字符串数组同构）
 *   3. 拖拽悬浮提示与附件条 UI（antd 风格，可单个移除）
 * 百宝箱等页面自身的 drop 处理会 preventDefault，本脚本检测 defaultPrevented 后自动让位。
 */
(function () {
  'use strict';
  if (window.__knowlyDropShim) return;

  var MAX_FILES = 20;
  var files = []; // 路径字符串

  var bar = null;
  var overlay = null;
  var overlayTimer = null;

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'knowly-drop-bar';
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:150px;z-index:2147483000;'
      + 'display:none;align-items:center;flex-wrap:wrap;gap:6px;max-width:70vw;padding:8px 12px;'
      + 'background:#fff;border:1px solid #d9d9d9;border-radius:10px;'
      + 'box-shadow:0 6px 16px rgba(0,0,0,.12);font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;';
    var label = document.createElement('span');
    label.textContent = '指定文件：';
    label.style.cssText = 'color:#666;white-space:nowrap;';
    bar.appendChild(label);
    document.body.appendChild(bar);
    return bar;
  }

  function fileName(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function renderChips() {
    if (!files.length) {
      if (bar) bar.style.display = 'none';
      return;
    }
    var b = ensureBar();
    while (b.childNodes.length > 1) b.removeChild(b.lastChild);
    files.forEach(function (p, idx) {
      var chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;'
        + 'background:#f0f5ff;border:1px solid #adc6ff;border-radius:6px;color:#2f54eb;max-width:260px;';
      var name = document.createElement('span');
      name.textContent = fileName(p);
      name.title = p;
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      var del = document.createElement('span');
      del.textContent = '×';
      del.title = '移除 ' + fileName(p);
      del.style.cssText = 'cursor:pointer;color:#999;font-weight:bold;padding:0 2px;';
      del.onclick = function () {
        files.splice(idx, 1);
        renderChips();
      };
      chip.appendChild(name);
      chip.appendChild(del);
      b.appendChild(chip);
    });
    b.style.display = 'flex';
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'knowly-drop-overlay';
    overlay.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:170px;z-index:2147483001;'
      + 'display:none;padding:10px 22px;border-radius:12px;background:rgba(74,143,247,.92);color:#fff;'
      + 'font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:none;'
      + 'box-shadow:0 8px 20px rgba(74,143,247,.35);';
    overlay.textContent = '松开鼠标，将文件添加为对话附件';
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay() {
    clearTimeout(overlayTimer);
    ensureOverlay().style.display = 'block';
    overlayTimer = setTimeout(hideOverlay, 1500);
  }
  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function hasChatComposer() {
    return Boolean(document.querySelector('textarea'));
  }

  function isFileDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function pathForFile(file) {
    try {
      if (window.electronAPI && typeof window.electronAPI.getPathForFile === 'function') {
        return window.electronAPI.getPathForFile(file) || '';
      }
    } catch (e) { /* 非 Electron 环境 */ }
    return '';
  }

  function addPaths(paths) {
    var seen = {};
    files.forEach(function (p) { seen[p] = true; });
    var added = 0;
    for (var i = 0; i < paths.length && files.length < MAX_FILES; i += 1) {
      var p = paths[i];
      if (!p || seen[p]) continue;
      seen[p] = true;
      files.push(p);
      added += 1;
    }
    renderChips();
    return added;
  }

  // 拖拽悬浮提示（dragover 需持续刷新）
  document.addEventListener('dragover', function (e) {
    if (!isFileDrag(e) || !hasChatComposer()) return;
    e.preventDefault(); // 允许 drop
    showOverlay();
  }, false);

  document.addEventListener('dragleave', function (e) {
    if (!isFileDrag(e)) return;
    hideOverlay();
  }, false);

  document.addEventListener('drop', function (e) {
    hideOverlay();
    // 百宝箱等页面自身的 drop 处理（React 已 preventDefault）→ 让位
    if (e.defaultPrevented) return;
    if (!isFileDrag(e) || !hasChatComposer()) return;
    e.preventDefault();
    e.stopPropagation();
    var dropped = Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || []);
    var paths = dropped.map(pathForFile).filter(Boolean);
    if (!paths.length) {
      window.__knowlyDropShim.toast('无法获取拖入文件的本地路径（仅支持本机文件）');
      return;
    }
    var added = addPaths(paths);
    window.__knowlyDropShim.toast(added ? '已添加 ' + added + ' 个附件，发送消息时自动附带' : '附件已达上限（' + MAX_FILES + ' 个）或重复');
  }, false);

  // fetch 包装：发送时合并 selected_files
  var TARGETS = ['/qa/chat/stream', '/qa/task/executions', '/qa/task/stream'];
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isTarget = TARGETS.some(function (t) { return url.indexOf(t) !== -1; });
      var body = init && typeof init.body === 'string' && init.body.charAt(0) === '{' ? init.body : null;
      if (isTarget && body && files.length) {
        var payload = JSON.parse(body);
        if (payload && typeof payload === 'object') {
          var existing = Array.isArray(payload.selected_files) ? payload.selected_files : [];
          var merged = existing.slice();
          files.forEach(function (p) {
            if (merged.indexOf(p) === -1) merged.push(p);
          });
          payload.selected_files = merged.slice(0, MAX_FILES);
          init = Object.assign({}, init, { body: JSON.stringify(payload) });
          files = [];
          renderChips();
        }
      }
    } catch (e) { /* 不影响原请求 */ }
    return originalFetch.call(this, input, init);
  };

  // 通知 toast（antd message 若不可用则用轻量实现）
  function toast(msg) {
    try {
      var host = document.querySelector('.ant-message');
      if (host && window.__knowlyDropShim.useAntd) { /* antd message 内部 API 不可稳定调用，统一用自绘 */ }
    } catch (e) { /* ignore */ }
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:24px;z-index:2147483002;'
      + 'padding:8px 16px;border-radius:8px;background:#fff;border:1px solid #d9d9d9;'
      + 'box-shadow:0 6px 16px rgba(0,0,0,.12);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  // 供测试与高级用法：手动添加附件路径
  window.__knowlyDropShim = {
    version: '1.0.0',
    add: function (paths) { return addPaths(Array.isArray(paths) ? paths : [paths]); },
    files: function () { return files.slice(); },
    clear: function () { files = []; renderChips(); },
    toast: toast,
  };
})();
