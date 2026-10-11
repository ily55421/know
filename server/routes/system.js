'use strict';

/** 系统与配置路由：/health /version /config /cache /directories /api/models /scheduler 通知等。 */
const os = require('node:os');
const { chatOnce } = require('../llm');

const APP_VERSION = '3.13.2';

function register(app, { store, registry }) {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/version', (_req, res) => {
    res.json({ success: true, data: { version: APP_VERSION, reconstructed: true } });
  });

  // ---- 配置 ----
  app.get('/config', (_req, res) => {
    res.json({ success: true, data: store.load('config', {}) });
  });

  app.post('/config', (req, res) => {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const next = store.update('config', {}, (current) => ({ ...current, ...patch }));
    res.json({ success: true, data: next });
  });

  // ---- 缓存开关（形态对齐原版在线响应：字段在顶层）----
  app.get('/cache/status', (_req, res) => {
    const enabled = Boolean(store.load('cache', { enabled: false }).enabled);
    res.json({
      success: true,
      enabled,
      cache_info: {
        enabled,
        total_cached: 0,
        max_size: 5,
        last_global_activity: Date.now() / 1000,
        time_since_last_activity: 0,
        cached_folders: [],
      },
    });
  });
  app.post('/cache/enable', (_req, res) => {
    store.save('cache', { enabled: true });
    res.json({ success: true, enabled: true });
  });
  app.post('/cache/disable', (_req, res) => {
    store.save('cache', { enabled: false });
    res.json({ success: true, enabled: false });
  });

  // ---- 工作目录（原版由 Python /directories API 管理，见 ipc-handlers.js 注释）
  // 形态对齐原版：{success, directories: {路径: 信息}} ----
  app.get('/directories', (_req, res) => {
    res.json({ success: true, directories: store.load('directories', { map: {} }).map || {} });
  });
  app.post('/directories/add', (req, res) => {
    const dir = String(req.body?.path || req.body?.directory || '').trim();
    const fs = require('node:fs');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.json({ success: false, error: `目录不存在: ${dir}` });
    }
    const next = store.update('directories', { map: {} }, (current) => {
      const map = current.map || {};
      map[dir] = { added_at: Date.now(), enabled: true };
      return { map };
    });
    res.json({ success: true, directories: next.map });
  });
  app.post('/directories/remove', (req, res) => {
    const dir = String(req.body?.path || req.body?.directory || '').trim();
    const next = store.update('directories', { map: {} }, (current) => {
      const map = { ...(current.map || {}) };
      delete map[dir];
      return { map };
    });
    res.json({ success: true, directories: next.map });
  });

  // ---- 模型（形态对齐原版：data.{source_type, llm, embedding, vision}）----
  app.get('/api/models/current', (_req, res) => {
    const config = store.load('config', {});
    const models = config.models || {};
    const fallback = require('../data-seed/software-default-models.json');
    const defaultModelId = models.current || fallback?.data?.defaultModelId || 'deepseek-flash';
    res.json({
      success: true,
      data: {
        source_type: models.source_type || 'software_default',
        llm: {
          provider: models.llm_provider || 'software_default',
          model: models.llm_model || defaultModelId,
          api_base: models.llm_api_base || '',
          ...(models.api_key ? { api_key_configured: true } : {}),
        },
        embedding: models.embedding || { provider: 'dashscope', model: 'text-embedding-v4', api_base: '' },
        vision: models.vision || { provider: 'dashscope', model: 'qwen3-vl-plus', api_base: '' },
      },
    });
  });
  app.get('/api/llm/software-default-models', (_req, res) => {
    // 原版经云端同步后缓存；重建版直接内嵌最近一次观测到的云端目录（见 data-seed）。
    let seed = null;
    try {
      seed = require('../data-seed/software-default-models.json');
    } catch { /* 无种子时给空目录 */ }
    if (seed?.data) {
      res.json({ success: true, data: { ...seed.data, source: 'builtin-seed' } });
      return;
    }
    res.json({ success: true, data: { defaultModelId: null, source: 'none', version: null, syncedAt: null, models: [] } });
  });
  // 渲染层启动时触发云端同步（原版形态：同步成功后返回模型目录）
  app.post('/api/llm/software-default-models/sync', (_req, res) => {
    let seed = null;
    try {
      seed = require('../data-seed/software-default-models.json');
    } catch { /* 无种子时给空目录 */ }
    if (seed?.data) {
      res.json({ success: true, data: { ...seed.data, source: 'builtin-seed' } });
      return;
    }
    res.json({ success: true, data: { defaultModelId: null, source: 'none', version: null, syncedAt: null, models: [] } });
  });

  // ---- 会员状态（形态对齐原版：顶层 expired）----
  app.get('/check-membership', (_req, res) => {
    res.json({ success: true, expired: false });
  });

  // ---- 设备数据迁移状态（形态对齐原版在线观测）----
  app.get('/device-transfer/status', (_req, res) => {
    res.json({
      success: true,
      sync_directive: { mode: 'NORMAL', guard: null, entitlement_generation: null },
    });
  });
  app.get('/api/ollama/ping', (_req, res) => res.json({ success: false, error: '重建版未集成 Ollama' }));
  app.get('/api/ollama/models/list', (_req, res) => res.json({ success: true, data: { models: [] } }));

  // ---- 系统信息（形态对齐原版：cpu/memory/gpu/platform）----
  app.get('/api/system/hardware', (_req, res) => {
    res.json({
      success: true,
      data: {
        cpu: {
          cores: os.cpus().length,
          frequency: os.cpus()[0]?.speed || 0,
          model: os.cpus()[0]?.model || '',
        },
        memory: {
          total_gb: Math.round((os.totalmem() / 1024 ** 3) * 100) / 100,
          available_gb: Math.round((os.freemem() / 1024 ** 3) * 100) / 100,
        },
        gpu: { available: false, name: null, memory_gb: null },
        platform: os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux',
      },
    });
  });
  app.get('/api/system/score', (_req, res) => {
    res.json({ success: true, data: { score: Math.min(100, os.cpus().length * 8 + Math.round(os.totalmem() / 1024 ** 3)) } });
  });

  // ---- 主进程轮询端点（见 electron/src/app-lifecycle.js）----
  app.get('/scheduler/notifications', (_req, res) => {
    res.json({ success: true, data: [] });
  });
  app.get('/remote-control/notifications', (_req, res) => {
    res.json({ success: true, data: [] });
  });
  app.get('/scheduler/enabled-count', (_req, res) => {
    const tasks = store.load('tasks', { items: [] }).items || [];
    res.json({ success: true, data: { count: tasks.filter((t) => t.enabled).length } });
  });
  // 定时任务清单（原版在线观测：GET /scheduler/tasks → {success, data:[...]})
  app.get('/scheduler/tasks', (_req, res) => {
    res.json({ success: true, data: store.load('tasks', { items: [] }).items || [] });
  });

  // ---- 技能 / MCP / 自定义 Agent ----
  app.get('/api/tools/skills', (_req, res) => {
    // 原版返回内建技能清单；重建版内嵌最近一次观测到的清单（data-seed/builtin-skills.json），
    // 用户安装的自定义技能从本地存储合并。
    let builtin = [];
    try {
      builtin = require('../data-seed/builtin-skills.json').data || [];
    } catch { /* 无种子时给空清单 */ }
    const custom = store.load('skills', { items: [] }).items || [];
    res.json({ success: true, data: [...builtin, ...custom] });
  });
  app.post('/api/tools/skills/cloud/install-batch', (_req, res) => {
    res.json({ success: false, error: '云技能安装依赖云端服务，重建版未实现' });
  });
  app.get('/mcp/servers', (_req, res) => {
    res.json({ success: true, data: { servers: store.load('mcp', { items: [] }).items } });
  });
  app.get('/agents/custom', (_req, res) => {
    // 形态对齐原版在线观测：data 直接为数组（渲染层 s.map(...) 消费）
    res.json({ success: true, data: store.load('agents', { items: [] }).items });
  });
  app.post('/agents/custom', (req, res) => {
    const agent = { id: `agent_${Date.now()}`, ...(req.body || {}) };
    const next = store.update('agents', { items: [] }, (current) => ({ items: [...(current.items || []), agent] }));
    res.json({ success: true, data: agent });
  });
  app.get('/agents/custom/:agentId', (req, res) => {
    const items = store.load('agents', { items: [] }).items || [];
    const agent = items.find((a) => a.id === req.params.agentId);
    if (!agent) return res.json({ success: false, error: '未找到该 Agent' });
    res.json({ success: true, data: agent });
  });

  // ---- 工具目录与执行（REST 形态沿用先前复刻版约定）----
  app.get('/tools', (_req, res) => {
    res.json({ success: true, data: { tools: registry.catalog() } });
  });
  app.post('/tools/:name', async (req, res) => {
    const result = await registry.execute(req.params.name, req.body);
    res.json(result);
  });
  app.post('/api/test-llm', async (req, res) => {
    try {
      const result = await chatOnce(store, {
        messages: [{ role: 'user', content: '回复"连接成功"四个字' }],
        maxTokens: 16,
      });
      res.json({ success: true, data: { reply: result.content } });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });
}

module.exports = { register };
