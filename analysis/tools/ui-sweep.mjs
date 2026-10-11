// UI 端到端扫描：CDP 逐页点击 + Network 抓取全部失败请求 + 控制台错误 + 真实对话发送
import fs from 'node:fs';

const CDP_PORT = process.argv[2] || '9333';
const WAIT_MS = Number(process.env.SWEEP_WAIT) || 2600;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:23099'))
  || targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
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
    if (response.status >= 400) {
      failedRequests.push({ status: response.status, method: response.requestHeaders?.[':method'] || response.requestHeaders?.method || '?', url: response.url.replace('http://localhost:28099', '').slice(0, 140) });
    }
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push((d.exception?.description || d.text || '').slice(0, 200));
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clickByText = (text) => evalJs(`(() => {
  const els = [...document.querySelectorAll('li,div,span,a,button')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '${text}');
  const el = els[els.length - 1];
  if (!el) return 'NOT-FOUND';
  let t = el; let guard = 0;
  while (t && guard++ < 6) { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); t = t.parentElement; }
  return 'CLICKED';
})()`);

// React 受控输入：原生 setter + input 事件
const typeIntoTextarea = (text) => evalJs(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'NO-TEXTAREA';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '${text}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`);

const report = {};
const record = async (label, fn, waitMs) => {
  const before = failedRequests.length;
  const result = await fn();
  await sleep(waitMs || WAIT_MS);
  report[label] = { ...(result ? { result } : {}), fails: failedRequests.slice(before) };
};

await record('页面/新建会话', () => clickByText('新建会话'));
await record('页面/skill技能', () => clickByText('skill技能'));
await record('页面/百宝箱', () => clickByText('百宝箱'));
await record('页面/本地资料学习', () => clickByText('本地资料学习'));
await record('页面/文件语义搜索', () => clickByText('文件语义搜索'));
await record('页面/知识创作成就', () => clickByText('知识创作成就'));
await record('页面/个人中心', () => clickByText('个人中心'));

// 设置面板各页
await record('设置/外观与语言', () => clickByText('外观与语言'));
await record('设置/系统配置', () => clickByText('系统配置'));
await record('设置/本地大模型配置', () => clickByText('本地大模型配置'));
await record('设置/三方大模型配置', () => clickByText('三方大模型配置'));
await record('设置/离线模型包', () => clickByText('离线模型包'));
await record('设置/MCP 工具', () => clickByText('MCP 工具'));
await record('设置/LibreOffice', () => clickByText('LibreOffice'));
await record('设置/软件诊断', () => clickByText('软件诊断'));
await record('设置/会员配置迁移', () => clickByText('会员配置迁移'));
await record('设置/推广拉新', () => clickByText('推广拉新'));
await record('设置/关于我们', () => clickByText('关于我们'));
await record('设置/意见反馈', () => clickByText('意见反馈'));
await record('设置/更新日志', () => clickByText('更新日志'));

// 回到会话，真实发送（问答模式）
await record('会话/回到新建', () => clickByText('新建会话'));
await record('会话/切换问答模式', () => clickByText('问答模式'));
await record('会话/输入', () => typeIntoTextarea('你好，简单介绍一下你自己'));
await record('会话/发送(问答模式)', () => evalJs(`(() => {
  const tas = document.querySelector('textarea');
  if (!tas) return 'NO-TEXTAREA';
  const box = tas.closest('div').parentElement;
  const btns = [...box.querySelectorAll('button')].filter(b => !b.disabled);
  const btn = btns[btns.length - 1];
  if (!btn) return 'NO-BUTTON';
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'SENT';
})()`), 12000);
await record('会话/读取回答', () => evalJs(`document.body.innerText.slice(0, 700)`), 4000);

// 任务模式
await record('会话/切换任务模式', () => clickByText('任务模式'));
await record('会话/任务输入', () => typeIntoTextarea('列出当前目录的文件'));
await record('会话/发送(任务模式)', () => evalJs(`(() => {
  const tas = document.querySelector('textarea');
  if (!tas) return 'NO-TEXTAREA';
  const box = tas.closest('div').parentElement;
  const btns = [...box.querySelectorAll('button')].filter(b => !b.disabled);
  const btn = btns[btns.length - 1];
  if (!btn) return 'NO-BUTTON';
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'SENT';
})()`), 12000);
await record('会话/任务回答', () => evalJs(`document.body.innerText.slice(0, 900)`), 4000);

const all = failedRequests.map((f) => `${f.status} ${f.method} ${f.url}`);
console.log('=== 失败请求（去重）===');
for (const u of [...new Set(all)]) console.log(' ', u);
console.log('=== 控制台异常（去重，前 12）===');
for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(' ', e);
console.log('=== 页面点击/对话摘要 ===');
for (const [k, v] of Object.entries(report)) {
  const click = v.result ? ` ${v.result}` : '';
  console.log(` ${k}:${click} fails=${v.fails.length}${v.fails.length ? ' -> ' + v.fails.map((f) => f.status + ' ' + f.url).join(' | ') : ''}`);
}
fs.writeFileSync('E:/data/Knowly/analysis/ui-sweep-report.json', JSON.stringify({ failedRequests, consoleErrors, report }, null, 2), 'utf8');
console.log('报告已写入 analysis/ui-sweep-report.json');
ws.close();
process.exit(0);
