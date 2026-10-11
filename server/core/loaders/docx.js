'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

/**
 * 原版对应物：FileReaderTool._parse_docx（python-docx → jszip + XML）
 *
 * 规范化规则与原件一致：
 *   段落样式名匹配 ^(?:Heading|标题)\s*([1-6])$ 时输出 '#'*level + ' ' + 文本；
 *   表格输出 '[表格 N]'，随后每行用 ' | ' 连接单元格文本；
 *   所有片段（段落与表格行）最后用 '\n\n' 连接。
 *
 * 实现说明：fast-xml-parser 的 preserveOrder 模式里，一个节点形如
 *   { 标签名: [子节点…], ':@': { 属性… } }
 * 因此取属性必须拿到“节点对象”本身，而不是 node[标签名]。
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  textNodeName: '#text',
});

const HEADING_STYLE_RE = /^(?:heading|标题)\s*([1-6])$/i;
const HEADING_STYLE_ID_RE = /^heading\s*([1-6])$/i;

/** 从子节点数组里挑出指定标签的“节点对象”。 */
function nodes(children, name) {
  if (!Array.isArray(children)) return [];
  return children.filter((node) => node && Object.prototype.hasOwnProperty.call(node, name));
}

/** 取节点的子节点数组。 */
function kids(node, name) {
  if (!node || !Array.isArray(node[name])) return [];
  return node[name];
}

function attrs(node) {
  return (node && node[':@']) || {};
}

function firstNode(children, name) {
  return nodes(children, name)[0] || null;
}

/** 递归收集所有文本节点（w:t → t）。 */
function collectText(children) {
  if (!Array.isArray(children)) return '';
  let out = '';
  for (const node of children) {
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === '#text') {
        out += String(value);
        continue;
      }
      if (key === ':@') continue;
      out += collectText(value);
    }
  }
  return out;
}

function rootChildren(parsed, name) {
  return kids(firstNode(parsed, name), name);
}

/** word/styles.xml → styleId → 样式名 */
async function loadStyleNames(zip) {
  const entry = zip.file('word/styles.xml');
  const map = new Map();
  if (!entry) return map;
  const parsed = parser.parse(await entry.async('string'));
  for (const styleNode of nodes(rootChildren(parsed, 'styles'), 'style')) {
    const styleId = attrs(styleNode)['@_styleId'];
    if (!styleId) continue;
    const nameNode = firstNode(kids(styleNode, 'style'), 'name');
    const name = nameNode ? attrs(nameNode)['@_val'] : undefined;
    map.set(String(styleId), String(name ?? styleId));
  }
  return map;
}

function headingLevel(styleId, styleIdToName) {
  if (!styleId) return 0;
  const name = (styleIdToName.get(styleId) || styleId).replace(/\u00a0/g, ' ');
  let match = name.match(HEADING_STYLE_RE);
  if (match) return Number.parseInt(match[1], 10);
  match = String(styleId).match(HEADING_STYLE_ID_RE);
  if (match) return Number.parseInt(match[1], 10);
  return 0;
}

function paragraphStyleId(paragraphChildren) {
  const propsNode = firstNode(paragraphChildren, 'pPr');
  if (!propsNode) return undefined;
  const styleNode = firstNode(kids(propsNode, 'pPr'), 'pStyle');
  if (!styleNode) return undefined;
  const value = attrs(styleNode)['@_val'];
  return value === undefined ? undefined : String(value);
}

function tableRows(tableChildren) {
  const rows = [];
  for (const rowNode of nodes(tableChildren, 'tr')) {
    const cells = nodes(kids(rowNode, 'tr'), 'tc').map((cellNode) => collectText(kids(cellNode, 'tc')).trim());
    rows.push(cells.join(' | '));
  }
  return rows;
}

async function parseDocx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const docEntry = zip.file('word/document.xml');
  if (!docEntry) throw new Error('缺少 word/document.xml');
  const parsed = parser.parse(await docEntry.async('string'));
  const styleIdToName = await loadStyleNames(zip);

  const documentNode = firstNode(parsed, 'document');
  const bodyNode = documentNode ? firstNode(kids(documentNode, 'document'), 'body') : null;
  const bodyChildren = bodyNode ? kids(bodyNode, 'body') : [];
  const parts = [];
  let paragraphCount = 0;
  let tableCount = 0;

  for (const item of bodyChildren) {
    if (Object.prototype.hasOwnProperty.call(item, 'p')) {
      paragraphCount += 1;
      const paragraphChildren = kids(item, 'p');
      const text = collectText(paragraphChildren);
      const level = headingLevel(paragraphStyleId(paragraphChildren), styleIdToName);
      parts.push(level ? `${'#'.repeat(level)} ${text}`.trimEnd() : text);
    } else if (Object.prototype.hasOwnProperty.call(item, 'tbl')) {
      tableCount += 1;
      parts.push(`[表格 ${tableCount}]`);
      for (const row of tableRows(kids(item, 'tbl'))) parts.push(row);
    }
  }

  return {
    text: parts.join('\n\n'),
    paragraph_count: paragraphCount,
    table_count: tableCount,
  };
}

module.exports = { parseDocx };
