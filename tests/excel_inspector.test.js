'use strict';

const test = require('node:test');

const {
  expect,
  expectEqual,
  expectIncludes,
  printAssertionSummary,
  ensureSamples,
  samplePath,
  startServer,
  postJson,
} = require('./helpers');

ensureSamples();
test.after(() => printAssertionSummary(__filename));

async function inspectExcel(baseUrl, body) {
  return postJson(baseUrl, '/tools/excel_inspector', body);
}

test('AC9：excel_inspector 深度分析结构（合并单元格 / 多层表头 / 公式 / 隐藏行列 / 样式）', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const target = samplePath('structure.xlsx');
    const response = await inspectExcel(baseUrl, { file_path: target });
    expectEqual(response.status, 200, 'excel_inspector 应返回 200');
    expectEqual(response.json.success, true, 'excel_inspector 应成功');
    const result = response.json.result;
    const sheet = result.sheets_analysis[0];

    expectEqual(result.sheet_count, 1, '样例只有一个 sheet');
    expectEqual(result.sheet_list, ['销售明细'], 'sheet 名称应为销售明细');
    expectEqual(result.named_ranges.length, 1, '应返回 1 个命名范围');
    expectEqual(result.named_ranges[0].name, '金额范围', '命名范围名称应正确');

    expectEqual(sheet.header_info.header_row, 1, '多层表头起始行应为 1');
    expectEqual(sheet.header_info.header_layers, 2, '表头层数应为 2');
    expectEqual(sheet.header_info.is_multi_header, true, '应标记为多层表头');
    expectEqual(sheet.header_info.header_hierarchy.length, 2, 'header_hierarchy 应有两层');
    expectIncludes(sheet.header_info.pandas_hint, 'header=[0, 1]', '多层表头应给出 MultiIndex 读取建议');

    expectEqual(sheet.merged_cells.count, 3, '合并单元格总数应为 3');
    expectEqual(sheet.merged_cells.header_merges.length, 2, '表头区合并应为 2 处');
    expectEqual(
      sheet.merged_cells.header_merges.map((item) => item.value),
      ['2024年度', '2025年度'],
      '表头合并内容应正确',
    );
    expectEqual(sheet.merged_cells.header_merges[0].cols, 2, 'A1:B1 应跨 2 列');
    expectEqual(sheet.merged_cells.data_merges, 1, '数据区合并应为 1 处');

    expectEqual(sheet.hidden.hidden_rows, [8], '隐藏行应为第 8 行');
    expectEqual(sheet.hidden.hidden_rows_count, 1, '隐藏行数应为 1');
    expectEqual(sheet.hidden.hidden_cols, ['E'], '隐藏列应为 E');
    expectEqual(sheet.hidden.hidden_cols_count, 1, '隐藏列数应为 1');

    expectEqual(sheet.formulas.has_formulas, true, '应检测到公式');
    expectEqual(sheet.formulas.formula_count, 11, '样例中共 11 个公式');
    expectEqual(sheet.formulas.formula_columns[0].column, 'E', '公式所在列应为 E');
    expectEqual(sheet.formulas.formula_columns[0].pattern, '求和', 'SUM 公式应识别为求和');

    expectEqual(sheet.style_analysis.has_summary_rows, true, '应识别出汇总行');
    expect(
      sheet.style_analysis.summary_rows.some((row) => row.row === 13),
      '合计行（第 13 行）应被识别为汇总行',
    );
    const summary = sheet.style_analysis.summary_rows.find((row) => row.row === 13);
    expectEqual(summary.is_bold, true, '合计行应为加粗');
    expectEqual(summary.has_fill, true, '合计行应有背景色');
    expectEqual(sheet.style_analysis.has_hierarchy, true, '应识别出层级标记行');
    expectEqual(sheet.style_analysis.hierarchical_rows[0].row, 14, '层级标记行应为第 14 行');

    expectEqual(sheet.data_validations.count, 1, '应有 1 条数据验证');
    expectEqual(sheet.data_validations.validations[0].type, 'list', '数据验证类型应为 list');
    expectEqual(sheet.comments.count, 1, '应有 1 条批注');
    expectEqual(sheet.comments.comments[0].cell, 'B3', '批注所在单元格应为 B3');
    expectEqual(sheet.freeze_panes, 'B3', '冻结窗格位置应为 B3');

    expectEqual(sheet.data_info.columns_detail[0].name, '2024年度 > 产品', '多层表头列名应用 " > " 拼接');
    expectEqual(sheet.data_info.total_rows, 12, '数据行数应为 12');
    expectEqual(sheet.data_info.preview.length, 2, '默认 preview_rows=2');

    expectIncludes(result.report, '【合并单元格】', '文本报告应包含合并单元格章节');
    expectIncludes(result.report, '多层表头: 共 2 层', '文本报告应说明多层表头层数');
    expectIncludes(result.report, '【隐藏行列】', '文本报告应包含隐藏行列章节');
    expectIncludes(result.report, '【公式分析】', '文本报告应包含公式章节');
  } finally {
    await close();
  }
});

test('AC9：preview_rows 与 analysis_depth 生效', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const five = await inspectExcel(baseUrl, { file_path: samplePath('structure.xlsx'), preview_rows: 5 });
    expectEqual(five.json.result.sheets_analysis[0].data_info.preview.length, 5, 'preview_rows=5 时预览行数应为 5');
    const firstRow = five.json.result.sheets_analysis[0].data_info.preview[0];
    expectEqual(firstRow[0], '产品A', '预览首列应为产品A');
    expectEqual(firstRow[1], '12756', '预览应包含数值列');

    const expectations = [
      ['basic', 20],
      ['standard', 50],
      ['deep', 100],
    ];
    for (const [depth, cap] of expectations) {
      const response = await inspectExcel(baseUrl, {
        file_path: samplePath('big-table.xlsx'),
        analysis_depth: depth,
      });
      const result = response.json.result;
      const sheet = result.sheets_analysis[0];
      expectEqual(result.analysis_depth, depth, `analysis_depth 应回显 ${depth}`);
      expectEqual(result.sample_rows, cap, `${depth} 的采样上限应为 ${cap}`);
      expectEqual(sheet.data_info.rows, cap, `${depth} 应采样 ${cap} 行`);
      expectEqual(sheet.data_info.total_rows, 150, '样例数据共 150 行');
      expectEqual(sheet.data_info.is_sampled, true, `${depth} 应标记为采样`);
      expectEqual(sheet.header_info.header_layers, 1, `${depth} 大表应为单层表头`);
    }
  } finally {
    await close();
  }
});

test('AC9：非 Excel 输入与异常输入的错误语义', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const txt = await inspectExcel(baseUrl, { file_path: samplePath('report.md') });
    expectEqual(txt.json.success, false, '非 Excel 文件应失败');
    expectIncludes(txt.json.error, '仅支持 Excel 文件（.xlsx / .xls / .xlsm）', '应提示仅支持 Excel');

    const missing = await inspectExcel(baseUrl, { file_path: samplePath('nope.xlsx') });
    expectEqual(missing.json.success, false, '不存在的文件应失败');
    expectIncludes(missing.json.error, '文件不存在: ', '应提示文件不存在');

    const noPath = await inspectExcel(baseUrl, {});
    expectEqual(noPath.json.success, false, '缺少 file_path 应失败');
    expectIncludes(noPath.json.error, '必须提供 file_path', '应提示缺少 file_path');

    const directory = await inspectExcel(baseUrl, { file_path: samplePath('unsupported') });
    expectEqual(directory.json.success, false, '目录应失败');
    expectIncludes(directory.json.error, '路径是目录不是文件: ', '应提示是目录');
  } finally {
    await close();
  }
});
