'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

/**
 * 原版对应物：FileReaderTool._parse_pptx（python-pptx → jszip + XML）
 *
 * 规范化规则与原件一致：
 *   每页起始 '====第N页===='；标题占位符文本输出 '# ' + 标题；
 *   文本框段落逐行输出；表格行用 ' | ' 连接；备注输出 '[备注] ' + 备注文本；
 *   所有片段用 '\n\n' 连接。
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  textNodeName: '#text',
});

function nodes(children, name) {
  if (!Array.isArray(children)) return [];
  return children.filter((node) => node && Object.prototype.hasOwnProperty.call(node, name));
}

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

function containsTag(children, tag) {
  if (!Array.isArray(children)) return false;
  for (const node of children) {
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue;
      if (key === tag) return true;
      if (containsTag(value, tag)) return true;
    }
  }
  return false;
}

/** a:p 列表 → 多行文本 */
function paragraphsText(textBodyChildren) {
  return nodes(textBodyChildren, 'p')
    .map((paragraphNode) => collectText(kids(paragraphNode, 'p')))
    .join('\n');
}

function placeholderType(shapeChildren) {
  const nvSpPr = firstNode(shapeChildren, 'nvSpPr');
  if (!nvSpPr) return null;
  const nvPr = firstNode(kids(nvSpPr, 'nvSpPr'), 'nvPr');
  if (!nvPr) return null;
  const ph = firstNode(kids(nvPr, 'nvPr'), 'ph');
  if (!ph) return null;
  const type = attrs(ph)['@_type'];
  return type === undefined ? null : String(type);
}

function tableTexts(tableChildren) {
  const rows = [];
  for (const rowNode of nodes(tableChildren, 'tr')) {
    const cells = nodes(kids(rowNode, 'tr'), 'tc').map((cellNode) => collectText(kids(cellNode, 'tc')).trim());
    rows.push(cells.join(' | '));
  }
  return rows;
}

/** p:graphicFrame 里的表格（PPTX 表格不在 p:sp 内） */
function graphicFrameTables(spTreeChildren) {
  const rows = [];
  for (const frameNode of nodes(spTreeChildren, 'graphicFrame')) {
    const graphic = firstNode(kids(frameNode, 'graphicFrame'), 'graphic');
    if (!graphic) continue;
    const graphicData = firstNode(kids(graphic, 'graphic'), 'graphicData');
    if (!graphicData) continue;
    for (const tableNode of nodes(kids(graphicData, 'graphicData'), 'tbl')) {
      rows.push(...tableTexts(kids(tableNode, 'tbl')));
    }
  }
  return rows;
}

function slideIndex(zipPath) {
  const match = zipPath.match(/slide(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function notesIndex(zipPath) {
  const match = zipPath.match(/notesSlide(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function relsTargets(relsXml) {
  const targets = new Map();
  const parsed = parser.parse(relsXml);
  const root = firstNode(parsed, 'Relationships');
  if (!root) return targets;
  for (const relNode of nodes(kids(root, 'Relationships'), 'Relationship')) {
    const attributes = attrs(relNode);
    if (attributes['@_Type'] && String(attributes['@_Type']).endsWith('/notesSlide')) {
      const target = String(attributes['@_Target']).replace(/^\.\.\//, 'ppt/').replace(/^\.\//, '');
      targets.set(String(attributes['@_Id']), target.startsWith('ppt/') ? target : `ppt/${target}`);
    }
  }
  return targets;
}

async function notesText(zip, notesPath) {
  const entry = zip.file(notesPath);
  if (!entry) return '';
  const parsed = parser.parse(await entry.async('string'));
  const notesChildren = kids(firstNode(parsed, 'notes'), 'notes');
  const cSld = firstNode(notesChildren, 'cSld');
  const spTree = cSld ? firstNode(kids(cSld, 'cSld'), 'spTree') : null;
  if (!spTree) return '';

  const lines = [];
  for (const shapeNode of nodes(kids(spTree, 'spTree'), 'sp')) {
    const type = placeholderType(kids(shapeNode, 'sp'));
    if (type === 'sldNum' || type === 'sldImg' || type === 'slideImage') continue;
    const txBody = firstNode(kids(shapeNode, 'sp'), 'txBody');
    if (!txBody) continue;
    const bodyChildren = kids(txBody, 'txBody');
    // 纯页码字段（a:fld type="slidenum"）不计入备注
    if (containsTag(bodyChildren, 'fld') && collectText(bodyChildren).trim().length <= 4) continue;
    const text = paragraphsText(bodyChildren).trim();
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

async function parsePptx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  const parts = [];
  for (let i = 0; i < slidePaths.length; i += 1) {
    const index = i + 1;
    parts.push(`====第${index}页====`);
    const parsed = parser.parse(await zip.file(slidePaths[i]).async('string'));
    const sldChildren = kids(firstNode(parsed, 'sld'), 'sld');
    const cSld = firstNode(sldChildren, 'cSld');
    const spTree = cSld ? firstNode(kids(cSld, 'cSld'), 'spTree') : null;
    const spTreeChildren = spTree ? kids(spTree, 'spTree') : [];

    const titleTypes = new Set(['title', 'ctrTitle']);
    const shapes = nodes(spTreeChildren, 'sp');
    for (const shapeNode of shapes) {
      const shapeChildren = kids(shapeNode, 'sp');
      const type = placeholderType(shapeChildren);
      if (!type || !titleTypes.has(type)) continue;
      const txBody = firstNode(shapeChildren, 'txBody');
      const title = txBody ? paragraphsText(kids(txBody, 'txBody')).replace(/\s+/g, ' ').trim() : '';
      if (title) parts.push(`# ${title}`);
    }
    for (const shapeNode of shapes) {
      const shapeChildren = kids(shapeNode, 'sp');
      const type = placeholderType(shapeChildren);
      if (type && titleTypes.has(type)) continue;
      const txBody = firstNode(shapeChildren, 'txBody');
      if (txBody) {
        const text = paragraphsText(kids(txBody, 'txBody')).trim();
        if (text) parts.push(text);
        for (const tableNode of nodes(kids(txBody, 'txBody'), 'tbl')) {
          parts.push(...tableTexts(kids(tableNode, 'tbl')));
        }
      }
    }
    parts.push(...graphicFrameTables(spTreeChildren));

    // 备注：优先按 rels 关联，找不到则按序号匹配
    let notesPath = null;
    const relsEntry = zip.file(`ppt/slides/_rels/slide${index}.xml.rels`);
    if (relsEntry) {
      const targets = relsTargets(await relsEntry.async('string'));
      notesPath = [...targets.values()][0] || null;
    }
    if (!notesPath && zip.file(`ppt/notesSlides/notesSlide${index}.xml`)) {
      notesPath = `ppt/notesSlides/notesSlide${index}.xml`;
    }
    if (notesPath) {
      const text = await notesText(zip, notesPath);
      if (text) parts.push(`[备注] ${text}`);
    }
  }

  return { text: parts.join('\n\n'), page_count: slidePaths.length };
}

module.exports = { parsePptx };
