'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

/**
 * 原版对应物：src/tools/excel_inspector.py（ExcelInspectorTool）
 *
 * 深度分析 Excel 结构：合并单元格、多层表头、公式、样式、隐藏行列、数据验证、
 * 批注、冻结窗格、多表格区域、条件格式，并给出数据预览与列分布摘要。
 * 仅支持 .xlsx / .xlsm（深度分析）与 .xls（基础模式）。
 */

const MAX_FILE_SIZE = 104857600; // 100MB
const ANALYSIS_DEPTH_ROWS = { basic: 20, standard: 50, deep: 100 };
const DEFAULT_DEPTH = 'standard';
const DEFAULT_PREVIEW_ROWS = 2;
const HEADER_SCAN_ROWS = 30;
const MAX_SCANNED_COLS = 200;
const HEADER_MERGES_PREVIEW = 10;
const HIDDEN_ROWS_PREVIEW = 20;
const FORMULA_SAMPLE_LIMIT = 50;
const COLUMN_DETAIL_LIMIT = 20;

const SUMMARY_KEYWORDS = ['合计', '小计', '总计', '总额', '汇总', 'total', 'sum', 'subtotal'];
const HIERARCHY_MARKERS = [
  '一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、', '九、', '十、',
  '（一）', '（二）', '（三）', '1.', '2.', '3.', '1、', '2、', '3、',
];

function columnLetter(index) {
  let value = index;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function columnIndex(letters) {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

/** 'A1:B2' → {top,left,bottom,right} */
function decodeRange(range) {
  const match = String(range).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    left: columnIndex(match[1]),
    top: Number.parseInt(match[2], 10),
    right: columnIndex(match[3]),
    bottom: Number.parseInt(match[4], 10),
  };
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.formula) return `=${value.formula}`;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink) return String(value.text ?? value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}

function numericValue(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.result === 'number') return value.result;
  return null;
}

function cellFormula(cell) {
  if (cell.formula) return String(cell.formula);
  const value = cell.value;
  if (value && typeof value === 'object' && typeof value.formula === 'string') return value.formula;
  if (typeof value === 'string' && value.startsWith('=')) return value.slice(1);
  return null;
}

/** 一行是否“像数据行”（原版 _looks_like_data_row 的内容特征启发式）。 */
function looksLikeDataRow(texts) {
  for (const text of texts) {
    if (!text) continue;
    const value = Number(text);
    if (Number.isFinite(value) && Math.abs(value) >= 100000000) return true;
    if (/\d{5,}/.test(text)) return true;
    if (/^[A-Za-z]+\d{6,}$/.test(text)) return true;
    if (text.length > 15) return true;
  }
  return false;
}

function detectFormulaType(formula) {
  const upper = String(formula).toUpperCase();
  if (upper.includes('SUM(')) return '求和';
  if (upper.includes('AVERAGE(')) return '平均值';
  if (upper.includes('COUNT(')) return '计数';
  if (upper.includes('VLOOKUP(') || upper.includes('XLOOKUP(')) return '查找引用';
  if (upper.includes('IF(')) return '条件判断';
  if (upper.includes('SUMIF(') || upper.includes('COUNTIF(')) return '条件汇总';
  if (/[+\-*/]/.test(formula)) return '四则运算';
  return '其他';
}

function buildGrid(worksheet, maxRows, maxCols) {
  const rows = [];
  const limit = Math.min(worksheet.rowCount || 0, maxRows);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = [];
    const texts = [];
    const numbers = [];
    for (let colNumber = 1; colNumber <= maxCols; colNumber += 1) {
      const cell = row.getCell(colNumber);
      const text = cellText(cell.value);
      cells.push(cell);
      texts.push(text);
      numbers.push(numericValue(cell.value));
    }
    rows.push({ rowNumber, row, cells, texts, numbers, nonEmpty: texts.filter((t) => t !== '').length });
  }
  return rows;
}

class ExcelInspectorTool {
  static get name() {
    return 'excel_inspector';
  }

  static get displayName() {
    return 'Excel结构分析';
  }

  static schema() {
    return {
      name: 'excel_inspector',
      display_name: 'Excel结构分析',
      description:
        '深度分析 Excel 文件结构（合并单元格、多层表头、公式、样式、隐藏行列等），支持探测各种复杂excel内容结构。在分析 Excel 数据前可以用此工具了解文件结构。仅支持 .xlsx / .xls / .xlsm。',
      category: 'data_analysis',
      parameters: {
        type: 'object',
        properties: {
          file_path: { name: 'file_path', type: 'string', description: 'Excel 文件路径（相对路径或绝对路径）', required: true },
          preview_rows: { name: 'preview_rows', type: 'number', description: '预览前N行数据，默认2', required: false, default: 2 },
          analysis_depth: {
            name: 'analysis_depth',
            type: 'string',
            description: '分析深度：basic（前20行）、standard（前50行，默认）、deep（前100行）',
            required: false,
            default: 'standard',
          },
        },
      },
    };
  }

  static _resolvePath(inputPath, userFolders = []) {
    if (!inputPath) return null;
    if (nodePath.isAbsolute(inputPath)) return fs.existsSync(inputPath) ? inputPath : null;
    for (const folder of userFolders) {
      const candidate = nodePath.resolve(folder, inputPath);
      if (fs.existsSync(candidate)) return candidate;
    }
    const fallback = nodePath.resolve(process.cwd(), inputPath);
    return fs.existsSync(fallback) ? fallback : null;
  }

  static async execute(parameters = {}, context = {}) {
    const filePathInput = parameters.file_path;
    let previewRows = Number.isFinite(Number(parameters.preview_rows)) ? Math.max(0, Math.trunc(Number(parameters.preview_rows))) : DEFAULT_PREVIEW_ROWS;
    let analysisDepth = parameters.analysis_depth ?? DEFAULT_DEPTH;
    if (!['basic', 'standard', 'deep'].includes(analysisDepth)) analysisDepth = DEFAULT_DEPTH;
    const sampleRows = ANALYSIS_DEPTH_ROWS[analysisDepth];

    if (!filePathInput || typeof filePathInput !== 'string') {
      return { success: false, error: '必须提供 file_path' };
    }
    const userFolders = Array.isArray(context.user_selected_folders) ? context.user_selected_folders : [];
    const resolved = ExcelInspectorTool._resolvePath(filePathInput, userFolders);
    if (!resolved) {
      return { success: false, error: `文件不存在: ${filePathInput}` };
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, error: `路径是目录不是文件: ${filePathInput}` };
    }
    const ext = nodePath.extname(resolved).toLowerCase();
    if (!['.xlsx', '.xlsm', '.xls'].includes(ext)) {
      return {
        success: false,
        error: `仅支持 Excel 文件（.xlsx / .xls / .xlsm），当前类型: ${ext || '无扩展名'}`,
      };
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: `文件过大（${stat.size} 字节），超过 100MB 分析上限` };
    }

    try {
      const result =
        ext === '.xls'
          ? ExcelInspectorTool._inspectBasic(resolved, previewRows, stat)
          : await ExcelInspectorTool._inspectDeep(resolved, previewRows, sampleRows, analysisDepth);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: `检查 Excel 失败: ${err.message}` };
    }
  }

  /** 深度分析（.xlsx / .xlsm，基于 exceljs） */
  static async _inspectDeep(filePath, previewRows, sampleRows, analysisDepth) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const stat = fs.statSync(filePath);
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
    const namedRanges = [];
    if (workbook.definedNames && workbook.definedNames.model) {
      for (const model of workbook.definedNames.model) {
        namedRanges.push({ name: model.name, value: model.ranges ? model.ranges.join(',') : '' });
      }
    }

    const sheetsAnalysis = [];
    for (const worksheet of workbook.worksheets) {
      sheetsAnalysis.push(
        ExcelInspectorTool._analyzeSheet(worksheet, previewRows, sampleRows, namedRanges),
      );
    }

    const report = ExcelInspectorTool._formatEnhancedResult(filePath, stat.size, sheetNames, sheetsAnalysis, namedRanges);
    return {
      file_path: filePath,
      file_size: stat.size,
      sheet_count: sheetNames.length,
      sheet_list: sheetNames,
      named_ranges: namedRanges,
      analysis_depth: analysisDepth,
      sample_rows: sampleRows,
      sheets_analysis: sheetsAnalysis,
      report,
    };
  }

  /** 基础模式（.xls，基于 SheetJS） */
  static _inspectBasic(filePath, previewRows, stat) {
    const workbook = XLSX.readFile(filePath);
    const sheetList = workbook.SheetNames;
    const sheetsAnalysis = sheetList.map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, blankrows: true });
      const preview = rows.slice(0, previewRows).map((row) => row.map((cell) => cellText(cell)));
      const headerRow = 1;
      return {
        name: sheetName,
        dimensions: `A1:${columnLetter(Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0)))}${rows.length}`,
        max_row: rows.length,
        max_col: rows.reduce((max, row) => Math.max(max, row.length), 0),
        cols_truncated: false,
        header_info: { header_row: headerRow, header_layers: 1, is_multi_header: false, confidence: 'low' },
        data_info: {
          rows: Math.max(0, rows.length - headerRow),
          total_rows: Math.max(0, rows.length - headerRow),
          is_sampled: false,
          columns: rows.reduce((max, row) => Math.max(max, row.length), 0),
          columns_detail: [],
          preview,
        },
      };
    });
    return {
      file_path: filePath,
      file_size: stat.size,
      sheet_count: sheetList.length,
      sheet_list: sheetList,
      named_ranges: [],
      analysis_depth: 'basic',
      sheets_analysis: sheetsAnalysis,
      report:
        `Excel文件结构信息（基础模式）\n\n文件路径: ${filePath}\n文件大小: ${stat.size} 字节\n\nSheet数量: ${sheetList.length}\n` +
        `Sheet列表: ${sheetList.join(', ')}\n\n说明: 当前为降级模式（.xls），无法探测合并单元格、多层表头、公式、隐藏行列等结构。\n`,
    };
  }

  static _analyzeSheet(worksheet, previewRows, sampleRows, namedRanges) {
    const maxRow = worksheet.rowCount || 0;
    const maxCol = Math.min(worksheet.columnCount || 0, MAX_SCANNED_COLS);
    const colsTruncated = (worksheet.columnCount || 0) > MAX_SCANNED_COLS;
    // 表格需要额外留出表头扫描行，保证数据区至少能取到 sampleRows 行
    const grid = buildGrid(worksheet, Math.min(maxRow, sampleRows + HEADER_SCAN_ROWS), maxCol);
    const merges = (worksheet.model && worksheet.model.merges) || [];

    const headerInfo = ExcelInspectorTool._analyzeHeader(grid, merges, maxCol);
    const mergedCells = ExcelInspectorTool._analyzeMergedCells(grid, merges, headerInfo);
    const hidden = ExcelInspectorTool._analyzeHidden(worksheet, maxRow, maxCol);
    const formulas = ExcelInspectorTool._analyzeFormulas(grid, worksheet, Math.min(maxRow, sampleRows), maxCol);
    const styleAnalysis = ExcelInspectorTool._analyzeStyles(grid, Math.min(maxRow, sampleRows));
    const dataValidations = ExcelInspectorTool._analyzeValidations(worksheet);
    const comments = ExcelInspectorTool._analyzeComments(grid, Math.min(maxRow, sampleRows), maxCol);
    const tableRegions = ExcelInspectorTool._detectTableRegions(grid);
    const freezePanes = ExcelInspectorTool._freezePanes(worksheet);
    const autoFilter = ExcelInspectorTool._autoFilter(worksheet);
    const conditionalFormats = ExcelInspectorTool._conditionalFormats(worksheet);
    const dataInfo = ExcelInspectorTool._dataInfo(grid, headerInfo, previewRows, sampleRows, maxRow, maxCol);

    const analysis = {
      name: worksheet.name,
      dimensions: `A1:${columnLetter(Math.max(1, maxCol))}${Math.max(1, maxRow)}`,
      max_row: maxRow,
      max_col: maxCol,
      cols_truncated: colsTruncated,
      merged_cells: mergedCells,
      header_info: headerInfo,
      hidden,
      formulas,
      style_analysis: styleAnalysis,
      data_validations: dataValidations,
      comments,
      freeze_panes: freezePanes,
      table_regions: tableRegions,
      auto_filter: autoFilter,
      conditional_formats: conditionalFormats,
      data_info: dataInfo,
    };
    if (colsTruncated) {
      analysis.note = `列数声明为 ${worksheet.columnCount}，结构分析只扫描了前 ${MAX_SCANNED_COLS} 列`;
    }
    if (tableRegions.length > 1) {
      analysis.table_note =
        `该 Sheet 存在 ${tableRegions.length} 个独立表格区域，上述表头判定只对第一个区域有效，其余区域需自行定位`;
    }
    return analysis;
  }

  /** 表头结构：标题行、多层表头、混合布局（原版 _analyze_header 的启发式复刻）。 */
  static _analyzeHeader(grid, merges, maxCol) {
    const notes = [];
    const headerBeforeContent = [];
    const scanRows = grid.slice(0, HEADER_SCAN_ROWS);
    const headerCols = maxCol || 1;

    const emptySheet = scanRows.every((row) => row.nonEmpty === 0);
    if (emptySheet || scanRows.length === 0) {
      return {
        header_row: 1,
        header_layers: 1,
        is_multi_header: false,
        header_hierarchy: [],
        header_before_content: headerBeforeContent,
        pandas_hint: null,
        confidence: 'low',
        confidence_notes: [`前 ${HEADER_SCAN_ROWS} 行没有任何内容，该 Sheet 可能是空表`],
      };
    }

    let firstDataRow = null;
    for (const row of scanRows) {
      if (row.nonEmpty === 0) continue;
      if (looksLikeDataRow(row.texts)) {
        firstDataRow = row.rowNumber;
        break;
      }
    }

    let headerBlockEnd;
    let confidence;
    if (firstDataRow === null) {
      // 未找到明确的数据行：按第一行是表头处理
      headerBlockEnd = 1;
      confidence = 'medium';
      notes.push(
        `前 ${scanRows.length} 行内未能通过内容特征区分表头行与数据行（常见于各列都是短文本的表），已按第 1 行为表头处理`,
      );
    } else {
      headerBlockEnd = Math.max(1, firstDataRow - 1);
      confidence = 'high';
      if (headerBlockEnd > 1) {
        notes.push(`数据从第 ${firstDataRow} 行开始`);
      }
    }

    // 向上扩展多层表头：上一行非空、无纯数值、且覆盖足够多的列
    let headerBlockStart = headerBlockEnd;
    while (headerBlockStart > 1) {
      const candidate = grid[headerBlockStart - 2];
      if (!candidate || candidate.nonEmpty === 0) break;
      if (candidate.nonEmpty < Math.max(2, Math.floor(headerCols * 0.5))) break;
      headerBlockStart -= 1;
    }

    const layers = headerBlockEnd - headerBlockStart + 1;
    const headerRows = new Set();
    for (let row = headerBlockStart; row <= headerBlockEnd; row += 1) headerRows.add(row);

    for (const row of grid.slice(0, Math.max(0, headerBlockStart - 1))) {
      if (row.nonEmpty === 0) continue;
      headerBeforeContent.push({
        row: row.rowNumber,
        content: row.texts.filter((text) => text !== '').join(' | ').slice(0, 200),
      });
    }

    const headerHierarchy = [];
    for (let rowNumber = headerBlockStart; rowNumber <= headerBlockEnd; rowNumber += 1) {
      const row = grid[rowNumber - 1];
      const mergedItems = [];
      const standalone = [];
      const covered = new Set();
      for (const range of merges) {
        const decoded = decodeRange(range);
        if (!decoded) continue;
        if (rowNumber >= decoded.top && rowNumber <= decoded.bottom) {
          for (let col = decoded.left; col <= decoded.right; col += 1) covered.add(col);
          if (rowNumber === decoded.top) {
            const value = row.cells[decoded.left - 1] ? cellText(row.cells[decoded.left - 1].value) : '';
            mergedItems.push({ range, value, rows: decoded.bottom - decoded.top + 1, cols: decoded.right - decoded.left + 1 });
          }
        }
      }
      for (let col = 1; col <= headerCols; col += 1) {
        if (covered.has(col)) continue;
        const text = row && row.texts[col - 1] ? row.texts[col - 1] : '';
        if (text) standalone.push({ column: columnLetter(col), text });
      }
      headerHierarchy.push({
        layer: rowNumber - headerBlockStart + 1,
        row: rowNumber,
        merged_items: mergedItems.slice(0, HEADER_MERGES_PREVIEW),
        standalone_headers: standalone.slice(0, 50),
      });
    }

    if (layers > 1) {
      notes.push('多层表头的列名由 pandas 拼接生成，实际列名可能与肉眼所见不同，建议读取后先确认 df.columns');
    }
    if (layers > 1 && headerBlockStart > 1) {
      notes.push(`表头之前存在 ${headerBlockStart - 1} 行内容`);
    }

    const sheetName = null;
    const pandasHint =
      layers > 1
        ? `pd.read_excel(file_path, sheet_name='{sheet}', header=[${Array.from({ length: layers }, (_, i) => headerBlockStart - 1 + i).join(', ')}])  # MultiIndex表头`
        : headerBlockStart === 1
          ? `pd.read_excel(file_path, sheet_name='{sheet}')`
          : `pd.read_excel(file_path, sheet_name='{sheet}', header=${headerBlockStart - 1})`;

    return {
      header_row: headerBlockStart,
      header_row_end: headerBlockEnd,
      header_layers: layers,
      is_multi_header: layers > 1,
      header_hierarchy: headerHierarchy,
      header_before_content: headerBeforeContent,
      pandas_hint: pandasHint,
      confidence,
      confidence_notes: notes,
      sheet_name: sheetName,
    };
  }

  static _analyzeMergedCells(grid, merges, headerInfo) {
    const headerRows = new Set();
    for (let row = headerInfo.header_row; row <= (headerInfo.header_row_end ?? headerInfo.header_row); row += 1) {
      headerRows.add(row);
    }
    const headerMerges = [];
    let dataMergeCount = 0;
    for (const range of merges) {
      const decoded = decodeRange(range);
      if (!decoded) continue;
      const inHeader =
        decoded.top >= headerInfo.header_row &&
        decoded.bottom <= (headerInfo.header_row_end ?? headerInfo.header_row);
      if (inHeader) {
        const row = grid[decoded.top - 1];
        const value = row && row.cells[decoded.left - 1] ? cellText(row.cells[decoded.left - 1].value) : '';
        headerMerges.push({
          range,
          value,
          rows: decoded.bottom - decoded.top + 1,
          cols: decoded.right - decoded.left + 1,
        });
      } else {
        dataMergeCount += 1;
      }
    }
    return {
      count: merges.length,
      header_merges: headerMerges.slice(0, HEADER_MERGES_PREVIEW),
      data_merges: dataMergeCount,
    };
  }

  static _analyzeHidden(worksheet, maxRow, maxCol) {
    const hiddenRows = [];
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      if (row && row.hidden) hiddenRows.push(rowNumber);
    }
    const hiddenCols = [];
    for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
      const column = worksheet.getColumn(colNumber);
      if (column && column.hidden) hiddenCols.push(columnLetter(colNumber));
    }
    return {
      hidden_rows: hiddenRows.slice(0, HIDDEN_ROWS_PREVIEW),
      hidden_rows_count: hiddenRows.length,
      hidden_cols: hiddenCols.slice(0, HIDDEN_ROWS_PREVIEW),
      hidden_cols_count: hiddenCols.length,
    };
  }

  static _analyzeFormulas(grid, worksheet, sampleRows, maxCol) {
    const byColumn = new Map();
    let total = 0;
    for (let rowNumber = 1; rowNumber <= sampleRows; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      if (!row) continue;
      for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
        const cell = row.getCell(colNumber);
        const formula = cellFormula(cell);
        if (!formula) continue;
        total += 1;
        const letter = columnLetter(colNumber);
        if (!byColumn.has(letter)) byColumn.set(letter, { column: letter, count: 0, pattern: detectFormulaType(formula), sample: [] });
        const entry = byColumn.get(letter);
        entry.count += 1;
        if (entry.sample.length < FORMULA_SAMPLE_LIMIT) {
          entry.sample.push({ row: rowNumber, formula: `=${formula.replace(/^=/, '')}` });
        }
      }
    }
    const formulaColumns = [...byColumn.values()];
    return { has_formulas: total > 0, formula_count: total, formula_columns: formulaColumns };
  }

  static _analyzeStyles(grid, sampleRows) {
    const summaryRows = [];
    const hierarchicalRows = [];
    for (const row of grid.slice(0, sampleRows)) {
      // 公式单元格文本是 '=SUM(...)'，关键字匹配时排除，避免把公式误判成汇总行
      const text = row.cells
        .map((cell) => (cellFormula(cell) ? '' : cellText(cell.value)))
        .filter((value) => value !== '')
        .join(' | ');
      if (!text) continue;
      const lowered = text.toLowerCase();
      const isBold = row.cells.some((cell) => cell && cell.font && cell.font.bold);
      const hasFill = row.cells.some((cell) => {
        const fill = cell && cell.fill;
        return Boolean(fill && fill.type && fill.type !== 'none' && (fill.fgColor || fill.bgColor));
      });
      if (SUMMARY_KEYWORDS.some((keyword) => lowered.includes(keyword.toLowerCase()))) {
        summaryRows.push({ row: row.rowNumber, text: text.slice(0, 40), is_bold: isBold, has_fill: hasFill });
      }
      const marker = HIERARCHY_MARKERS.find((item) => text.startsWith(item));
      if (marker) {
        hierarchicalRows.push({ row: row.rowNumber, text: text.slice(0, 40), marker });
      }
    }
    return {
      summary_rows: summaryRows,
      has_summary_rows: summaryRows.length > 0,
      hierarchical_rows: hierarchicalRows,
      has_hierarchy: hierarchicalRows.length > 0,
    };
  }

  static _analyzeValidations(worksheet) {
    const model = worksheet.dataValidations && worksheet.dataValidations.model ? worksheet.dataValidations.model : {};
    const validations = [];
    for (const [range, rules] of Object.entries(model)) {
      for (const rule of Array.isArray(rules) ? rules : [rules]) {
        const item = { type: rule.type ?? 'unknown', range };
        if (rule.formulae && rule.formulae.length) {
          item.options_ref = String(rule.formulae[0]);
          if (rule.type === 'list') item.options = String(rule.formulae[0]).split(',');
        }
        validations.push(item);
      }
    }
    return { count: validations.length, validations: validations.slice(0, 10) };
  }

  static _analyzeComments(grid, sampleRows, maxCol) {
    const comments = [];
    for (const row of grid.slice(0, sampleRows)) {
      for (let col = 1; col <= maxCol; col += 1) {
        const cell = row.cells[col - 1];
        if (!cell || !cell.note) continue;
        const note = typeof cell.note === 'string' ? cell.note : (cell.note.texts || []).map((t) => t.text).join('');
        comments.push({ cell: `${columnLetter(col)}${row.rowNumber}`, text: String(note).slice(0, 200) });
      }
    }
    return { count: comments.length, comments: comments.slice(0, 10) };
  }

  static _detectTableRegions(grid) {
    const regions = [];
    let current = null;
    for (const row of grid) {
      if (row.nonEmpty > 0) {
        if (!current) current = { start: row.rowNumber, end: row.rowNumber, rows: 1 };
        else {
          current.end = row.rowNumber;
          current.rows += 1;
        }
      } else if (current) {
        regions.push(current);
        current = null;
      }
    }
    if (current) regions.push(current);
    return regions.slice(0, 50);
  }

  static _freezePanes(worksheet) {
    const views = worksheet.views || [];
    for (const view of views) {
      if (view && view.state === 'frozen' && (view.xSplit || view.ySplit)) {
        const col = (view.xSplit || 0) + 1;
        const row = (view.ySplit || 0) + 1;
        return `${columnLetter(col)}${row}`;
      }
    }
    return null;
  }

  static _autoFilter(worksheet) {
    if (worksheet.autoFilter) return { range: worksheet.autoFilter, has_filter: true };
    return { range: '', has_filter: false };
  }

  static _conditionalFormats(worksheet) {
    const formats = worksheet.conditionalFormattings || [];
    const rules = [];
    for (const format of formats) {
      for (const rule of format.rules || []) {
        rules.push({ range: format.ref ?? '', type: rule.type ?? 'unknown', priority: rule.priority ?? null });
      }
    }
    return { count: rules.length, rules: rules.slice(0, 5) };
  }

  /** 列名：多层表头用 ' > ' 拼接（原版 pandas MultiIndex 的列名形态）。 */
  static _columnNames(grid, headerInfo, maxCol) {
    const layers = [];
    for (let row = headerInfo.header_row; row <= (headerInfo.header_row_end ?? headerInfo.header_row); row += 1) {
      const gridRow = grid[row - 1];
      layers.push(gridRow ? gridRow.texts : []);
    }
    const names = [];
    for (let col = 1; col <= maxCol; col += 1) {
      const parts = layers.map((layer) => (layer[col - 1] ?? '').trim()).filter((text) => text !== '');
      names.push(parts.length ? parts.join(' > ') : columnLetter(col));
    }
    return names;
  }

  static _dataInfo(grid, headerInfo, previewRows, sampleRows, maxRow, maxCol) {
    const headerEnd = headerInfo.header_row_end ?? headerInfo.header_row;
    const dataRows = grid.filter((row) => row.rowNumber > headerEnd);
    const totalRows = Math.max(0, maxRow - headerEnd);
    const sampled = dataRows.slice(0, sampleRows);
    const columnNames = ExcelInspectorTool._columnNames(grid, headerInfo, maxCol);

    const columnsDetail = [];
    for (let col = 1; col <= Math.min(maxCol, COLUMN_DETAIL_LIMIT); col += 1) {
      const values = sampled.map((row) => row.texts[col - 1] ?? '');
      const nonEmpty = values.filter((text) => text !== '');
      const nullCount = values.length - nonEmpty.length;
      const numbers = sampled
        .map((row) => row.numbers[col - 1])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      const unique = new Set(nonEmpty);
      const counts = new Map();
      for (const text of nonEmpty) counts.set(text, (counts.get(text) || 0) + 1);
      const topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
      const detail = {
        name: columnNames[col - 1],
        dtype: numbers.length === values.length && values.length > 0 ? 'numeric' : 'text',
        non_null: nonEmpty.length,
        null: nullCount,
        null_pct: values.length ? Number(((nullCount / values.length) * 100).toFixed(1)) : 0,
        unique: unique.size,
        top_values: topValues,
        sample_values: nonEmpty.slice(0, 5),
        is_categorical: unique.size > 0 && unique.size <= 20 && numbers.length === 0,
      };
      if (numbers.length) {
        detail.min = Math.min(...numbers);
        detail.max = Math.max(...numbers);
        detail.mean = Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(4));
      }
      columnsDetail.push(detail);
    }

    const preview = dataRows.slice(0, previewRows).map((row) => row.texts.map((text) => text));
    return {
      rows: sampled.length,
      total_rows: totalRows,
      is_sampled: totalRows > sampled.length,
      columns: maxCol,
      columns_detail: columnsDetail,
      preview,
    };
  }

  /** 文本报告：结构对齐原版 _format_enhanced_result 的章节。 */
  static _formatEnhancedResult(filePath, fileSize, sheetList, sheetsAnalysis, namedRanges) {
    const lines = [];
    lines.push('Excel文件深度分析报告');
    lines.push('');
    lines.push(`文件路径: ${filePath}`);
    lines.push(`文件大小: ${fileSize} 字节`);
    lines.push('');
    lines.push(`Sheet数量: ${sheetList.length}`);
    lines.push(`Sheet列表: ${sheetList.join(', ')}`);
    if (namedRanges.length) {
      lines.push('');
      lines.push(`【命名范围】共 ${namedRanges.length} 个`);
      for (const item of namedRanges.slice(0, 10)) {
        lines.push(`  - ${item.name}: ${item.value}`);
      }
      if (namedRanges.length > 10) lines.push(`  ... 还有 ${namedRanges.length - 10} 个未显示`);
    }
    lines.push('='.repeat(70));
    sheetsAnalysis.forEach((sheet, index) => {
      lines.push('');
      lines.push(`Sheet ${index + 1}: ${sheet.name}`);
      lines.push('');
      lines.push('【基本信息】');
      lines.push(`数据范围: ${sheet.dimensions}`);
      lines.push(`最大行数: ${sheet.max_row}`);
      lines.push(`最大列数: ${sheet.max_col}`);
      if (sheet.cols_truncated) lines.push(`注意: 列数过多，结构分析只扫描了前 ${MAX_SCANNED_COLS} 列`);
      if (sheet.merged_cells) {
        lines.push('');
        lines.push(`【合并单元格】总数: ${sheet.merged_cells.count} 处`);
        if (sheet.merged_cells.header_merges.length) {
          lines.push('表头区域合并:');
          for (const merge of sheet.merged_cells.header_merges.slice(0, 5)) {
            lines.push(`  ${merge.range}: "${merge.value}" (${merge.rows}行×${merge.cols}列)`);
          }
        }
        lines.push(`数据区域合并: ${sheet.merged_cells.data_merges}`);
      }
      if (sheet.header_info) {
        lines.push('');
        lines.push('【表头结构】');
        if (sheet.header_info.is_multi_header) {
          lines.push(
            `多层表头: 共 ${sheet.header_info.header_layers} 层，位于第 ${sheet.header_info.header_row} 行`,
          );
        } else if (sheet.header_info.header_row === 1) {
          lines.push('表头行位置: 第 1 行');
        } else {
          lines.push(
            `表头行位置: 第 ${sheet.header_info.header_row} 行（不是第 1 行，读取时必须指定 header=${sheet.header_info.header_row - 1}）`,
          );
        }
        if (sheet.header_info.pandas_hint) lines.push(`读取建议: ${sheet.header_info.pandas_hint}`);
        lines.push(`判定置信度: ${sheet.header_info.confidence}`);
        for (const note of sheet.header_info.confidence_notes || []) lines.push(`  ⚠ ${note}`);
      }
      if (sheet.hidden) {
        lines.push('');
        lines.push('【隐藏行列】');
        lines.push(`隐藏行: ${sheet.hidden.hidden_rows_count} 行 ${sheet.hidden.hidden_rows.length ? `(如: ${sheet.hidden.hidden_rows.join(', ')})` : ''}`);
        lines.push(`隐藏列: ${sheet.hidden.hidden_cols_count}`);
      }
      if (sheet.formulas) {
        lines.push('');
        lines.push('【公式分析】');
        lines.push(`公式数: ${sheet.formulas.formula_count}`);
        for (const column of sheet.formulas.formula_columns) {
          lines.push(`  ${column.column} 列: ${column.pattern} (共${column.count}处)`);
        }
      }
      if (sheet.style_analysis) {
        lines.push('');
        lines.push('【数据层级与汇总】');
        lines.push(`汇总行: ${sheet.style_analysis.summary_rows.map((row) => row.row).join(', ') || '无'}`);
        lines.push(`层级标记: ${sheet.style_analysis.hierarchical_rows.map((row) => row.row).join(', ') || '无'}`);
      }
      if (sheet.data_validations && sheet.data_validations.count) {
        lines.push('');
        lines.push(`【数据验证】验证规则: ${sheet.data_validations.count}`);
      }
      if (sheet.comments && sheet.comments.count) {
        lines.push('');
        lines.push(`【批注】批注数: ${sheet.comments.count}`);
      }
      if (sheet.freeze_panes) {
        lines.push('');
        lines.push(`【冻结窗格】冻结位置: ${sheet.freeze_panes}`);
      }
      if (sheet.auto_filter && sheet.auto_filter.has_filter) {
        lines.push('');
        lines.push(`【自动筛选】筛选范围: ${sheet.auto_filter.range}`);
      }
      if (sheet.conditional_formats && sheet.conditional_formats.count) {
        lines.push('');
        lines.push(`【条件格式】规则数: ${sheet.conditional_formats.count} 条`);
      }
      if (sheet.table_regions && sheet.table_regions.length > 1) {
        lines.push('');
        lines.push(`【多表格区域】检测到同一Sheet中有 ${sheet.table_regions.length} 个独立表格区域:`);
        for (const region of sheet.table_regions) {
          lines.push(`  - 区域: 第${region.start}-${region.end}行 (${region.rows}行数据)`);
        }
      }
      const info = sheet.data_info;
      if (info) {
        lines.push('');
        lines.push('【数据统计】');
        lines.push(`数据行数: ${info.total_rows} 行${info.is_sampled ? `（分析采样: 前${info.rows}行）` : ''}`);
        lines.push(`数据列数: ${info.columns} 列`);
        lines.push('');
        lines.push('【列信息】');
        for (const column of info.columns_detail) {
          lines.push(column.name);
          lines.push(`    类型: ${column.dtype} | 非空: ${column.non_null} | 空值: ${column.null} | 唯一值: ${column.unique}`);
          if (column.min !== undefined) lines.push(`    范围: ${column.min} ~ ${column.max}  均值: ${column.mean}`);
          if (column.top_values && column.top_values.length) {
            lines.push(`    分布: ${column.top_values.map((item) => `${item.value}(${item.count})`).join(', ')}`);
          }
          if (column.is_categorical) lines.push('    提示: 该列为分类/枚举型');
        }
        lines.push('');
        lines.push('【数据预览】');
        for (const row of info.preview) lines.push(row.join(' | '));
      }
    });
    return lines.join('\n');
  }
}

module.exports = { ExcelInspectorTool, ANALYSIS_DEPTH_ROWS };
