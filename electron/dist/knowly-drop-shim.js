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
    if (!isFileDrag(e)) return;
    if (isKnowledgePage()) { e.preventDefault(); showKnowledgeOverlay(); return; }
    if (!hasChatComposer()) return;
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
    if (!isFileDrag(e)) return;

    // 知识库/本地资料学习页：拖入文件或文件夹 → 添加其目录并开始学习
    if (isKnowledgePage()) {
      e.preventDefault();
      e.stopPropagation();
      var dropped = Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || []);
      var paths = dropped.map(pathForFile).filter(Boolean);
      if (!paths.length) { toast('无法获取拖入项的本地路径（仅支持本机文件）'); return; }
      addKnowledgeFolders(paths);
      return;
    }

    if (!hasChatComposer()) return;
    e.preventDefault();
    e.stopPropagation();
    var dropped2 = Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || []);
    var paths2 = dropped2.map(pathForFile).filter(Boolean);
    if (!paths2.length) {
      toast('无法获取拖入文件的本地路径（仅支持本机文件）');
      return;
    }
    var added = addPaths(paths2);
    toast(added ? '已添加 ' + added + ' 个附件，发送消息时自动附带' : '附件已达上限（' + MAX_FILES + ' 个）或重复');
  }, false);

  // ---- 知识库/本地资料学习页支持 ----
  function isKnowledgePage() {
    if (document.querySelector('.knowly-learning-workspace, .knowly-learning-manager')) return true;
    var text = document.body ? document.body.innerText.slice(0, 1500) : '';
    return /本地资料学习|开始学习|知识库/.test(text) && /添加文件|添加文件夹|添加目录|开始学习/.test(text);
  }

  function showKnowledgeOverlay() {
    clearTimeout(overlayTimer);
    var o = ensureOverlay();
    o.textContent = '松开鼠标，将文件/文件夹添加为学习资料';
    o.style.display = 'block';
    overlayTimer = setTimeout(hideOverlay, 1500);
  }

  /** 拖入的路径：文件取其所在目录，文件夹直接使用；逐个 POST /directories/add 后自动开始学习 */
  function addKnowledgeFolders(paths) {
    var folders = [];
    paths.forEach(function (p) {
      var dir = p;
      var m = p.match(/[\\/]([^\\/]+)$/);
      var name = m ? m[1] : p;
      if (name.indexOf('.') !== -1 && !/^\.+$/.test(name)) {
        dir = p.replace(/[\\/][^\\/]+$/, '');
      }
      if (dir && folders.indexOf(dir) === -1) folders.push(dir);
    });
    if (!folders.length) { toast('未能解析拖入项所在目录'); return; }
    var done = 0;
    var ok = 0;
    folders.forEach(function (dir) {
      fetch('http://localhost:28099/directories/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: dir }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.success) { ok += 1; return fetch('http://localhost:28099/index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: dir }) }); }
      }).catch(function () { /* 单个失败继续 */ }).finally(function () {
        done += 1;
        if (done === folders.length) {
          if (ok) {
            toast('已添加 ' + ok + ' 个目录并开始学习，正在刷新列表…');
            refreshKnowledgePage();
          } else {
            toast('添加失败（目录不可读或后端未启动）');
          }
        }
      });
    });
  }

  /** 温和刷新：切换页面再切回（重新挂载即重拉目录列表），比整页 reload 体验好 */
  function clickNav(text) {
    var els = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function (e) {
      return e.childElementCount === 0 && e.textContent.trim() === text && e.getBoundingClientRect().height > 0;
    });
    var el = els[els.length - 1];
    if (!el) return false;
    var t = el, g = 0;
    while (t && g++ < 8) {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      t = t.parentElement;
    }
    return true;
  }

  function refreshKnowledgePage() {
    setTimeout(function () {
      if (!clickNav('新建会话')) { location.reload(); return; }
      setTimeout(function () {
        if (!clickNav('本地资料学习')) location.reload();
      }, 600);
    }, 1200);
  }

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
    var result = originalFetch.call(this, input, init);
    // 任务创建响应 → 启动思考轮询（把推理过程内联到对话气泡）
    try {
      var url2 = typeof input === 'string' ? input : (input && input.url) || '';
      var method2 = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (/\/qa\/task\/executions$/.test(url2) && method2 === 'POST') {
        return result.then(function (res) {
          try {
            res.clone().json().then(function (j) {
              if (j && j.success && j.execution_id) watchTaskExecution(j.execution_id);
            }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
          return res;
        });
      }
    } catch (e) { /* 不影响原请求 */ }
    return result;
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

  // ==================== 任务模式：思考过程内联展示 ====================
  // 背景：渲染层任务模式的消息不携带 thinkingContent，推理只出现在「查看完整过程」抽屉（隔离面板）。
  // 本模块在任务执行期间轮询后端执行记录，把推理全文以官方同款样式（chat-panel__thinking-block）
  // 注入到最后一条 assistant 气泡内，实现"思考过程在对话框中展示"。
  var taskWatch = { executionId: null, timer: null, thinkingText: '' };

  function ensureThinkingBlock() {
    var bubbles = document.querySelectorAll('.chat-panel__bubble-content');
    if (!bubbles.length) return null;
    var bubble = bubbles[bubbles.length - 1];
    var existing = bubble.querySelector(':scope > .knowly-recon-thinking');
    if (existing) return existing;

    var block = document.createElement('div');
    block.className = 'chat-panel__thinking-block knowly-recon-thinking';
    var header = document.createElement('div');
    header.className = 'chat-panel__thinking-block-header';
    header.style.cursor = 'pointer';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '6px';
    var label = document.createElement('span');
    label.textContent = '深度思考';
    var streaming = document.createElement('span');
    streaming.className = 'chat-panel__thinking-block-streaming';
    streaming.textContent = '思考中…';
    var arrow = document.createElement('span');
    arrow.textContent = '▾';
    arrow.style.marginLeft = 'auto';
    arrow.style.fontSize = '12px';
    header.appendChild(label);
    header.appendChild(streaming);
    header.appendChild(arrow);
    var content = document.createElement('div');
    content.className = 'chat-panel__thinking-block-content';
    content.style.whiteSpace = 'pre-wrap';
    header.addEventListener('click', function () {
      var hidden = content.style.display === 'none';
      content.style.display = hidden ? '' : 'none';
      arrow.textContent = hidden ? '▾' : '▸';
    });
    block.appendChild(header);
    block.appendChild(content);
    bubble.insertBefore(block, bubble.firstChild);
    return block;
  }

  function updateThinkingBlock(text, done) {
    if (!text) return;
    var block = ensureThinkingBlock();
    if (!block) return;
    var content = block.querySelector('.chat-panel__thinking-block-content');
    if (content && content.textContent !== text) content.textContent = text;
    var streaming = block.querySelector('.chat-panel__thinking-block-streaming');
    if (streaming) streaming.style.display = done ? 'none' : '';
  }

  async function pollTaskThinking() {
    var id = taskWatch.executionId;
    if (!id) return;
    try {
      var res = await originalFetch('http://localhost:28099/qa/task/executions/' + encodeURIComponent(id));
      var rec = await res.json();
      var data = rec && rec.data;
      if (!data) return;
      var text = data.thinking || '';
      if (!text) {
        // 兼容：从事件记录拼接推理增量
        for (var i = 0; i < (data.events || []).length; i += 1) {
          var ev = data.events[i];
          if (ev && ev.type === 'reasoning_chunk' && ev.data && ev.data.chunk) text += ev.data.chunk;
        }
      }
      taskWatch.thinkingText = text;
      var done = data.status && data.status !== 'running' && data.status !== 'cancelling';
      updateThinkingBlock(text, done);
      if (done) {
        clearInterval(taskWatch.timer);
        taskWatch.timer = null;
        taskWatch.executionId = null;
      }
    } catch (e) { /* 轮询失败忽略，下次重试 */ }
  }

  function watchTaskExecution(executionId) {
    if (!executionId) return;
    taskWatch.executionId = executionId;
    taskWatch.thinkingText = '';
    if (taskWatch.timer) clearInterval(taskWatch.timer);
    setTimeout(function () { updateThinkingBlock('（思考即将开始…）', false); }, 800);
    taskWatch.timer = setInterval(pollTaskThinking, 1500);
    pollTaskThinking();
  }

  // React 重绘可能冲掉注入块：守护式重注入（有数据时）
  var thinkingGuard = new MutationObserver(function () {
    if (!taskWatch.thinkingText) return;
    var bubbles = document.querySelectorAll('.chat-panel__bubble-content');
    if (bubbles.length && !bubbles[bubbles.length - 1].querySelector(':scope > .knowly-recon-thinking')) {
      updateThinkingBlock(taskWatch.thinkingText, !taskWatch.timer);
    }
  });
  thinkingGuard.observe(document.documentElement, { childList: true, subtree: true });

  // 供测试与高级用法：手动添加附件路径
  window.__knowlyDropShim = {
    version: '1.2.0',
    add: function (paths) { return addPaths(Array.isArray(paths) ? paths : [paths]); },
    addKnowledgeFolders: addKnowledgeFolders,
    watchTaskExecution: watchTaskExecution,
    files: function () { return files.slice(); },
    clear: function () { files = []; renderChips(); },
    toast: toast,
  };
})();
