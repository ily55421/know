'use strict';

const nodePath = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

/**
 * 原版对应物：FileReaderTool._parse_excel_preview（pandas.read_excel → exceljs / SheetJS）
 *
 * 规范化格式与原件一致：每个 sheet 先输出 '# Sheet: 名称'，再输出前 50 行；
 * 返回结果带 preview_only=True 与 sheet_names，提示结构分析改用 excel_inspector。
 */
const PREVIEW_ROWS = 50;

function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.formula) return `=${value.formula}`;
    if (value.hyperlink) return String(value.text ?? value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}

async function parseExcelPreviewXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const parts = [];
  const sheetNames = [];
  for (const worksheet of workbook.worksheets) {
    sheetNames.push(worksheet.name);
    parts.push(`# Sheet: ${worksheet.name}`);
    const maxRow = Math.min(worksheet.rowCount || 0, PREVIEW_ROWS);
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const cells = [];
      const maxCol = Math.min(Math.max(row.cellCount || 0, 1), 200);
      for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
        cells.push(cellToText(row.getCell(colNumber).value));
      }
      parts.push(cells.join(' | '));
    }
  }
  return { text: parts.join('\n\n'), sheet_names: sheetNames, preview_only: true };
}

function parseExcelPreviewXls(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    parts.push(`# Sheet: ${sheetName}`);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, blankrows: true });
    for (const row of rows.slice(0, PREVIEW_ROWS)) {
      parts.push(row.map((cell) => cellToText(cell)).join(' | '));
    }
  }
  return { text: parts.join('\n\n'), sheet_names: workbook.SheetNames, preview_only: true };
}

async function parseExcelPreview(filePath) {
  const ext = nodePath.extname(filePath).toLowerCase();
  const parsed = ext === '.xls' ? parseExcelPreviewXls(filePath) : await parseExcelPreviewXlsx(filePath);
  return {
    ...parsed,
    // 原版常量：读取 Excel 只给预览，结构分析交给 excel_inspector
    note: '仅提供前 50 行文字预览；结构分析请使用 excel_inspector。',
  };
}
module.exports = { parseExcelPreview, PREVIEW_ROWS };
