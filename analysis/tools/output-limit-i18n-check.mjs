// 校验注入字段随界面语言切换（zh / en）
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 200) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (txt) => ev(`(() => {
  const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&(e.textContent||'').trim()===${JSON.stringify(txt)}&&e.getBoundingClientRect().height>0);
  const el=els[0]; if(!el) return 'nf';
  let t=el,g=0; while(t&&g++<6){t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));t=t.parentElement;}
  return 'ok';
})()`);
const injected = () => ev(`(() => {
  const s=document.querySelector('.knowly-recon-output-limit'); if(!s) return 'MISSING';
  return JSON.stringify({ h3:(s.querySelector('h3')||{}).textContent, label:(s.querySelector('.knowly-runtime-config__row-label')||{}).textContent, aria:(s.querySelector('input')||{}).getAttribute ? s.querySelector('input').getAttribute('aria-label') : '', value:(s.querySelector('input')||{}).value });
})()`);
const reinject = () => ev(`(() => { const s=document.querySelector('.knowly-recon-output-limit'); if(s&&s.parentNode) s.parentNode.removeChild(s); return 'removed'; })()`);

await send('Runtime.enable', {});
await sleep(1500);
console.log('shim:', await ev('window.__knowlyDropShim.version'), '| 版本:', await ev('(document.body.innerText.match(/v3\\.[0-9.]+[a-z.-]*[0-9]+/)||["none"])[0]'));

console.log('点 本地资料学习:', await clickText('本地资料学习'));
await sleep(2600);
console.log('点 打开参数配置:', await clickText('打开参数配置'));
await sleep(2200);
console.log('dialog:', await ev('document.querySelectorAll(".knowly-runtime-config").length'));

console.log('\n[zh] lang=', await ev('document.documentElement.lang'));
console.log('[zh] 注入内容:', await injected());

console.log('\n切到 en …');
await ev(`document.documentElement.lang='en'`);
await reinject();
await sleep(900);
console.log('[en] 注入内容:', await injected());

console.log('\n复原 zh …');
await ev(`document.documentElement.lang='zh-CN'`);
await reinject();
await sleep(900);
console.log('[zh] 注入内容:', await injected());

// 关掉对话框
await ev(`(() => { const b=document.querySelector('.knowly-runtime-config .ant-modal-close'); if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
await sleep(600);
console.log('\n关闭后残留注入节点:', await ev('document.querySelectorAll(".knowly-recon-output-limit").length'));
ws.close();
process.exit(0);
