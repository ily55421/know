const { log, API_BASE_URL, appState } = require('./config');
const { callCloudFunction } = require('./cloud-services');

/** 启动后延迟执行，避免与窗口加载、Python 初始化抢资源 */
const SYNC_DELAY_MS = 5000;
/** 云函数调用超时（内网不可达时尽快放弃，不长时间挂起） */
const CLOUD_TIMEOUT_MS = 6 * 1000;
/** 本地 install-batch 请求超时 */
const INSTALL_BATCH_TIMEOUT_MS = 30 * 1000;

let isSyncing = false;

function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      log.debug(`[default-skills-sync] ${label} 超时 (${timeoutMs}ms)，已放弃`);
      resolve(null);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function fetchInstallBatch(skills) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_BATCH_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE_URL}/api/tools/skills/cloud/install-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 冷启动后延迟异步同步云端默认技能。
 * 内网/无公网时云函数或下载失败均静默放弃，不影响启动与主流程。
 */
async function syncDefaultSkills() {
  if (isSyncing) return;
  if (!appState.pythonServerRunning) {
    log.debug('[default-skills-sync] Python 未就绪，跳过');
    return;
  }

  isSyncing = true;
  try {
    const result = await withTimeout(
      callCloudFunction('emas-skills', { defaults: true }),
      CLOUD_TIMEOUT_MS,
      '云函数'
    );
    if (!result) return;

    const list = result?.data?.skills;
    if (!result?.success || !Array.isArray(list)) {
      log.debug('[default-skills-sync] 获取默认技能失败，已跳过:', result?.message);
      return;
    }
    if (list.length === 0) {
      log.debug('[default-skills-sync] 无默认技能需同步');
      return;
    }

    const skills = [];
    for (const item of list) {
      const name = String(item?.name || '').trim();
      const zipUrl = String(item?.zip_url || '').trim();
      if (!name || !zipUrl) continue;
      skills.push({
        name,
        version: item.version,
        zip_url: zipUrl,
        enabled: item.enabled,
        is_default: true,
      });
    }

    if (skills.length === 0) {
      log.debug('[default-skills-sync] 默认技能均缺少 zip_url，已跳过');
      return;
    }

    let res;
    try {
      res = await fetchInstallBatch(skills);
    } catch (error) {
      if (error?.name === 'AbortError') {
        log.debug('[default-skills-sync] install-batch 超时，已放弃');
      } else {
        log.debug('[default-skills-sync] install-batch 请求失败，已跳过:', error?.message);
      }
      return;
    }

    if (!res.ok) {
      log.debug(`[default-skills-sync] install-batch HTTP ${res.status}，已跳过`);
      return;
    }

    const json = await res.json();
    if (!json?.success) {
      log.debug('[default-skills-sync] install-batch 失败，已跳过:', json?.message);
      return;
    }

    const d = json.data || {};
    const failed = Array.isArray(d.failed) ? d.failed : [];
    log.info(
      `[default-skills-sync] 完成: 更新 ${d.updated_count ?? 0}, 未变 ${d.unchanged_count ?? 0}, 失败 ${failed.length}`
    );
    if (failed.length > 0) {
      log.debug('[default-skills-sync] 部分技能安装失败（可能无公网）:', failed);
    }
  } catch (error) {
    log.debug('[default-skills-sync] 同步异常，已跳过:', error?.message);
  } finally {
    isSyncing = false;
  }
}

/**
 * 冷启动后延迟触发，fire-and-forget。
 * 任何失败均不抛出、不弹窗、不阻断启动链路。
 */
function startDefaultSkillsSync() {
  setTimeout(() => {
    void syncDefaultSkills().catch((error) => {
      log.debug('[default-skills-sync] 未捕获异常，已忽略:', error?.message);
    });
  }, SYNC_DELAY_MS);
}

module.exports = {
  syncDefaultSkills,
  startDefaultSkillsSync,
};
