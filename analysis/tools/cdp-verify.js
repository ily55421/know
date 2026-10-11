// CDP 端到端验证：连接 Electron 渲染进程，检查页面状态与渲染层→后端连通性
const CDP_PORT = process.argv[2] || '9333';

async function json(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return res.json();
}

const targets = await json('/json/list');
const page = targets.find((t) => t.type === 'page' && /localhost:23099|localhost:13099/.test(t.url))
  || targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.log(JSON.stringify({ verdict: 'FAIL', reason: 'no page target', targets: targets.map((t) => t.type + ':' + t.title + ':' + t.url.slice(0, 60)) }));
  process.exit(1);
}
console.log('页面目标:', page.title, '|', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};

await new Promise((resolve) => { ws.onopen = resolve; });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r.result);
};

const report = {};

report.title = await evaluate('document.title');
report.readyState = await evaluate('document.readyState');
report.rootChildren = await evaluate("document.getElementById('root') ? document.getElementById('root').children.length : -1");
report.hasElectronAPI = await evaluate('typeof window.electronAPI');
report.bodyTextPreview = await evaluate("document.body.innerText.slice(0, 200)");

// 渲染层 → 后端连通性（在页面上下文内请求重建版后端）
report.backendHealth = await evaluate("fetch('http://localhost:28099/health').then(r=>r.json()).catch(e=>'FETCH-ERR:'+e.message)");
report.backendSessions = await evaluate("fetch('http://localhost:28099/chat/sessions').then(r=>r.json()).then(j=>({success:j.success,count:(j.data||[]).length})).catch(e=>'FETCH-ERR:'+e.message)");
// 渲染层的 electronAPI IPC 通路
report.appVersion = await evaluate("window.electronAPI ? window.electronAPI.getAppVersion() : 'NO-API'");

console.log(JSON.stringify(report, null, 2));
const ok = report.title.includes('Knowly') && report.readyState === 'complete' && report.rootChildren > 0
  && report.hasElectronAPI === 'object' && report.backendHealth && report.backendHealth.status === 'ok';
console.log('E2E-VERDICT:', ok ? 'PASS' : 'FAIL');
ws.close();
process.exit(ok ? 0 : 1);
