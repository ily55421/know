// 实测：思考过程渲染位置 + 中断样本（问答/任务两模式）
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
const errs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 120));
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable', {});
await sleep(1500);

// 切到问答模式
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.textContent.trim() === '问答模式' && e.childElementCount <= 1); for (const el of els.reverse()) { let t = el, g = 0; while (t && g++ < 8) { if (t.tagName === 'BUTTON') { t.click(); return 'qa'; } t = t.parentElement; } } return 'nf'; })()`);
await sleep(1000);
await ev(`(() => { const ta = document.querySelector('textarea'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(ta, '请详细推导：为什么 0.1+0.2 在浮点里不等于 0.3？要包含二进制表示与舍入误差分析。'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(400);
await ev(`(() => { const b = document.querySelector('button[aria-label="发送"]'); if (b) b.click(); })()`);

// 流式期间采样思考文本位置
console.log('=== 流式期间采样（每 2.5s）===');
for (let i = 1; i <= 6; i += 1) {
  await sleep(2500);
  const probe = await ev(`(() => {
    const toasts = [...document.querySelectorAll('.ant-message-notice')].map(n => n.innerText.slice(0, 60));
    // 找疑似思考文本：包含「思考」或较长中文推理的容器
    const thinkEls = [...document.querySelectorAll('*')].filter(e => {
      const t = (e.className || '').toString();
      return /think|reason/i.test(t) && e.getBoundingClientRect().height > 0;
    }).map(e => ({ cls: (e.className || '').toString().slice(0, 70), len: (e.innerText || '').length }));
    const inBubble = document.querySelectorAll('.chat-panel__bubble-content').length;
    const drawer = document.querySelectorAll('.ant-drawer-content, .ant-modal-content').length;
    const steps = document.querySelectorAll('[class*=task-step]').length;
    return JSON.stringify({ toasts, thinkEls: thinkEls.slice(0, 6), inBubble, drawer, steps });
  })()`);
  console.log('t+' + i * 2.5 + 's:', probe);
}

const answer = await ev(`(() => { const b = document.body.innerText; const i = b.lastIndexOf('你的问题'); return b.slice(i, i + 400).replace(/\\n/g, ' | '); })()`);
console.log('=== 对话区 ===');
console.log(String(answer).slice(0, 400));
console.log('异常:', JSON.stringify([...new Set(errs)].slice(0, 3)));
ws.close();
process.exit(0);
