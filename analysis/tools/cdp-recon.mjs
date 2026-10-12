// CDP 侦察：确认聊天页 DOM 结构（textarea / 发送按钮 / 消息列表类名）
const CDP = 'http://127.0.0.1:9334';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('无 page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
};
await send('Runtime.enable', {});
await new Promise((r) => setTimeout(r, 1200));

console.log('URL:', await ev('location.href'));
console.log('shim:', await ev('window.__knowlyDropShim ? window.__knowlyDropShim.version : "missing"'));
console.log('msg-list count:', await ev('document.querySelectorAll(".chat-panel__msg-list").length'));
console.log('bubbles:', await ev('document.querySelectorAll(".chat-panel__bubble-content").length'));
console.log('textareas:', await ev('JSON.stringify([...document.querySelectorAll("textarea")].map(t=>({cls:t.className,ph:t.placeholder,vis:t.getBoundingClientRect().height>0})))'));
console.log('发送-ish buttons:', await ev(`JSON.stringify([...document.querySelectorAll('button,div[role=button],span')].filter(e=>/发送|send/i.test(e.textContent||'')||/send/i.test(e.className||'')).slice(0,10).map(e=>({tag:e.tagName,cls:String(e.className).slice(0,90),txt:(e.textContent||'').trim().slice(0,20),vis:e.getBoundingClientRect().height>0})))`));
console.log('nav items:', await ev(`JSON.stringify([...document.querySelectorAll('*')].filter(e=>e.childElementCount===0&&e.textContent.trim().length>0&&e.textContent.trim().length<8&&e.getBoundingClientRect().height>0).map(e=>e.textContent.trim()).slice(0,60))`));
console.log('body tail:', await ev('document.body.innerText.slice(0,300)'));
ws.close();
process.exit(0);
