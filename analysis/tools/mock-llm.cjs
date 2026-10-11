'use strict';

/**
 * 本地 Mock OpenAI 兼容服务（仅用于功能验证）。
 * - POST /v1/chat/completions（stream / 非流式）
 * - 记录收到的 Authorization 头与请求体摘要，供测试断言"自定义 api_key 被正确传递"
 */

const http = require('node:http');
const PORT = Number(process.env.MOCK_PORT) || 28100;

const requests = [];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略坏包 */ }
    const auth = req.headers.authorization || '';
    requests.push({
      path: req.url,
      auth,
      api_key_seen: auth.replace(/^Bearer\s+/i, ''),
      model: payload.model,
      stream: Boolean(payload.stream),
      messages: (payload.messages || []).length,
    });
    console.log(`[mock-llm] ${req.url} model=${payload.model} stream=${payload.stream} auth=${auth.slice(0, 24)}... msgs=${(payload.messages || []).length}`);

    const replyText = `MOCK-REPLY: 已收到 ${req.url} 的请求（模型 ${payload.model}）。这是本地 Mock 服务的固定回复，用于验证自定义 API Key 全链路。`;

    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunks = ['MOCK-REPLY: 你好！', '这是分片流式', '回复的第三段。'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i] } }] })}\n\n`);
          i += 1;
        } else {
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          res.end();
        }
      }, 40);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`));
module.exports = { requests };
