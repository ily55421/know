// 端到端（真 UI）：发送用户的原提示词，验证
//  A) 不再中断、产出完整正文  B) 思考过程内联在对话气泡  C) 消息列表默认贴底且不打断上翻
const CDP = 'http://127.0.0.1:9334';
const PROMPT = '在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。已知不同口味的糖果和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖果？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）\n苹果味 桃子味 西瓜味\n圆形 7 9 8\n五角星形 7 6 4\n帮我做一下，不调用任何工具，也不调用联网';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const d = r.result;
  if (d?.exceptionDetails) return { __err: (d.exceptionDetails.exception?.description || d.exceptionDetails.text || '').slice(0, 200) };
  return d?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable', {});
await sleep(1000);

// 1) 新建会话，避免污染历史
console.log('新建会话:', await ev(`(() => { const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&e.textContent.trim()==='新建会话'&&e.getBoundingClientRect().height>0); const el=els[0]; if(!el) return 'nf'; let t=el,g=0; while(t&&g++<6){t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));t=t.parentElement;} return 'ok'; })()`));
await sleep(2500);

// 2) 写入提示词（React 受控 textarea 需用原生 setter）
const setRes = await ev(`(() => {
  const ta = document.querySelector('textarea.chat-panel__textfield') || document.querySelector('textarea');
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
  setter.call(ta, ${JSON.stringify(PROMPT)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return 'len=' + ta.value.length;
})()`);
console.log('写入提示词:', setRes);

// 3) 点击发送
const sendRes = await ev(`(() => {
  const icon = document.querySelector('span.anticon-send');
  const btn = icon ? icon.closest('button') : null;
  if (!btn) return 'no-send-btn';
  btn.click();
  return 'clicked';
})()`);
console.log('发送:', sendRes);

// 4) 轮询直到稳定
const state = async () => ev(`(() => {
  const list = document.querySelector('.chat-panel__msg-list');
  const bubbles = [...document.querySelectorAll('.chat-panel__bubble-content')];
  const last = bubbles[bubbles.length - 1];
  let answerText = '';
  if (last) {
    const clone = last.cloneNode(true);
    const tb = clone.querySelector(':scope > .knowly-recon-thinking');
    if (tb && tb.parentNode) tb.parentNode.removeChild(tb);
    answerText = (clone.textContent || '').trim();
  }
  const th = last ? last.querySelector(':scope > .knowly-recon-thinking') : null;
  const thc = th ? th.querySelector('.chat-panel__thinking-block-content') : null;
  const thStreaming = th ? th.querySelector('.chat-panel__thinking-block-streaming') : null;
  const stopBtn = [...document.querySelectorAll('button')].find(b => /停止|停止生成|stop/i.test(b.textContent || ''));
  return JSON.stringify({
    bubbles: bubbles.length,
    answerLen: answerText.length,
    lastText: answerText.slice(-300),
    thinking: !!th, thinkingLen: thc ? thc.textContent.length : 0,
    thinkingStreaming: thStreaming ? thStreaming.style.display !== 'none' : false,
    dist: list ? Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) : -1,
    hasStop: !!stopBtn,
  });
})()`);

let prev = '', stable = 0, last = null;
for (let i = 0; i < 200; i += 1) {
  await sleep(3000);
  const raw = await state();
  if (raw && raw.__err) { console.log(`t=${(i + 1) * 3}s eval err:`, raw.__err); continue; }
  last = JSON.parse(raw);
  const key = last.answerLen + '|' + last.thinkingLen + '|' + last.hasStop;
  if (key === prev) stable += 1; else stable = 0;
  prev = key;
  console.log(`t=${(i + 1) * 3}s bubbles=${last.bubbles} ans=${last.answerLen} think=${last.thinkingLen} streaming=${last.thinkingStreaming} stop=${last.hasStop} dist=${last.dist}`);
  if (stable >= 5 && !last.hasStop) break;
}

if (!last) { console.log('未取到状态'); process.exit(5); }
console.log('\n=== 结果 ===');
console.log('气泡尾部:', JSON.stringify(last.lastText));
console.log('判定 A 完整作答  :', last.answerLen > 120 ? '✓ 正文 ' + last.answerLen + ' 字' : '✗ 正文仅 ' + last.answerLen + ' 字');
console.log('判定 B 思考内联  :', last.thinking && last.thinkingLen > 300 ? '✓ ' + last.thinkingLen + ' 字' : '✗ thinking=' + last.thinking + ' len=' + last.thinkingLen);
console.log('判定 C1 默认贴底 :', last.dist >= 0 && last.dist < 80 ? '✓ 距底 ' + last.dist + 'px' : '✗ 距底 ' + last.dist + 'px');

// 5) 粘底策略：手动上翻后不应被强行拉回
await ev(`(() => { const el = document.querySelector('.chat-panel__msg-list'); if (el) el.scrollTop = 0; return true; })()`);
await sleep(4200); // 跨过 2.5s 兜底 interval
const afterScrollUp = await ev(`(() => { const el = document.querySelector('.chat-panel__msg-list'); return el ? Math.round(el.scrollTop) : -1; })()`);
console.log('判定 C2 上翻不被拉回:', afterScrollUp !== null && afterScrollUp < 40 ? `✓ 仍在顶部 (scrollTop=${afterScrollUp})` : `✗ 被拉回 (scrollTop=${afterScrollUp})`);

// 6) 强制置底 API
await ev('window.__knowlyDropShim.scrollToBottom()');
await sleep(600);
const afterForce = await ev(`(() => { const el = document.querySelector('.chat-panel__msg-list'); return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1; })()`);
console.log('判定 C3 强制置底  :', afterForce >= 0 && afterForce < 40 ? `✓ 距底 ${afterForce}px` : `✗ 距底 ${afterForce}px`);

ws.close();
process.exit(0);
