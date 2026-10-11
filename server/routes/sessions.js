'use strict';

/**
 * 会话路由：/chat/sessions CRUD、消息、收藏、localStorage 迁移。
 *
 * 响应形态对齐原版在线观测（analysis/EVIDENCE-LEDGER.md §在线对照）：
 * - 会话字段：{id, title, selectedFolders, currentAgentId, source, taskId,
 *              isFavorite, createdAt, updatedAt, messages[]}
 * - 列表：{success, data:[...], pagination:{page, page_size, total, total_pages}}
 * - 详情：{success, data:{...会话, messages:[...]}}
 */

const { generateTitle } = require('../agent');

const newId = () => `session_${Date.now()}`;

function normalizeSession(input) {
  return {
    id: input.id || input.session_id || newId(),
    title: String(input.title || '新的对话').slice(0, 100),
    selectedFolders: Array.isArray(input.selectedFolders) ? input.selectedFolders : ['all'],
    currentAgentId: input.currentAgentId ?? null,
    source: input.source || 'chat',
    taskId: input.taskId ?? null,
    isFavorite: Boolean(input.isFavorite ?? input.favorite),
    createdAt: input.createdAt || input.created_at || Date.now(),
    updatedAt: input.updatedAt || input.updated_at || Date.now(),
    messages: Array.isArray(input.messages) ? input.messages : [],
  };
}

function register(app, { store }) {
  const listStore = () => store.load('sessions', { items: [] });

  app.get('/chat/sessions', (req, res) => {
    const items = [...(listStore().items || [])]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.max(Number(req.query.page_size) || Number(req.query.limit) || 10, 1);
    const start = (page - 1) * pageSize;
    const sessions = items.slice(start, start + pageSize).map((s) => ({ ...s, messages: undefined }));
    res.json({
      success: true,
      data: sessions,
      pagination: { page, page_size: pageSize, total: items.length, total_pages: Math.ceil(items.length / pageSize) },
    });
  });

  app.post('/chat/sessions', (req, res) => {
    const session = normalizeSession(req.body || {});
    store.update('sessions', { items: [] }, (current) => ({
      items: [session, ...(current.items || []).filter((s) => s.id !== session.id)],
    }));
    res.json({ success: true, data: session });
  });

  app.get('/chat/sessions/:sessionId', (req, res) => {
    const session = (listStore().items || []).find((s) => s.id === req.params.sessionId);
    if (!session) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: session });
  });

  const patchSession = (req, res) => {
    const patch = req.body || {};
    let updated = null;
    store.update('sessions', { items: [] }, (current) => ({
      items: (current.items || []).map((s) => {
        if (s.id !== req.params.sessionId) return s;
        updated = {
          ...s,
          ...(patch.title !== undefined ? { title: String(patch.title).slice(0, 100) } : {}),
          ...(patch.isFavorite !== undefined || patch.favorite !== undefined
            ? { isFavorite: Boolean(patch.isFavorite ?? patch.favorite) }
            : {}),
          ...(patch.selectedFolders !== undefined ? { selectedFolders: patch.selectedFolders } : {}),
          ...(patch.currentAgentId !== undefined ? { currentAgentId: patch.currentAgentId } : {}),
          updatedAt: Date.now(),
        };
        return updated;
      }),
    }));
    if (!updated) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: updated });
  };
  app.patch('/chat/sessions/:sessionId', patchSession);
  app.put('/chat/sessions/:sessionId', patchSession);

  app.delete('/chat/sessions/:sessionId', (req, res) => {
    let removed = false;
    store.update('sessions', { items: [] }, (current) => ({
      items: (current.items || []).filter((s) => {
        if (s.id === req.params.sessionId) {
          removed = true;
          return false;
        }
        return true;
      }),
    }));
    if (!removed) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: { deleted: req.params.sessionId } });
  });

  app.get('/chat/sessions/:sessionId/messages', (req, res) => {
    const session = (listStore().items || []).find((s) => s.id === req.params.sessionId);
    if (!session) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: session.messages || [] });
  });

  app.post('/chat/sessions/:sessionId/messages', (req, res) => {
    const body = req.body || {};
    const message = {
      role: body.role === 'assistant' ? 'assistant' : 'user',
      content: String(body.content ?? ''),
      timestamp: body.timestamp || Date.now(),
      ...(body.agentName ? { agentName: body.agentName } : {}),
      ...(body.agentIcon ? { agentIcon: body.agentIcon } : {}),
      ...(body.sources ? { sources: body.sources } : {}),
      ...(body.thinkingContent ? { thinkingContent: body.thinkingContent } : {}),
      ...(body.selected_files ? { selected_files: body.selected_files } : {}),
    };
    let saved = false;
    store.update('sessions', { items: [] }, (current) => ({
      items: (current.items || []).map((s) => {
        if (s.id !== req.params.sessionId) return s;
        saved = true;
        return { ...s, messages: [...(s.messages || []), message], updatedAt: Date.now() };
      }),
    }));
    if (!saved) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: message });
  });

  app.delete('/chat/sessions/:sessionId/messages', (req, res) => {
    let cleared = false;
    store.update('sessions', { items: [] }, (current) => ({
      items: (current.items || []).map((s) => {
        if (s.id !== req.params.sessionId) return s;
        cleared = true;
        return { ...s, messages: [], updatedAt: Date.now() };
      }),
    }));
    if (!cleared) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: { cleared: req.params.sessionId } });
  });

  app.post('/chat/sessions/:sessionId/favorite', (req, res) => {
    const isFavorite = Boolean(req.body?.favorite ?? req.body?.isFavorite);
    let updated = null;
    store.update('sessions', { items: [] }, (current) => ({
      items: (current.items || []).map((s) => {
        if (s.id !== req.params.sessionId) return s;
        updated = { ...s, isFavorite };
        return updated;
      }),
    }));
    if (!updated) return res.json({ success: false, error: '会话不存在' });
    res.json({ success: true, data: updated });
  });

  app.post('/chat/migrate-from-localstorage', (req, res) => {
    const incoming = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
    let migrated = 0;
    store.update('sessions', { items: [] }, (current) => {
      const items = [...(current.items || [])];
      for (const raw of incoming) {
        const session = normalizeSession(raw);
        if (items.some((s) => s.id === session.id)) continue;
        items.push(session);
        migrated += 1;
      }
      return { items };
    });
    res.json({ success: true, data: { migrated } });
  });

  app.post('/qa/generate-title', async (req, res) => {
    const result = await generateTitle(store, req.body || {});
    res.json(result);
  });
}

module.exports = { register };
