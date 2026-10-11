const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2000, 5000]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status > 0) {
      return status;
    }
  }
  return null;
}

function getErrorMessage(error) {
  return String(error?.message || error || '').toLowerCase();
}

function isRateLimitError(error) {
  const message = getErrorMessage(error);
  return (
    getErrorStatus(error) === 429
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('限流')
  );
}

function isRetryableEmbeddingError(error) {
  if (isRateLimitError(error)) {
    return true;
  }

  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 408 || status === 409 || status >= 500;
  }

  const message = getErrorMessage(error);
  return [
    'connection',
    'econnreset',
    'econnrefused',
    'enotfound',
    'fetch failed',
    'network',
    'socket',
    'timeout',
    'timed out',
  ].some((marker) => message.includes(marker));
}

function readErrorHeader(error, name) {
  const headers = error?.headers || error?.response?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return null;
}

function getRetryAfterMs(error, now = Date.now()) {
  const retryAfterMs = Number.parseFloat(readErrorHeader(error, 'retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs;
  }

  const retryAfter = readErrorHeader(error, 'retry-after');
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') {
    return null;
  }

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

class EmbeddingRequestCoordinator {
  constructor({
    cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    now = () => Date.now(),
    wait = sleep,
    logger = null,
  } = {}) {
    this.cooldownMs = cooldownMs;
    this.maxRetries = maxRetries;
    this.retryDelaysMs = retryDelaysMs;
    this.now = now;
    this.wait = wait;
    this.logger = logger;
    this.cooldownUntil = 0;
  }

  async waitForAvailability() {
    while (true) {
      const waitMs = this.cooldownUntil - this.now();
      if (waitMs <= 0) {
        return;
      }
      await this.wait(waitMs);
    }
  }

  startRateLimitCooldown(error) {
    const retryAfterMs = getRetryAfterMs(error, this.now());
    const cooldownMs = Math.max(this.cooldownMs, retryAfterMs || 0);
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + cooldownMs);
    return Math.max(0, this.cooldownUntil - this.now());
  }

  async execute(operation) {
    let retries = 0;

    while (true) {
      await this.waitForAvailability();

      try {
        return await operation();
      } catch (error) {
        const rateLimited = isRateLimitError(error);
        const retryable = isRetryableEmbeddingError(error);
        let waitMs = 0;

        if (rateLimited) {
          // 即使当前请求已耗尽重试次数，也要阻止其他请求继续冲击接口。
          waitMs = this.startRateLimitCooldown(error);
        }

        if (!retryable || retries >= this.maxRetries) {
          if (rateLimited) {
            this.logger?.warn(
              `向量接口持续限流，本请求停止重试；其他向量请求继续暂停 ${Math.ceil(waitMs / 1000)} 秒`,
            );
          }
          throw error;
        }

        retries += 1;
        if (rateLimited) {
          this.logger?.warn(
            `向量接口触发限流，全部向量请求暂停 ${Math.ceil(waitMs / 1000)} 秒后重试 (${retries}/${this.maxRetries})`,
          );
          continue;
        }

        const delayIndex = Math.min(retries - 1, this.retryDelaysMs.length - 1);
        waitMs = this.retryDelaysMs[delayIndex] || 0;
        this.logger?.warn(
          `向量接口临时异常，${Math.ceil(waitMs / 1000)} 秒后重试当前请求 (${retries}/${this.maxRetries}): ${error.message}`,
        );
        await this.wait(waitMs);
      }
    }
  }
}

module.exports = {
  EmbeddingRequestCoordinator,
  getRetryAfterMs,
  isRateLimitError,
  isRetryableEmbeddingError,
};
