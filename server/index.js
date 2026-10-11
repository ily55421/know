'use strict';

/**
 * Knowly 后端服务（重建版）——替代原版 resources/python-server/findme.exe。
 *
 * 对外契约与原版对齐（证据见 analysis/EVIDENCE-LEDGER.md）：
 * - 监听 127.0.0.1:28099（原版 18099；electron/src/config.js 的 API_PORT 同源）
 * - 启动后打印 uvicorn 风格就绪行（主进程以 output.includes('Uvicorn running on') 判定就绪）
 * - REST 面：/health /config /chat/sessions /qa/* /tasks /tools /directories /apps 等
 * - LLM 调用统一走主进程 API 代理 127.0.0.1:28081（原版架构：Python → 代理 → 模型厂商）
 * - 数据根由主进程经 --data-root 命令行参数传入（utilityProcess 的 env 传递不可靠）
 */

const express = require('express');

// [重建版适配] 数据根以命令行参数 --data-root 传入（主进程 utilityProcess fork 保证送达）；
// 兜底顺序：argv → env → exe 旁 data/backend（store.js 同款自证逻辑）
const argvRoot = (() => {
  const i = process.argv.indexOf('--data-root');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
if (argvRoot) process.env.KNOWLY_DATA_ROOT = argvRoot;

const store = require('./store');
const { ToolRegistry } = require('./tools/registry');

// [重建版适配] 端口迁移：默认 28099（原版 18099），与 electron/src/config.js 的 API_PORT 对齐
const PORT = Number(process.env.PORT || process.env.KNOWLY_BACKEND_PORT) || 28099;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 渲染层以 file:// 加载（Origin: null），与原版一致放开 CORS；
// 主进程 window-manager 也会在会话级注入 ACAO 头。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// 请求日志（INFO: 前缀使主进程把它当作普通输出）
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`INFO:     ${req.method} ${req.path}`);
  }
  next();
});

const registry = new ToolRegistry();
store.dataRoot();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

require('./routes/system').register(app, { store, registry });
require('./routes/sessions').register(app, { store });
require('./routes/qa').register(app, { store, registry });
require('./routes/tasks').register(app, { store });
require('./routes/files').register(app, { store });
require('./routes/apps').register(app, { store });

// 兜底：未知路径按原版 FastAPI 404 形态返回
app.use((req, res) => {
  res.status(404).json({ detail: 'Not Found', path: req.path, note: '重建版后端未实现该端点（详见 analysis/EVIDENCE-LEDGER.md）' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`INFO:     Started server process [${process.pid}]`);
  console.log(`INFO:     Waiting for application startup.`);
  console.log(`INFO:     Application startup complete.`);
  // 与原版 uvicorn 就绪行保持一致，主进程依赖该标记（python-server.js markServerStarted）
  console.log(`INFO:     Uvicorn running on http://${HOST}:${PORT} (Press CTRL+C to quit)`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`ERROR:    端口 ${PORT} 已被占用（原版 Knowly 或另一实例可能正在运行）。`);
    // [重建版适配] 子进程模式（打包版）不能 process.exit——让主进程按启动超时/清理流程处理
    if (process.env.KNOWLY_IN_PROCESS === '1') {
      console.error('ERROR:    子进程模式：后端启动失败，主进程将按启动超时处理。');
      return;
    }
    process.exit(1);
  }
  console.error('ERROR:    服务启动失败:', error);
  if (process.env.KNOWLY_IN_PROCESS !== '1') process.exit(1);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
