// 复现任务模式发送：切任务模式 → 输入 → 点发送 → 捕获创建/订阅请求与页面结果
const CDP = 'http://127.0.0.1:9334';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('NO-PAGE'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const reqs = [];
const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('28099') && !/health|scheduler|remote-control/.test(u)) reqs.push('REQ ' + m.params.request.method + ' ' + u.replace('http://localhost:28099', '').slice(0, 60));
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (u.includes('28099') && !/health|scheduler|remote-control/.test(u)) reqs.push('RESP ' + m.params.response.status + ' ' + u.replace('http://localhost:28099', '').slice(0, 50));
  }
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 150));
};

let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise((resolve) => {
  const id = ++mid;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable', {});
await send('Runtime.enable', {});
await sleep(2000);

// 1) 切到任务模式（点击文案为「任务模式」且 role=button 的切换控件）
const switched = await ev(`(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.textContent.trim() === '任务模式' && e.childElementCount <= 1);
  for (const el of els.reverse()) {
    let t = el, g = 0;
    while (t && g++ < 8) { if (t.tagName === 'BUTTON') { t.click(); return 'clicked@' + Math.round(t.getBoundingClientRect().y); } t = t.parentElement; }
  }
  return 'not-found';
})()`);
console.log('1) 切换任务模式:', switched);
await sleep(1200);

// 2) 输入
await ev(`(() => { const ta = document.querySelector('textarea'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(ta, '请只回复两个字：收到'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(500);

// 3) 点发送（aria-label=发送）
const btn = await ev(`(() => { const b = document.querySelector('button[aria-label="发送"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
console.log('2) 发送按钮:', JSON.stringify(btn));
reqs.length = 0;
if (btn) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
}
await sleep(20000);

console.log('3) 请求序列:'); for (const r of reqs.slice(0, 10)) console.log('  ', r);
console.log('4) 控制台异常:', JSON.stringify([...new Set(errs)].slice(0, 3)));
console.log('5) toast:', JSON.stringify(await ev(`[...document.querySelectorAll('.ant-message-notice')].map(n => n.innerText.slice(0, 70))`)));
const chat = String(await ev('document.body.innerText'));
const idx = chat.lastIndexOf('你的问题');
console.log('6) 聊天区:', JSON.stringify(chat.slice(Math.max(0, idx - 40), idx + 320)));
ws.close();
process.exit(0);
