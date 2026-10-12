const fs = require('fs');
const s = fs.readFileSync('electron/dist/bundle.js', 'utf8');
function around(term, before = 400, after = 700) {
  const i = s.indexOf(term);
  if (i < 0) return console.log(`[${term}] not found`);
  console.log(`\n===== ${term} @ ${i} =====`);
  console.log(s.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' '));
}
for (const t of ['thinking_content', 'answer_revoke', 'reasoning_chunk', 'thinking_result', 'quota_exceeded']) around(t);
// 查找事件类型分派表
const types = [...s.matchAll(/"(metadata|sources|thinking_content|content|complete|quota_exceeded|error|answer_chunk|answer_revoke|answer_start|answer_commit|reasoning_chunk|reasoning_complete|execution_start|tool_result)"/g)].map((m) => m[1]);
console.log('\nevent type occurrences:', JSON.stringify(types.reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}), null, 1));
