// 终验：知识库目录列表 + 搜索页命中
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
const clickNav = async (text) => ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '${text}' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);

await send('Runtime.enable', {});
await sleep(1500);

// 1) 知识库目录列表
await clickNav('本地资料学习');
await sleep(4000);
const list = await ev(`(() => { const l = document.querySelector('.knowly-learning-manager__list'); return l ? l.innerText : '列表未找到'; })()`);
console.log('=== 知识库目录列表 ===');
console.log(list);

// 2) 搜索页：输入「风险」并搜索
await clickNav('文件语义搜索');
await sleep(3500);
await ev(`(() => { const ta = document.querySelector('textarea, input[type=text]'); if (!ta) return 'nf'; const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement; const s = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set; s.call(ta, '风险'); ta.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`);
await sleep(600);
const searchBtn = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /搜索/.test(x.innerText) && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
console.log('搜索按钮:', JSON.stringify(searchBtn));
if (searchBtn) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: searchBtn.x, y: searchBtn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: searchBtn.x, y: searchBtn.y, button: 'left', clickCount: 1 });
}
await sleep(6000);
const results = await ev(`document.body.innerText.slice(-600)`);
console.log('=== 搜索结果区 ===');
console.log(String(results));
ws.close();
process.exit(0);
