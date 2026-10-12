'use strict';

/** 问答流路由：/qa/chat/stream、/qa/task/*。
 *
 * 任务模式（渲染层契约，反混淆自 bundle.js @~6,155,949）：
 *   1. POST /qa/task/executions        → {success, execution_id}（立即返回，后台执行）
 *   2. GET  /qa/task/executions/{id}/stream → SSE 订阅（先重放已产生事件，再实时跟随至终态）
 *   3. POST /qa/task/executions/{id}/cancel → 取消
 *   4. POST /qa/task/executions/{id}/user-input → ask_user 交互（重建版不支持，诚实降级）
 */

const { runChatStream, runTaskStream, runTaskExecution } = require('../agent');

function register(app, { store, registry }) {
  const executions = new Map(); // execution_id → {status, events, answer}
  const aborts = new Map();     // execution_id → AbortController

  const isTerminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);

  app.post('/qa/chat/stream', (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    runChatStream(store, registry, req.body, res, controller.signal).catch(() => {
      if (!res.headersSent) res.status(500).json({ success: false, error: '流式响应中断' });
    });
  });

  // 兼容保留：直连式任务流
  app.post('/qa/task/stream', (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    runTaskStream(store, registry, executions, aborts, req.body, res, controller.signal).catch(() => {
      if (!res.headersSent) res.status(500).json({ success: false, error: '流式响应中断' });
    });
  });

  // 渲染层任务模式主链路：创建执行并立即返回，后台执行
  app.post('/qa/task/executions', (req, res) => {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = { execution_id: executionId, status: 'running', created_at: Date.now(), events: [] };
    executions.set(executionId, record);
    const controller = new AbortController();
    aborts.set(executionId, controller);
    runTaskExecution(store, registry, executions, aborts, req.body || {}, null, controller.signal, record).catch(() => {});
    res.json({ success: true, execution_id: executionId });
  });

  // 渲染层订阅：先重放，后实时跟随
  app.get('/qa/task/executions/:executionId/stream', (req, res) => {
    const record = executions.get(req.params.executionId);
    if (!record) {
      return res.status(404).json({ success: false, error: '执行记录不存在' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    let cursor = 0;
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const timer = setInterval(() => {
      while (cursor < record.events.length) {
        send(record.events[cursor]);
        cursor += 1;
      }
      if (isTerminal(record.status) && cursor >= record.events.length) {
        send({ type: 'execution_status', data: { execution_id: record.execution_id, status: record.status } });
        clearInterval(timer);
        res.end();
      }
    }, 120);
    req.on('close', () => clearInterval(timer));
  });

  app.get('/qa/task/executions', (_req, res) => {
    const items = [...executions.entries()].map(([execution_id, record]) => ({
      execution_id,
      status: record.status,
      created_at: record.created_at,
    }));
    res.json({ success: true, data: { executions: items } });
  });

  app.get('/qa/task/executions/:executionId', (req, res) => {
    const record = executions.get(req.params.executionId);
    if (!record) return res.json({ success: false, error: '执行记录不存在' });
    res.json({
      success: true,
      data: {
        execution_id: record.execution_id,
        status: record.status,
        created_at: record.created_at,
        answer: record.answer || null,
        // 推理全文：渲染层任务消息不自带 thinkingContent，前端注入模块据此内联展示思考过程
        thinking: record.thinking || null,
      },
    });
  });

  app.post('/qa/task/executions/:executionId/cancel', (req, res) => {
    const controller = aborts.get(req.params.executionId);
    if (controller) controller.abort();
    const record = executions.get(req.params.executionId);
    if (record && !isTerminal(record.status)) {
      record.status = record.status === 'cancelling' ? 'cancelled' : 'cancelling';
      record.events.push({ type: 'cancelling', data: { execution_id: record.execution_id } });
    }
    res.json({ success: true, data: { execution_id: req.params.executionId, status: 'cancelling' } });
  });

  app.post('/qa/task/executions/:executionId/user-input', (req, res) => {
    res.json({ success: false, error: '重建版不支持任务中的 ask_user 交互（原版经 react_loop 等待用户输入）' });
  });
  app.post('/qa/task/user-input', (req, res) => {
    res.json({ success: false, error: '重建版不支持任务中的 ask_user 交互' });
  });
  app.post('/qa/task/user-input/cancel', (req, res) => {
    res.json({ success: true, data: { cancelled: true } });
  });

  app.post('/qa/diagram/regenerate', (_req, res) => {
    res.json({ success: false, error: '图表重生成依赖原版 diagram 管线，重建版未实现' });
  });
}

module.exports = { register };
