'use strict';

/** 系统与配置路由：/health /version /config /cache /directories /api/models /scheduler 通知等。 */
const os = require('node:os');
const path = require('node:path');
const { chatOnce, proxyPost } = require('../llm');

const APP_VERSION = '3.13.2';

function register(app, { store, registry }) {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/version', (_req, res) => {
    res.json({ success: true, data: { version: APP_VERSION, reconstructed: true } });
  });

  // ---- 配置 ----
  // ---- 运行参数（渲染层启动/参数面板契约：GET /config 内嵌 runtime 对象）----
  const RUNTIME_DEFAULTS = {
    max_iterations: 20,                  // 1..100
    max_documents_per_chat: 8,           // 1..15
    chat_confidence_threshold: 55,       // 1..100
    file_search_confidence_threshold: 30, // 1..100
    enable_document_ocr: true,
    ocr_store_images: true,
  };
  const RUNTIME_KEYS = Object.keys(RUNTIME_DEFAULTS);
  const clampRuntime = (r) => ({
    max_iterations: Math.min(100, Math.max(1, Math.floor(Number(r.max_iterations) || RUNTIME_DEFAULTS.max_iterations))),
    max_documents_per_chat: Math.min(15, Math.max(1, Math.floor(Number(r.max_documents_per_chat) || RUNTIME_DEFAULTS.max_documents_per_chat))),
    chat_confidence_threshold: Math.min(100, Math.max(1, Math.floor(Number(r.chat_confidence_threshold) || RUNTIME_DEFAULTS.chat_confidence_threshold))),
    file_search_confidence_threshold: Math.min(100, Math.max(1, Math.floor(Number(r.file_search_confidence_threshold) || RUNTIME_DEFAULTS.file_search_confidence_threshold))),
    enable_document_ocr: r.enable_document_ocr !== false,
    ocr_store_images: r.ocr_store_images !== false,
  });

  app.get('/config', (_req, res) => {
    const stored = store.load('config', {});
    res.json({ success: true, data: { ...stored, runtime: clampRuntime({ ...RUNTIME_DEFAULTS, ...(stored.runtime || {}) }) } });
  });

  app.post('/config', (req, res) => {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    // 运行参数面板发扁平字段：归位到 config.runtime；其余字段照旧顶层合并
    const rest = {};
    const runtimePatch = {};
    for (const [key, value] of Object.entries(patch)) {
      if (RUNTIME_KEYS.includes(key)) runtimePatch[key] = value;
      else rest[key] = value;
    }
    const next = store.update('config', {}, (current) => ({
      ...current,
      ...rest,
      runtime: clampRuntime({ ...RUNTIME_DEFAULTS, ...(current.runtime || {}), ...runtimePatch }),
    }));
    res.json({ success: true, data: { ...next, runtime: clampRuntime(next.runtime || {}) } });
  });

  // ---- 会员状态（重建版：本地最高档位，模型费用由用户自有网关承担，不涉及原厂云端）----
  // 字段消费自 bundle 会员中心组件（XCt @~6,895,313）
  const MEMBERSHIP_USER_STATUS = {
    level: 'flagship',
    level_name: '旗舰版（重建版）',
    is_temporary: false,
    is_expired: false,
    expiry_date: null,
    days_remaining: null, // null → 永久分支，不显示剩余天数
    upgrade_source: 'reconstruction',
    max_total_files: 9999999,
    max_file_size_mb: 2048,
    max_text_length: 5000000,
    supports_multimodal: true,
    supports_media: true,
    supports_vision: true,
    remote_channel_limit: 99,
  };

  app.get('/user-status', (_req, res) => {
    res.json({
      success: true,
      userStatus: MEMBERSHIP_USER_STATUS,
      expiryWarning: null,
      currentIndexedFiles: 0,
    });
  });

  // 已索引文件数（会员中心用量卡，消费顶层 currentIndexedFiles）
  app.get('/get-total-files', (_req, res) => {
    res.json({ success: true, currentIndexedFiles: 0 });
  });

  // 智能问答额度（会员中心额度卡：is_unlimited → 不限量展示）
  app.get('/llm-quota', (_req, res) => {
    res.json({
      success: true,
      data: {
        is_permanent: true,
        expiry_date: null,
        is_unlimited: true,
        membership_quota: 999999999,
        purchased_quota: 0,
        used_queries: 0,
        total_quota: 999999999,
      },
    });
  });

  // 离线激活码校验（重建版已是最高档位，直接确认激活）
  app.post('/verify-offline-activation', (req, res) => {
    res.json({
      success: true,
      data: {
        level: MEMBERSHIP_USER_STATUS.level,
        level_name: MEMBERSHIP_USER_STATUS.level_name,
        is_permanent: true,
        expiry_date: null,
        days_remaining: null,
        activated_at: Date.now(),
      },
    });
  });

  // 会员套餐列表（渲染层消费顶层 plans 字段；重建版旗舰版为当前档位）
  app.get('/membership-plans', (_req, res) => {
    res.json({
      success: true,
      plans: [
        {
          level: 'basic', name: '基础版', description: '入门能力',
          original_price: 29, discount_price: null, is_active: false,
          features: ['基础对话', '文件学习'],
        },
        {
          level: 'premium', name: '专业版', description: '进阶能力',
          original_price: 99, discount_price: null, is_active: false,
          features: ['基础版全部能力', '更高额度', '优先支持'],
        },
        {
          level: 'flagship', name: '旗舰版（重建版）', description: '全能力解锁（本地重建版：模型费用由用户自有网关承担）',
          original_price: 0, discount_price: 0, is_active: true,
          features: ['全部能力解锁', '对话/任务不限量', '多模态与图片理解', '手机远程通道'],
        },
      ],
    });
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
    // 三方自定义配置（api_config 面板保存）优先展示
    if (config.api_config && config.api_config.api_base && config.api_config.api_key) {
      res.json({
        success: true,
        data: {
          source_type: 'custom',
          llm: {
            provider: 'custom',
            model: config.api_config.llm_model || '',
            api_base: config.api_config.api_base,
            api_key_configured: true,
          },
          embedding: config.api_config.use_custom_embedding
            ? { provider: 'custom', model: config.api_config.embedding_model || '', api_base: config.api_config.embedding_api_base || config.api_config.api_base }
            : (models.embedding || { provider: 'dashscope', model: 'text-embedding-v4', api_base: '' }),
          vision: models.vision || { provider: 'dashscope', model: 'qwen3-vl-plus', api_base: '' },
        },
      });
      return;
    }
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
  // 本地大模型面板探测（渲染层消费 data.running/.path）
  app.get('/api/ollama/detect', (_req, res) => {
    res.json({ success: true, data: { installed: false, running: false, path: null, version: null } });
  });
  // 可下载模型目录（重建版无 Ollama 拉取通道，空列表让面板优雅降级）
  app.get('/api/ollama/models/available', (_req, res) => {
    res.json({ success: true, data: [] });
  });
  // MCP 服务器清单（渲染层 /api/tools/mcp/servers，消费 data 数组）
  app.get('/api/tools/mcp/servers', (_req, res) => {
    res.json({ success: true, data: store.load('mcp', { items: [] }).items });
  });
  // 渲染层 skill 导出能力校验（office.docx_* 工具执行前探测，消费 {available}）
  // 设置面板状态判定为 !!t.success && t.available —— 必须带 success:true
  app.get('/libreoffice-status', (_req, res) => {
    const { detectSoffice } = require('../core/libreoffice');
    const info = detectSoffice();
    res.json({ success: true, available: Boolean(info.found), path: info.path || null, source: info.source || null, version_hint: info.versionHint || null });
  });
  // 「一键安装」按钮（原版亦为引导式：POST 后 toast + 刷新状态）
  app.post('/libreoffice-help-install', (_req, res) => {
    const { detectSoffice } = require('../core/libreoffice');
    const info = detectSoffice({ useCache: false });
    if (info.found) {
      return res.json({ success: true, message: `已检测到 LibreOffice（${info.path}）` });
    }
    res.json({
      success: true,
      message: '请到 https://www.libreoffice.org/download/ 下载安装（支持自定义盘符），'
        + '或设置环境变量 KNOWLY_SOFFICE_PATH 指向 soffice.exe，保存后重启应用即可识别',
    });
  });

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

  // ---- 三方大模型配置面板（渲染层 API 配置页：GET/POST /api/config + POST /api/config/test）----
  // 形态自 bundle.js 反混淆还原（settings.apiConfigPanel 组件）。
  const EMPTY_PANEL = {
    provider: '',
    custom: {
      has_api_key: false, api_key: '', api_key_preview: '', api_base: '',
      llm_model: '', use_custom_embedding: false, embedding_model: '', embedding_api_base: '',
    },
  };

  const panelData = (config) => {
    const p = config.api_config;
    if (!p || !p.api_base || !p.api_key) return { ...EMPTY_PANEL };
    const key = String(p.api_key);
    return {
      provider: 'custom',
      custom: {
        has_api_key: true,
        api_key: key,
        api_key_preview: key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : '****',
        api_base: p.api_base || '',
        llm_model: p.llm_model || '',
        use_custom_embedding: Boolean(p.use_custom_embedding),
        embedding_model: p.embedding_model || '',
        embedding_api_base: p.embedding_api_base || '',
      },
    };
  };

  app.get('/api/config', (_req, res) => {
    res.json({ success: true, data: panelData(store.load('config', {})) });
  });

  app.post('/api/config', (req, res) => {
    const body = req.body || {};
    const apiConfig = {
      provider: 'custom',
      api_key: String(body.api_key ?? ''),
      api_base: String(body.api_base ?? ''),
      llm_model: String(body.llm_model ?? ''),
      use_custom_embedding: Boolean(body.use_custom_embedding),
      embedding_model: String(body.embedding_model ?? ''),
      embedding_api_base: String(body.embedding_api_base ?? ''),
    };
    if (body.provider === 'custom' && (!apiConfig.api_key || !apiConfig.api_base)) {
      return res.json({ success: false, message: 'API 密钥与 API 地址不能为空' });
    }
    // 双写：api_config 供面板回显；llm*/api_key/base_url/model 供 llm.js 与 /api/models/current
    store.update('config', {}, (current) => ({
      ...current,
      api_config: apiConfig,
      api_key: apiConfig.api_key,
      base_url: apiConfig.api_base,
      model: apiConfig.llm_model,
      llm: { provider: 'custom', api_key: apiConfig.api_key, model: apiConfig.llm_model, api_base: apiConfig.api_base },
      ...(apiConfig.use_custom_embedding ? {
        embedding: { provider: 'custom', model: apiConfig.embedding_model, api_base: apiConfig.embedding_api_base || apiConfig.api_base },
      } : {}),
    }));
    res.json({ success: true });
  });

  app.post('/api/config/test', async (req, res) => {
    const body = req.body || {};
    const apiKey = String(body.api_key ?? '');
    const apiBase = String(body.api_base ?? '');
    const model = String(body.llm_model ?? '');
    if (!apiKey || !apiBase || !model) {
      return res.json({ success: false, message: 'API 密钥、API 地址与对话模型均不能为空' });
    }
    try {
      const chat = await proxyPost('/api/openai/chat/completions', {
        api_key: apiKey, base_url: apiBase, model,
        messages: [{ role: 'user', content: '回复两个字：连接成功' }],
        stream: false, max_tokens: 64,
      });
      if (!chat?.success) {
        return res.json({ success: false, message: chat?.error || '对话模型连接失败' });
      }
      if (body.test_embedding) {
        const emb = await proxyPost('/api/openai/embeddings', {
          api_key: apiKey,
          base_url: String(body.embedding_api_base || apiBase),
          model: String(body.embedding_model || ''),
          input: ['连接测试'],
        });
        if (!emb?.success) {
          return res.json({ success: false, message: `对话模型正常，但向量模型连接失败: ${emb?.error || '未知错误'}` });
        }
      }
      return res.json({ success: true });
    } catch (error) {
      return res.json({ success: false, message: error.message });
    }
  });

  // ---- LibreOffice 探测状态（file_converter 依赖）----
  app.get('/api/libreoffice/status', (_req, res) => {
    const { detectSoffice } = require('../core/libreoffice');
    const info = detectSoffice();
    res.json({ success: true, data: info });
  });

  // ---- 全量数据备份 / 恢复（对齐上游 v3.12.6，jszip 打包后端持久区 JSON）----
  app.post('/api/backup/export', async (req, res) => {
    try {
      const fs = require('node:fs');
      const target = String(req.body?.target_path || '').trim();
      if (!target) return res.json({ success: false, error: '缺少 target_path' });
      const JSZip = require('jszip');
      const root = store.dataRoot();
      const zip = new JSZip();
      const files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
      for (const f of files) zip.file(f, fs.readFileSync(path.join(root, f), 'utf8'));
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      res.json({ success: true, data: { file: target, size: buf.length, files } });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  app.post('/api/backup/import', async (req, res) => {
    try {
      const fs = require('node:fs');
      const source = String(req.body?.source_path || '').trim();
      if (!source || !fs.existsSync(source)) {
        return res.json({ success: false, error: `备份包不存在: ${source}` });
      }
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(fs.readFileSync(source));
      const entries = Object.keys(zip.files).filter((f) => f.endsWith('.json') && !zip.files[f].dir);
      if (!entries.length) return res.json({ success: false, error: '备份包中没有可导入的 JSON 数据' });
      const root = store.dataRoot();
      const imported = [];
      for (const name of entries) {
        // 防路径穿越：只允许纯文件名
        if (name.includes('/') || name.includes('\\')) continue;
        fs.writeFileSync(path.join(root, name), await zip.files[name].async('nodebuffer'));
        imported.push(name);
      }
      store.clearCache();
      res.json({ success: true, data: { imported, restored_from: source } });
    } catch (error) {
      res.json({ success: false, error: `导入失败: ${error.message}` });
    }
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
