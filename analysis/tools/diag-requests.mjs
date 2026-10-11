// 抓页面加载时的全部后端请求，定位渲染层真实 API base
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
const urls = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/18099|28099|18081|28081/.test(u)) urls.push(m.params.request.method + ' ' + u.slice(0, 80));
  }
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable', {});
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: false });
await sleep(12000);
console.log('页面加载期间的后端请求（去重）:');
for (const u of [...new Set(urls)].slice(0, 20)) console.log('  ', u);
ws.close();
process.exit(0);
