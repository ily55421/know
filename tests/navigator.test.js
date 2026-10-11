'use strict';

const test = require('node:test');
const crypto = require('node:crypto');

const { DocumentNavigator, clampInt, splitLinesKeepEnds } = require('../server/core/document-navigator');
const { NavigationError } = require('../server/core/navigation-error');
const { documentVersion, dumpsReaderResult, isCompactList } = require('../server/core/reader-schema');
const { expect, expectEqual, expectIncludes, printAssertionSummary } = require('./helpers');

test.after(() => printAssertionSummary(__filename));

const PAGE_TEXT = '====第1页====\nA1\nA2\n====第2页====\nB1\nB2\n';

test('documentVersion 与原版一致（sha256 前 16 位）', () => {
  const text = '样例文本';
  const expected = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 16);
  expectEqual(documentVersion(text), expected, 'documentVersion 应为 sha256 前 16 位');
  expectEqual(documentVersion(text).length, 16, '版本号长度应为 16');
  expect(documentVersion('a') !== documentVersion('b'), '不同文本应产生不同版本号');
  expectEqual(documentVersion(null), documentVersion(''), '空值与空串应等价处理');
});

test('clampInt 复刻 _clamp_int 的默认值与区间行为', () => {
  expectEqual(clampInt(undefined, 50, 1, 100), 50, '非法值应返回默认值');
  expectEqual(clampInt('abc', 50, 1, 100), 50, '非数字字符串应返回默认值');
  expectEqual(clampInt(200, 50, 1, 100), 100, '超过上限应截断');
  expectEqual(clampInt(0, 50, 1, 100), 1, '低于下限应截断到最小值 1');
  expectEqual(clampInt('7', 50, 1, 100), 7, '数字字符串应被解析');
  expectEqual(clampInt(7.9, 50, 1, 100), 7, '浮点应向零取整');
});

test('dumpsReaderResult 保持短原始值数组一行', () => {
  const output = dumpsReaderResult({ chars: [178, 311], nested: { title: '标题', items: [1, 2] }, list: [{ a: 1 }] });
  expectIncludes(output, '"chars": [178, 311]', '短数组应压成一行');
  expect(output.includes('\n'), '对象应多行缩进');
  expect(isCompactList([1, 2, 3]), '原始值数组应判定为紧凑');
  expect(!isCompactList([{ a: 1 }]), '对象数组不应判定为紧凑');
});

test('splitLinesKeepEnds 复刻 Python splitlines(keepends=True)', () => {
  expectEqual(splitLinesKeepEnds('a\nb'), ['a\n', 'b'], '普通换行');
  expectEqual(splitLinesKeepEnds('a\n'), ['a\n'], '结尾换行不产生空行');
  expectEqual(splitLinesKeepEnds('a\r\nb'), ['a\r\n', 'b'], 'CRLF 视为一个换行');
  expectEqual(splitLinesKeepEnds(''), [], '空串没有行');
});

test('页标记与目录：inspect / pages 读取', () => {
  const nav = new DocumentNavigator(PAGE_TEXT, 'demo.txt', documentVersion(PAGE_TEXT));
  const info = nav.inspect();
  expectEqual(info.page_count, 2, '应识别 2 页');
  expectEqual(info.total_chars, PAGE_TEXT.length, 'total_chars 应为文本长度');
  expectIncludes(info.note, '无标题结构，可按 pages 读取', '无标题但有页时应给出提示');

  const page2 = nav.read({ pages: [2] });
  expectEqual(page2.content, '====第2页====\nB1\nB2', '按页读取会保留页标记并 strip 首尾空白');
  expectEqual(page2.location, '第2页', '位置应为第 2 页');
  expectEqual(page2.truncated, false, '短页不应截断');
  expect(page2.chars === undefined, '页模式下不返回 chars');

  let error = null;
  try {
    nav.read({ pages: [9] });
  } catch (err) {
    error = err;
  }
  expect(error instanceof NavigationError, '不存在的页码应抛 NavigationError');
  expectIncludes(error.message, '页码不存在: ', '错误文案应包含「页码不存在」');
});

test('游标：编码格式、版本校验、越界校验与续读', () => {
  const version = documentVersion(PAGE_TEXT);
  const nav = new DocumentNavigator(PAGE_TEXT, 'demo.txt', version);

  const first = nav.read({ pages: [1, 2], max_length: 12 });
  expectEqual(first.truncated, true, 'max_length=12 应截断');
  expectIncludes(first.cursor, `v2:${version}:12:p:`, '游标应为 v2 格式并记录页模式');
  let combined = first.content;
  let cursor = first.cursor;
  let guard = 0;
  while (cursor && guard < 10) {
    const next = nav.read({ cursor });
    combined += next.content;
    cursor = next.cursor;
    guard += 1;
  }
  expectEqual(combined, nav._selectRanges(nav._pageRanges([1, 2]), true), '续读应恰好覆盖所选页面文本');

  const badVersion = new DocumentNavigator(PAGE_TEXT, 'demo.txt', 'ffffffffffffffff');
  errorOf(() => badVersion.read({ cursor: first.cursor }), '续读游标已失效，请重新读取文档');
  errorOf(() => nav.read({ cursor: 'v1:x:0:r:0-5' }), '续读游标已失效，请重新读取文档');
  errorOf(() => nav.read({ cursor: `v2:${version}:9999:r:0-10` }), '续读游标超出文档范围');
  errorOf(() => nav.read({ cursor: `v2:${version}:0:r:10-5` }), '续读游标格式无效');
});

test('标题：不唯一与未找到的错误语义', () => {
  const text = '# 重复\n\nA\n\n# 重复\n\nB\n';
  const nav = new DocumentNavigator(text, 'demo.md', documentVersion(text));
  errorOf(() => nav.read({ heading: '重复' }), '标题不唯一');
  errorOf(() => nav.read({ heading: '不存在' }), '未找到标题: 不存在');
  const info = nav.inspect();
  expectEqual(info.outline.length, 2, '两个同名一级标题都应在目录中');
  expectEqual(info.outline[0].title, '重复', '目录标题应正确');
});

test('互斥选择器与全文读取', () => {
  const text = 'line1\nline2\nline3\n';
  const nav = new DocumentNavigator(text, 'demo.txt', documentVersion(text));
  errorOf(() => nav.read({ pages: [1], chars: [0, 3] }), '只能选择一种');
  const all = nav.read({});
  expectEqual(all.content, text, '无选择器时应返回全文');
  expectEqual(all.truncated, false, '全文未被截断');
  expectEqual(all.chars, [0, text.length], '非页模式应返回 chars');
  const lines = nav.read({ start_line: 2, end_line: 2 });
  expectEqual(lines.content, 'line2\n', '单行读取应包含行尾换行');
});

function errorOf(fn, expectedMessage) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error instanceof NavigationError, `应抛出 NavigationError（期望包含「${expectedMessage}」）`);
  expectIncludes(error.message, expectedMessage, `错误文案应包含「${expectedMessage}」`);
}
