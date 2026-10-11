// 知识库页真机验证：导航 → 拖拽钩子 → 学习 → 搜索
const CDP = 'http://127.0.0.1:9334';
const FOLDER = 'C:/Users/84168/AppData/Local/Temp/kb-test';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const reqs = [];
const errs = [];
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('28099') && !/health|scheduler|remote-control/.test(u)) reqs.push('REQ ' + m.params.request.method + ' ' + u.replace('http://localhost:28099', '').slice(0, 44));
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (u.includes('28099') && /directories|index|search/.test(u)) reqs.push('RESP ' + m.params.response.status + ' ' + u.replace('http://localhost:28099', '').slice(0, 44));
  }
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 140));
});
const send = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable', {});
await send('Runtime.enable', {});
await sleep(2500);

// 1) 导航到「本地资料学习」
const nav = await ev(`(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '本地资料学习' && e.getBoundingClientRect().height > 0);
  const el = els[els.length - 1];
  if (!el) return 'not-found';
  let t = el, g = 0;
  while (t && g++ < 8) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; }
  return 'clicked';
})()`);
console.log('1) 导航到本地资料学习:', nav);
await sleep(3000);
const pageInfo = await ev(`(() => ({
  isKnowledge: !!document.querySelector('.knowly-learning-workspace, .knowly-learning-manager'),
  shimVersion: window.__knowlyDropShim ? window.__knowlyDropShim.version : 'missing',
  hasDropHook: !!(window.__knowlyDropShim && window.__knowlyDropShim.addKnowledgeFolders),
  text: document.body.innerText.slice(0, 150).replace(/\\n/g, ' / ')
}))()`);
console.log('2) 页面状态:', JSON.stringify(pageInfo));

// 2) 缩放：调用拖拽钩子（等价于 drop 后行为）
reqs.length = 0;
await ev(`window.__knowlyDropShim.addKnowledgeFolders(['${FOLDER}'])`);
await sleep(4000);
console.log('3) 拖拽后请求:', JSON.stringify(reqs.slice(0, 8)));
console.log('4) toast:', JSON.stringify(await ev(`[...document.querySelectorAll('.ant-message-notice')].map(n => n.innerText.slice(0, 70))`)));

// 3) 等待自动 reload 后验证目录与学习状态
await sleep(6000);
const after = await ev(`(() => ({
  text: document.body.innerText.slice(0, 260).replace(/\\n/g, ' / '),
  hasFolder: document.body.innerText.includes('kb-test'),
  hasLearn: /学习|开始/.test(document.body.innerText)
}))()`);
console.log('5) reload 后页面:', JSON.stringify(after));
console.log('6) 异常:', JSON.stringify([...new Set(errs)].slice(0, 3)));
ws.close();
process.exit(0);
