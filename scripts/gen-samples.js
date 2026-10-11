'use strict';

/**
 * 生成测试样例外加不支持类型样例。
 * 可重复执行：每次重新生成 samples/ 下的全部文件。
 *
 *   node scripts/gen-samples.js      （等价于 npm run gen:samples）
 */

const fs = require('node:fs');
const path = require('node:path');

const docx = require('docx');
const PptxGenJS = require('pptxgenjs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const iconv = require('iconv-lite');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const UNSUPPORTED = path.join(SAMPLES, 'unsupported');

const LARGE_TXT_LINES = 3200;
const FIND_KEYWORD = '风险点';
const FIND_KEYWORD_OCCURRENCES = 30;

function ensureDirs() {
  fs.rmSync(SAMPLES, { recursive: true, force: true });
  fs.mkdirSync(UNSUPPORTED, { recursive: true });
}

function writeLargeTxt() {
  const lines = [];
  for (let i = 1; i <= LARGE_TXT_LINES; i += 1) {
    lines.push(`第${i}行：这是用于验证分段续读的中文正文内容，编号 ${i}，包含逗号、句号与全角字符。`);
  }
  fs.writeFileSync(path.join(SAMPLES, 'large.txt'), lines.join('\n') + '\n', 'utf8');
}

function markdownBody(index) {
  const lines = [];
  for (let i = 0; i < 4; i += 1) {
    lines.push(`这是第 ${index} 节第 ${i + 1} 段正文，用于验证按标题读取与切片一致性。`);
  }
  return lines.join('\n\n');
}

function writeMarkdown() {
  const lines = [];
  lines.push('# 年度研究报告');
  lines.push('');
  lines.push(markdownBody(1));
  lines.push('');
  lines.push('## 第一章 背景');
  lines.push('');
  lines.push(markdownBody(2));
  lines.push('');
  lines.push('### 1.1 行业现状');
  lines.push('');
  lines.push(markdownBody(3));
  lines.push('');
  lines.push('#### 1.1.1 市场规模');
  lines.push('');
  lines.push(markdownBody(4));
  lines.push('');
  lines.push('##### 1.1.1.1 数据来源');
  lines.push('');
  lines.push(markdownBody(5));
  lines.push('');
  lines.push('###### 1.1.1.1.1 口径说明');
  lines.push('');
  lines.push(markdownBody(6));
  lines.push('');
  lines.push('## 第二章 风险因素');
  lines.push('');
  for (let i = 1; i <= FIND_KEYWORD_OCCURRENCES; i += 1) {
    lines.push(`${FIND_KEYWORD} ${i}：这是第 ${i} 条${FIND_KEYWORD}的说明文本。`);
    lines.push('');
  }
  lines.push('## 第三章 结论');
  lines.push('');
  lines.push(markdownBody(7));
  lines.push('');
  fs.writeFileSync(path.join(SAMPLES, 'report.md'), lines.join('\n'), 'utf8');
}

function writeCsv() {
  const rows = ['产品,金额,日期'];
  for (let i = 1; i <= 20; i += 1) {
    rows.push(`产品${i},${1000 + i * 37},2025-01-${String((i % 28) + 1).padStart(2, '0')}`);
  }
  fs.writeFileSync(path.join(SAMPLES, 'table.csv'), rows.join('\n') + '\n', 'utf8');
}

function writeJson() {
  const payload = { name: '样例数据', items: [] };
  for (let i = 1; i <= 15; i += 1) payload.items.push({ id: i, title: `条目 ${i}`, score: i * 3 });
  fs.writeFileSync(path.join(SAMPLES, 'data.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function writeHtml() {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>样例页面</title></head>',
    '<body>',
    '<h1>样例页面</h1>',
    '<p>这是用于验证 HTML 文本读取的段落。</p>',
    '<ul><li>条目一</li><li>条目二</li></ul>',
    '</body>',
    '</html>',
  ].join('\n');
  fs.writeFileSync(path.join(SAMPLES, 'page.html'), html, 'utf8');
}

function writeGbkText() {
  const text = '这是一段 GBK 编码的文本，用于验证编码回退顺序。\n第二行内容。\n';
  fs.writeFileSync(path.join(SAMPLES, 'gbk.txt'), iconv.encode(text, 'gbk'));
}

async function writeDocx() {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = docx;
  const children = [];
  children.push(new Paragraph({ text: '技术方案说明书', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: '本文档用于验证 docx 解析：标题层级、段落与表格。' }));
  children.push(new Paragraph({ text: '第一章 总体设计', heading: HeadingLevel.HEADING_2 }));
  children.push(new Paragraph({ text: '系统分为解析层与导航层两部分。' }));
  children.push(new Paragraph({ text: '第二章 数据结构', heading: HeadingLevel.HEADING_3 }));
  children.push(new Paragraph({ text: '下表列出关键字段。' }));
  children.push(
    new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun('字段')] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun('说明')] })] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun('cursor')] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun('续读游标')] })] }),
          ],
        }),
      ],
    }),
  );
  children.push(new Paragraph({ text: '第三章 风险分析', heading: HeadingLevel.HEADING_2 }));
  children.push(new Paragraph({ text: `${FIND_KEYWORD}：解析失败时的回退策略。` }));

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(path.join(SAMPLES, 'report.docx'), buffer);
}

async function writePptx() {
  const pptx = new PptxGenJS();
  const slide1 = pptx.addSlide();
  slide1.addText('产品发布说明', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 28 });
  slide1.addText('第一页正文：介绍发布范围与时间安排。', { x: 0.5, y: 2, w: 9, h: 1 });

  const slide2 = pptx.addSlide();
  slide2.addText('第二章 关键指标', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 24 });
  slide2.addText('第二页正文：本页包含一个表格。', { x: 0.5, y: 1.8, w: 9, h: 0.6 });
  slide2.addTable(
    [
      [{ text: '指标' }, { text: '数值' }],
      [{ text: '日活' }, { text: '12345' }],
    ],
    { x: 0.5, y: 2.6, w: 6, h: 1 },
  );
  slide2.addNotes('这是第二页的备注：需要重点说明指标口径。');

  const slide3 = pptx.addSlide();
  slide3.addText('第三章 后续计划', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 24 });
  slide3.addText('第三页正文：下一步动作与负责团队。', { x: 0.5, y: 2, w: 9, h: 1 });

  await pptx.writeFile({ fileName: path.join(SAMPLES, 'slides.pptx') });
}

async function writePdf() {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(path.join(SAMPLES, 'doc.pdf'));
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.addPage();
    doc.fontSize(20).text('Sample Report Page One', { align: 'left' });
    doc.fontSize(12).text('Page one body: project background and scope.');
    doc.addPage();
    doc.fontSize(20).text('Sample Report Page Two');
    doc.fontSize(12).text('Page two body: key risks and mitigations.');
    doc.addPage();
    doc.fontSize(20).text('Sample Report Page Three');
    doc.fontSize(12).text('Page three body: conclusions and recommendations.');
    doc.end();
  });
}

async function writeStructureXlsx() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'knowly-file-tools samples';
  const sheet = workbook.addWorksheet('销售明细');

  // 第 1 行：合并的分组表头（A1:B1 / C1:D1）
  sheet.getCell('A1').value = '2024年度';
  sheet.getCell('C1').value = '2025年度';
  sheet.mergeCells('A1:B1');
  sheet.mergeCells('C1:D1');

  // 第 2 行：列名
  const headerRow = sheet.getRow(2);
  const headerNames = ['产品', '金额', '产品', '金额'];
  for (let col = 1; col <= headerNames.length; col += 1) {
    const cell = headerRow.getCell(col);
    cell.value = headerNames[col - 1];
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  }
  sheet.getRow(1).font = { bold: true };

  // 第 3-12 行：数据
  for (let i = 3; i <= 12; i += 1) {
    sheet.getCell(`A${i}`).value = `产品${String.fromCharCode(64 + (i - 2))}`;
    sheet.getCell(`B${i}`).value = 12345 + i * 137;
    sheet.getCell(`C${i}`).value = `产品${String.fromCharCode(64 + (i - 2))}`;
    sheet.getCell(`D${i}`).value = 22345 + i * 173;
  }

  // 第 13 行：合计行（合并 + 加粗 + 汇总关键字），行内带公式
  sheet.getCell('A13').value = '合计';
  sheet.mergeCells('A13:D13');
  sheet.getCell('A13').font = { bold: true };
  sheet.getCell('A13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

  // E 列公式：每行合计
  for (let i = 3; i <= 12; i += 1) {
    sheet.getCell(`E${i}`).value = { formula: `SUM(B${i},D${i})`, result: 34690 + i * 310 };
  }
  sheet.getCell('E2').value = '计算值';
  sheet.getCell('E13').value = { formula: 'SUM(E3:E12)', result: 381890 };

  // 第 14 行：层级标记行
  sheet.getCell('A14').value = '一、重点客户明细';
  sheet.getCell('B14').value = 98765;

  // 隐藏行与隐藏列
  sheet.getRow(8).hidden = true;
  sheet.getColumn(5).hidden = true;

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

  // 数据验证（下拉列表）
  sheet.getCell('F3').dataValidation = { type: 'list', allowBlank: true, formulae: ['"增长,持平,下降"'] };

  // 批注
  sheet.getCell('B3').note = '金额单位：元';

  // 命名范围
  workbook.definedNames.add('销售明细!$B$3:$B$12', '金额范围');

  await workbook.xlsx.writeFile(path.join(SAMPLES, 'structure.xlsx'));

}

/** 第二张 sheet：150 行数据，用于验证 analysis_depth 的采样上限（20/50/100）。 */
async function writeBigSheetXlsx() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('明细大表');
  const header = sheet.getRow(1);
  const names = ['编号', '客户', '金额'];
  for (let col = 1; col <= names.length; col += 1) {
    const cell = header.getCell(col);
    cell.value = names[col - 1];
    cell.font = { bold: true };
  }
  for (let i = 1; i <= 150; i += 1) {
    sheet.getCell(`A${i + 1}`).value = 1000000 + i;
    sheet.getCell(`B${i + 1}`).value = `客户${i}`;
    sheet.getCell(`C${i + 1}`).value = 100000 + i * 13;
  }
  await workbook.xlsx.writeFile(path.join(SAMPLES, 'big-table.xlsx'));
}
function writeUnsupportedSamples() {
  // 最小合法 PNG（1x1 像素）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AOv0HwAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(path.join(UNSUPPORTED, 'image.png'), png);
  fs.writeFileSync(path.join(UNSUPPORTED, 'audio.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
  fs.writeFileSync(path.join(UNSUPPORTED, 'archive.zip'), Buffer.from('PK\u0003\u0004', 'binary'));
  fs.writeFileSync(path.join(UNSUPPORTED, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
  fs.writeFileSync(path.join(UNSUPPORTED, 'old.doc'), Buffer.from('DOC-LEGACY-PLACEHOLDER', 'utf8'));
  fs.writeFileSync(path.join(UNSUPPORTED, 'old.ppt'), Buffer.from('PPT-LEGACY-PLACEHOLDER', 'utf8'));
}

async function writeExtraZipSample() {
  // 一个真实可解压的 zip（仍属于“压缩包不支持直接读取”的样例）
  const zip = new JSZip();
  zip.file('inner.txt', '压缩包内部文件内容。');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(path.join(UNSUPPORTED, 'real-archive.zip'), buffer);
}

async function main() {
  ensureDirs();
  writeLargeTxt();
  writeMarkdown();
  writeCsv();
  writeJson();
  writeHtml();
  writeGbkText();
  await writeDocx();
  await writePptx();
  await writePdf();
  await writeStructureXlsx();
  writeUnsupportedSamples();
  await writeBigSheetXlsx();
  await writeExtraZipSample();
  const files = fs.readdirSync(SAMPLES, { withFileTypes: true });
  console.log(`samples 生成完成：${SAMPLES}`);
  for (const entry of files) {
    if (entry.isFile()) {
      const stat = fs.statSync(path.join(SAMPLES, entry.name));
      console.log(`  ${entry.name} (${stat.size} 字节)`);
    } else {
      console.log(`  ${entry.name}/`);
    }
  }
}

main().catch((err) => {
  console.error('生成样例失败:', err);
  process.exitCode = 1;
});
