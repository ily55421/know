// 复现用户的复杂推理提示词（任务模式），并探测网关可接受的 max_tokens
const BASE = 'http://127.0.0.1:28099';
const PROMPT = '在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。已知不同口味的糖果和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖果？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）\n苹果味 桃子味 西瓜味\n圆形 7 9 8\n五角星形 7 6 4\n帮我做一下，不调用任何工具，也不调用联网';

async function streamCall(body) {
  const started = Date.now();
  const res = await fetch(`${BASE}/qa/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  const err = events.find((e) => e.type === 'error');
  const done = events.find((e) => e.type === 'complete');
  const thinking = events.filter((e) => e.type === 'thinking_content').map((e) => e.data).join('');
  const content = events.filter((e) => e.type === 'content').map((e) => e.data).join('');
  return { ms: Date.now() - started, err: err ? String(err.data).slice(0, 200) : null, done: done ? String(done.data?.answer || '').slice(0, 300) : null, thinkingLen: thinking.length, contentLen: content.length };
}

console.log('=== 1) 现状（max_tokens=4096）：完整提示词 ===');
const r1 = await streamCall({ query: PROMPT, history: [], enable_thinking: true });
console.log(JSON.stringify(r1, null, 1).slice(0, 900));

// 2) 直接探测网关可接受的 max_tokens（非流式，短问题）
console.log('=== 2) 网关 max_tokens 上限探测 ===');
for (const maxTokens of [8192, 16384, 32768]) {
  try {
    const res = await fetch('http://127.0.0.1:28081/api/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'self', base_url: 'http://127.0.0.1:18888/v1', model: 'self', messages: [{ role: 'user', content: '回复OK' }], stream: false, max_tokens: maxTokens }),
    });
    const j = await res.json();
    console.log(`max_tokens=${maxTokens}:`, j.success ? '受理 ✓' : `拒绝 -> ${String(j.error).slice(0, 120)}`);
  } catch (e) { console.log(`max_tokens=${maxTokens}: 异常 ${e.message}`); }
}
