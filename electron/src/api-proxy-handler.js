const express = require('express');
const http = require('http');
const https = require('https');
const { OpenAI } = require('openai');
const { log } = require('./config');
const { EmbeddingRequestCoordinator } = require('./embedding-request-policy');
const { isLocalUrl } = require('./no-proxy-local');

/**
 * API 代理服务器
 * 为 Python 后端提供统一的外部 API 访问能力
 * 通过本地 HTTP 服务解决 Windows 防火墙/安全软件阻止 Python 子进程网络访问的问题
 */

// [重建版适配] 端口迁移：原版为 18081，重建版默认 28081，避免与已安装原版冲突；env 可覆盖
const API_PROXY_PORT = Number(process.env.KNOWLY_PROXY_PORT) || 28081;
let proxyServer = null;
const app = express();
const embeddingRequestCoordinator = new EmbeddingRequestCoordinator({ logger: log });

// 解析 JSON 请求体，增大限制以支持大型请求（如图片 base64）
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 存储活跃的流式会话
const activeStreams = new Map();
let streamIdCounter = 0;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createOpenAIClient(apiKey, baseURL, timeout, maxRetries = 2) {
  const options = {
    apiKey,
    baseURL,
    timeout,
    maxRetries,
  };
  if (isLocalUrl(baseURL)) {
    options.httpAgent = new http.Agent();
    options.httpsAgent = new https.Agent();
  }
  return new OpenAI(options);
}

/**
 * 创建流式会话
 * @param {AsyncIterable} stream - 流对象
 * @returns {string} 流ID
 */
function createStreamSession(stream) {
  const streamId = `stream_${++streamIdCounter}_${Date.now()}`;
  activeStreams.set(streamId, {
    stream,
    iterator: stream[Symbol.asyncIterator](),
    createdAt: Date.now()
  });
  return streamId;
}

/**
 * 读取流式数据块
 * @param {string} streamId - 流ID
 * @returns {Promise<{chunk: any, done: boolean}>}
 */
async function readStreamChunk(streamId) {
  const session = activeStreams.get(streamId);
  if (!session) {
    return { done: true, error: 'Stream not found' };
  }

  try {
    const { value, done } = await session.iterator.next();
    
    if (done) {
      activeStreams.delete(streamId);
      return { done: true };
    }

    // 将 OpenAI SDK 的对象转换为纯 JSON 对象
    // 这样可以确保通过 HTTP 传递时不会丢失数据
    const chunkData = JSON.parse(JSON.stringify(value));

    return { done: false, chunk: chunkData };
  } catch (error) {
    activeStreams.delete(streamId);
    return { done: true, error: error.message };
  }
}

/**
 * 清理超时的流式会话（兜底机制，正常情况下 Python 端会主动调用 cancel）
 */
function cleanupExpiredStreams() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; 
  for (const [streamId, session] of activeStreams.entries()) {
    if (now - session.createdAt > timeout) {
      activeStreams.delete(streamId);
      log.info(`清理超时流式会话: ${streamId}`);
    }
  }
}

// 每分钟清理一次过期会话
setInterval(cleanupExpiredStreams, 60 * 1000);

// ==================== HTTP API 路由 ====================

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: API_PROXY_PORT });
});

/**
 * OpenAI 兼容 Embedding API
 */
app.post('/api/openai/embeddings', async (req, res) => {
  const { api_key, base_url, model, input } = req.body;

  try {
    // 向量请求由全局协调器统一重试；关闭 SDK 内部重试，避免 429 时其他请求继续发送。
    const client = createOpenAIClient(api_key, base_url, 60000, 0);

    const response = await embeddingRequestCoordinator.execute(
      () => client.embeddings.create({
        model: model,
        input: input
      }),
    );
    res.json({
      success: true,
      data: response
    });

  } catch (error) {
    log.error('向量API调用失败，请检查网络连接:', error.message);
    res.json({
      success: false,
      error: error.message,
      error_type: error.constructor.name,
      status: error.status || null
    });
  }
});

/**
 * OpenAI 兼容 Chat Completions API
 */
app.post('/api/openai/chat/completions', async (req, res) => {
  const { api_key, base_url, model, messages, stream, ...otherParams } = req.body;
  const {
    extra_body: extraBodySnake,
    extraBody: extraBodyCamel,
    ...restParams
  } = otherParams;
  const extraBody = {
    ...(isPlainObject(extraBodySnake) ? extraBodySnake : {}),
    ...(isPlainObject(extraBodyCamel) ? extraBodyCamel : {})
  };

  try {
    const client = createOpenAIClient(api_key, base_url, 120000);

    const payload = {
      model: model,
      messages: messages,
      ...restParams,
      ...extraBody
    };

    if (stream) {
      // 流式响应
      const streamResponse = await client.chat.completions.create({
        ...payload,
        stream: true
      });
      
      const streamId = createStreamSession(streamResponse);
      res.json({
        success: true,
        stream_id: streamId
      });
    } else {
      // 非流式响应
      const response = await client.chat.completions.create(payload);
      res.json({
        success: true,
        data: response
      });
    }

  } catch (error) {
    log.error('大模型API调用失败，请检查网络连接:', error.message);
    res.json({
      success: false,
      error: error.message,
      error_type: error.constructor.name,
      status: error.status || null
    });
  }
});

/**
 * 流式数据读取
 */
app.post('/api/stream/read', async (req, res) => {
  const { stream_id } = req.body;

  try {
    const chunk = await readStreamChunk(stream_id);
    res.json(chunk);
  } catch (error) {
    log.error('流式数据读取失败:', error.message);
    res.json({
      done: true,
      error: error.message
    });
  }
});

/**
 * 取消流式会话
 */
app.post('/api/stream/cancel', async (req, res) => {
  const { stream_id } = req.body;

  if (activeStreams.has(stream_id)) {
    activeStreams.delete(stream_id);
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Stream not found' });
  }
});

// ==================== 服务器管理 ====================

/**
 * 启动 API 代理服务器
 */
function startProxyServer() {
  return new Promise((resolve, reject) => {
    if (proxyServer) {
      log.info('API 代理服务器已在运行');
      resolve();
      return;
    }

    try {
      proxyServer = app.listen(API_PROXY_PORT, '127.0.0.1', () => {
        log.info(`API 代理服务器已启动: http://127.0.0.1:${API_PROXY_PORT}`);
        resolve();
      });

      proxyServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          log.error(`端口 ${API_PROXY_PORT} 已被占用，API 代理服务器启动失败`);
          reject(new Error(`端口 ${API_PROXY_PORT} 已被占用`));
        } else {
          log.error('API 代理服务器错误:', error);
          reject(error);
        }
      });
    } catch (error) {
      log.error('启动 API 代理服务器失败:', error);
      reject(error);
    }
  });
}

/**
 * 停止 API 代理服务器
 */
function stopProxyServer() {
  return new Promise((resolve) => {
    if (!proxyServer) {
      resolve();
      return;
    }

    proxyServer.close(() => {
      log.info('API 代理服务器已停止');
      proxyServer = null;
      
      // 清理所有活跃流
      activeStreams.clear();
      
      resolve();
    });
  });
}

module.exports = {
  startProxyServer,
  stopProxyServer
};
