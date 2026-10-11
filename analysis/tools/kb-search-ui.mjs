// 搜索页精确操作：dump 结构 → 输入 → 搜索 → 读结果
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

// 已在搜索页或切过去
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '文件语义搜索' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);
await sleep(3500);

const struct = await ev(`(() => {
  const inputs = [...document.querySelectorAll('input, textarea')].map(e => ({ tag: e.tagName, ph: e.placeholder || '', cls: (e.className || '').toString().slice(0, 50), y: Math.round(e.getBoundingClientRect().y) }));
  const btns = [...document.querySelectorAll('button')].filter(b => /搜索/.test(b.innerText)).map(b => ({ text: b.innerText.trim().slice(0, 12), y: Math.round(b.getBoundingClientRect().y) }));
  const root = document.querySelector('[class*=search]');
  return JSON.stringify({ inputs, btns, hasSearchClass: !!root });
})()`);
console.log('1) 搜索页结构:', struct);

// 输入到 placeholder 含搜索的输入框
await ev(`(() => {
  const el = [...document.querySelectorAll('input, textarea')].find(e => /搜索|关键词|内容/.test(e.placeholder || ''));
  if (!el) return 'nf';
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
  const s = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  s.call(el, '风险');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed@' + Math.round(el.getBoundingClientRect().y);
})()`);
await sleep(500);
const btn = await ev();
console.log('2) 搜索按钮:', JSON.stringify(btn));
if (btn) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
}
await sleep(7000);

console.log('3) /search 请求:', JSON.stringify([...new Set(reqs)]));
const pageText = String(await ev(`(() => { const m = document.querySelector('main') || document.body; return m.innerText.slice(-700); })()`));
console.log('4) 页面尾部文本:', pageText.slice(0, 500));
ws.close();
process.exit(0);
