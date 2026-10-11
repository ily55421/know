// 清理测试会话（标题含测试关键词）
const list = await (await fetch('http://127.0.0.1:28099/chat/sessions?limit=50')).json();
const testRe = /测试任务|问答模式测试|ui-send|hello from ui|MARKER/i;
const targets = list.data.filter((s) => testRe.test(s.title || ''));
for (const s of targets) {
  const r = await (await fetch(`http://127.0.0.1:28099/chat/sessions/${s.id}`, { method: 'DELETE' })).json();
  console.log('删除', s.title.slice(0, 26), '->', r.success ? 'OK' : 'FAIL');
}
const after = await (await fetch('http://127.0.0.1:28099/chat/sessions?limit=50')).json();
console.log('剩余会话数:', after.pagination.total);
console.log('保留:', after.data.map((s) => s.title.slice(0, 20)).join(' | '));
