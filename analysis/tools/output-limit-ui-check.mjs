// 端到端：运行参数对话框内注入的「单次输出上限」是否渲染、读取现值、保存后落库
const CDP = 'http://127.0.0.1:9334';
const BASE = 'http://127.0.0.1:28099';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 250) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (txt) => ev(`(() => {
  const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&(e.textContent||'').trim()===${JSON.stringify(txt)}&&e.getBoundingClientRect().height>0);
  const el=els[0]; if(!el) return 'nf';
  let t=el,g=0; while(t&&g++<6){t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));t=t.parentElement;}
  return 'ok';
})()`);
await send('Runtime.enable', {});
await sleep(1500);

console.log('shim:', await ev('window.__knowlyDropShim.version'));
console.log('版本:', await ev('(document.body.innerText.match(/v3\\.[0-9.]+[a-z.-]*[0-9]+/)||["none"])[0]'));

// 基线：先记录当前配置
const before = await (await fetch(`${BASE}/config`)).json();
console.log('保存前 max_output_tokens:', before.runtime.max_output_tokens);

// 进入本地资料学习 → 打开参数配置
console.log('点 本地资料学习:', await clickText('本地资料学习'));
await sleep(2800);
console.log('点 打开参数配置:', await clickText('打开参数配置'));
await sleep(2500);

console.log('对话框存在:', await ev('document.querySelectorAll(".knowly-runtime-config").length'));
console.log('注入区块存在:', await ev('document.querySelectorAll(".knowly-recon-output-limit").length'));
console.log('注入区块标题:', await ev('(document.querySelector(".knowly-recon-output-limit h3")||{}).textContent'));
console.log('注入行 label/hint:', await ev(`(() => {
  const s=document.querySelector('.knowly-recon-output-limit'); if(!s) return 'nf';
  return JSON.stringify({ label:(s.querySelector('.knowly-runtime-config__row-label')||{}).textContent, hint:(s.querySelector('p')||{}).textContent, range:(s.querySelector('.knowly-runtime-config__control span')||{}).textContent });
})()`));
await sleep(1200); // 等 GET /config 回填
console.log('输入框当前值:', await ev(`(() => { const i=document.querySelector('.knowly-recon-output-limit__input'); return i? i.value : 'nf'; })()`));
console.log('区块数量（含原有 4 组）:', await ev('document.querySelectorAll(".knowly-runtime-config__section").length'));

// 改值并保存
const NEWVAL = before.runtime.max_output_tokens === 32768 ? 40960 : 32768;
console.log(`\n设为 ${NEWVAL} 并点保存`);
console.log('改值:', await ev(`(() => {
  const i=document.querySelector('.knowly-recon-output-limit__input'); if(!i) return 'nf';
  const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set;
  setter.call(i, String(${NEWVAL})); i.dispatchEvent(new Event('input',{bubbles:true}));
  return i.value;
})()`));
console.log('点保存:', await ev(`(() => {
  const b=document.querySelector('.knowly-runtime-config .ant-modal-footer .ant-btn-primary'); if(!b) return 'nf';
  b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return 'clicked';
})()`));
await sleep(2500);

const after = await (await fetch(`${BASE}/config`)).json();
console.log('保存后 max_output_tokens:', after.runtime.max_output_tokens, after.runtime.max_output_tokens === NEWVAL ? '✓ 已落库' : '✗ 未落库');
console.log('其它字段未被清空（max_iterations）:', after.runtime.max_iterations);

// 越界钳制
await fetch(`${BASE}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_output_tokens: 999999 }) });
console.log('越界 999999 →', (await (await fetch(`${BASE}/config`)).json()).runtime.max_output_tokens);
// 复位
await fetch(`${BASE}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_output_tokens: 16384 }) });
console.log('复位 16384 →', (await (await fetch(`${BASE}/config`)).json()).runtime.max_output_tokens);
ws.close();
process.exit(0);
