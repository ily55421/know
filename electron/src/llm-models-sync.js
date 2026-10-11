const { log, API_BASE_URL, appState } = require('./config');
const { callCloudFunction } = require('./cloud-services');
const { sendToRendererWhenReady } = require('./window-manager');

/** 启动后延迟执行，避免与窗口加载、Python 初始化抢资源 */
const SYNC_DELAY_MS = 5000;
/** 云函数调用超时 */
const CLOUD_TIMEOUT_MS = 6 * 1000;
/** 本地 sync 请求超时 */
const SYNC_TIMEOUT_MS = 10 * 1000;

let isSyncing = false;

function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      log.debug(`[llm-models-sync] ${label} 超时 (${timeoutMs}ms)，已放弃`);
      resolve(null);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function postModelsSync(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE_URL}/api/llm/software-default-models/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 冷启动后延迟异步同步云端软件默认模型列表。
 * 成功时先写入加密本地缓存，再通知渲染进程刷新当前模型列表。
 */
async function syncSoftwareDefaultLlmModels() {
  if (isSyncing) return;
  if (!appState.pythonServerRunning) {
    log.debug('[llm-models-sync] Python 未就绪，跳过');
    return;
  }

  isSyncing = true;
  try {
    const result = await withTimeout(
      callCloudFunction('emas-agents', { action: 'llmModels' }),
      CLOUD_TIMEOUT_MS,
      '云函数',
    );
    if (!result) return;

    const payload = result?.data;
    if (!result?.success || !payload || !Array.isArray(payload.models) || payload.models.length === 0) {
      log.debug('[llm-models-sync] 获取模型列表失败，已跳过:', result?.message);
      return;
    }

    let res;
    try {
      res = await postModelsSync(payload);
    } catch (error) {
      if (error?.name === 'AbortError') {
        log.debug('[llm-models-sync] sync 超时，已放弃');
      } else {
        log.debug('[llm-models-sync] sync 请求失败，已跳过:', error?.message);
      }
      return;
    }

    if (!res.ok) {
      log.debug(`[llm-models-sync] sync HTTP ${res.status}，已跳过`);
      return;
    }

    const json = await res.json();
    if (!json?.success || !json?.data) {
      log.debug('[llm-models-sync] sync 失败，已跳过:', json?.message);
      return;
    }

    log.info(`[llm-models-sync] 完成: ${json.data.models?.length ?? 0} 个模型，来源 ${json.data.source || 'cache'}`);
    sendToRendererWhenReady('llm-models-updated', json.data);
  } catch (error) {
    log.debug('[llm-models-sync] 同步异常，已跳过:', error?.message);
  } finally {
    isSyncing = false;
  }
}

function startSoftwareDefaultLlmModelsSync() {
  setTimeout(() => {
    void syncSoftwareDefaultLlmModels().catch((error) => {
      log.debug('[llm-models-sync] 未捕获异常，已忽略:', error?.message);
    });
  }, SYNC_DELAY_MS);
}

module.exports = {
  syncSoftwareDefaultLlmModels,
  startSoftwareDefaultLlmModelsSync,
};
