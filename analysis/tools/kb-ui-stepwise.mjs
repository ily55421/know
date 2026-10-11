// 逐步诊断知识库页信息流：每 3 秒 dump 一次工作区文本
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

// 重新加载页面，等主界面稳定
await send('Page.enable', {});
await send('Page.reload', {});
await sleep(10000);
console.log('reload 后工作区:', await ev(`(() => { const w = document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'); return w ? w.innerText.slice(0, 120).replace(/\\n/g, ' / ') : '未挂载'; })()`));

// 切到知识库页
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);

for (let i = 1; i <= 5; i += 1) {
  await sleep(3000);
  const w = await ev(`(() => { const w = document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'); return w ? w.innerText.slice(0, 140).replace(/\\n/g, ' / ') : '未挂载'; })()`);
  console.log('t+' + i * 3 + 's:', w);
}
ws.close();
process.exit(0);
