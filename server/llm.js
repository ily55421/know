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

// [重建版适配] 上游（本地网关 → 模型厂商）为不可控边界，偶发 Connection error / 5xx 是常态。
// 统一在此做退避重试，避免一次抖动直接抛给用户（历史表现为"莫名调用失败"）。
const RETRYABLE = /connection error|econn|etimedout|timeout|socket hang up|fetch failed|502|503|504|temporarily/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function proxyPost(pathname, body, { retry = true, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= (retry ? attempts : 1); attempt += 1) {
    try {
      const response = await fetch(`${PROXY_BASE}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      const errText = String(payload?.error || payload?.message || '');
      if (payload && payload.success === false && retry && attempt < attempts && RETRYABLE.test(errText)) {
        lastError = new Error(errText);
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (!retry || attempt >= attempts || !RETRYABLE.test(String(error.message))) throw error;
      await sleep(600 * 2 ** (attempt - 1));
    }
  }
  throw lastError || new Error('上游调用失败');
}

/** 连接类错误的用户可读归一化（渲染层据此展示指引性文案） */
function normalizeLlmError(message) {
  const text = String(message || '');
  if (/enotfound|econnrefused|connection error|fetch failed|econnreset|socket hang up/i.test(text)) {
    return `无法连接到大模型服务：网关（${PROXY_BASE}）或其上游无响应，请确认本机网关已启动后重试。原始错误: ${text}`;
  }
  if (/timeout|etimedout/i.test(text)) {
    return `大模型响应超时，请稍后重试。原始错误: ${text}`;
  }
  return text || '大模型调用失败';
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

async function chatOnce(store, { messages, temperature = 0.7, maxTokens = 4096, enableThinking = true }) {
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
    // 思考链：默认向网关请求 reasoning（兼容 OpenAI 格式的端点会忽略未知字段）
    enable_thinking: enableThinking,
  });
  if (!payload?.success) {
    const error = new Error(normalizeLlmError(payload?.error || '大模型调用失败'));
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
 *
 * [重建版适配] 健壮性策略：
 * - 尚未产出任何内容前发生上游错误（连接抖动/网关 5xx）→ 退避重试整个流式启动（最多 3 次）；
 * - 已产出内容后失败 → 保留已输出并抛出（避免重复内容）；
 * - 读流（/api/stream/read）不重试（会话失效重试无意义）；
 * - 错误消息统一归一化，渲染层可给出指引性文案而非"莫名失败"。
 */
async function chatStream(store, { messages, temperature = 0.7, maxTokens = 4096, onDelta, signal, enableThinking = true }) {
  const cfg = loadModelConfig(store);
  if (!cfg.api_key || !cfg.base_url || !cfg.model) {
    const error = new Error('未配置大模型：请在应用设置中配置 API Key、Base URL 与模型名');
    error.code = 'LLM_NOT_CONFIGURED';
    throw error;
  }

  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let full = '';
    let reasoning = '';
    let produced = false;
    let streamId = null;
    let retryNeeded = false;

    try {
      const started = await proxyPost('/api/openai/chat/completions', {
        api_key: cfg.api_key,
        base_url: cfg.base_url,
        model: cfg.model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        enable_thinking: enableThinking,
      }, { retry: true, attempts: 2 });
      if (!started?.success || !started.stream_id) {
        throw new Error(started?.error || '大模型流式调用失败');
      }
      streamId = started.stream_id;

      while (!signal?.aborted) {
        const step = await proxyPost('/api/stream/read', { stream_id: streamId }, { retry: false });
        if (step?.error) {
          if (!produced && attempt < MAX_ATTEMPTS && RETRYABLE.test(String(step.error))) {
            lastError = new Error(step.error);
            retryNeeded = true;
            break;
          }
          throw new Error(step.error);
        }
        if (step?.done) return { content: full, reasoning };
        const chunk = step?.chunk;
        const delta = chunk?.choices?.[0]?.delta || {};
        const reasoningPiece = delta.reasoning_content || delta.reasoning || '';
        const contentPiece = delta.content || '';
        if (reasoningPiece) {
          reasoning += reasoningPiece;
          produced = true;
          onDelta?.({ reasoning: reasoningPiece });
        }
        if (contentPiece) {
          full += contentPiece;
          produced = true;
          onDelta?.({ content: contentPiece });
        }
      }
      if (signal?.aborted) return { content: full, reasoning };
      if (!retryNeeded) return { content: full, reasoning };
    } catch (error) {
      lastError = error;
      if (produced || signal?.aborted || attempt >= MAX_ATTEMPTS) {
        throw new Error(normalizeLlmError(error.message));
      }
    } finally {
      if (streamId && (signal?.aborted || retryNeeded)) {
        proxyPost('/api/stream/cancel', { stream_id: streamId }, { retry: false }).catch(() => {});
      }
    }

    await sleep(600 * 2 ** (attempt - 1)); // 退避后重试整个流式启动
  }

  throw new Error(normalizeLlmError(lastError?.message || '大模型流式调用失败'));
}

module.exports = { chatOnce, chatStream, loadModelConfig, proxyPost, PROXY_BASE };
