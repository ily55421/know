'use strict';

/**
 * LLM 调用层：复用原版架构——后端不直连模型厂商，
 * 一律走 Electron 主进程的 API 代理（127.0.0.1:18081，见 electron/src/api-proxy-handler.js）。
 *
 * 代理协议（观察自原版主进程源码）：
 *   POST /api/openai/chat/completions  {api_key, base_url, model, messages, stream, ...}
 *     - stream=false → {success, data: <OpenAI 响应>}
 *     - stream=true  → {success, stream_id}，随后 POST /api/stream/read {stream_id}
 *                      返回 {done, chunk?|error?}，直到 done=true
 *   POST /api/stream/cancel {stream_id}
 *   POST /api/openai/embeddings {api_key, base_url, model, input}
 */

// [重建版适配] 端口迁移：代理默认 28081（原版 18081），与 electron/src/api-proxy-handler.js 对齐
const PROXY_BASE = process.env.KNOWLY_PROXY_BASE
  || `http://127.0.0.1:${process.env.KNOWLY_PROXY_PORT || 28081}`;

async function proxyPost(pathname, body) {
  const response = await fetch(`${PROXY_BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

/** 读取模型配置（渲染层通过 POST /config 写入；与原版一样由后端持有 api_key/base_url）。 */
function loadModelConfig(store) {
  const config = store.load('config', {});
  const models = config.models || config.model_config || {};
  const current = models.current || models.current_model || null;
  const list = Array.isArray(models.list) ? models.list : [];
  const active = list.find((m) => m.id === current) || list[0] || models.active || null;
  return {
    api_key: active?.api_key || config.api_key || '',
    base_url: active?.base_url || config.base_url || '',
    model: active?.model || config.model || '',
  };
}

async function chatOnce(store, { messages, temperature = 0.7, maxTokens = 4096 }) {
  const cfg = loadModelConfig(store);
  if (!cfg.api_key || !cfg.base_url || !cfg.model) {
    const error = new Error('未配置大模型：请在应用设置中配置 API Key、Base URL 与模型名');
    error.code = 'LLM_NOT_CONFIGURED';
    throw error;
  }
  const payload = await proxyPost('/api/openai/chat/completions', {
    api_key: cfg.api_key,
    base_url: cfg.base_url,
    model: cfg.model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
  });
  if (!payload?.success) {
    const error = new Error(payload?.error || '大模型调用失败');
    error.code = 'LLM_ERROR';
    throw error;
  }
  const choice = payload.data?.choices?.[0];
  return {
    content: choice?.message?.content || '',
    reasoning: choice?.message?.reasoning_content || choice?.message?.reasoning || '',
  };
}

/**
 * 流式对话：走代理的 stream 会话并轮询 /api/stream/read（与原版 Python 端一致）。
 * onDelta 回调拿到每个增量文本块；返回最终全文。
 */
async function chatStream(store, { messages, temperature = 0.7, maxTokens = 4096, onDelta, signal }) {
  const cfg = loadModelConfig(store);
  if (!cfg.api_key || !cfg.base_url || !cfg.model) {
    const error = new Error('未配置大模型：请在应用设置中配置 API Key、Base URL 与模型名');
    error.code = 'LLM_NOT_CONFIGURED';
    throw error;
  }
  const started = await proxyPost('/api/openai/chat/completions', {
    api_key: cfg.api_key,
    base_url: cfg.base_url,
    model: cfg.model,
    messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  });
  if (!started?.success || !started.stream_id) {
    const error = new Error(started?.error || '大模型流式调用失败');
    error.code = 'LLM_ERROR';
    throw error;
  }

  const streamId = started.stream_id;
  let full = '';
  let reasoning = '';
  try {
    while (!signal?.aborted) {
      const step = await proxyPost('/api/stream/read', { stream_id: streamId });
      if (step?.error) {
        throw new Error(step.error);
      }
      if (step?.done) break;
      const chunk = step?.chunk;
      const delta = chunk?.choices?.[0]?.delta || {};
      const reasoningPiece = delta.reasoning_content || delta.reasoning || '';
      const contentPiece = delta.content || '';
      if (reasoningPiece) {
        reasoning += reasoningPiece;
        onDelta?.({ reasoning: reasoningPiece });
      }
      if (contentPiece) {
        full += contentPiece;
        onDelta?.({ content: contentPiece });
      }
    }
  } finally {
    if (signal?.aborted) {
      proxyPost('/api/stream/cancel', { stream_id: streamId }).catch(() => {});
    }
  }
  return { content: full, reasoning };
}

module.exports = { chatOnce, chatStream, loadModelConfig, PROXY_BASE };
