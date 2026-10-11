'use strict';

/** 问答流路由：/qa/chat/stream、/qa/task/*（含执行记录与取消）。 */
const { runChatStream, runTaskStream } = require('../agent');

function register(app, { store, registry }) {
  const executions = new Map(); // execution_id → {status, events, answer}
  const aborts = new Map();     // execution_id → AbortController

  app.post('/qa/chat/stream', (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    runChatStream(store, registry, req.body, res, controller.signal).catch(() => {
      if (!res.headersSent) res.status(500).json({ success: false, error: '流式响应中断' });
    });
  });

  app.post('/qa/task/stream', (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    runTaskStream(store, registry, executions, req.body, res, controller.signal).catch(() => {
      if (!res.headersSent) res.status(500).json({ success: false, error: '流式响应中断' });
    });
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
      },
    });
  });

  app.get('/qa/task/executions/:executionId/stream', (req, res) => {
    const record = executions.get(req.params.executionId);
    if (!record) {
      return res.status(404).json({ success: false, error: '执行记录不存在' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const event of record.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write('data: {"type":"execution_status","data":{"execution_id":"' + record.execution_id + '","status":"' + record.status + '"}}\n\n');
    res.end();
  });

  app.post('/qa/task/executions/:executionId/cancel', (req, res) => {
    const controller = aborts.get(req.params.executionId);
    if (controller) controller.abort();
    const record = executions.get(req.params.executionId);
    if (record && record.status === 'running') record.status = 'cancelling';
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
