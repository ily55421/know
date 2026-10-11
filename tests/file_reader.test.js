'use strict';

const test = require('node:test');
const fs = require('node:fs');

const {
  expect,
  expectEqual,
  expectIncludes,
  expectMatch,
  printAssertionSummary,
  ensureSamples,
  samplePath,
  startServer,
  postJson,
} = require('./helpers');

ensureSamples();
test.after(() => printAssertionSummary(__filename));

function flattenOutline(outline) {
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      flat.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(outline);
  return flat;
}

async function readFile(baseUrl, body) {
  return postJson(baseUrl, '/tools/file_reader', body);
}

test('AC3：read + cursor 续读闭环（large.txt 拼接等于原文）', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const target = samplePath('large.txt');
    const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    const maxLength = 20000;

    const first = await readFile(baseUrl, { action: 'read', file_paths: [target], max_length: maxLength });
    expectEqual(first.json.success, true, '首次 read 应成功');
    const firstResult = first.json.result.results[0];
    expectEqual(firstResult.action, undefined, '工具级 result 不应包含 action');
    expectEqual(firstResult.truncated, true, '首次 read 应被截断');
    expect(firstResult.cursor && firstResult.cursor.length > 0, '截断时应返回 cursor');
    expect(firstResult.content.length <= maxLength, 'content 长度不应超过 max_length');
    expectEqual(firstResult.remaining_chars, source.length - firstResult.content.length, 'remaining_chars 应正确');

    const segments = [firstResult.content];
    let cursor = firstResult.cursor;
    let guard = 0;
    let truncated = firstResult.truncated;
    while (truncated && guard < 200) {
      const next = await readFile(baseUrl, { action: 'read', file_paths: [target], cursor, max_length: maxLength });
      expectEqual(next.json.success, true, '续读应成功');
      const result = next.json.result.results[0];
      expect(result.content.length <= maxLength, '续读 content 不应超过 max_length');
      segments.push(result.content);
      truncated = result.truncated;
      cursor = result.cursor;
      guard += 1;
    }
    expect(guard >= 2, `应至少续读两次，实际 ${guard}`);
    expectEqual(truncated, false, '最后一页不应再被截断');
    expectEqual(segments.join(''), source, '所有分段按顺序拼接后应等于原文（无重复、无缺失）');
  } finally {
    await close();
  }
});

test('AC4：start_line/end_line、chars、heading 三种定位读取', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const target = samplePath('large.txt');
    const text = fs.readFileSync(target, 'utf8');
    const lines = text.split('\n');

    const byLine = await readFile(baseUrl, {
      action: 'read',
      file_paths: [target],
      start_line: 10,
      end_line: 12,
      max_length: 100000,
    });
    const lineResult = byLine.json.result.results[0];
    expectEqual(lineResult.content, lines.slice(9, 12).join('\n') + '\n', 'start_line/end_line 应包含端点');
    expectEqual(lineResult.chars, [lines.slice(0, 9).join('\n').length + 1, lines.slice(0, 12).join('\n').length + 1], '行范围对应的 chars 应正确');

    const mdTarget = samplePath('report.md');
    const mdText = fs.readFileSync(mdTarget, 'utf8');
    const byChars = await readFile(baseUrl, { action: 'read', file_paths: [mdTarget], chars: [100, 260] });
    expectEqual(byChars.json.result.results[0].content, mdText.slice(100, 260), 'chars 读取应与切片一致');

    const inspect = await readFile(baseUrl, { action: 'inspect', file_paths: [mdTarget] });
    const outline = flattenOutline(inspect.json.result.results[0].outline);
    const heading = outline.find((entry) => entry.title === '第二章 风险因素');
    expect(Boolean(heading), 'inspect 应返回「第二章 风险因素」标题');
    const byHeading = await readFile(baseUrl, {
      action: 'read',
      file_paths: [mdTarget],
      heading: heading.title,
      max_length: 100000,
    });
    const headingResult = byHeading.json.result.results[0];
    expectEqual(headingResult.content, mdText.slice(heading.chars[0], heading.chars[1]), 'heading 读取应等于标题区间切片');
    expectIncludes(headingResult.content, '## 第二章 风险因素', '标题读取应包含标题行本身');

    const badChars = await readFile(baseUrl, { action: 'read', file_paths: [mdTarget], chars: [260, 100] });
    expectEqual(badChars.json.success, false, '非法 chars 应失败');
    expectIncludes(badChars.json.error, 'chars 范围无效', '错误应说明 chars 范围无效');

    const badLine = await readFile(baseUrl, { action: 'read', file_paths: [mdTarget], start_line: 'abc' });
    expectEqual(badLine.json.success, false, '非法 start_line 应失败');
    expectIncludes(badLine.json.error, 'start_line/end_line 必须是整数', '错误应说明必须是整数');

    const mixed = await readFile(baseUrl, {
      action: 'read',
      file_paths: [mdTarget],
      chars: [0, 10],
      start_line: 1,
    });
    expectEqual(mixed.json.success, false, '同时给多种选择器应失败');
    expectIncludes(mixed.json.error, '只能选择一种', '错误应说明互斥');

    const missingHeading = await readFile(baseUrl, { action: 'read', file_paths: [mdTarget], heading: '不存在的章节' });
    expectEqual(missingHeading.json.success, false, '不存在的标题应失败');
    expectIncludes(missingHeading.json.error, '未找到标题: ', '错误应说明未找到标题');

    const health = await postJson(baseUrl, '/health', {});
    expectEqual(health.status, 404, 'POST /health 应 404（服务未崩溃且路由正确）');
  } finally {
    await close();
  }
});

test('AC5：inspect 章节目录、max_depth 与 max_entries', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const mdTarget = samplePath('report.md');
    const docxTarget = samplePath('report.docx');

    const full = await readFile(baseUrl, { action: 'inspect', file_paths: [mdTarget] });
    const fullOutline = full.json.result.results[0].outline;
    const flatFull = flattenOutline(fullOutline);
    expect(flatFull.length >= 8, `md 目录条目应为 8 条（实际 ${flatFull.length}）`);
    expectEqual(Math.max(...flatFull.map((entry) => entry.level)), 6, 'md 应存在第 6 级标题');
    expect(flatFull.every((entry) => Array.isArray(entry.chars) && entry.chars.length === 2), '每个目录项应带 chars');
    expectEqual(fullOutline[0].title, '年度研究报告', '根标题应为文档首个一级标题');

    const shallow = await readFile(baseUrl, { action: 'inspect', file_paths: [mdTarget], max_depth: 2 });
    const flatShallow = flattenOutline(shallow.json.result.results[0].outline);
    expect(flatShallow.length > 0, 'max_depth=2 仍应返回标题');
    expect(flatShallow.every((entry) => entry.level <= 2), 'max_depth=2 时不应出现 3 级以上标题');

    const limited = await readFile(baseUrl, { action: 'inspect', file_paths: [mdTarget], max_entries: 5 });
    const limitedResult = limited.json.result.results[0];
    const flatLimited = flattenOutline(limitedResult.outline);
    expectEqual(flatLimited.length, 5, 'max_entries=5 时目录条目应为 5 条');
    expectEqual(limitedResult.outline_truncated, true, '被截断时应带 outline_truncated 标记');

    const docx = await readFile(baseUrl, { action: 'inspect', file_paths: [docxTarget] });
    const docxOutline = docx.json.result.results[0].outline;
    const flatDocx = flattenOutline(docxOutline);
    expect(flatDocx.length >= 3, `docx 应解析出标题层级（实际 ${flatDocx.length}）`);
    expectEqual(flatDocx[0].title, '技术方案说明书', 'docx 根标题应正确');
    expect(flatDocx.some((entry) => entry.level === 3), 'docx 应包含三级标题');

    const noHeading = await readFile(baseUrl, { action: 'inspect', file_paths: [samplePath('table.csv')] });
    const noHeadingResult = noHeading.json.result.results[0];
    expectEqual(noHeadingResult.outline.length, 0, 'CSV 无标题结构');
    expectIncludes(noHeadingResult.note, '无标题结构', '无标题文档应给出 note');
  } finally {
    await close();
  }
});

test('AC6：find 关键词与正则、max_results、chars 闭环', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const mdTarget = samplePath('report.md');
    const mdText = fs.readFileSync(mdTarget, 'utf8');

    const keyword = await readFile(baseUrl, {
      action: 'find',
      file_paths: [mdTarget],
      query: '风险点',
      max_results: 5,
      context_chars: 10,
    });
    const keywordResult = keyword.json.result.results[0];
    expectEqual(keywordResult.matches.length, 5, 'max_results=5 时应返回 5 条命中');
    expectEqual(keywordResult.total_matches, 60, '样例中共 60 次命中');
    expectEqual(keywordResult.truncated, true, '命中被截断时应带 truncated');
    expectEqual(keywordResult.matches[0].match, '风险点', '命中文本应正确');
    expectIncludes(keywordResult.matches[0].location, '第二章 风险因素', '命中位置应包含所在章节');
    expect(
      keywordResult.matches[0].snippet.length <= 2 * 10 + '风险点'.length,
      'context_chars=10 时片段长度应受限',
    );

    const regexFind = await readFile(baseUrl, {
      action: 'find',
      file_paths: [mdTarget],
      query: '风险点\\s*\\d+',
      regex: true,
      max_results: 3,
    });
    const regexResult = regexFind.json.result.results[0];
    expect(regexResult.matches.length >= 1, '正则应能命中');
    expectMatch(regexResult.matches[0].match, /^风险点\s*\d+$/, '正则命中内容应匹配模式');

    const closure = await readFile(baseUrl, {
      action: 'read',
      file_paths: [mdTarget],
      chars: keywordResult.matches[0].chars,
      max_length: 100000,
    });
    const closureResult = closure.json.result.results[0];
    expectEqual(
      closureResult.content,
      mdText.slice(keywordResult.matches[0].chars[0], keywordResult.matches[0].chars[1]),
      'find 返回的 chars 应可直接用于 read',
    );
    expectEqual(closureResult.content, keywordResult.matches[0].snippet, 'read(chars) 应等于 find 的 snippet');

    const emptyQuery = await readFile(baseUrl, { action: 'find', file_paths: [mdTarget], query: '' });
    expectEqual(emptyQuery.json.success, false, '空 query 应失败');
    expectIncludes(emptyQuery.json.error, 'find 的 query 不能为空', '错误应说明 query 不能为空');

    const badRegex = await readFile(baseUrl, { action: 'find', file_paths: [mdTarget], query: '([', regex: true });
    expectEqual(badRegex.json.success, false, '非法正则应失败');
    expectIncludes(badRegex.json.error, '正则表达式无效', '错误应说明正则无效');
  } finally {
    await close();
  }
});

test('AC7：多格式 read（txt/md/csv/json/html/docx/pptx/pdf/xlsx）', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const csv = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('table.csv')], max_length: 100000 });
    expectIncludes(csv.json.result.results[0].content, '产品,金额,日期', 'CSV 应返回正文');

    const json = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('data.json')], max_length: 100000 });
    expectIncludes(json.json.result.results[0].content, '"name": "样例数据"', 'JSON 应返回正文');

    const html = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('page.html')], max_length: 100000 });
    expectIncludes(html.json.result.results[0].content, '<h1>样例页面</h1>', 'HTML 应返回正文');

    const gbk = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('gbk.txt')], max_length: 100000 });
    expectIncludes(gbk.json.result.results[0].content, '这是一段 GBK 编码的文本', 'GBK 文本应能正确解码');

    const docx = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('report.docx')], max_length: 100000 });
    const docxContent = docx.json.result.results[0].content;
    expectIncludes(docxContent, '# 技术方案说明书', 'docx 应输出 Markdown 标题');
    expectIncludes(docxContent, '[表格 1]', 'docx 表格应有 [表格 N] 标记');
    expectIncludes(docxContent, '字段 | 说明', 'docx 表格行应用 " | " 连接');

    const pptx = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('slides.pptx')], max_length: 100000 });
    const pptxContent = pptx.json.result.results[0].content;
    expectIncludes(pptxContent, '====第1页====', 'pptx 应有页标记');
    expectIncludes(pptxContent, '====第2页====', 'pptx 应有第二页标记');
    expectIncludes(pptxContent, '指标 | 数值', 'pptx 表格行应用 " | " 连接');
    expectIncludes(pptxContent, '[备注] 这是第二页的备注', 'pptx 应包含备注');

    const pdfPages = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('doc.pdf')], pages: [2], max_length: 100000 });
    const pdfContent = pdfPages.json.result.results[0].content;
    expectIncludes(pdfContent, '====第2页====', 'pages=[2] 应返回第 2 页标记');
    expectIncludes(pdfContent, 'Page two body', 'pages=[2] 应返回第 2 页正文');
    expect(!pdfContent.includes('Page one body'), 'pages=[2] 不应包含第 1 页正文');
    expect(!pdfContent.includes('====第1页===='), 'pages=[2] 不应包含第 1 页标记');

    const pdfAll = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('doc.pdf')], max_length: 100000 });
    const pdfAllContent = pdfAll.json.result.results[0].content;
    for (const page of [1, 2, 3]) {
      expectIncludes(pdfAllContent, `====第${page}页====`, `完整读取应包含第 ${page} 页标记`);
    }

    const xlsx = await readFile(baseUrl, { action: 'read', file_paths: [samplePath('structure.xlsx')], max_length: 200000 });
    const xlsxResult = xlsx.json.result.results[0];
    expectIncludes(xlsxResult.content, '# Sheet: 销售明细', 'xlsx 预览应输出 sheet 标题');
    expectIncludes(
      xlsxResult.content,
      '产品A | 12756 | 产品A | 22864 | 35620',
      'xlsx 预览应包含数据行与公式结果',
    );
    expectIncludes(xlsxResult.content, '2024年度 | 2024年度 | 2025年度 | 2025年度', 'xlsx 预览应包含合并表头行');
    expectIncludes(xlsxResult.note, '仅提供前 50 行文字预览；结构分析请使用 excel_inspector。', 'xlsx 预览应提示改用 excel_inspector');
  } finally {
    await close();
  }
});

test('AC8：不支持类型返回原版语义的中文错误', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const cases = [
      ['unsupported/image.png', '未索引图片当前不支持读取: .png'],
      ['unsupported/audio.mp3', '不支持读取音视频文件: .mp3'],
      ['unsupported/archive.zip', '不支持直接读取压缩包: .zip'],
      ['unsupported/real-archive.zip', '不支持直接读取压缩包: .zip'],
      ['unsupported/binary.bin', '不支持读取二进制文件: .bin'],
      ['unsupported/old.doc', '.doc 格式不支持直接读取，请先用 file_converter 转为'],
      ['unsupported/old.ppt', '.ppt 格式不支持直接读取，请先用 file_converter 转为'],
    ];
    for (const [name, expected] of cases) {
      const response = await readFile(baseUrl, { action: 'read', file_paths: [samplePath(name)] });
      expectEqual(response.json.success, false, `${name} 应返回 success=false`);
      expectIncludes(response.json.error, expected, `${name} 的错误文案应与原版一致`);
      expectIncludes(response.json.error, '所有文件均未能读取：', '全部失败时应给出聚合错误');
    }
    const health = await postJson(baseUrl, '/tools/file_reader', { action: 'bad-action', file_paths: [samplePath('report.md')] });
    expectEqual(health.json.success, false, '非法 action 应失败');
    expectIncludes(health.json.error, 'action 只能是 inspect、read 或 find', 'action 错误文案应与原版一致');
  } finally {
    await close();
  }
});
