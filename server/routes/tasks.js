'use strict';

/** 定时任务路由（原版 /tasks/*，主进程启动/退出时会轮询 enabled-count 与通知）。 */

const newId = () => `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function register(app, { store }) {
  const list = () => store.load('tasks', { items: [] }).items || [];
  const saveList = (items) => store.save('tasks', { items });

  app.get('/tasks', (_req, res) => {
    res.json({ success: true, data: { tasks: list() } });
  });

  app.post('/tasks', (req, res) => {
    const body = req.body || {};
    const task = {
      task_id: newId(),
      name: String(body.name || body.title || '未命名任务').slice(0, 100),
      prompt: String(body.prompt || body.query || ''),
      schedule: body.schedule || body.cron || null,
      enabled: body.enabled !== false,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_run_at: null,
      runs: [],
    };
    saveList([task, ...list()]);
    res.json({ success: true, data: { task } });
  });

  const findTask = (id) => list().find((t) => t.task_id === id) || null;

  app.get('/tasks/subscription', (_req, res) => {
    res.json({ success: true, data: { subscriptions: [] } });
  });

  app.get('/tasks/:taskId', (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { task } });
  });

  const patchTask = (req, res) => {
    const patch = req.body || {};
    let updated = null;
    saveList(list().map((t) => {
      if (t.task_id !== req.params.taskId) return t;
      updated = {
        ...t,
        ...(patch.name !== undefined ? { name: String(patch.name).slice(0, 100) } : {}),
        ...(patch.prompt !== undefined ? { prompt: String(patch.prompt) } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
        updated_at: Date.now(),
      };
      return updated;
    }));
    if (!updated) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { task: updated } });
  };
  app.patch('/tasks/:taskId', patchTask);
  app.put('/tasks/:taskId', patchTask);

  app.delete('/tasks/:taskId', (req, res) => {
    const before = list().length;
    saveList(list().filter((t) => t.task_id !== req.params.taskId));
    if (list().length === before) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { deleted: req.params.taskId } });
  });

  app.post('/tasks/:taskId/enabled', (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    let updated = null;
    saveList(list().map((t) => {
      if (t.task_id !== req.params.taskId) return t;
      updated = { ...t, enabled, updated_at: Date.now() };
      return updated;
    }));
    if (!updated) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { task: updated } });
  });

  app.post('/tasks/:taskId/run-now', (req, res) => {
    let updated = null;
    saveList(list().map((t) => {
      if (t.task_id !== req.params.taskId) return t;
      updated = { ...t, last_run_at: Date.now(), runs: [...(t.runs || []).slice(-49), { started_at: Date.now(), trigger: 'manual', status: 'queued' }] };
      return updated;
    }));
    if (!updated) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { task: updated, note: '重建版仅记录运行请求，未接入完整调度执行' } });
  });

  app.get('/tasks/:taskId/runs', (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return res.json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: { runs: task.runs || [] } });
  });

  app.post('/tasks/:taskId/cancel', (req, res) => {
    res.json({ success: true, data: { cancelled: req.params.taskId } });
  });
}

module.exports = { register };
