const { app } = require('electron');
const os = require('os');
const MPServerless = require('@alicloud/mpserverless-node-sdk').default;
const { log, store, EMAS_CONFIG, API_BASE_URL } = require('./config');
const { resolveAndPersistDeviceId } = require('./device-id');

/** 云函数/EMAS 不可达时展示给用户的文案（内网阻断、证书等问题不暴露细节） */
const CLOUD_NETWORK_ERROR_MESSAGE = '网络错误，请重试';

const STATISTICS_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查一次是否跨天
let statisticsCheckTimer = null;
let isUploadingStatistics = false;

const QUOTA_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 每小时同步一次配额
const LAST_SYNCED_QUOTA_SNAPSHOT_KEY = 'lastSyncedQuotaSnapshot';
let quotaSyncTimer = null;
let isSyncingQuota = false;

function quotaSnapshotSignature(data) {
  return JSON.stringify(data);
}

function isQuotaSnapshotUnchanged(data) {
  const last = store.get(LAST_SYNCED_QUOTA_SNAPSHOT_KEY);
  if (!last) return false;
  return quotaSnapshotSignature(last) === quotaSnapshotSignature(data);
}
/** 当前进程内已成功上报的日期（YYYY-MM-DD），用于长时间运行时不重复上报 */
let lastUploadDateInSession = null;

const EVENT_TYPE_APP_LAUNCH = 'app_launch';
/** 进程未退出、仅跨天时的活跃上报（非冷启动） */
const EVENT_TYPE_DAILY_ACTIVE = 'daily_active';

// 上传用户统计数据
async function uploadUserStatistics(eventType = EVENT_TYPE_APP_LAUNCH) {
  try {
    // 在开发环境下不上传统计数据
    if (!app.isPackaged) {
      log.info('开发环境下不上传统计数据');
      return { success: true, skipped: true, reason: 'development_environment' };
    }
    
    const deviceId = resolveAndPersistDeviceId(store);

    // 收集基本系统信息
    const appVersion = app.getVersion();
    const osInfo = {
      type: process.platform,
      version: os.release(),
      arch: os.arch()
    };

    const statsData = {
      userId: deviceId,
      appVersion: appVersion,
      osType: osInfo.type,
      osVersion: osInfo.version,
      timestamp: Date.now(),
      eventType
    };

    log.info('准备上传统计数据', statsData);

    const url = EMAS_CONFIG.statisticsEndpoint;
    if (!url) {
      throw new Error('未配置 statisticsEndpoint');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statsData)
    });

    if (!response.ok) {
      throw new Error(`统计上报 HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result && result.success === false) {
      throw new Error(result.message || result.error || '统计上报失败');
    }

    log.info('统计数据上传成功', result);
    return result;
  } catch (error) {
    // 错误不应影响主程序流程
    log.error('统计数据上传失败', error.message);
    return { success: false, error: error.message };
  }
}

async function uploadStatisticsIfNeeded({ isAppLaunch = false } = {}) {
  if (isUploadingStatistics) {
    log.debug('统计上传任务执行中，跳过本次检查');
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  // 启动时每次上报；同一次运行内未跨天则不再重复
  if (!isAppLaunch && lastUploadDateInSession === today) {
    return;
  }

  const eventType = isAppLaunch ? EVENT_TYPE_APP_LAUNCH : EVENT_TYPE_DAILY_ACTIVE;

  isUploadingStatistics = true;
  try {
    const result = await uploadUserStatistics(eventType);
    if (result && (result.success || result.skipped)) {
      lastUploadDateInSession = today;
    }
  } catch (error) {
    log.error('检查统计上传状态出错', error.message);
  } finally {
    isUploadingStatistics = false;
  }
}

// 启动时上报一次；长时间运行则每小时检查，跨天后补上报
function checkAndUploadStatistics() {
  uploadStatisticsIfNeeded({ isAppLaunch: true });

  if (statisticsCheckTimer) {
    return;
  }

  statisticsCheckTimer = setInterval(() => {
    uploadStatisticsIfNeeded();
  }, STATISTICS_CHECK_INTERVAL_MS);
}

function stopStatisticsUploadScheduler() {
  if (statisticsCheckTimer) {
    clearInterval(statisticsCheckTimer);
    statisticsCheckTimer = null;
  }
}

// 同步配额快照到云端
async function syncQuotaToCloud() {
  if (isSyncingQuota) return;

  // // 开发环境不同步
  // if (!app.isPackaged) {
  //   log.debug('开发环境下跳过配额同步');
  //   return;
  // }

  const deviceId = resolveAndPersistDeviceId(store);
  if (!deviceId) {
    log.debug('无 deviceId，跳过配额同步');
    return;
  }

  isSyncingQuota = true;
  try {
    const response = await fetch(`${API_BASE_URL}/quota-snapshot`, { timeout: 10000 });
    if (!response.ok) {
      log.warn(`配额快照接口返回 ${response.status}，跳过同步`);
      return;
    }

    const json = await response.json();
    if (json.sync_directive && json.sync_directive.mode !== 'NORMAL') {
      await syncPendingDeviceTransferFromMain();
      store.delete(LAST_SYNCED_QUOTA_SNAPSHOT_KEY);
      return;
    }
    if (!json.success || !json.data) {
      log.warn('配额快照数据无效，跳过同步');
      return;
    }

    if (isQuotaSnapshotUnchanged(json.data)) {
      log.debug('配额快照无变化，跳过上传');
      return;
    }

    const result = await callCloudFunction('emas-membership', {
      action: 'syncQuotaData',
      device_id: deviceId,
      quota_data: json.data,
    });

    if (result && result.success) {
      store.set(LAST_SYNCED_QUOTA_SNAPSHOT_KEY, json.data);
      log.info('配额快照同步成功');
    } else {
      log.warn('配额快照同步失败:', result && result.message);
    }
  } catch (error) {
    log.error('配额快照同步出错:', error.message);
  } finally {
    isSyncingQuota = false;
  }
}

async function syncPendingDeviceTransferFromMain() {
  try {
    const response = await fetch(`${API_BASE_URL}/device-transfer/sync-payload`);
    if (!response.ok) return false;
    const payload = await response.json();
    const directive = payload.sync_directive;
    if (!payload.success || !directive || directive.mode !== 'SOURCE_REVOKED' || !directive.guard) {
      return true;
    }
    if (directive.guard.state === 'ACKNOWLEDGED') {
      return true;
    }
    const result = await callCloudFunction('emas-membership', {
      action: 'syncTransferEvent',
      event_type: 'SOURCE_REVOKED',
      ...directive.guard,
    });
    if (!result || !result.success) return false;
    await fetch(`${API_BASE_URL}/device-transfer/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'SOURCE_REVOKED', transfer_id: directive.guard.transfer_id }),
    });
    return true;
  } catch (error) {
    log.warn('迁出事件暂未同步，将在联网后重试:', error.message);
    return false;
  }
}

function startQuotaSyncScheduler() {
  syncQuotaToCloud();

  if (quotaSyncTimer) return;
  quotaSyncTimer = setInterval(syncQuotaToCloud, QUOTA_SYNC_INTERVAL_MS);
}

function stopQuotaSyncScheduler() {
  if (quotaSyncTimer) {
    clearInterval(quotaSyncTimer);
    quotaSyncTimer = null;
  }
}

// 提交用户反馈（复用 emas-statistics HTTP 触发，写入 feedback 集合）
async function submitUserFeedback(payload = {}) {
  try {
    const {
      contact = '',
      content = '',
      type = 'app',
      question = '',
      result: answer = '',
    } = payload;
    const deviceId = resolveAndPersistDeviceId(store);

    const appVersion = app.getVersion();
    const osInfo = {
      type: process.platform,
      version: os.release(),
      arch: os.arch()
    };

    const feedbackData = {
      action: 'feedback',
      type,
      contact: contact || '',
      content: content || '',
      question: question || '',
      result: answer || '',
      userId: deviceId || 'anonymous',
      appVersion: appVersion,
      osType: osInfo.type,
      osVersion: osInfo.version,
      timestamp: Date.now()
    };

    log.info('准备提交反馈', {
      ...feedbackData,
      content: content ? `[${String(content).length} chars]` : '',
      question: question ? `[${String(question).length} chars]` : '',
      result: answer ? `[${String(answer).length} chars]` : '',
    });

    const url = EMAS_CONFIG.statisticsEndpoint;
    if (!url) {
      throw new Error('未配置 statisticsEndpoint');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedbackData)
    });

    if (!response.ok) {
      throw new Error(`反馈提交 HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result && result.success === false) {
      log.warn('反馈提交被拒绝', result.message);
      return {
        success: false,
        message: result.message || CLOUD_NETWORK_ERROR_MESSAGE
      };
    }

    log.info('反馈提交成功', result);
    return result;
  } catch (error) {
    log.error('反馈提交失败', error.message);
    return { success: false, message: CLOUD_NETWORK_ERROR_MESSAGE };
  }
}

// 获取公告信息（复用 emas-statistics HTTP 触发，action=announcement）
async function getAnnouncements() {
  try {
    // 在开发环境下不获取公告
    if (!app.isPackaged) {
      log.info('开发环境下不获取公告');
      return {
        success: true,
        data: [],
        skipped: true,
        message: '开发环境下不获取公告'
      };
    }

    // [重建版适配] 遥测门：打包便携版默认不向原厂云端请求公告（避免外呼）
    if (process.env.KNOWLY_ENABLE_TELEMETRY !== '1') {
      log.info('[重建版适配] 遥测门：公告拉取已跳过');
      return { success: true, data: [], skipped: true, message: '重建版遥测门：公告已跳过' };
    }

    const appVersion = app.getVersion();
    const requestData = {
      action: 'announcement',
      appVersion,
      osType: process.platform,
      timestamp: Date.now()
    };

    log.debug('准备获取公告', requestData);

    const url = EMAS_CONFIG.statisticsEndpoint;
    if (!url) {
      throw new Error('未配置 statisticsEndpoint');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });

    if (!response.ok) {
      throw new Error(`获取公告 HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result && result.success === false) {
      log.warn('获取公告被拒绝', result.message);
      return {
        success: false,
        data: [],
        message: result.message || CLOUD_NETWORK_ERROR_MESSAGE
      };
    }

    log.debug('获取公告成功', result);
    return result;
  } catch (error) {
    // 错误不应影响主程序流程
    log.error('获取公告失败', error.message);
    return { 
      success: false, 
      data: [],
      message: CLOUD_NETWORK_ERROR_MESSAGE
    };
  }
}

// 验证邀请码
async function verifyInviteCode(inviteCode) {
  try {
    // 准备请求数据
    const requestData = {
      inviteCode: inviteCode,
      timestamp: Date.now()
    };

    log.info('准备验证邀请码', { inviteCode: inviteCode });
    
    // 初始化MPServerless客户端
    const mpServerless = new MPServerless({
      timeout: 60 * 1000,
      spaceId: EMAS_CONFIG.spaceId,
      serverSecret: EMAS_CONFIG.serverSecret,
      endpoint: EMAS_CONFIG.endpoint,
    });
    
    // 调用云函数
    const response = await mpServerless.function.invoke('emas-invitation', requestData);
    
    log.info('验证邀请码成功', response.result);
    return response.result;
  } catch (error) {
    log.error('验证邀请码失败', error.message);
    return { 
      success: false, 
      message: CLOUD_NETWORK_ERROR_MESSAGE
    };
  }
}

// 通用云函数调用
async function callCloudFunction(functionName, params) {
  try {
    log.debug(`调用云函数: ${functionName}`, params);
    
    // 初始化MPServerless客户端
    const mpServerless = new MPServerless({
      timeout: 60 * 1000,
      spaceId: EMAS_CONFIG.spaceId,
      serverSecret: EMAS_CONFIG.serverSecret,
      endpoint: EMAS_CONFIG.endpoint,
    });
    
    // 调用云函数
    const response = await mpServerless.function.invoke(functionName, params);
    
    // log.debug(`云函数 ${functionName} 调用成功`, response.result);
    return response.result;
  } catch (error) {
    log.error(`调用云函数 ${functionName} 失败`, error.message);
    return { 
      success: false, 
      message: CLOUD_NETWORK_ERROR_MESSAGE
    };
  }
}

module.exports = {
  uploadUserStatistics,
  checkAndUploadStatistics,
  stopStatisticsUploadScheduler,
  syncQuotaToCloud,
  startQuotaSyncScheduler,
  stopQuotaSyncScheduler,
  submitUserFeedback,
  getAnnouncements,
  verifyInviteCode,
  callCloudFunction
};
