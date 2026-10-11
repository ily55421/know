// 搜索页终验 v2：输入「风险」→ 回车 + 点击兜底 → 读结果
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
    if (u.includes('28099') && /search/.test(u)) reqs.push(m.params.request.method + ' ' + u.replace('http://localhost:28099', '').slice(0, 40));
  }
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable', {});
await send('Network.enable', {});
await sleep(1200);

await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '文件语义搜索' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);
await sleep(3500);

const typed = await ev(`(() => {
  const el = [...document.querySelectorAll('input')].find(e => /请输入搜索内容/.test(e.placeholder || ''));
  if (!el) return 'nf';
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(el, '风险');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return 'typed';
})()`);
console.log('1) 输入:', typed);

await ev(`(() => { const el = [...document.querySelectorAll('input')].find(e => /请输入搜索内容/.test(e.placeholder || '')); ['keydown','keypress','keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))); return 'enter'; })()`);
await sleep(4000);

if (!reqs.length) {
  const pos = await ev(`(() => {
    const cands = [...document.querySelectorAll('*')].filter(e => e.childElementCount <= 1 && e.textContent.trim().replace(/\\s/g, '') === '搜索' && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().y > 60);
    const el = cands[cands.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  console.log('2) 点击「搜索」元素:', JSON.stringify(pos));
  if (pos) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  }
}
await sleep(7000);

console.log('3) /search 请求:', JSON.stringify([...new Set(reqs)]));
const tail = String(await ev(`(() => { const m = document.querySelector('main') || document.body; return m.innerText; })()`));
const i = tail.lastIndexOf('搜索结果');
console.log('4) 结果区:', JSON.stringify(tail.slice(i >= 0 ? i : Math.max(0, tail.length - 500), (i >= 0 ? i : tail.length) + 400)));
ws.close();
process.exit(0);
