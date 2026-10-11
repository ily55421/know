// 诊断渲染层的 API base 来源：localStorage + 页面上下文 fetch
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
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};

const ls = await ev(`JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => /url|base|port|api|python|server/i.test(k))))`);
console.log('1) localStorage 相关键:', ls);

const all = await ev(`JSON.stringify(Object.keys(localStorage))`);
console.log('2) localStorage 全部键:', all);

const fromPage = await ev(`fetch('http://localhost:28099/config').then(r => r.json()).then(j => JSON.stringify({ ok: true, hasRuntime: !!j.data?.runtime, runtime: j.data?.runtime?.max_documents_per_chat })).catch(e => 'ERR:' + e.message)`);
console.log('3) 页面上下文 fetch localhost:28099/config:', fromPage);

const fromPage2 = await ev(`fetch('http://127.0.0.1:28099/config').then(r => r.json()).then(j => JSON.stringify({ ok: true, hasRuntime: !!j.data?.runtime })).catch(e => 'ERR:' + e.message)`);
console.log('4) 页面上下文 fetch 127.0.0.1:28099/config:', fromPage2);

const legacy = await ev(`fetch('http://localhost:18099/config').then(r => r.json()).then(j => JSON.stringify({ reachable: true, hasRuntime: !!j.data?.runtime, keys: Object.keys(j.data || j) })).catch(e => 'ERR:' + e.message)`);
console.log('5) 页面上下文 fetch localhost:18099/config（原版）:', legacy);

ws.close();
process.exit(0);
