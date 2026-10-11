const https = require('https');
const http = require('http');
const dns = require('dns');
const { promisify } = require('util');

const dnsResolve = promisify(dns.resolve);

/**
 * 检测HTTP/HTTPS连接
 * @param {string} url - 要检测的URL
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Object>} 连接检测结果
 */
function checkHttpConnection(url, timeout = 5000) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET',
      timeout: timeout,
      headers: {
        'User-Agent': 'FindMe-Diagnostics'
      }
    };
    
    const startTime = Date.now();
    
    const req = protocol.request(options, (res) => {
      const responseTime = Date.now() - startTime;
      resolve({
        success: true,
        statusCode: res.statusCode,
        responseTime: responseTime,
        message: `连接成功 (${res.statusCode}, ${responseTime}ms)`
      });
      res.resume(); // 消费响应数据
    });
    
    req.on('error', (error) => {
      resolve({
        success: false,
        error: error.code || error.message,
        message: `连接失败: ${error.message}`
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: 'TIMEOUT',
        message: `连接超时 (>${timeout}ms)`
      });
    });
    
    req.end();
  });
}

/**
 * 检测DNS解析
 * @param {string} hostname - 要解析的主机名
 * @returns {Promise<Object>} DNS解析结果
 */
async function checkDNSResolution(hostname) {
  try {
    const startTime = Date.now();
    const addresses = await dnsResolve(hostname);
    const responseTime = Date.now() - startTime;
    
    return {
      success: true,
      addresses: addresses,
      responseTime: responseTime,
      message: `解析成功 (${addresses.length} 条记录, ${responseTime}ms)`
    };
  } catch (error) {
    return {
      success: false,
      error: error.code || error.message,
      message: `DNS解析失败: ${error.message}`
    };
  }
}

/**
 * 检测系统代理设置（包括环境变量和系统代理）
 * @param {Object} session - Electron session对象（可选）
 * @returns {Promise<Object>} 代理设置信息
 */
async function checkSystemProxy(session = null) {
  try {
    const proxyInfo = {
      envProxy: null,
      systemProxy: null,
      enabled: false,
      message: ''
    };
    
    // 1. 检查环境变量中的代理设置
    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    
    if (httpProxy || httpsProxy) {
      proxyInfo.envProxy = {
        http: httpProxy || '未设置',
        https: httpsProxy || '未设置',
        noProxy: noProxy || '未设置'
      };
      proxyInfo.enabled = true;
    }
    
    // 2. 检测系统代理（通过 Electron session）
    if (session) {
      try {
        // 使用一个常见的URL来检测系统代理配置
        const proxyUrl = await session.resolveProxy('https://www.google.com');
        if (proxyUrl && proxyUrl !== 'DIRECT') {
          proxyInfo.systemProxy = proxyUrl;
          proxyInfo.enabled = true;
        }
      } catch (e) {
        // resolveProxy 可能失败，忽略错误继续
      }
    }
    
    // 3. 生成消息
    if (proxyInfo.envProxy && proxyInfo.systemProxy) {
      proxyInfo.message = '检测到环境变量代理和系统代理';
    } else if (proxyInfo.envProxy) {
      proxyInfo.message = '检测到环境变量代理配置';
    } else if (proxyInfo.systemProxy) {
      proxyInfo.message = `检测到系统代理: ${proxyInfo.systemProxy}`;
    } else {
      proxyInfo.message = '未检测到代理配置（可能使用直连或透明代理）';
    }
    
    return proxyInfo;
  } catch (error) {
    return {
      enabled: false,
      error: error.message,
      message: '检测代理配置失败'
    };
  }
}

const API_HOST = 'localhost';
// [重建版适配] 端口迁移：与 config.js 的 API_PORT 保持一致（原版 18099 → 重建版 28099）
const API_PORT = Number(process.env.KNOWLY_BACKEND_PORT) || 28099;
const API_TIMEOUT = 3000;

/**
 * 请求本地后端 API
 * @param {string} path - 请求路径
 * @returns {Promise<Object|null>} 成功时返回 result.data，否则 null
 */
async function requestAPI(path) {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.request({
        hostname: API_HOST,
        port: API_PORT,
        path,
        method: 'GET',
        timeout: API_TIMEOUT
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success && result.data) {
              resolve(result.data);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  } catch (error) {
    return null;
  }
}

/**
 * 获取用户配置的 API 信息（/api/config）
 * @returns {Promise<Object|null>} API 配置
 */
async function getAPIConfig() {
  return requestAPI('/api/config');
}

/**
 * 获取当前实际在用的模型信息（LLM/嵌入/视觉的 provider 与 api_base）
 * 用于诊断时按「实际使用的云端服务」添加测试，包含未配 key 的软件默认场景
 * @returns {Promise<Object|null>} { llm, embedding, vision }
 */
async function getCurrentModels() {
  return requestAPI('/api/models/current');
}

/**
 * 分析防火墙拦截可能性
 * @param {Object} connectionResults - 连接测试结果
 * @returns {Object} 防火墙分析结果
 */
function analyzeFirewallIssues(connectionResults) {
  const firewallIndicators = {
    timeouts: 0,
    connectionRefused: 0,
    totalTests: 0,
    suspectedFirewall: false,
    message: ''
  };

  Object.values(connectionResults).forEach(result => {
    firewallIndicators.totalTests++;
    if (!result.success) {
      if (result.error === 'TIMEOUT' || result.error === 'ETIMEDOUT') {
        firewallIndicators.timeouts++;
      } else if (result.error === 'ECONNREFUSED') {
        firewallIndicators.connectionRefused++;
      }
    }
  });

  // 判断是否可能是防火墙问题
  const failureRate = (firewallIndicators.timeouts + firewallIndicators.connectionRefused) / firewallIndicators.totalTests;
  
  if (firewallIndicators.timeouts >= 2 || failureRate >= 0.5) {
    firewallIndicators.suspectedFirewall = true;
    if (firewallIndicators.timeouts >= 2) {
      firewallIndicators.message = '检测到多个连接超时，可能被防火墙或安全软件拦截';
    } else {
      firewallIndicators.message = '多个连接失败，建议检查防火墙或网络安全软件设置';
    }
  } else {
    firewallIndicators.message = '未检测到明显的防火墙拦截迹象';
  }

  return firewallIndicators;
}

/**
 * 运行完整的网络诊断
 * @param {Object} log - 日志对象
 * @param {Object} session - Electron session对象（可选）
 * @returns {Promise<Object>} 诊断结果
 */
async function runNetworkDiagnostics(log, session = null) {
  log.info('开始网络诊断...');
  
  const diagnostics = {
    timestamp: new Date().toISOString(),
    results: {}
  };
  
  try {
    // 1. 检测系统代理
    diagnostics.results.proxy = await checkSystemProxy(session);
    
    // 2. 获取 API 配置与当前实际使用的模型（后者包含软件默认场景下的真实 provider）
    const apiConfig = await getAPIConfig();
    const currentModels = await getCurrentModels();

    // 3. 构建需要检测的服务列表：以「实际在用的云端服务」为准，保证未配 key 的软件默认用户也会被诊断
    const connectionTests = [];
    const addedUrls = new Set();

    function addTest(name, url, isCore) {
      if (!url || addedUrls.has(url)) return;
      addedUrls.add(url);
      connectionTests.push({ name, url, isCore });
    }

    const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com';
    const DEEPSEEK_URL = 'https://api.deepseek.com';

    if (currentModels) {
      // 按实际在用的 LLM / 嵌入 / 视觉 provider 添加云端服务测试（含软件默认）
      const providersToCheck = [
        { p: currentModels.llm?.provider, apiBase: currentModels.llm?.api_base, name: '阿里云DashScope API', openaiName: 'OpenAI API', customName: '自定义大模型API' },
        { p: currentModels.embedding?.provider, apiBase: currentModels.embedding?.api_base, name: '阿里云DashScope API', openaiName: 'OpenAI API', customName: '自定义向量API' },
        { p: currentModels.vision?.provider, apiBase: currentModels.vision?.api_base, name: '阿里云DashScope API', openaiName: 'OpenAI API', customName: '自定义大模型API' }
      ];
      for (const { p, apiBase, name, openaiName, customName } of providersToCheck) {
        if (!p || p === 'ollama') continue;
        if (p === 'software_default') {
          const base = (apiBase && apiBase.trim()) || DEEPSEEK_URL;
          addTest('软件默认大模型API', base, true);
        } else if (p === 'dashscope') {
          addTest(name, DASHSCOPE_URL, true);
        } else if (p === 'openai') {
          const base = apiBase && apiBase.trim();
          if (base) addTest(openaiName, base, true);
        } else if (p === 'custom') {
          const base = (apiBase && apiBase.trim()) || apiConfig?.custom?.api_base;
          if (base) addTest(customName, base, true);
        }
      }
    }

    // 无 currentModels 或未添加任何核心测试时，按 apiConfig 回退（当前 provider + 已配置 key）
    if (connectionTests.filter(t => t.isCore).length === 0 && apiConfig) {
      const provider = apiConfig.provider || 'software_default';
      if (provider === 'custom' && apiConfig.custom?.api_base) {
        addTest('自定义大模型API', apiConfig.custom.api_base, true);
        if (apiConfig.custom.use_custom_embedding && apiConfig.custom.embedding_api_base) {
          addTest('自定义向量API', apiConfig.custom.embedding_api_base, true);
        }
      } else if (provider === 'software_default') {
        addTest('软件默认大模型API', DEEPSEEK_URL, true);
      }
      if (apiConfig.custom?.has_api_key && apiConfig.custom?.api_base) addTest('自定义大模型API', apiConfig.custom.api_base, true);
      if (apiConfig.custom?.use_custom_embedding && apiConfig.custom?.embedding_api_base) {
        addTest('自定义向量API', apiConfig.custom.embedding_api_base, true);
      }
    }
    if (connectionTests.filter(t => t.isCore).length === 0) {
      addTest('软件默认大模型API', DEEPSEEK_URL, true);
    }
    
    // 添加基础网络连通性测试
    connectionTests.push({
      name: '基础网络测试 (Baidu)',
      url: 'https://www.baidu.com',
      isCore: false
    });
    
    // 4. 执行DNS解析测试
    const dnsTests = [];
    connectionTests.forEach(test => {
      try {
        const url = new URL(test.url);
        if (!dnsTests.find(t => t.hostname === url.hostname)) {
          dnsTests.push({
            name: url.hostname,
            hostname: url.hostname
          });
        }
      } catch (e) {
        log.warn(`无效的URL: ${test.url}`);
      }
    });
    
    diagnostics.results.dns = {};
    for (const test of dnsTests) {
      diagnostics.results.dns[test.name] = await checkDNSResolution(test.hostname);
    }
    
    // 5. 执行连接测试
    diagnostics.results.connections = {};
    for (const test of connectionTests) {
      diagnostics.results.connections[test.name] = await checkHttpConnection(test.url);
      diagnostics.results.connections[test.name].isCore = test.isCore;
    }
    
    // 6. 分析防火墙问题
    diagnostics.results.firewall = analyzeFirewallIssues(diagnostics.results.connections);
    
    // 7. 总结诊断结果
    const allDnsSuccess = Object.values(diagnostics.results.dns).every(r => r.success);
    const coreConnectionsSuccess = Object.entries(diagnostics.results.connections)
      .filter(([_, result]) => result.isCore)
      .every(([_, result]) => result.success);
    const allConnectionsSuccess = Object.values(diagnostics.results.connections)
      .every(r => r.success);
    
    diagnostics.summary = {
      overall: allDnsSuccess && coreConnectionsSuccess ? 'success' : 'warning',
      dnsStatus: allDnsSuccess ? '正常' : '异常',
      coreConnectionStatus: coreConnectionsSuccess ? '正常' : '异常',
      connectionStatus: allConnectionsSuccess ? '正常' : '部分异常',
      proxyStatus: diagnostics.results.proxy.enabled ? '已启用' : '未启用',
      firewallStatus: diagnostics.results.firewall.suspectedFirewall ? '可能被拦截' : '正常'
    };
    
    log.info('网络诊断完成', diagnostics.summary);
    
    return {
      success: true,
      data: diagnostics
    };
  } catch (error) {
    log.error('网络诊断失败:', error);
    return {
      success: false,
      message: `网络诊断失败: ${error.message}`,
      error: error.message
    };
  }
}

module.exports = {
  checkHttpConnection,
  checkDNSResolution,
  checkSystemProxy,
  runNetworkDiagnostics
};
