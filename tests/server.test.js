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
  require('../server/routes/apps').register(app, { store });
  require('../server/routes/knowledge').register(app, { store });
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

test('LibreOffice 面板契约：/libreoffice-status 必须带 success（面板判定 !!t.success && t.available）+ 引导安装端点', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/libreoffice-status');
    const body = await res.json();
    assert.equal(body.success, true, '缺 success:true 会让设置面板恒显示「一键安装」');
    assert.equal(body.available, true, '本机装有 LibreOffice，应可用');
    assert.ok(body.path, '应带 soffice 路径');

    const install = await json(base, 'POST', '/libreoffice-help-install');
    assert.equal(install.body.success, true);
    assert.ok(install.body.message, '应带引导消息');
  });
});

test('拖拽附件：readFileAttachments 文本读取/图片提示/缺失容错', async () => {
  const { readFileAttachments } = require('../server/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-attach-'));
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, '机密口令是 KNOWLY-2026', 'utf8');
  const gbk = path.join(dir, 'gbk.md');
  fs.writeFileSync(gbk, Buffer.from('中文内容：密钥 ALPHA-77', 'utf8'));
  const img = path.join(dir, 'pic.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const missing = path.join(dir, 'ghost.txt'); // 从未创建

  const block = readFileAttachments([txt, gbk, img, missing]);
  assert.ok(block.includes('[用户附加的本地文件]'));
  assert.ok(block.includes('机密口令是 KNOWLY-2026'), '应含 utf8 文本内容');
  assert.ok(block.includes('中文内容：密钥 ALPHA-77'), '应含 gbk 解码内容');
  assert.ok(block.includes('image_reader'), '图片应提示 image_reader 工具');
  assert.ok(block.includes('文件不存在或不可读'), '缺失文件应容错');

  // 空数组不产生附件块
  assert.equal(readFileAttachments([]), '');
});

test('应用管理：种子示例 + 导入 + 重命名 + 内容读写 + 删除', async () => {
  await withServer(async (base) => {
    // 首次 GET 触发示例种子
    const seeded = await json(base, 'GET', '/apps');
    assert.equal(seeded.body.success, true);
    assert.ok(Array.isArray(seeded.body.data));
    assert.ok(seeded.body.data.length >= 3, '应预置 3 个示例应用');
    const sample = seeded.body.data.find((a) => a.name === '示例：计算器');
    assert.ok(sample, '应包含示例计算器');
    assert.ok(sample.entry && sample.id);

    // 导入一个 HTML 文件
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-app-'));
    const html = path.join(dir, 'hello.html');
    fs.writeFileSync(html, '<!doctype html><html><body><h1>hello-app-MARK</h1></body></html>', 'utf8');
    const imported = await json(base, 'POST', '/apps/import', { source_path: html, name: '测试应用' });
    assert.equal(imported.body.success, true, imported.body.message);
    const appId = imported.body.data.id;
    assert.equal(imported.body.data.entry, 'hello.html');

    // 内容读写
    const content = await json(base, 'GET', `/apps/content?app_id=${appId}&entry=hello.html`);
    assert.ok(content.body.data.html.includes('hello-app-MARK'));
    await json(base, 'PUT', '/apps/content', { app_id: appId, entry: 'hello.html', html: '<h1>edited-MARK</h1>' });
    const content2 = await json(base, 'GET', `/apps/content?app_id=${appId}&entry=hello.html`);
    assert.ok(content2.body.data.html.includes('edited-MARK'));

    // 重命名
    await json(base, 'PUT', '/apps', { app_id: appId, name: '改名应用' });
    const listed = await json(base, 'GET', '/apps');
    assert.ok(listed.body.data.find((a) => a.id === appId && a.name === '改名应用'));

    // 删除
    const del = await json(base, 'DELETE', '/apps', { app_id: appId });
    assert.equal(del.body.success, true);
    const after = await json(base, 'GET', '/apps');
    assert.ok(!after.body.data.find((a) => a.id === appId));

    // 删除示例后再次 GET 不应复活（seeded 标记）
    const delSample = await json(base, 'DELETE', '/apps', { app_id: sample.id });
    assert.equal(delSample.body.success, true);
    const again = await json(base, 'GET', '/apps');
    assert.ok(!again.body.data.find((a) => a.id === sample.id), '示例删除后不应复活');
  });
});

test('运行参数契约：GET /config 内嵌 runtime 默认值，POST 扁平字段归位（渲染层参数面板）', async () => {
  await withServer(async (base) => {
    const cfg = await json(base, 'GET', '/config');
    const rt = cfg.body.data.runtime;
    assert.ok(rt, 'GET /config 必须内嵌 runtime（渲染层启动校验 max_documents_per_chat）');
    assert.ok(rt.max_documents_per_chat >= 1 && rt.max_documents_per_chat <= 15);
    assert.ok(rt.max_iterations >= 1 && rt.max_iterations <= 100);
    assert.ok(rt.chat_confidence_threshold >= 1 && rt.chat_confidence_threshold <= 100);
    assert.ok(rt.file_search_confidence_threshold >= 1 && rt.file_search_confidence_threshold <= 100);
    assert.equal(typeof rt.enable_document_ocr, 'boolean');
    assert.equal(typeof rt.ocr_store_images, 'boolean');
    // 单次输出上限：默认 16384，且随 GET /config 暴露（运行参数面板注入字段消费）
    assert.equal(rt.max_output_tokens, 16384);

    // 参数面板保存：扁平 body（bundle @~6,988,000）
    const saved = await json(base, 'POST', '/config', {
      max_iterations: 45, max_documents_per_chat: 6,
      chat_confidence_threshold: 70, file_search_confidence_threshold: 25,
      enable_document_ocr: false, ocr_store_images: false,
    });
    assert.equal(saved.body.success, true);
    const again = await json(base, 'GET', '/config');
    assert.equal(again.body.data.runtime.max_iterations, 45);
    assert.equal(again.body.data.runtime.max_documents_per_chat, 6);
    assert.equal(again.body.data.runtime.enable_document_ocr, false);
    // 未提交的字段不被清空（注入字段与渲染层字段各自独立写入）
    assert.equal(again.body.data.runtime.max_output_tokens, 16384);
    // 非法值被钳制
    const clamped = await json(base, 'POST', '/config', { max_documents_per_chat: 99 });
    assert.equal(clamped.body.data.runtime.max_documents_per_chat, 15);
    // 输出上限：可写、越界钳制到 256..131072
    const limit = await json(base, 'POST', '/config', { max_output_tokens: 32768 });
    assert.equal(limit.body.data.runtime.max_output_tokens, 32768);
    assert.equal((await json(base, 'GET', '/config')).body.data.runtime.max_output_tokens, 32768);
    assert.equal((await json(base, 'POST', '/config', { max_output_tokens: 999999 })).body.data.runtime.max_output_tokens, 131072);
    assert.equal((await json(base, 'POST', '/config', { max_output_tokens: 1 })).body.data.runtime.max_output_tokens, 256);
    assert.equal((await json(base, 'POST', '/config', { max_output_tokens: 'abc' })).body.data.runtime.max_output_tokens, 16384);

    // user-status 形态（多面板消费 userStatus 字段）
    const us = await json(base, 'GET', '/user-status');
    assert.equal(us.body.success, true);
    assert.ok(us.body.userStatus, '应含 userStatus');
  });
});

test('本地资料学习全链路：目录契约 → 索引 → 进度 → 搜索 → 读全文', async () => {
  await withServer(async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowly-learn-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'risk.md'), '# 项目风险分析\n\n本季度主要风险点：供应链延迟与预算超支。\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'sub', 'notes.txt'), '会议纪要：讨论知识库与向量检索方案。\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 1) 目录添加（渲染层契约：body {folder}）
    const add = await json(base, 'POST', '/directories/add', { folder: dir });
    assert.equal(add.body.success, true, JSON.stringify(add.body));

    // 2) 开始学习
    const idx = await json(base, 'POST', '/index', { folder: dir });
    assert.equal(idx.body.success, true, idx.body.message);

    // 3) 轮询进度至完成（完成文案需与渲染层正则对齐）
    let progress = null;
    for (let i = 0; i < 80; i += 1) {
      progress = await json(base, 'GET', '/index-progress');
      if (progress.body.completed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(progress.body.completed, true);
    assert.match(progress.body.status, /学习完成！成功 \d+ 个，失败 \d+ 个，精简 \d+ 个/);
    assert.equal(progress.body.file_stats.success_count, 2, '两个文本文件应成功');
    assert.equal(progress.body.file_stats.simplified_count, 1, 'png 应计入精简');

    // 4) 目录列表契约形态（path/indexed/monitoring/last_updated）
    const dirs = await json(base, 'GET', '/directories');
    const key = Object.keys(dirs.body.directories).find((k) => k.toLowerCase() === path.resolve(dir).toLowerCase());
    assert.ok(key, '目录应出现在列表中');
    const item = dirs.body.directories[key];
    assert.equal(item.indexed, true);
    assert.equal(typeof item.monitoring, 'boolean');
    assert.ok(item.last_updated, '应有 last_updated');

    // 5) 关键词搜索（含 <mark> 高亮与 confidence）
    const search = await json(base, 'POST', '/search', { query: '风险', folder: 'all' });
    assert.equal(search.body.success, true);
    assert.ok(search.body.results.length >= 1, '应命中风险文档');
    const hit = search.body.results[0];
    assert.ok(hit.snippet.includes('<mark>'), 'snippet 应含 <mark> 高亮');
    assert.ok(hit.confidence >= 0 && hit.confidence <= 100);
    assert.ok(hit.indexed_folder);
    assert.ok(hit.source);

    // 多关键词 AND
    const multi = await json(base, 'POST', '/search', { query: '知识库 向量检索', folder: 'all' });
    assert.ok(multi.body.results.length >= 1, '多关键词 AND 应命中笔记');

    // 6) 读全文（渲染层 /search/file-text 消费 {success, content}）
    const text = await json(base, 'POST', '/search/file-text', { folder: key, source: path.join(dir, 'risk.md') });
    assert.equal(text.body.success, true);
    assert.ok(text.body.content.includes('风险'));

    // 7) 索引总数与清理
    const total = await json(base, 'GET', '/get-total-files');
    assert.equal(total.body.currentIndexedFiles, 2);
    const clean = await json(base, 'POST', '/clean-all-indexes');
    assert.equal(clean.body.success, true);
    const total2 = await json(base, 'GET', '/get-total-files');
    assert.equal(total2.body.currentIndexedFiles, 0);
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

test('输出上限解析：loadOutputLimit 读运行参数并钳制，缺省落回 16384', async () => {
  const { loadOutputLimit, DEFAULT_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } =
    require('../server/llm');
  const mk = (config) => ({ load: (name, def) => (config === undefined ? def : config) });

  assert.equal(DEFAULT_OUTPUT_TOKENS, 16384);
  // 运行参数面板写入的位置
  assert.equal(loadOutputLimit(mk({ runtime: { max_output_tokens: 32768 } })), 32768);
  // 兼容顶层 / 文件直改 / 历史 max_tokens 键
  assert.equal(loadOutputLimit(mk({ max_output_tokens: 24576 })), 24576);
  assert.equal(loadOutputLimit(mk({ max_tokens: 8192 })), 8192);
  // runtime 优先于顶层
  assert.equal(loadOutputLimit(mk({ max_tokens: 8192, runtime: { max_output_tokens: 40960 } })), 40960);
  // 缺省 / 非法 / 越界
  assert.equal(loadOutputLimit(mk({})), DEFAULT_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(mk({ runtime: {} })), DEFAULT_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(mk({ runtime: { max_output_tokens: 0 } })), DEFAULT_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(mk({ runtime: { max_output_tokens: 'abc' } })), DEFAULT_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(mk({ runtime: { max_output_tokens: 10 } })), MIN_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(mk({ runtime: { max_output_tokens: 10 ** 9 } })), MAX_OUTPUT_TOKENS);
  // store 抛错时不崩，回落缺省
  assert.equal(loadOutputLimit({ load: () => { throw new Error('boom'); } }), DEFAULT_OUTPUT_TOKENS);
  assert.equal(loadOutputLimit(undefined), DEFAULT_OUTPUT_TOKENS);
});

test('输出上限贯通：chatStream/chatOnce 发出的 max_tokens 等于运行参数配置值', async () => {
  const { chatStream, chatOnce } = require('../server/llm');
  const realFetch = global.fetch;
  const captured = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    captured.push({ url: String(url), body });
    if (String(url).includes('/api/openai/chat/completions')) {
      if (body.stream) return { json: async () => ({ success: true, stream_id: 's1' }) };
      return {
        json: async () => ({
          success: true,
          data: { choices: [{ finish_reason: 'stop', message: { content: '好的' } }] },
        }),
      };
    }
    if (String(url).includes('/api/stream/read')) {
      return {
        json: async () => ({
          done: true,
          chunk: { choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] },
        }),
      };
    }
    return { json: async () => ({ success: true }) };
  };

  const mkStore = (n) => ({
    load: (name, def) => (name === 'config'
      ? { models: { list: [{ id: 'm', api_key: 'k', base_url: 'http://x/v1', model: 'mm' }], current: 'm' }, runtime: { max_output_tokens: n } }
      : def),
  });

  try {
    await chatStream(mkStore(32768), { messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
    const streamReq = captured.find((c) => c.body.stream === true);
    assert.equal(streamReq.body.max_tokens, 32768, '流式请求应携带配置的输出上限');

    captured.length = 0;
    await chatOnce(mkStore(40960), { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured[0].body.max_tokens, 40960, '非流式请求应携带配置的输出上限');

    captured.length = 0;
    await chatStream(mkStore(undefined), { messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
    assert.equal(captured.find((c) => c.body.stream === true).body.max_tokens, 16384, '未配置时回落默认 16384');
  } finally {
    global.fetch = realFetch;
  }
});
