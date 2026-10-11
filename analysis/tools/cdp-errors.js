// CDP: reload page and capture renderer exceptions/console errors
const CDP_PORT = process.argv[2] || '9333';
const WAIT_MS = Number(process.argv[3]) || 9000;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:23099'));
if (!page) { console.log('NO-PAGE'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const events = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    events.push({ kind: 'exception', text: d.text, detail: d.exception?.description?.slice(0, 500) || d.exception?.value });
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    events.push({ kind: msg.params.type, text: msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
  }
};
await new Promise((resolve) => { ws.onopen = resolve; });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, WAIT_MS));

// 汇总重复错误
const seen = new Map();
for (const e of events) {
  const key = (e.detail || e.text || '').slice(0, 120);
  seen.set(key, (seen.get(key) || 0) + 1);
}
console.log('捕获事件数:', events.length);
for (const [key, count] of seen) console.log(`x${count}  ${key}`);
const rootState = await send('Runtime.evaluate', { expression: "document.getElementById('root').children.length", returnByValue: true });
console.log('reload 后 root children:', rootState.result?.result?.value);
ws.close();
process.exit(0);
