/**
 * 本机回环地址不走系统代理；远程请求仍使用 HTTP_PROXY / 系统代理。
 */

const LOCAL_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'];

function parseNoProxyList(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 合并 NO_PROXY / no_proxy，供主进程与子进程（Python）使用。
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function appendLocalNoProxy(env = process.env) {
  const existing = env.NO_PROXY || env.no_proxy || '';
  const parts = parseNoProxyList(existing);
  const toAdd = LOCAL_NO_PROXY_ENTRIES.filter((entry) => !parts.includes(entry));
  if (toAdd.length === 0) {
    return { ...env };
  }
  const merged = [...parts, ...toAdd].join(',');
  return {
    ...env,
    NO_PROXY: merged,
    no_proxy: merged,
  };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isLocalUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  try {
    const { hostname } = new URL(url);
    if (!hostname) {
      return false;
    }
    const host = hostname.toLowerCase();
    if (LOCAL_NO_PROXY_ENTRIES.includes(host)) {
      return true;
    }
    return host.endsWith('.localhost');
  } catch {
    return false;
  }
}

module.exports = {
  appendLocalNoProxy,
  isLocalUrl,
};
