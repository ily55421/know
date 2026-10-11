'use strict';

/**
 * 本地资料学习 / 知识库路由（重建版）。
 * 契约自渲染层反混淆（bundle @~7,055,765 起）：
 *   POST /index {folder}                开始学习（后台索引）
 *   GET  /index-progress                {progress,status,file_stats:{success_count,failure_count,simplified_count,total_count},success_files,failed_files,simplified_files,completed,error,doc_parse_failed}
 *   POST /index-cancel                  暂停学习
 *   POST /clean-all-indexes             清理学习数据
 *   POST /start-monitoring {folder}     开启文件监控（重建版记录状态）
 *   POST /stop-monitoring  {folder}     停止文件监控
 *   POST /search {query,folder}         → {success, results:[{source,indexed_folder,inner_path,confidence,snippet(<mark>)}]}
 *   POST /search/file-text {folder,source,inner_path} → {success, content}
 *   POST /api/dedup/exclude-file {directory,file_path} → {success}
 */

const path = require('node:path');
const fs = require('node:fs');
const { IndexEngine } = require('../core/indexer');

function register(app, { store }) {
  const engine = new IndexEngine(store.dataRoot());

  app.post('/index', (req, res) => {
    const folder = String(req.body?.folder || '').trim();
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return res.json({ success: false, message: `目录不存在: ${folder}` });
    }
    if (engine.state.running) {
      return res.json({ success: false, message: `正在学习 ${engine.state.folder}，请先等待完成或暂停` });
    }
    engine.index(folder).catch((e) => {
      engine.state.running = false;
      engine.state.completed = true;
      engine.state.error = e.message;
      engine.state.status = `学习失败: ${e.message}`;
    });
    res.json({ success: true, message: '开始学习', folder: path.resolve(folder) });
  });

  app.get('/index-progress', (_req, res) => {
    res.json(engine.state);
  });

  app.post('/index-cancel', (_req, res) => {
    engine.cancel();
    res.json({ success: true });
  });

  app.post('/clean-all-indexes', (_req, res) => {
    const removed = engine.cleanAll();
    res.json({ success: true, message: `已清理 ${removed} 个目录的学习数据` });
  });

  app.post('/start-monitoring', (req, res) => {
    const folder = String(req.body?.folder || '');
    if (!folder) return res.json({ success: false, message: '缺少 folder' });
    store.update('directories', { map: {} }, (current) => {
      const map = { ...(current.map || {}) };
      const key = path.resolve(folder);
      map[key] = { ...(map[key] || { path: key, indexed: false, last_updated: null }), monitoring: true };
      return { map };
    });
    res.json({ success: true });
  });

  app.post('/stop-monitoring', (req, res) => {
    const folder = String(req.body?.folder || '');
    const key = path.resolve(folder);
    store.update('directories', { map: {} }, (current) => {
      const map = { ...(current.map || {}) };
      if (map[key]) map[key] = { ...map[key], monitoring: false };
      return { map };
    });
    res.json({ success: true });
  });

  app.post('/search', (req, res) => {
    const query = String(req.body?.query || '').trim();
    const folder = String(req.body?.folder || 'all');
    if (!query) return res.json({ success: false, message: '搜索内容不能为空' });
    try {
      const results = engine.search(query, folder);
      res.json({ success: true, results });
    } catch (error) {
      res.json({ success: false, message: error.message });
    }
  });

  app.post('/search/file-text', (req, res) => {
    const { folder, source } = req.body || {};
    const text = engine.fileText(folder, source);
    if (text === null) return res.json({ success: false, message: '未找到该文件的提取文本，请重新学习该目录' });
    res.json({ success: true, content: text });
  });

  app.post('/api/dedup/exclude-file', (_req, res) => {
    // 重建版暂无查重库，记录忽略即视为成功
    res.json({ success: true });
  });

  // 目录学习状态检查（知识库页每目录一查：bundle @~7,057,378）
  //   GET /check-db?folder=...            → {exists}
  //   GET /monitoring-status?folder=...   → {success,is_monitoring,last_updated}
  app.get('/check-db', (req, res) => {
    const folder = String(req.query.folder || '');
    const idx = engine.loadIndex(folder);
    res.json({ exists: Boolean(idx && (idx.files || []).length) });
  });

  app.get('/monitoring-status', (req, res) => {
    const folder = String(req.query.folder || '');
    const key = path.resolve(folder);
    const map = store.load('directories', { map: {} }).map || {};
    const idx = engine.loadIndex(key);
    res.json({
      success: true,
      is_monitoring: Boolean(map[key] && map[key].monitoring),
      last_updated: idx ? idx.updated_at : null,
    });
  });

  // 真实索引文件数（覆盖 system.js 中的占位实现）
  app.get('/get-total-files', (_req, res) => {
    res.json({ success: true, currentIndexedFiles: engine.totalIndexedFiles() });
  });
}

module.exports = { register };
