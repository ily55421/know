// 定向补测：设置抽屉逐页 + 任务模式真实发送
import fs from 'node:fs';

const CDP_PORT = process.argv[2] || '9333';
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:23099'));
if (!page) { console.log('NO-PAGE'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve) => {
  const id = ++mid;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const failedRequests = [];
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Network.responseReceived') {
    const { response } = msg.params;
    if (response.status >= 400) failedRequests.push({ status: response.status, url: response.url.replace('http://localhost:28099', '').slice(0, 140) });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push((msg.params.exceptionDetails.exception?.description || '').slice(0, 180));
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByText = (text) => evalJs(`(() => {
  const els = [...document.querySelectorAll('li,div,span,a,button')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '${text}');
  const el = els[els.length - 1];
  if (!el) return 'NOT-FOUND';
  let t = el; let guard = 0;
  while (t && guard++ < 6) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; }
  return 'CLICKED';
})()`);
const typeIntoTextarea = (text) => evalJs(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'NO-TEXTAREA';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '${text}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`);
const clickSend = () => evalJs(`(() => {
  const tas = document.querySelector('textarea');
  if (!tas) return 'NO-TEXTAREA';
  const box = tas.closest('div').parentElement;
  const btns = [...box.querySelectorAll('button')].filter(b => !b.disabled);
  const btn = btns[btns.length - 1];
  if (!btn) return 'NO-BUTTON';
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'SENT';
})()`);

const results = {};
const step = async (label, fn, wait = 2200) => {
  const before = failedRequests.length;
  const r = await fn();
  await sleep(wait);
  results[label] = { r, fails: failedRequests.slice(before).map((f) => f.status + ' ' + f.url) };
};

// 打开设置抽屉
await step('打开个人中心', () => clickByText('个人中心'));
await step('打开软件设置', () => clickByText('软件设置'));
// 设置页逐页
for (const name of ['基础', '外观与语言', '系统配置', '本地大模型配置', '三方大模型配置', '离线模型包', 'MCP 工具', 'LibreOffice', '软件诊断', '会员配置迁移', '推广拉新', '意见反馈', '更新日志']) {
  await step('设置/' + name, () => clickByText(name));
}
// 关闭抽屉（Esc）
await step('关闭抽屉', () => evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true})) || window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true})) || 'esc'`));
await sleep(1200);

// 回到会话：切换任务模式并发送
await step('点新建会话', () => clickByText('新建会话'));
// 任务模式切换：找包含"任务模式"的可点击祖先按钮
await step('切换任务模式', () => evalJs(`(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.textContent.trim() === '任务模式' && e.childElementCount <= 1);
  for (const el of els.reverse()) {
    let t = el; let guard = 0;
    const clickable = (() => { while (t && guard++ < 8) { if (t.tagName === 'BUTTON' || (t.getAttribute && t.getAttribute('role') === 'button') || t.tagName === 'LI') return t; t = t.parentElement; } return null; })();
    if (clickable) { clickable.click(); return 'CLICKED'; }
  }
  return 'NOT-FOUND';
})()`));
await step('任务输入', () => typeIntoTextarea('统计一下 D 盘 soft 目录有哪些软件'));
await step('发送(任务模式)', () => clickSend(), 15000);
await step('任务回答', () => evalJs(`document.body.innerText.slice(-1200)`), 6000);

const uniq = [...new Set(failedRequests.map((f) => f.status + ' ' + f.url))];
console.log('=== 失败请求（去重）===');
for (const u of uniq) console.log(' ', u);
console.log('=== 控制台异常 ===');
for (const e of [...new Set(consoleErrors)].slice(0, 8)) console.log(' ⚠', e);
console.log('=== 步骤 ===');
for (const [k, v] of Object.entries(results)) console.log(` ${k}: ${v.r} ${v.fails.length ? 'FAILS: ' + v.fails.join(' | ') : 'ok'}`);
fs.writeFileSync('E:/data/Knowly/analysis/ui-sweep-report2.json', JSON.stringify({ failedRequests, consoleErrors, results }, null, 2), 'utf8');
ws.close();
process.exit(0);
