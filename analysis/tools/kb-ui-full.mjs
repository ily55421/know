// 完整 dump 知识库工作区 + 目录卡片 DOM + 最近请求
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
const reqs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('28099') && /directories|check-db|monitoring|index/.test(u)) reqs.push(m.params.request.method + ' ' + u.replace('http://localhost:28099', '').slice(0, 60));
  }
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable', {});
await send('Network.enable', {});
await sleep(1500);

await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);
await sleep(12000);

const full = await ev(`(() => { const w = document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'); return w ? w.innerText : '未挂载'; })()`);
console.log('=== 工作区完整文本 ===');
console.log(full);

const classes = await ev(`(() => { const w = document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'); if (!w) return 'nf'; return [...new Set([...w.querySelectorAll('*')].map(e => (e.className || '').toString()).filter(c => c && /knowly-learning/.test(c)))].slice(0, 20).join('\\n'); })()`);
console.log('=== 工作区内的类名 ===');
console.log(classes);

console.log('=== 最近目录相关请求 ===');
for (const r of [...new Set(reqs)].slice(0, 10)) console.log('  ', r);
ws.close();
process.exit(0);
