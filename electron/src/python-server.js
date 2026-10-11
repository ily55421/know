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
      
      if (app.isPackaged) {
        // 生产环境：使用打包的可执行文件
        const executableName = process.platform === 'win32' ? 'findme.exe' : 'findme';
        pythonExecutable = path.join(process.resourcesPath, 'python-server', executableName);
        
        // 检查可执行文件是否存在
        if (!fs.existsSync(pythonExecutable)) {
          log.error(`Python可执行文件不存在: ${pythonExecutable}`);
          reject(new Error(`Python可执行文件不存在: ${pythonExecutable}`));
          return;
        }
      } else {
        // 开发环境：使用Python脚本
        pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
        const pythonScript = path.join(app.getAppPath(), 'python', 'api.py');

        
        if (!fs.existsSync(pythonScript)) {
          log.error(`Python脚本不存在: ${pythonScript}`);
          reject(new Error(`Python脚本不存在: ${pythonScript}`));
          return;
        }
        
        pythonExecutable = [pythonExecutable, pythonScript];
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
