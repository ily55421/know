'use strict';

/**
 * 简化智能体：为 /qa/chat/stream（普通对话）与 /qa/task/*（任务模式）产出 SSE 事件流。
 *
 * 事件协议还原自渲染层 bundle.js 的 SSE 解析器（证据见 analysis/EVIDENCE-LEDGER.md §SSE 协议）：
 * 普通对话事件：metadata / sources / thinking_content / content / complete / quota_exceeded / error
 * 任务模式事件：round_start / reasoning_* / preparing_tools / calling_tool / tool_output_chunk /
 *              tool_result / tool_error / thinking_result / answer_start / answer_chunk /
 *              answer_commit / complete / max_iterations / cancelled / error 等
 *
 * 与原版差异（诚实声明）：原版为多轮 ReAct 循环（src/agent/react_loop），含子 Agent、
 * 网络搜索、RAG 检索与上下文压缩；重建版为单轮 + 可选一轮工具调用的简化循环，
 * 工具面以 ToolRegistry 中真实实现的部分为准。
 */

const { chatOnce, chatStream } = require('./llm');

const TOOL_SYSTEM_PROMPT = `你可以使用以下工具来完成任务。需要调用工具时，仅输出一个如下格式的 JSON 代码块（不要有其他文字）：
\`\`\`tool_call
{"tool": "工具名", "arguments": { ...入参... }}
\`\`\`
可用工具及入参说明会在用户消息后附上。若无需工具，直接用 Markdown 回答。`;

function extractToolCall(text) {
  const match = text.match(/```tool_call\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed.tool === 'string') {
      return { tool: parsed.tool, arguments: parsed.arguments || {} };
    }
  } catch { /* 模型输出非法 JSON 时按普通文本处理 */ }
  return null;
}

function stripToolCall(text) {
  return text.replace(/```tool_call[\s\S]*?```/g, '').trim();
}

/** 构建 messages：系统提示 + 历史 + 当前问题（含工作目录与工具目录摘要） */
function buildMessages({ query, history = [], customPrompt, toolCatalog, folders }) {
  const messages = [];
  const sysParts = ['你是 Knowly（一个本地 AI 知识助手），请用与用户一致的语言、以 Markdown 回答。'];
  if (customPrompt) sysParts.push(`用户自定义提示：${customPrompt}`);
  if (folders?.length) sysParts.push(`用户工作目录：${folders.join(' ; ')}`);
  messages.push({ role: 'system', content: sysParts.join('\n') });
  for (const item of history.slice(-20)) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') {
      messages.push({ role: item.role, content: item.content });
    }
  }
  let userContent = query;
  if (toolCatalog?.length) {
    userContent += `\n\n[可用工具目录]\n${toolCatalog.map((t) => `- ${t.name}（${t.display_name}）：${t.description}；入参：${JSON.stringify(t.parameters)}`).join('\n')}\n${TOOL_SYSTEM_PROMPT}`;
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

class SseWriter {
  constructor(res) {
    this.res = res;
    this.closed = false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
  }

  send(type, data, extra = {}) {
    if (this.closed) return;
    const payload = { type, ...(data !== undefined ? { data } : {}), ...extra };
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  end() {
    if (!this.closed) {
      this.closed = true;
      this.res.end();
    }
  }
}

/** 普通对话流（POST /qa/chat/stream） */
async function runChatStream(store, registry, body, res, signal) {
  const sse = new SseWriter(res);
  const query = String(body?.query || '').trim();
  const folders = Array.isArray(body?.folders) ? body.folders : [];
  try {
    if (!query) {
      sse.send('error', '问题不能为空');
      return sse.end();
    }
    const messages = buildMessages({
      query,
      history: body.history,
      customPrompt: body.custom_prompt,
      folders,
      toolCatalog: registry.catalog().filter((t) => t.name !== 'ask_user'),
    });

    let answer = '';
    let thinking = '';
    const onDelta = ({ reasoning, content }) => {
      if (reasoning && body.enable_thinking) sse.send('thinking_content', reasoning);
      if (content) sse.send('content', content);
    };

    const first = await chatStream(store, { messages, onDelta, signal });
    thinking = first.reasoning || '';
    const call = extractToolCall(first.content);

    if (call) {
      const tool = registry.get(call.tool);
      sse.send('metadata', { tool: call.tool, arguments: call.arguments });
      if (!tool) {
        sse.send('sources', []);
        answer = stripToolCall(first.content) || `未找到工具 ${call.tool}`;
        sse.send('complete', { answer });
        return sse.end();
      }
      let result;
      try {
        result = await registry.execute(call.tool, call.arguments);
      } catch (error) {
        result = { success: false, error: error.message };
      }
      const followup = await chatOnce(store, {
        messages: [
          ...messages,
          { role: 'assistant', content: first.content },
          { role: 'user', content: `工具 ${call.tool} 的执行结果（JSON）：\n${JSON.stringify(result).slice(0, 60000)}\n请基于该结果用 Markdown 回答用户。` },
        ],
        signal,
      });
      answer = stripToolCall(followup.content) || '（工具执行完成，但模型未给出总结）';
      sse.send('content', answer);
      sse.send('sources', []);
      sse.send('complete', { answer, ...(thinking ? { thinking } : {}) });
      return sse.end();
    }

    answer = stripToolCall(first.content);
    sse.send('sources', []);
    sse.send('complete', { answer, ...(thinking ? { thinking } : {}) });
    return sse.end();
  } catch (error) {
    if (signal?.aborted) return sse.end();
    sse.send('error', error.message || '服务内部错误');
    return sse.end();
  } finally {
    sse.end();
  }
}

/** 任务模式核心：事件发射器。emit(type, data) 同时写执行记录与（可选的）SSE 连接。
 * 传入 existing（路由侧已登记的执行记录）时复用其 id/记录，信号由路由侧的 AbortController 提供。 */
async function runTaskExecution(store, registry, executions, aborts, body, emit, signal, existing) {
  const query = String(body?.query || '').trim();
  const executionId = existing?.execution_id || `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = existing || { execution_id: executionId, status: 'running', created_at: Date.now(), events: [] };
  executions.set(executionId, record);
  let ownController = null;
  if (!existing) {
    ownController = new AbortController();
    aborts.set(executionId, ownController);
  }
  signal = signal || ownController?.signal;

  const track = (type, data) => {
    record.events.push({ type, data });
    emit(type, data);
  };

  try {
    track('execution_start', { execution_id: executionId, status: 'running' });
    if (!query) {
      track('error', '任务描述不能为空');
      record.status = 'failed';
      return { executionId, record };
    }
    sseEmit(emit, 'round_start', { round: 1 });
    track('round_start', { round: 1 });

    const folders = Array.isArray(body?.folders) ? body.folders : [];
    const messages = buildMessages({
      query,
      history: body.history,
      customPrompt: body.custom_prompt,
      agentName: body.agent_name,
      folders,
      toolCatalog: registry.catalog().filter((t) => !['ask_user', 'compact_context'].includes(t.name)),
    });

    const first = await chatStream(store, {
      messages,
      signal,
      onDelta: ({ reasoning }) => {
        if (reasoning && body.enable_thinking) {
          sseEmit(emit, 'reasoning_chunk', { round: 1, chunk: reasoning });
          track('reasoning_chunk', { round: 1, chunk: reasoning });
        }
      },
    });
    if (first.reasoning) {
      sseEmit(emit, 'reasoning_complete', { round: 1, has_content: true });
      track('reasoning_complete', { round: 1, has_content: true });
    }

    const call = extractToolCall(first.content);
    let answer = stripToolCall(first.content);

    if (call) {
      sseEmit(emit, 'preparing_tools', { round: 1 });
      track('preparing_tools', { round: 1 });
      const callId = `call_${Date.now()}`;
      sseEmit(emit, 'calling_tool', { tool_name: call.tool, call_id: callId, round: 1, arguments: call.arguments });
      track('calling_tool', { tool_name: call.tool, call_id: callId, round: 1, arguments: call.arguments });
      let result;
      try {
        result = await registry.execute(call.tool, call.arguments);
        sseEmit(emit, 'tool_result', { tool_name: call.tool, call_id: callId, success: result.success, summary: result.success ? '执行完成' : result.error });
        track('tool_result', { tool_name: call.tool, call_id: callId, success: result.success, summary: result.success ? '执行完成' : result.error });
      } catch (error) {
        sseEmit(emit, 'tool_error', { tool_name: call.tool, call_id: callId, error: error.message });
        track('tool_error', { tool_name: call.tool, call_id: callId, error: error.message });
        result = { success: false, error: error.message };
      }
      const followup = await chatOnce(store, {
        messages: [
          ...messages,
          { role: 'assistant', content: first.content },
          { role: 'user', content: `工具 ${call.tool} 的执行结果（JSON）：\n${JSON.stringify(result).slice(0, 60000)}\n请基于该结果用 Markdown 回答用户。` },
        ],
        signal,
      });
      answer = stripToolCall(followup.content) || '（工具执行完成，但模型未给出总结）';
    }

    sseEmit(emit, 'thinking_result', { round: 1 });
    track('thinking_result', { round: 1 });
    sseEmit(emit, 'answer_start');
    sseEmit(emit, 'answer_chunk', answer);
    track('answer_chunk', answer);
    sseEmit(emit, 'answer_commit');
    sseEmit(emit, 'complete', { answer, execution_id: executionId });
    track('complete', { answer, execution_id: executionId });
    record.status = 'completed';
    record.answer = answer;
    return { executionId, record };
  } catch (error) {
    record.status = signal?.aborted ? 'cancelled' : 'failed';
    if (signal?.aborted) {
      sseEmit(emit, 'cancelled', { execution_id: executionId });
      track('cancelled', { execution_id: executionId });
    } else {
      sseEmit(emit, 'error', error.message || '任务执行失败');
      track('error', error.message || '任务执行失败');
    }
    return { executionId, record };
  } finally {
    if (ownController) aborts.delete(executionId);
  }
}

/** SSE 包装：emit 同时写 SSE 与执行记录 */
function sseEmit(emit, type, data) {
  if (emit) emit(type, data);
}

/** 任务模式流（POST /qa/task/stream）：带执行记录与工具事件的直连 SSE。 */
async function runTaskStream(store, registry, executions, aborts, body, res, signal) {
  const sse = new SseWriter(res);
  let sseClosed = false;
  const emit = (type, data) => {
    if (sseClosed) return;
    sse.send(type, data);
  };
  try {
    await runTaskExecution(store, registry, executions, aborts, body, emit, signal);
  } finally {
    sseClosed = true;
    sse.end();
  }
}

/** 会话标题生成（POST /qa/generate-title）：一次非流式调用，失败回退截断。 */
async function generateTitle(store, body) {
  const text = String(body?.query || body?.text || body?.content || '').trim();
  if (!text) return { success: false, error: '内容不能为空' };
  try {
    const result = await chatOnce(store, {
      messages: [
        { role: 'system', content: '为用户的提问生成不超过 12 个字的会话标题，直接输出标题本身，不要任何其他内容或标点结尾。' },
        { role: 'user', content: text.slice(0, 500) },
      ],
      maxTokens: 32,
      temperature: 0.3,
    });
    const title = (result.content || '').trim().replace(/^["'#\s]+|["'\s]+$/g, '').slice(0, 30);
    return { success: true, data: { title: title || text.slice(0, 12) } };
  } catch (error) {
    return { success: true, data: { title: text.slice(0, 12) } };
  }
}

module.exports = { runChatStream, runTaskStream, runTaskExecution, generateTitle, SseWriter };
