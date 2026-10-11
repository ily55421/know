'use strict';

/**
 * 应用管理（渲染层契约，反混淆自 bundle.js apps 面板）：
 *   GET    /apps           → {success, data:[{id,name,entry,created_at}]}
 *   POST   /apps/import    {source_path, name} → 复制 HTML 文件/目录到持久区
 *   POST   /apps/open      {app_id} → 用默认浏览器打开入口 HTML
 *   DELETE /apps           {app_id} → 删除应用及其文件
 *   PUT    /apps           {app_id, name, entry} → 重命名/改入口
 *   PUT    /apps/content   {app_id, entry, html} → 在线编辑保存
 *   GET    /apps/content   ?app_id&entry → {success, data:{html}}（在线编辑读取）
 */

const fs = require('node:fs');
const path = require('node:path');

function register(app, { store }) {
  const appsDir = () => {
    const dir = path.join(store.dataRoot(), 'apps');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const list = () => store.load('apps', { items: [], seeded: false });
  const saveList = (s) => store.save('apps', s);

  const copyTree = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyTree(s, d);
      else fs.copyFileSync(s, d);
    }
  };

  const findEntry = (dir) => {
    const preferred = ['index.html', 'main.html'];
    for (const name of preferred) {
      if (fs.existsSync(path.join(dir, name))) return name;
    }
    const flat = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.html'));
    return flat || null;
  };

  // 预置示例：首次运行（apps 存储不存在）时导入内置示例应用
  function seedSamples() {
    const state = list();
    if (state.seeded || (state.items && state.items.length)) return;
    const seedDir = path.resolve(__dirname, '..', 'data-seed', 'sample-apps');
    if (!fs.existsSync(seedDir)) return;
    for (const dir of fs.readdirSync(seedDir)) {
      const src = path.join(seedDir, dir);
      if (!fs.statSync(src).isDirectory()) continue;
      const manifestPath = path.join(src, 'manifest.json');
      let name = dir;
      let entry = findEntry(src);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        name = manifest.name || name;
        entry = manifest.entry || entry;
      } catch { /* 无 manifest 时用目录名 */ }
      if (!entry) continue;
      const id = `sample_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const dest = path.join(appsDir(), id);
      copyTree(src, dest);
      try { fs.rmSync(path.join(dest, 'manifest.json')); } catch { /* ignore */ }
      saveList({ ...list(), items: [...list().items, { id, name, entry, created_at: Date.now() }], seeded: true });
    }
  }

  app.get('/apps', (_req, res) => {
    seedSamples();
    res.json({ success: true, data: list().items });
  });

  app.post('/apps/import', (req, res) => {
    try {
      const source = String(req.body?.source_path || '').trim();
      const name = String(req.body?.name || '').trim() || '未命名应用';
      if (!source || !fs.existsSync(source)) {
        return res.json({ success: false, message: `路径不存在: ${source}` });
      }
      const stat = fs.statSync(source);
      const id = `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const dest = path.join(appsDir(), id);
      let entry;
      if (stat.isFile()) {
        if (!/\.html?$/i.test(source)) {
          return res.json({ success: false, message: '仅支持 HTML 文件或包含 HTML 的文件夹' });
        }
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(source, path.join(dest, path.basename(source)));
        entry = path.basename(source);
      } else {
        copyTree(source, dest);
        entry = findEntry(dest);
        if (!entry) {
          fs.rmSync(dest, { recursive: true, force: true });
          return res.json({ success: false, message: '文件夹中未找到 HTML 文件' });
        }
      }
      const state = list();
      state.items = [...(state.items || []), { id, name, entry, created_at: Date.now() }];
      saveList(state);
      res.json({ success: true, data: { id, name, entry, created_at: Date.now() } });
    } catch (error) {
      res.json({ success: false, message: error.message });
    }
  });

  const findApp = (id) => (list().items || []).find((a) => a.id === id) || null;

  app.post('/apps/open', (req, res) => {
    const item = findApp(String(req.body?.app_id || ''));
    if (!item) return res.json({ success: false, message: '应用不存在' });
    const entryPath = path.join(appsDir(), item.id, item.entry);
    if (!fs.existsSync(entryPath)) return res.json({ success: false, message: '入口文件不存在' });
    try {
      const { spawn } = require('node:child_process');
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', entryPath], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [entryPath], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [entryPath], { detached: true, stdio: 'ignore' }).unref();
      res.json({ success: true, data: { entry_path: entryPath } });
    } catch (error) {
      res.json({ success: false, message: error.message });
    }
  });

  app.delete('/apps', (req, res) => {
    const id = String(req.body?.app_id || '');
    const state = list();
    const item = (state.items || []).find((a) => a.id === id);
    if (!item) return res.json({ success: false, message: '应用不存在' });
    state.items = state.items.filter((a) => a.id !== id);
    saveList(state);
    fs.rmSync(path.join(appsDir(), id), { recursive: true, force: true });
    res.json({ success: true });
  });

  app.put('/apps', (req, res) => {
    const id = String(req.body?.app_id || '');
    const state = list();
    const item = (state.items || []).find((a) => a.id === id);
    if (!item) return res.json({ success: false, message: '应用不存在' });
    if (req.body?.name) item.name = String(req.body.name).slice(0, 60);
    if (req.body?.entry) item.entry = String(req.body.entry);
    saveList(state);
    res.json({ success: true, data: item });
  });

  app.get('/apps/content', (req, res) => {
    const item = findApp(String(req.query.app_id || ''));
    if (!item) return res.json({ success: false, message: '应用不存在' });
    const entryPath = path.join(appsDir(), item.id, String(req.query.entry || item.entry));
    if (!fs.existsSync(entryPath)) return res.json({ success: false, message: '入口文件不存在' });
    res.json({ success: true, data: { html: fs.readFileSync(entryPath, 'utf8'), entry: req.query.entry || item.entry } });
  });

  app.put('/apps/content', (req, res) => {
    const item = findApp(String(req.body?.app_id || ''));
    if (!item) return res.json({ success: false, message: '应用不存在' });
    const entry = String(req.body?.entry || item.entry);
    const entryPath = path.join(appsDir(), item.id, entry);
    if (!entryPath.startsWith(path.join(appsDir(), item.id))) {
      return res.json({ success: false, message: '非法路径' });
    }
    fs.writeFileSync(entryPath, String(req.body?.html ?? ''), 'utf8');
    res.json({ success: true });
  });
}

module.exports = { register };
