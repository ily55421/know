// 打开「打开参数配置」对话框并 dump 结构
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
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || '').slice(0, 250) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable', {});
await sleep(600);

console.log('打开参数配置:', await ev(`(() => {
  const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&(e.textContent||'').trim()==='打开参数配置'&&e.getBoundingClientRect().height>0);
  const el=els[0]; if(!el) return 'nf';
  let t=el,g=0; while(t&&g++<6){t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));t=t.parentElement;}
  return 'ok';
})()`));
await sleep(2500);

console.log('modal:', await ev('document.querySelectorAll(".knowly-runtime-config").length'));
console.log('\n=== 轮廓（maxDepth 6） ===');
console.log(await ev(`(() => {
  const modal = document.querySelector('.knowly-runtime-config');
  if (!modal) return 'no-modal';
  function outline(el, d, maxD) {
    if (d > maxD) return '';
    let out = '';
    for (const c of el.children) {
      const raw = c.className && c.className.baseVal !== undefined ? c.className.baseVal : (c.className || '');
      const cls = String(raw).split(/\\s+/).filter(x => /knowly-runtime-config|ant-modal|ant-input-number|ant-modal-footer|ant-modal-body|ant-modal-content/.test(x)).join('.');
      out += '  '.repeat(d) + c.tagName.toLowerCase() + (cls ? '.' + cls : '') + (c.childElementCount ? '' : ' :: ' + (c.textContent || '').trim().slice(0, 30)) + '\\n';
      out += outline(c, d + 1, maxD);
    }
    return out;
  }
  return outline(modal, 0, 6);
})()`));

console.log('\n=== 数值行 HTML（第 1 行） ===');
console.log(await ev(`(() => {
  const r = document.querySelector('.knowly-runtime-config__row');
  return r ? r.outerHTML.slice(0, 900) : 'no-row';
})()`));

console.log('\n=== footer ===');
console.log(await ev(`(() => {
  const f = document.querySelector('.knowly-runtime-config .ant-modal-footer') || document.querySelector('.ant-modal-footer');
  return f ? f.outerHTML.slice(0, 600) : 'no-footer';
})()`));
ws.close();
process.exit(0);
