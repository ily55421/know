// 抓 /config 与 /directories 的响应体及缓存标志
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
const hits = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.responseReceived') {
    const { response, requestId } = m.params;
    if (/\/config$|\/directories$/.test(response.url) && response.url.includes('28099')) {
      hits.push({ requestId, url: response.url, status: response.status, fromDiskCache: response.fromDiskCache, fromServiceWorker: response.fromServiceWorker, headers: response.headers });
    }
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

// 完成后取响应体
for (const h of hits) {
  try {
    const body = (await send('Network.getResponseBody', { requestId: h.requestId })).result?.body || '';
    console.log('URL:', h.url.replace('http://localhost:28099', ''), '| status:', h.status, '| diskCache:', h.fromDiskCache, '| SW:', h.fromServiceWorker);
    console.log('   cache-control:', h.headers?.['cache-control'] || '(无)', '| etag:', (h.headers?.etag || '').slice(0, 30));
    console.log('   body 前 200 字:', body.slice(0, 200).replace(/\n/g, ' '));
  } catch (e) { console.log('URL:', h.url, '取 body 失败:', e.message); }
}

// 切到知识库页抓 /directories
hits.length = 0;
await ev(`(() => { const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0); const el = els[els.length - 1]; if (!el) return 'nf'; let t = el, g = 0; while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; } return 'ok'; })()`);
await sleep(5000);
for (const h of hits) {
  try {
    const body = (await send('Network.getResponseBody', { requestId: h.requestId })).result?.body || '';
    console.log('[知识库页] URL:', h.url.replace('http://localhost:28099', ''), '| status:', h.status, '| diskCache:', h.fromDiskCache);
    console.log('   body:', body.slice(0, 300).replace(/\n/g, ' '));
  } catch { /* ignore */ }
}
if (!hits.length) console.log('[知识库页] 未捕获 /directories 请求');
ws.close();
process.exit(0);
