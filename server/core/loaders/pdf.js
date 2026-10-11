'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * 原版对应物：FileReaderTool._parse_pdf + _pdf_outline（pypdf → pdfjs-dist）
 *
 * 规范化格式与原件一致：
 *   '====第N页===='（N 从 1 开始），页与页之间用 '\n\n' 连接；
 *   PDF 书签按页插入到对应页标记之后，用每级两个空格缩进。
 */
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    const entry = pathToFileURL(path.join(__dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
    pdfjsPromise = import(entry);
  }
  return pdfjsPromise;
}

/** 把 pdfjs 的 textContent 还原成带换行的文本。 */
function textContentToString(items) {
  const parts = [];
  for (const item of items) {
    if (typeof item.str === 'string') parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }
  return parts.join('');
}

/** 收集书签：pageNumber(1-based) → [{level, title}] */
async function collectOutline(doc, pdfjs) {
  const byPage = new Map();
  let outline;
  try {
    outline = await doc.getOutline();
  } catch (err) {
    return byPage;
  }
  if (!outline) return byPage;

  const walk = async (items, level) => {
    for (const item of items) {
      if (!item) continue;
      let pageNumber = null;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const index = await doc.getPageIndex(dest[0]);
          pageNumber = index + 1;
        }
      } catch (err) {
        pageNumber = null;
      }
      if (typeof item.title === 'string' && pageNumber !== null) {
        if (!byPage.has(pageNumber)) byPage.set(pageNumber, []);
        byPage.get(pageNumber).push({ level, title: item.title });
      }
      if (Array.isArray(item.items) && item.items.length) {
        await walk(item.items, level + 1);
      }
    }
  };
  try {
    await walk(outline, 1);
  } catch (err) {
    // 书签解析失败不影响正文
  }
  return byPage;
}

async function parsePdf(filePath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const outline = await collectOutline(doc, pdfjs);
  const parts = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    parts.push(`====第${index}页====`);
    for (const item of outline.get(index) || []) {
      parts.push(`${'  '.repeat(Math.max(0, item.level - 1))}${item.title}`);
    }
    try {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      parts.push(textContentToString(content.items));
    } catch (exc) {
      parts.push(`[第${index}页解析失败: ${exc.message}]`);
    }
  }
  const text = parts.join('\n\n');
  await doc.destroy();
  return { text, page_count: doc.numPages };
}

module.exports = { parsePdf };
