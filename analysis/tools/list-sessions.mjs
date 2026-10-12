// 列出所有会话并分类，只删「本次验证」产生的会话（我的 UI E2E 提示词为 233 字变体）
const BASE = 'http://127.0.0.1:28099';
const list = await (await fetch(`${BASE}/chat/sessions?limit=100`)).json();
const items = list.data || [];
console.log('会话总数:', list.pagination.total);
console.log('--- 逐个会话 ---');
for (const s of items) {
  const full = await (await fetch(`${BASE}/chat/sessions/${s.id}`)).json();
  const msgs = (full.data && full.data.messages) || [];
  const firstUser = msgs.find((m) => m.role === 'user');
  const len = firstUser ? String(firstUser.content || '').length : 0;
  const hasCandy = String(firstUser?.content || '').includes('糖果');
  console.log(`${s.id} | ${new Date(s.updatedAt || 0).toISOString().slice(11, 19)} | msgs=${msgs.length} | userLen=${len} | candy=${hasCandy} | ${String(s.title || '').slice(0, 24)}`);
}
