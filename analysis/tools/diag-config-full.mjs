// A) /config 全文找 runtime；B) 知识库页现场手测 /directories + dump 目录区
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
let configBody = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.responseReceived' && /\/config$/.test(m.params.response.url)) {
    const rid = m.params.requestId;
    send('Network.getResponseBody', { requestId: rid }).then((r) => { configBody = r.result?.body || ''; }).catch(() => {});
  }
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable', {});
await send('Runtime.enable', {});
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: false });
await sleep(10000);

console.log('A) 页面加载时的 /config 响应体（全文长度 ' + (configBody ? configBody.length : 0) + '）:');
if (configBody) {
  console.log('   含 runtime:', configBody.includes('"runtime"') ? '✓' : '✗');
  const i = configBody.indexOf('"runtime"');
  console.log('   runtime 片段:', i >= 0 ? configBody.slice(i, i + 200) : '(无)');
}

console.log('B) 知识库页现场:');
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);
await sleep(4000);
const manual = await ev(`fetch('http://localhost:28099/directories').then(r => r.json()).then(j => JSON.stringify({ success: j.success, keys: Object.keys(j.directories || {}) })).catch(e => 'ERR:' + e.message)`);
console.log('   页面手测 /directories:', manual);
const dom = await ev(`(() => {
  const ws = document.querySelector('.knowly-learning-workspace, .knowly-learning-manager');
  return ws ? ws.innerText.slice(0, 400).replace(/\\n/g, ' / ') : 'workspace 未找到';
})()`);
console.log('   知识库工作区文本:', dom);
ws.close();
process.exit(0);
