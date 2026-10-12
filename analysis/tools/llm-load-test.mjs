// 重负载压测：长历史 + 复杂问题（长思考）+ 三路并发，统计失败率与错误文案
const BASE = 'http://127.0.0.1:28099';

const longHistory = [];
for (let i = 1; i <= 12; i += 1) {
  longHistory.push({ role: 'user', content: `第${i}轮：请记住要点 ${i}` });
  longHistory.push({ role: 'assistant', content: `已记住要点 ${i}。` });
}

async function call(label, body) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/qa/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 200) return { label, ok: false, ms: Date.now() - started, detail: `HTTP ${res.status}` };
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
    const err = events.find((e) => e.type === 'error');
    const done = events.find((e) => e.type === 'complete');
    if (err) return { label, ok: false, ms: Date.now() - started, detail: String(err.data).slice(0, 180) };
    if (!done) return { label, ok: false, ms: Date.now() - started, detail: `无 complete（${events.map((e) => e.type).join(',')}）` };
    return { label, ok: true, ms: Date.now() - started, len: String(done.data?.answer || '').length };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - started, detail: `fetch: ${e.message}` };
  }
}

const scenarios = [
  ['长历史轻问', { query: '第 7 轮是什么？只回答数字', history: longHistory }],
  ['复杂问题(长思考)', { query: '请分三步详细说明：如何在一个 10 万文件的目录里设计去重方案？要求覆盖哈希选择、内存控制、并发策略，并给出复杂度分析。', history: [] }],
  ['深度推理', { query: '一个袋子有 3 种口味共 12 颗糖，随机取 4 颗恰好每种口味都有的概率是多少？请给推导过程。', history: [] }],
];

console.log('=== 场景一：串行（含长历史与长思考）===');
const serial = [];
for (const [label, body] of scenarios) {
  const r = await call(label, body);
  serial.push(r);
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label} ${r.ms}ms ${r.ok ? r.len + '字' : '-> ' + r.detail}`);
  await new Promise((res) => setTimeout(res, 500));
}

console.log('=== 场景二：三路并发 ===');
const conc = await Promise.all([
  call('并发A', { query: '并发测试A：回复A即可', history: [] }),
  call('并发B', { query: '并发测试B：回复B即可', history: [] }),
  call('并发C', { query: '并发测试C：回复C即可', history: [] }),
]);
for (const r of conc) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label} ${r.ms}ms ${r.ok ? r.len + '字' : '-> ' + r.detail}`);

const all = [...serial, ...conc];
const fail = all.filter((r) => !r.ok).length;
console.log(`\n汇总: ${all.length} 次（含长历史/长思考/并发），失败 ${fail} 次`);
for (const r of all.filter((x) => !x.ok)) console.log('  失败详情:', r.label, '->', r.detail);
