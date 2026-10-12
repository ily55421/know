// 进入「本地资料学习」页，定位「运行参数」入口
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
const clickText = (txt, exact = true) => ev(`(() => {
  const els=[...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&e.getBoundingClientRect().height>0&&${exact ? `(e.textContent||'').trim()===${JSON.stringify(txt)}` : `/${txt}/.test(e.textContent||'')`});
  const el=els[els.length-1]; if(!el) return 'nf';
  let t=el,g=0; while(t&&g++<6){t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));t=t.parentElement;}
  return 'ok';
})()`);
await send('Runtime.enable', {});
await sleep(800);

console.log('点 本地资料学习:', await clickText('本地资料学习'));
await sleep(3000);
console.log('现在 URL hash:', await ev('location.hash'));
console.log('learning-workspace:', await ev('document.querySelectorAll(".knowly-learning-workspace").length'));

console.log('\n=== 页面可见按钮/图标（title 或 aria-label 非空） ===');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('button,[role=button],.anticon,svg')].filter(e=>e.getBoundingClientRect().height>0).map(e=>({
  tag:e.tagName, cls:String(e.className.baseVal!==undefined?e.className.baseVal:e.className).slice(0,60),
  title:e.getAttribute('title')||e.getAttribute('aria-label')||'',
  txt:(e.textContent||'').trim().slice(0,16)
})).filter(x=>x.title||x.txt).slice(0,40), null, 1)`));

console.log('\n=== 文本块（前 60） ===');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&e.textContent.trim().length>0&&e.textContent.trim().length<14&&e.getBoundingClientRect().height>0).map(e=>e.textContent.trim()).slice(0,60))`));
ws.close();
process.exit(0);
