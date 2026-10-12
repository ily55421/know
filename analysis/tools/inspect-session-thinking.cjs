const fs = require('fs');
const p = 'data/backend/sessions.json';
const db = JSON.parse(fs.readFileSync(p, 'utf8'));
const sessions = Array.isArray(db) ? db : db.sessions || [];
console.log('session count:', sessions.length);
// 找出含糖果提示词的会话，按更新时间排序
const hit = sessions
  .filter((s) => JSON.stringify(s).includes('糖果'))
  .sort((a, b) => String(b.updated_at || b.updatedAt || '').localeCompare(String(a.updated_at || a.updatedAt || '')));
console.log('matching sessions:', hit.length);
for (const s of hit.slice(0, 4)) {
  const msgs = s.messages || [];
  console.log('\n--- session', s.id, '|', (s.title || '').slice(0, 40), '| updated', s.updated_at || s.updatedAt, '| msgs', msgs.length);
  for (const m of msgs) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const thinking = m.thinking || m.thinkingContent || m.reasoning || '';
    const meta = m.metadata || {};
    console.log(`   role=${m.role} contentLen=${content.length} thinkingLen=${String(thinking).length} metaKeys=${Object.keys(meta).join(',')} status=${m.status || meta.status || ''}`);
  }
  const asst = msgs.filter((m) => m.role === 'assistant');
  const lastA = asst[asst.length - 1];
  if (lastA) {
    const t = String(lastA.thinking || lastA.thinkingContent || '');
    console.log('   last assistant thinking head:', JSON.stringify(t.slice(0, 120)));
    console.log('   last assistant thinking tail:', JSON.stringify(t.slice(-200)));
    const c = typeof lastA.content === 'string' ? lastA.content : '';
    console.log('   last assistant content tail:', JSON.stringify(c.slice(-160)));
  }
}
