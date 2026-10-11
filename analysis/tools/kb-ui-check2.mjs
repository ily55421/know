// 验证 toast 为历史残留 + 知识库页目录列表
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable', {});
await send('Runtime.enable', {});

console.log('1) 重载前 toast:', JSON.stringify(await ev(`[...document.querySelectorAll('.ant-message-notice')].map(n => n.innerText.slice(0, 50))`)));

await send('Page.reload', { ignoreCache: false });
await sleep(9000);
console.log('2) 重载后 toast:', JSON.stringify(await ev(`[...document.querySelectorAll('.ant-message-notice')].map(n => n.innerText.slice(0, 50))`)));

// 导航到本地资料学习
await ev(`(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0);
  const el = els[els.length - 1];
  if (!el) return 'nf';
  let t = el, g = 0;
  while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; }
  return 'ok';
})()`);
await sleep(4000);
const kb = await ev(`(() => ({
  isKnowledge: !!document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'),
  hasFolder: document.body.innerText.includes('kb-test'),
  snippet: document.body.innerText.slice(0, 400).replace(/\\n/g, ' / ')
}))()`);
console.log('3) 知识库页:', JSON.stringify(kb));
ws.close();
process.exit(0);
