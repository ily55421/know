const { spawn, exec } = require('child_process');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { log, API_BASE_URL, appState, store } = require('./config');
const { appendLocalNoProxy } = require('./no-proxy-local');
const { resolveAndPersistDeviceId } = require('./device-id');

let pythonProcess = null;

// 启动前异步清理残留的 Python 进程（防止上次异常退出留下僵尸进程）
// 返回 Promise，最多等待 3 秒，超时或失败都不阻塞启动
function killResidualPythonProcess() {
  let cmd;
  if (process.platform === 'win32') {
    // [重建版适配] 便携重建版绝不能 taskkill findme.exe——那是原版应用的后端进程
    if (app.isPackaged && !fs.existsSync(path.join(process.resourcesPath, 'python-server', 'findme.exe'))) {
      return Promise.resolve();
    }
    cmd = app.isPackaged
      ? 'taskkill /F /T /IM findme.exe'
      : 'wmic process where "name=\'python.exe\' and CommandLine like \'%api.py%\'" delete';
  } else {
    const pattern = app.isPackaged ? 'python-server/findme' : 'python/api.py';
    cmd = `pkill -9 -f '${pattern}'`;
  }

  return new Promise((resolve) => {
    exec(cmd, { timeout: 3000 }, (err) => {
      if (!err) log.info('已清理残留的 Python 进程');
      // err 通常是"没有匹配进程"，属正常情况，静默忽略；timeout 时同样触发此回调
      resolve();
    });
  });
}

// [重建版适配] 后端子进程：便携包内不含 findme.exe，用 Electron utilityProcess（自带 Node 运行时）
// 启动后端——独立进程，不会阻塞/拖垮主进程事件循环（v1 的进程内 require 曾导致主进程卡死）。
function startInProcessBackend() {
  return new Promise((resolve, reject) => {
    try {
      const { utilityProcess } = require('electron');
      const backendEntry = path.join(__dirname, '..', '..', 'server', 'index.js');
      const dataRoot = process.env.KNOWLY_DATA_ROOT
        || path.join(path.dirname(app.getPath('exe')), 'data', 'backend');
      // 清理陈旧后端：杀掉仍监听 28099 的进程（单实例锁保证它只可能是上一实例的孤儿）
      try {
        const out = exec('netstat -ano | findstr ":28099" | findstr "LISTENING"', { timeout: 3000 });
        const pids = [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid))];
        for (const pid of pids) {
          log.info(`[重建版适配] 清理陈旧后端进程 PID=${pid}`);
          exec(`taskkill /F /T /PID ${pid}`, { timeout: 3000 });
        }
      } catch { /* 无占用 */ }
      const child = utilityProcess.fork(backendEntry, ['--data-root', dataRoot], {
        serviceName: 'knowly-backend',
        env: {
          ...process.env,
          KNOWLY_IN_PROCESS: '1',
          KNOWLY_DATA_ROOT: dataRoot,
          KNOWLY_SHARED_DATA_ROOT: process.env.KNOWLY_SHARED_DATA_ROOT || '',
          // 注意：不可在此设置 ELECTRON_RUN_AS_NODE —— 会破坏 asar 支持导致子进程立即退出
        },
      });
      // [重建版适配] 登记子进程：isPythonServerRunning() 依赖该引用，
      // 渲染层知识库页等仅在收到 python-ready 后加载数据（缺失会导致目录列表永远为空）
      pythonProcess = child;
      child.on('exit', (code) => {
        log.warn(`[重建版适配] 后端子进程退出，code=${code}`);
      });
      child.on('message', (m) => {
        log.info(`[重建版适配][backend] ${typeof m === 'string' ? m.slice(0, 200) : JSON.stringify(m).slice(0, 200)}`);
      });
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const req = require('node:http').get(`${API_BASE_URL}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            clearInterval(timer);
            log.info(`[重建版适配] 后端子进程已就绪: ${API_BASE_URL}`);
            resolve(API_BASE_URL);
          }
        });
        req.on('error', () => { /* 未就绪，继续轮询 */ });
        req.setTimeout(1500, () => req.destroy());
        if (Date.now() - startedAt > 60000) {
          clearInterval(timer);
          reject(new Error('后端子进程启动超时 (60秒)'));
        }
      }, 400);
    } catch (error) {
      reject(error);
    }
  });
}

// 启动Python后端服务
async function startPythonServer() {
  return new Promise(async (resolve, reject) => {
    try {
      const startTime = Date.now();
      log.info(`[${new Date().toISOString()}] 开始启动Python服务器...`);
      
      // 启动前清理可能残留的进程，避免 DLL 锁导致新进程初始化失败
      await killResidualPythonProcess();

      // 如果Python进程已经在运行，直接返回已有URL
      if (pythonProcess) {
        log.info(`[${new Date().toISOString()}] Python进程已在运行，使用现有连接`);
        appState.pythonServerRunning = true;
        appState.serverUrl = API_BASE_URL;
        resolve(API_BASE_URL);
        return;
      }
      
      // 确定Python可执行文件路径
      let pythonExecutable;

      // [重建版适配] 判据改为"findme.exe 是否存在"（而非 app.isPackaged）：
      // 便携重建版（含项目根 Knowly.exe）不含 findme.exe → 一律用进程内 Node 后端，
      // 不依赖系统 Python；原版安装目录仍走 findme.exe
      const findmePath = path.join(process.resourcesPath, 'python-server',
        process.platform === 'win32' ? 'findme.exe' : 'findme');
      if (fs.existsSync(findmePath)) {
        // 原版安装目录：使用打包的可执行文件
        pythonExecutable = findmePath;
      } else {
        // 重建版：优先进程内 Node 后端（自包含，无需 Python）
        const pythonScript = path.join(app.getAppPath(), 'python', 'api.py');

        if (!process.env.KNOWLY_PREFER_PYTHON || !fs.existsSync(pythonScript)) {
          log.info('[重建版适配] 包内无 findme.exe，改用进程内 Node 后端');
          startInProcessBackend().then(resolve).catch(reject);
          return;
        }
        // 兼容旧开发流程：python/api.py 存在且显式偏好时走 Python 垫片
        log.info('[重建版适配] 使用 Python 垫片启动 Node 后端');
        pythonExecutable = [process.platform === 'win32' ? 'python' : 'python3', pythonScript];
      }
      
      const elapsedBeforeSpawn = ((Date.now() - startTime) / 1000).toFixed(2);
      log.info(`[${new Date().toISOString()}] [+${elapsedBeforeSpawn}s] 启动Python服务: ${Array.isArray(pythonExecutable) ? pythonExecutable.join(' ') : pythonExecutable}`);
      
      // 设备ID以数据目录为准，并迁移 electron-store 里的历史 ID
      const deviceId = resolveAndPersistDeviceId(store);
      let envVars = appendLocalNoProxy({
        ...process.env,
        PYTHONUNBUFFERED: '1',
        FINDME_DEVICE_ID: deviceId,
      });
      
      // 增强 PATH：确保 MCP Server 等外部工具能找到 node/npx
      // macOS 从 Dock/Finder 启动时 PATH 只有 /usr/bin:/bin，需要补充常见路径
      if (process.platform !== 'win32') {
        const homedir = require('os').homedir();
        const extraPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
          `${homedir}/.nvm/versions/node`,  // nvm: 下面会展开为实际版本路径
          `${homedir}/.local/bin`,
          `${homedir}/.volta/bin`,
          '/usr/local/opt/node/bin',
        ];
        
        // nvm 特殊处理：找到当前默认的 node 版本路径
        const nvmDir = `${homedir}/.nvm/versions/node`;
        try {
          if (fs.existsSync(nvmDir)) {
            const versions = fs.readdirSync(nvmDir).sort().reverse();
            if (versions.length > 0) {
              extraPaths.push(path.join(nvmDir, versions[0], 'bin'));
            }
          }
        } catch (e) {
          // nvm 目录不可读，跳过
        }
        
        const currentPath = envVars.PATH || '';
        const pathsToAdd = extraPaths.filter(p => !currentPath.includes(p));
        if (pathsToAdd.length > 0) {
          envVars.PATH = currentPath + ':' + pathsToAdd.join(':');
        }
      }
      
      // Windows平台特殊编码设置
      if (process.platform === 'win32') {
        envVars.PYTHONIOENCODING = 'utf-8';
        envVars.PYTHONUTF8 = '1';
        // 设置控制台代码页为UTF-8
        envVars.CHCP = '65001';
      }
      

      
      // 如果是打包后的应用，确保加载.env文件中的环境变量
      if (app.isPackaged) {
        try {
          const envPath = path.join(process.resourcesPath, '.env');
          log.info(`[${new Date().toISOString()}] 尝试加载环境变量文件: ${envPath}`);
          
          if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const envLines = envContent.split('\n');
            
            for (const line of envLines) {
              if (line.trim() && !line.startsWith('#')) {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                  let key = match[1].trim();
                  let value = match[2].trim().replace(/^["']|["']$/g, '');
                  value = value.replace(/[%\s]+$/, '');
                  
                  envVars[key] = value;
                  log.info(`[${new Date().toISOString()}] 已加载环境变量: ${key}=${value.substring(0, 3)}...`);
                }
              }
            }
          } else {
            log.warn(`[${new Date().toISOString()}] 环境变量文件不存在: ${envPath}`);
          }
        } catch (envError) {
          log.error(`[${new Date().toISOString()}] 加载环境变量文件时出错: ${envError.message}`);
        }
      }
      
      // 启动Python进程
      const spawnTime = Date.now();
      log.info(`[${new Date().toISOString()}] 正在启动Python进程...`);
      
      if (Array.isArray(pythonExecutable)) {
        // 开发环境：运行Python脚本
        pythonProcess = spawn(pythonExecutable[0], [pythonExecutable[1]], { env: envVars });
      } else {
        // 生产环境：运行可执行文件
        // 设置工作目录为可执行文件所在目录，确保PyInstaller打包的文件能找到_internal依赖
        const executableDir = path.dirname(pythonExecutable);
        pythonProcess = spawn(pythonExecutable, [], { 
          env: envVars,
          cwd: executableDir
        });
      }
      
      const elapsedAfterSpawn = ((Date.now() - startTime) / 1000).toFixed(2);
      log.info(`[${new Date().toISOString()}] [+${elapsedAfterSpawn}s] Python进程已启动，PID: ${pythonProcess.pid}`);
      
      // 设置Python进程的监听器
      setupPythonProcessListeners(pythonProcess, resolve, reject, envVars);
    } catch (error) {
      log.error(`[${new Date().toISOString()}] 启动Python服务器失败:`, error);
      appState.pythonServerRunning = false;
      reject(error);
    }
  });
}

// 设置Python进程的监听器
function setupPythonProcessListeners(pythonProc, resolvePromise, rejectPromise, envVars) {
  let serverStarted = false;
  let outputBuffer = '';
  let errorBuffer = '';

  const timeout = setTimeout(() => {
    if (!serverStarted) {
      log.error('Python服务器启动超时 (60秒)');
      if (pythonProc && !pythonProc.killed) {
        pythonProc.kill();
      }
      pythonProcess = null;
      appState.pythonServerRunning = false;
      rejectPromise(new Error('Python服务器启动超时'));
    }
  }, 60000);

  const markServerStarted = (output) => {
    if (serverStarted || !output.includes('Uvicorn running on')) {
      return;
    }

    serverStarted = true;
    clearTimeout(timeout);

    appState.pythonServerRunning = true;
    appState.serverUrl = API_BASE_URL;

    log.info(`Python服务器已启动: ${API_BASE_URL}`);
    resolvePromise(API_BASE_URL);
  };
  
  pythonProc.stdout.on('data', (data) => {
    // Windows平台特殊处理UTF-8编码
    let output;
    if (process.platform === 'win32') {
      // 确保正确解码UTF-8字节
      output = data.toString('utf8');
    } else {
      output = data.toString();
    }
    
    outputBuffer += output;
    log.info(`Python stdout: ${output.trim()}`);
    
    markServerStarted(outputBuffer);
  });
  
  pythonProc.stderr.on('data', (data) => {
    // Windows平台特殊处理UTF-8编码
    let error;
    if (process.platform === 'win32') {
      // 确保正确解码UTF-8字节
      error = data.toString('utf8');
    } else {
      error = data.toString();
    }
    
    errorBuffer += error;
    const trimmedError = error.trim();
    const stderrLines = trimmedError.split(/\r?\n/).filter(Boolean);
    const isInfoOutput = stderrLines.length > 0
      && stderrLines.every((line) => line.trimStart().startsWith('INFO:'));

    if (isInfoOutput) {
      log.info(`Python stderr: ${trimmedError}`);
    } else {
      log.error(`Python stderr: ${trimmedError}`);
    }

    markServerStarted(errorBuffer);
  });
  
  pythonProc.on('close', (code) => {
    clearTimeout(timeout);
    log.info(`Python进程已退出，退出码: ${code}`);
    
    pythonProcess = null;
    appState.pythonServerRunning = false;
    
    if (!serverStarted) {
      const errorMsg = `Python服务器启动失败，退出码: ${code}`;
      log.error(errorMsg);
      if (errorBuffer) {
        log.error(`错误输出: ${errorBuffer}`);
      }
      rejectPromise(new Error(`${errorMsg}\n错误输出: ${errorBuffer}`));
    }
  });
  
  pythonProc.on('error', (error) => {
    clearTimeout(timeout);
    log.error('Python进程错误:', error);
    
    pythonProcess = null;
    appState.pythonServerRunning = false;
      
    if (!serverStarted) {
      rejectPromise(error);
    }
  });
}

// 停止Python服务器
function stopPythonServer() {
  if (pythonProcess) {
    try {
      process.kill(pythonProcess.pid);
      pythonProcess = null;
      appState.pythonServerRunning = false;
      log.info('Python服务器已停止');
    } catch (error) {
      log.error('停止Python进程失败:', error);
    }
  }
}

// 检查Python服务器是否运行
function isPythonServerRunning() {
  return pythonProcess !== null && appState.pythonServerRunning;
}

// 获取Python进程
function getPythonProcess() {
  return pythonProcess;
}

module.exports = {
  startPythonServer,
  stopPythonServer,
  isPythonServerRunning,
  getPythonProcess
};
