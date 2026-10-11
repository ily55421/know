'use strict';

/** 文件与导出路由：/files/*、/upload/*、/api/directory-stats/*、/export/*、/api/toolbox/*。 */

function register(app, { store }) {
  const fs = require('node:fs');
  const path = require('node:path');

  // ---- 目录统计（真实实现：异步遍历 + 进度查询） ----
  const statJobs = new Map(); // job_id → {total_files, total_bytes, done, dirs}
  app.post('/api/directory-stats/start', (req, res) => {
    const dir = String(req.body?.path || req.body?.directory || '').trim();
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.json({ success: false, error: `目录不存在: ${dir}` });
    }
    const jobId = `stat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const job = { total_files: 0, total_bytes: 0, done: false, error: null };
    statJobs.set(jobId, job);
    setImmediate(() => {
      try {
        const walk = (current, depth) => {
          if (job.done) return;
          let entries;
          try {
            entries = fs.readdirSync(current, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
              if (!['node_modules', '.git'].includes(entry.name) && depth < 10) walk(full, depth + 1);
              continue;
            }
            try {
              job.total_files += 1;
              job.total_bytes += fs.statSync(full).size;
            } catch { /* 文件被并发删除时忽略 */ }
          }
        };
        walk(dir, 0);
      } catch (error) {
        job.error = error.message;
      } finally {
        job.done = true;
      }
    });
    res.json({ success: true, data: { task_id: jobId } });
  });
  app.get('/api/directory-stats/progress/:taskId', (req, res) => {
    const job = statJobs.get(req.params.taskId);
    if (!job) return res.json({ success: false, error: '统计任务不存在' });
    res.json({ success: true, data: { ...job, task_id: req.params.taskId } });
  });
  app.post('/api/directory-stats/cancel/:taskId', (req, res) => {
    const job = statJobs.get(req.params.taskId);
    if (job) job.done = true;
    res.json({ success: true, data: { cancelled: req.params.taskId } });
  });

  // ---- 文件管理 ----
  app.post('/files/create_folder', (req, res) => {
    const target = String(req.body?.path || req.body?.folder || '').trim();
    if (!target) return res.json({ success: false, error: '路径不能为空' });
    try {
      fs.mkdirSync(target, { recursive: true });
      res.json({ success: true, data: { path: target } });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  app.post('/files/create_shortcut', (_req, res) => {
    res.json({ success: false, error: '快捷方式创建依赖原版 shell 集成，重建版未实现' });
  });

  for (const route of ['/files/upload', '/files/upload_all', '/files/upload_prepare', '/files/upload_part', '/files/upload_finish', '/upload/initialize', '/upload/part', '/upload/complete']) {
    app.post(route, (_req, res) => {
      res.json({ success: false, error: '文件分片上传依赖原版传输协议（手机远程/知识库导入），重建版未实现' });
    });
  }

  // ---- 知识创作成就（字段消费自 bundle fmt 组件：summary/status/activityDays/folders/lastError）----
  // 依赖原版索引统计，重建版返回全零 + 空热力图，让页面优雅渲染
  const zeroCounts = () => ({ added: 0, modified: 0, deleted: 0 });
  app.get('/knowledge-activity/overview', (req, res) => {
    res.json({
      success: true,
      data: {
        months: Number(req.query.months) || 12,
        status: { running: false, last_run_at: null, progress: 0 },
        summary: { today: zeroCounts(), last7Days: zeroCounts(), last30Days: zeroCounts() },
        activity30d: zeroCounts(),
        activityDays: [],
        folders: [],
        folderPath: null,
        lastError: null,
        total_learned: 0,
        total_documents: 0,
        last_activity: null,
        daily: [],
      },
    });
  });
  // 「立即统计」按钮（按钮 loading 取 data.status.running）
  app.post('/knowledge-activity/run-now', (_req, res) => {
    res.json({ success: true, data: { status: { running: false, last_run_at: new Date().toISOString() } } });
  });
  app.get('/knowledge-activity/events', (req, res) => {
    res.json({ success: true, data: [], limit: Number(req.query.limit) || 200 });
  });

  // ---- 导出 ----
  app.post('/export/xmind', (_req, res) => {
    res.json({ success: false, error: 'XMind 导出依赖原版 mind-elixir → xmind 转换管线，重建版未实现' });
  });
  app.post('/export/cancel', (_req, res) => {
    res.json({ success: true, data: { cancelled: true } });
  });

  // ---- 工具箱（图像修复 / 公众号导入 / 图片去隐私）----
  // 百宝箱工具清单（渲染层消费 {success, data:[], ocr}）：重建版暂无原版百宝箱工具，
  // 返回空清单让面板优雅降级，不再报「工具列表加载失败」
  app.get('/api/toolbox/tools', (_req, res) => {
    res.json({ success: true, data: [], ocr: null });
  });
  for (const route of ['/api/toolbox/image-inpaint/batch', '/api/toolbox/privacy/image-redact/batch', '/api/toolbox/article/import-docx', '/api/toolbox/wechat-mp/import-docx']) {
    app.post(route, (_req, res) => {
      res.json({ success: false, error: '工具箱能力依赖原版模型服务（图像修复/OCR/文档解析），重建版未实现' });
    });
  }
  app.post('/api/toolbox/image-inpaint/tasks/:taskId/cancel', (req, res) => {
    res.json({ success: true, data: { cancelled: req.params.taskId } });
  });
  app.post('/api/toolbox/privacy/image-redact/tasks/:taskId/cancel', (req, res) => {
    res.json({ success: true, data: { cancelled: req.params.taskId } });
  });

  // ---- 离线模型包 ----
  app.get('/api/offline-pack/options', (_req, res) => {
    res.json({ success: true, data: { options: [] } });
  });
  for (const route of ['/api/offline-pack/export', '/api/offline-pack/import']) {
    app.post(route, (_req, res) => {
      res.json({ success: false, error: '离线模型包依赖原版向量库与嵌入模型，重建版未实现' });
    });
  }
  app.get('/api/offline-pack/jobs/:jobId', (req, res) => {
    res.json({ success: true, data: { job_id: req.params.jobId, status: 'not_found', note: '重建版无离线包任务' } });
  });

  // ---- MCP ----
  app.get('/mcp/tools', (_req, res) => {
    res.json({ success: true, data: { tools: [] } });
  });
  app.get('/knowledge/status', (_req, res) => {
    res.json({ success: true, data: { indexed: false, note: '重建版未实现向量索引' } });
  });
}

module.exports = { register };
