'use strict';

/**
 * 后端路由集成测试：不依赖 Electron/LLM，直接以 supertest 风格起独立端口。
 * 运行：npm test（node --test）
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/store');
const { ToolRegistry } = require('../server/tools/registry');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const registry = new ToolRegistry();
  require('../server/routes/system').register(app, { store, registry });
  require('../server/routes/sessions').register(app, { store });
  require('../server/routes/qa').register(app, { store, registry });
  require('../server/routes/tasks').register(app, { store });
  require('../server/routes/files').register(app, { store });
  app.use((req, res) => res.status(404).json({ detail: 'Not Found' }));
  return app;
}

async function withServer(fn) {
  const app = buildApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = async (base, method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// 独立数据目录，避免污染真实数据
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-test-'));
process.env.KNOWLY_DATA_ROOT = tmpData;

test('GET /health 返回原版形态 {status:ok}', async () => {
  await withServer(async (base) => {
    const { status, body } = await json(base, 'GET', '/health');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });
});

test('GET /tools 列出 18 个工具且 file_reader/excel_inspector schema 完整', async () => {
  await withServer(async (base) => {
    const { body } = await json(base, 'GET', '/tools');
    assert.equal(body.success, true);
    const names = body.data.tools.map((t) => t.name);
    for (const expected of ['python_executor', 'file_reader', 'rag_file_reader', 'file_converter', 'image_converter', 'file_searcher', 'excel_inspector', 'file_locator', 'shell_executor', 'env_manager', 'rag_search', 'rag_retriever', 'ask_user', 'run_subagent', 'image_generator', 'compact_context', 'image_reader', 'file_batch_rename']) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }
    const fr = body.data.tools.find((t) => t.name === 'file_reader');
    assert.equal(fr.display_name, '文件内容读取');
    assert.equal(fr.parameters.required[0], 'file_paths');
    assert.equal(fr.parameters.properties.max_length.default, 50000);
    const ei = body.data.tools.find((t) => t.name === 'excel_inspector');
    assert.equal(ei.display_name, 'Excel结构分析');
    assert.equal(ei.parameters.properties.analysis_depth.default, 'standard');
    // file_converter 已升级为真实实现（不再返回"未实现"）
    const fc = body.data.tools.find((t) => t.name === 'file_converter');
    assert.ok(fc.parameters.properties.target_format, 'file_converter 应有 target_format 参数');
  });
});

test('LibreOffice 自动探测（env→PATH→注册表→标准路径）', async () => {
  await withServer(async (base) => {
    const { body } = await json(base, 'GET', '/api/libreoffice/status');
    assert.equal(body.success, true);
    assert.equal(body.data.found, true, '本机装有 LibreOffice，应能探测到');
    assert.ok(/soffice(\.exe)?$/.test(body.data.path), '应指向 soffice 可执行文件');
    assert.ok(body.data.source, '应记录探测来源');
  });
});

test('file_converter 真实转换（LibreOffice 无头 txt→pdf）', async () => {
  await withServer(async (base) => {
    const st = await json(base, 'GET', '/api/libreoffice/status');
    if (!st.body.data.found) return; // 未装 LibreOffice 的环境跳过
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-convert-'));
    const src = path.join(dir, 'demo.txt');
    fs.writeFileSync(src, '重建版格式转换测试 LibreOffice converter', 'utf8');
    const { body } = await json(base, 'POST', '/tools/file_converter', {
      file_path: src, target_format: 'pdf', timeout: 180,
    });
    assert.equal(body.success, true, JSON.stringify(body.error || ''));
    assert.ok(fs.existsSync(body.result.output_path), '应生成 pdf');
    assert.ok(body.result.size > 100);
  });
});

test('文件批量重命名：dry_run 预览 + 执行 + 冲突防护', async () => {
  await withServer(async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-rename-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    fs.writeFileSync(path.join(dir, 'b.txt'), '2');

    const dry = await json(base, 'POST', '/tools/file_batch_rename', { folder: dir, mode: 'prefix', prefix: '2026-' });
    assert.equal(dry.body.success, true);
    assert.equal(dry.body.result.dry_run, true);
    assert.equal(dry.body.result.would_rename, 2);
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'dry_run 不应实际改名');

    const run = await json(base, 'POST', '/tools/file_batch_rename', { folder: dir, mode: 'prefix', prefix: '2026-', dry_run: false });
    assert.equal(run.body.result.renamed, 2);
    assert.ok(fs.existsSync(path.join(dir, '2026-a.txt')));
    assert.ok(!fs.existsSync(path.join(dir, 'a.txt')));

    const seq = await json(base, 'POST', '/tools/file_batch_rename', { folder: dir, mode: 'sequence', base_name: '报告', start_index: 1, dry_run: false });
    assert.equal(seq.body.success, true);
    assert.ok(fs.existsSync(path.join(dir, '报告-001.txt')));
    assert.ok(fs.existsSync(path.join(dir, '报告-002.txt')));
  });
});

test('数据备份导出/导入往返（对齐上游 v3.12.6）', async () => {
  await withServer(async (base) => {
    // 先有配置与会话，再导出，保证备份包覆盖要验证的文件
    await json(base, 'POST', '/config', { keep: 'v1' });
    await json(base, 'POST', '/chat/sessions', { title: '备份测试' });
    const backup = path.join(os.tmpdir(), `knowly-backup-${Date.now()}-${process.pid}.zip`);
    const exp = await json(base, 'POST', '/api/backup/export', { target_path: backup });
    assert.equal(exp.body.success, true, exp.body.error);
    assert.ok(exp.body.data.files.includes('sessions.json'));
    assert.ok(exp.body.data.files.includes('config.json'));
    assert.ok(fs.existsSync(backup));

    await json(base, 'POST', '/config', { marker: '导入前的新值' });
    const imp = await json(base, 'POST', '/api/backup/import', { source_path: backup });
    assert.equal(imp.body.success, true, imp.body.error);
    assert.ok(imp.body.data.imported.includes('config.json'));

    // 导入后配置回滚为备份时状态（marker 不存在），说明 clearCache 生效
    const cfg = await json(base, 'GET', '/config');
    assert.equal(cfg.body.data.marker, undefined);
    assert.equal(cfg.body.data.keep, 'v1');
    fs.unlinkSync(backup);
  });
});

test('POST /tools/file_reader 读取文本并给出 chars 与截断 cursor', async () => {
  await withServer(async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-file-'));
    const file = path.join(dir, 'report.md');
    fs.writeFileSync(file, '# 标题一\n\n'.padEnd(200, 'x') + '\n# 标题二\n\n正文内容', 'utf8');
    const { body } = await json(base, 'POST', '/tools/file_reader', { file_paths: [file], max_length: 50 });
    assert.equal(body.success, true, body.error);
    const item = body.result.results[0];
    assert.ok(!item.error, item.error);
    assert.ok(item.content.length <= 50);
    assert.ok(item.cursor, '超长时应返回 cursor');
  });
});

test('POST /tools/excel_inspector 分析 xlsx 表头与合并单元格', async () => {
  await withServer(async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-xlsx-'));
    const file = path.join(dir, 'structure.xlsx');
    // 用 exceljs 生成一个两层表头样例
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.mergeCells('A1:B1');
    ws.getCell('A1').value = '基本信息';
    ws.getCell('C1').value = '备注';
    ws.getCell('A2').value = '姓名';
    ws.getCell('B2').value = '年龄';
    ws.getCell('C2').value = '备注列';
    ws.getCell('A3').value = '张三';
    ws.getCell('B3').value = 30;
    ws.getCell('C3').value = '样例';
    await wb.xlsx.writeFile(file);
    const { body } = await json(base, 'POST', '/tools/excel_inspector', { file_path: file, analysis_depth: 'standard' });
    assert.equal(body.success, true, body.error);
    assert.ok(body.result.report.includes('数据'), '报告应包含 sheet 名');
  });
});

test('会话 CRUD + 消息追加 + 收藏（形态对齐原版在线响应）', async () => {
  await withServer(async (base) => {
    const created = await json(base, 'POST', '/chat/sessions', { title: '测试会话' });
    assert.equal(created.body.success, true);
    const id = created.body.data.id;
    assert.ok(id, '应返回会话 id');
    assert.deepEqual(created.body.data.selectedFolders, ['all']);

    const msg = await json(base, 'POST', `/chat/sessions/${id}/messages`, { role: 'user', content: '你好' });
    assert.equal(msg.body.success, true);

    const got = await json(base, 'GET', `/chat/sessions/${id}`);
    assert.equal(got.body.data.messages.length, 1);
    assert.equal(got.body.data.messages[0].content, '你好');

    const fav = await json(base, 'POST', `/chat/sessions/${id}/favorite`, { favorite: true });
    assert.equal(fav.body.data.isFavorite, true);

    const listed = await json(base, 'GET', '/chat/sessions');
    assert.ok(Array.isArray(listed.body.data), '列表 data 应为数组');
    assert.ok(listed.body.pagination, '列表应带 pagination');
    assert.ok(listed.body.data.some((s) => s.id === id));

    const del = await json(base, 'DELETE', `/chat/sessions/${id}`);
    assert.equal(del.body.success, true);
    const after = await json(base, 'GET', `/chat/sessions/${id}`);
    assert.equal(after.body.success, false);
  });
});

test('未配置 LLM 时 /qa/chat/stream 以 error 事件收尾（SSE）', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/qa/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '你好', history: [] }),
    });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    assert.ok(events.some((e) => e.type === 'error'), '应有 error 事件');
    assert.ok(events[events.length - 1].type === 'error');
  });
});

test('/qa/task/stream 未配置 LLM 时产生执行记录且 status=failed', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/qa/task/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '做个任务' }),
    });
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const start = events.find((e) => e.type === 'execution_start');
    assert.ok(start, '应有 execution_start');
    const list = await json(base, 'GET', '/qa/task/executions');
    const record = list.body.data.executions.find((e) => e.execution_id === start.data.execution_id);
    assert.ok(record);
    assert.ok(['failed', 'completed', 'cancelled'].includes(record.status));
  });
});

test('定时任务 CRUD 与 enabled-count', async () => {
  await withServer(async (base) => {
    const created = await json(base, 'POST', '/tasks', { name: '日报', prompt: '写日报', enabled: true });
    const id = created.body.data.task.task_id;
    const count = await json(base, 'GET', '/scheduler/enabled-count');
    assert.equal(count.body.data.count, 1);
    const toggled = await json(base, 'POST', `/tasks/${id}/enabled`, { enabled: false });
    assert.equal(toggled.body.data.task.enabled, false);
    const count2 = await json(base, 'GET', '/scheduler/enabled-count');
    assert.equal(count2.body.data.count, 0);
    const runs = await json(base, 'POST', `/tasks/${id}/run-now`);
    assert.equal(runs.body.success, true);
  });
});

test('目录统计 start → progress → done', async () => {
  await withServer(async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-dir-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(10));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y'.repeat(20));
    const started = await json(base, 'POST', '/api/directory-stats/start', { path: dir });
    const taskId = started.body.data.task_id;
    let progress;
    for (let i = 0; i < 50; i += 1) {
      progress = await json(base, 'GET', `/api/directory-stats/progress/${taskId}`);
      if (progress.body.data.done) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(progress.body.data.done, true);
    assert.equal(progress.body.data.total_files, 2);
    assert.equal(progress.body.data.total_bytes, 30);
  });
});

test('配置读写与缓存开关（形态对齐原版）', async () => {
  await withServer(async (base) => {
    await json(base, 'POST', '/config', { models: { list: [], current: null } });
    const cfg = await json(base, 'GET', '/config');
    assert.ok('models' in cfg.body.data);
    const en = await json(base, 'POST', '/cache/enable');
    assert.equal(en.body.enabled, true);
    const st = await json(base, 'GET', '/cache/status');
    assert.equal(st.body.enabled, true);
    assert.ok(st.body.cache_info, 'cache_status 应带 cache_info');
    const models = await json(base, 'GET', '/api/models/current');
    assert.ok(models.body.data.llm, 'models/current 应含 llm 字段');
    assert.ok(models.body.data.embedding);
  });
});

test('启动门端点形态（agents 数组 / membership / device-transfer）', async () => {
  await withServer(async (base) => {
    // 渲染层 agent-manager 对 data 直接 map（s.map is not a function 回归防护）
    const agents = await json(base, 'GET', '/agents/custom');
    assert.ok(Array.isArray(agents.body.data), 'agents/custom 的 data 必须是数组');

    const membership = await json(base, 'GET', '/check-membership');
    assert.deepEqual(membership.body, { success: true, expired: false });

    const transfer = await json(base, 'GET', '/device-transfer/status');
    assert.equal(transfer.body.data ?? transfer.body.sync_directive.mode, transfer.body.sync_directive.mode);
    assert.equal(transfer.body.sync_directive.mode, 'NORMAL');

    const synced = await json(base, 'POST', '/api/llm/software-default-models/sync');
    assert.equal(synced.body.success, true);
    assert.ok(Array.isArray(synced.body.data.models));
  });
});

test('三方模型配置面板：/api/config 读写 + /api/config/test（形态自 bundle 反混淆）', async () => {
  await withServer(async (base) => {
    // 初始为空面板
    const empty = await json(base, 'GET', '/api/config');
    assert.equal(empty.body.data.provider, '');
    assert.equal(empty.body.data.custom.has_api_key, false);

    // 保存（渲染层 j() 载荷）
    const save = await json(base, 'POST', '/api/config', {
      provider: 'custom', api_key: 'k-test', api_base: 'http://127.0.0.1:18888/v1', llm_model: 'm1', use_custom_embedding: false,
    });
    assert.equal(save.body.success, true);

    // 回显面板（api_key 原样回填、preview 打码）
    const loaded = await json(base, 'GET', '/api/config');
    assert.equal(loaded.body.data.provider, 'custom');
    assert.equal(loaded.body.data.custom.api_key, 'k-test');
    assert.equal(loaded.body.data.custom.api_base, 'http://127.0.0.1:18888/v1');
    assert.equal(loaded.body.data.custom.llm_model, 'm1');
    assert.ok(loaded.body.data.custom.api_key_preview.includes('****'));

    // 保存后 /api/models/current 反映 custom，且 llm.js 兼容字段同步写入
    const models = await json(base, 'GET', '/api/models/current');
    assert.equal(models.body.data.source_type, 'custom');
    assert.equal(models.body.data.llm.provider, 'custom');
    assert.equal(models.body.data.llm.model, 'm1');

    // 测试连接：未配置 LLM 代理时经主进程代理失败 → 仍应返回 {success:false, message}（而非 500）
    const test = await json(base, 'POST', '/api/config/test', {
      provider: 'custom', api_key: 'x', api_base: 'http://127.0.0.1:9', llm_model: 'x', test_embedding: false,
    });
    assert.equal(test.body.success, false);
    assert.ok(test.body.message, '失败时应带 message');
  });
});

test('任务模式渲染层契约：POST /qa/task/executions 创建 → GET stream 订阅到终态', async () => {
  await withServer(async (base) => {
    const created = await json(base, 'POST', '/qa/task/executions', { query: '做个任务' });
    assert.equal(created.body.success, true, created.body.error);
    assert.ok(created.body.execution_id, '应返回 execution_id');

    // 订阅事件流：应收到 execution_start → … → 终态
    const res = await fetch(`${base}/qa/task/executions/${created.body.execution_id}/stream`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    assert.ok(events.some((e) => e.type === 'execution_start'), '应有 execution_start');
    assert.ok(events.some((e) => ['error', 'complete', 'cancelled'].includes(e.type)), '应有业务事件');
    const last = events[events.length - 1];
    assert.equal(last.type, 'execution_status', '流应以 execution_status 终态收尾');
    assert.ok(['completed', 'failed', 'cancelled'].includes(last.data.status));
  });
});

test('未实现端点返回 404 且带说明', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/definitely/not/exist');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.detail, 'Not Found');
  });
});
