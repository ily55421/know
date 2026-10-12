// 批量模型调用稳定性实测：连续 N 次完整链路（后端 → 主进程代理 → 18888 网关）
const BASE = 'http://127.0.0.1:28099';
const N = Number(process.argv[2]) || 6;

async function once(i) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/qa/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `回复数字 ${i} 即可`, history: [] }),
    });
    if (res.status !== 200) return { i, ok: false, ms: Date.now() - started, detail: `HTTP ${res.status}` };
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
    const err = events.find((e) => e.type === 'error');
    const done = events.find((e) => e.type === 'complete');
    const contents = events.filter((e) => e.type === 'content').map((e) => e.data).join('');
    if (err) return { i, ok: false, ms: Date.now() - started, detail: `error事件: ${String(err.data).slice(0, 160)}` };
    if (!done) return { i, ok: false, ms: Date.now() - started, detail: `无 complete（事件类型: ${events.map((e) => e.type).join(',')}）` };
    return { i, ok: true, ms: Date.now() - started, len: contents.length, answer: String(done.data?.answer || '').slice(0, 40).replace(/\n/g, ' ') };
  } catch (e) {
    return { i, ok: false, ms: Date.now() - started, detail: `fetch异常: ${e.message}` };
  }
}

const results = [];
for (let i = 1; i <= N; i += 1) {
  results.push(await once(i));
  await new Promise((r) => setTimeout(r, 800));
}
let fail = 0;
for (const r of results) {
  if (!r.ok) fail += 1;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} #${r.i} ${r.ms}ms ${r.ok ? '(' + r.len + '字) ' + r.answer : '-> ' + r.detail}`);
}
console.log(`\n汇总: ${N} 次调用，失败 ${fail} 次（${Math.round((fail / N) * 100)}%）`);
