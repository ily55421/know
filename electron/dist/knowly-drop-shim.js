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
 *
 * 后续在同一注入层内追加（均不修改 bundle）：
 *   4. 任务模式思考过程内联到对话气泡（轮询执行记录 + 守护式重注入）
 *   5. 消息列表默认贴底（粘底策略，不打断用户上翻阅读）
 *   6. 运行参数对话框注入「单次输出上限」（渲染层该字段硬编码缺失，长思考题需要更大预算）
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

  // ==================== 消息列表默认滚动到最新 ====================
  // 用户反馈：进入会话/新消息时应默认停在最下方（最新内容），且不能打断用户上翻阅读。
  // 采用「粘底」策略：默认跟随最新内容；用户主动上翻即停止跟随，回到底部附近自动恢复。
  var STICK_TOL = 60; // 距底部阈值(px)：小于该值视为"仍在底部"
  var scrollCtl = { stick: true, lastList: null };
  function msgListEl() { return document.querySelector('.chat-panel__msg-list'); }
  function nearBottom(el, tol) { return (el.scrollHeight - el.scrollTop - el.clientHeight) <= tol; }
  function scrollToBottom(force) {
    var el = msgListEl();
    if (!el) return;
    if (!force && !scrollCtl.stick) return; // 用户正在上翻阅读 → 不抢滚动条
    el.scrollTop = el.scrollHeight;
  }
  var msgObserver = new MutationObserver(function () {
    var el = msgListEl();
    if (el && el !== scrollCtl.lastList) {
      // 会话切换/首次挂载（滚动容器被换掉）→ 重置粘底并强制置底
      scrollCtl.lastList = el;
      scrollCtl.stick = true;
      scrollToBottom(true);
      return;
    }
    scrollToBottom(false);
  });
  msgObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('scroll', function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('chat-panel__msg-list')) return;
    scrollCtl.stick = nearBottom(el, STICK_TOL);
  }, true);
  // 发送新消息（回车）→ 回到最新，重新开始跟随
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.tagName === 'TEXTAREA') {
      scrollCtl.stick = true;
      setTimeout(function () { scrollToBottom(true); }, 60);
    }
  }, true);
  setInterval(function () { scrollToBottom(false); }, 2500); // 会话切换等场景兜底

  // ==================== 运行参数：模型单次输出上限（可配置） ====================
  // 渲染层的「运行参数」对话框字段是硬编码的（任务模式/智能对话/文件语义搜索/文档索引），
  // 不含输出上限；但长思考题恰恰需要更大预算（见 3.13.2-recon.19 的空回答根因）。
  // 此处注入一行「模型输出」并在点「保存」时一并提交（后端按 key 合并，与渲染层自身的 POST 互不覆盖）。
  var OUTPUT_LIMIT = { min: 256, max: 131072, def: 16384 };
  var outputLimitValue = null; // null = 本次打开尚未从后端读取
  // 渲染层对话框本身是多语言的（bundle 内 zh/en 两套 runtimeConfig 文案），注入行随之切换
  var OUTPUT_LIMIT_TEXT = {
    zh: {
      section: '模型输出',
      label: '单次输出上限（tokens）',
      hint: '单次回复最多生成的 token 数（含思考过程）。复杂推理题请调大（如 32768）；'
        + '若正文为空会自动加倍重试，最高到 ' + OUTPUT_LIMIT.max + '。',
    },
    en: {
      section: 'Model output',
      label: 'Max output tokens',
      hint: 'Maximum tokens generated per reply, including reasoning. Raise it for hard reasoning '
        + 'tasks (e.g. 32768); an empty answer triggers an automatic retry at double the budget, '
        + 'up to ' + OUTPUT_LIMIT.max + '.',
    },
  };

  function outputLimitLang() {
    var lang = (document.documentElement && document.documentElement.lang) || '';
    if (/^zh/i.test(lang)) return 'zh';
    if (/^en/i.test(lang)) return 'en';
    // 兜底：按对话框标题判断
    var h2 = document.querySelector('.knowly-runtime-config .ant-modal-title h2');
    return h2 && /运行参数/.test(h2.textContent || '') ? 'zh' : 'en';
  }

  function buildOutputLimitSection() {
    var text = OUTPUT_LIMIT_TEXT[outputLimitLang()];
    var section = document.createElement('section');
    section.className = 'knowly-runtime-config__section knowly-recon-output-limit';
    var header = document.createElement('div');
    header.className = 'knowly-runtime-config__section-header';
    var h3 = document.createElement('h3');
    h3.textContent = text.section;
    header.appendChild(h3);
    section.appendChild(header);

    var row = document.createElement('div');
    row.className = 'knowly-runtime-config__row';
    var left = document.createElement('div');
    var label = document.createElement('span');
    label.className = 'knowly-runtime-config__row-label';
    label.textContent = text.label;
    var hint = document.createElement('p');
    hint.textContent = text.hint;
    left.appendChild(label);
    left.appendChild(hint);

    var ctrl = document.createElement('div');
    ctrl.className = 'knowly-runtime-config__control';
    var range = document.createElement('span');
    range.textContent = OUTPUT_LIMIT.min + '-' + OUTPUT_LIMIT.max;
    var wrap = document.createElement('div');
    wrap.className = 'ant-input-number ant-input-number-mode-input knowly-recon-output-limit__wrap';
    var input = document.createElement('input');
    input.type = 'number';
    input.min = String(OUTPUT_LIMIT.min);
    input.max = String(OUTPUT_LIMIT.max);
    input.step = '1024';
    input.className = 'ant-input-number-input knowly-recon-output-limit__input';
    input.setAttribute('aria-label', text.label);
    input.value = String(outputLimitValue == null ? OUTPUT_LIMIT.def : outputLimitValue);
    input.addEventListener('input', function () {
      var v = Math.floor(Number(input.value));
      outputLimitValue = Number.isFinite(v) && v > 0 ? v : null;
    });
    wrap.appendChild(input);
    ctrl.appendChild(range);
    ctrl.appendChild(wrap);
    row.appendChild(left);
    row.appendChild(ctrl);
    section.appendChild(row);
    return section;
  }

  function ensureOutputLimitSection() {
    var sections = document.querySelector('.knowly-runtime-config__sections');
    if (!sections) {
      outputLimitValue = null; // 对话框已关闭 → 下次打开重新读取
      return;
    }
    if (sections.querySelector('.knowly-recon-output-limit')) return;
    var section = buildOutputLimitSection();
    sections.appendChild(section);
    if (outputLimitValue == null) {
      originalFetch('http://localhost:28099/config')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var v = j && j.runtime && j.runtime.max_output_tokens;
          if (typeof v === 'number' && v > 0) {
            outputLimitValue = v;
            var input = section.querySelector('.knowly-recon-output-limit__input');
            if (input) input.value = String(v);
          }
        })
        .catch(function () { /* 读取失败保留默认值 */ });
    }
  }

  /** 点「保存」时把输出上限一并写入（后端按 key 合并，不覆盖渲染层提交的其它字段） */
  function commitOutputLimit() {
    var input = document.querySelector('.knowly-recon-output-limit__input');
    if (!input) return;
    var v = Math.floor(Number(input.value));
    if (!Number.isFinite(v) || v <= 0) v = OUTPUT_LIMIT.def;
    v = Math.min(OUTPUT_LIMIT.max, Math.max(OUTPUT_LIMIT.min, v));
    input.value = String(v);
    outputLimitValue = v;
    originalFetch('http://localhost:28099/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_output_tokens: v }),
    }).catch(function () { /* 保存失败由渲染层的提示兜底 */ });
  }

  // 捕获阶段先于 React 的冒泡处理执行，确保在对话框关闭前发出自己的写入
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.knowly-runtime-config .ant-modal-footer .ant-btn-primary')) commitOutputLimit();
  }, true);

  var runtimeGuard = new MutationObserver(function () { ensureOutputLimitSection(); });
  runtimeGuard.observe(document.documentElement, { childList: true, subtree: true });
  ensureOutputLimitSection();


  // 供测试与高级用法：手动添加附件路径
  window.__knowlyDropShim = {
    version: '1.5.0',
    add: function (paths) { return addPaths(Array.isArray(paths) ? paths : [paths]); },
    addKnowledgeFolders: addKnowledgeFolders,
    watchTaskExecution: watchTaskExecution,
    scrollToBottom: function () { scrollCtl.stick = true; scrollToBottom(true); },
    setOutputLimit: function (v) {
      var n = Math.floor(Number(v));
      if (Number.isFinite(n) && n > 0) {
        outputLimitValue = Math.min(OUTPUT_LIMIT.max, Math.max(OUTPUT_LIMIT.min, n));
        var input = document.querySelector('.knowly-recon-output-limit__input');
        if (input) input.value = String(outputLimitValue);
      }
      return outputLimitValue;
    },
    commitOutputLimit: commitOutputLimit,
    files: function () { return files.slice(); },
    clear: function () { files = []; renderChips(); },
    toast: toast,
  };
})();
