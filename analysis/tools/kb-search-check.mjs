// 知识库搜索链路验证（Node fetch，UTF-8 正确）
const BASE = 'http://127.0.0.1:28097';
const FOLDER = 'C:/Users/84168/AppData/Local/Temp/kb-test';

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

const search = await post('/search', { query: '风险', folder: 'all' });
console.log('1) 搜索「风险」命中:', search.results.length);
for (const r of search.results) {
  console.log('   source:', r.source, '| confidence:', r.confidence);
  console.log('   snippet:', r.snippet.slice(0, 100).replace(/\n/g, ' '));
}

const search2 = await post('/search', { query: '向量检索 知识库', folder: 'all' });
console.log('2) 多关键词「向量检索 知识库」命中:', search2.results.length);
for (const r of search2.results) console.log('   ', r.source, '| conf:', r.confidence, '| <mark> 数量:', (r.snippet.match(/<mark>/g) || []).length);

const text = await post('/search/file-text', { folder: FOLDER, source: 'C:\\Users\\84168\\AppData\\Local\\Temp\\kb-test\\risk.md' });
console.log('3) 读全文:', text.success ? text.content.slice(0, 60).replace(/\n/g, ' ') : text.message);

const miss = await post('/search', { query: '不存在的词xyz', folder: 'all' });
console.log('4) 无命中场景:', miss.results.length, '(应为 0)');
