// 任务模式思考内联验证：发送任务 → 观察流式与完成后气泡内是否有思考块
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable', {});
await sleep(1500);

// 确保任务模式
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.textContent.trim() === '任务模式' && e.childElementCount <= 1); for (const el of els.reverse()) { let t = el, g = 0; while (t && g++ < 8) { if (t.tagName === 'BUTTON') { const active = t.className.includes('primary') || t.getAttribute('type') === 'primary'; t.click(); return 'clicked'; } t = t.parentElement; } } return 'nf'; })()`);
await sleep(800);

// 新建会话后发送任务
await ev(`(() => { const b = [...document.querySelectorAll('button[aria-label="新建会话"]')][0]; if (b) b.click(); })()`);
await sleep(1500);
await ev(`(() => { const ta = document.querySelector('textarea'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(ta, '用三步说明：如何判断一个数是否为素数？请给出推理过程。'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(400);
await ev(`(() => { const b = document.querySelector('button[aria-label="发送"]'); if (b) b.click(); })()`);

console.log('已发送，采样中…');
for (let i = 1; i <= 10; i += 1) {
  await sleep(3000);
  const probe = await ev(`(() => {
    const blocks = [...document.querySelectorAll('.knowly-recon-thinking')];
    const inBubble = [...document.querySelectorAll('.chat-panel__bubble-content > .knowly-recon-thinking')];
    const streaming = document.querySelector('.knowly-recon-thinking .chat-panel__thinking-block-streaming');
    const text = inBubble.length ? (inBubble[inBubble.length - 1].innerText || '') : '';
    const body = document.body.innerText;
    return JSON.stringify({
      blocks: blocks.length, inBubbles: inBubble.length,
      streamingVisible: streaming ? getComputedStyle(streaming).display !== 'none' : null,
      thinkingLen: text.replace(/深度思考|思考中…/g, '').length,
      preview: text.slice(0, 60).replace(/\\n/g, ' '),
      hasStopped: body.includes('任务已停止')
    });
  })()`);
  console.log('t+' + i * 3 + 's:', probe);
}
ws.close();
process.exit(0);
