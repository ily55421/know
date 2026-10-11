const { app } = require('electron');
const Store = require('electron-store');
const log = require('electron-log');

// 配置日志
log.transports.file.level = 'info';

// Windows平台特殊配置，确保日志文件正确处理UTF-8编码
if (process.platform === 'win32') {
  // 强制设置日志文件编码为UTF-8
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  
  // 为Windows平台设置编码相关的环境变量
  process.env.ELECTRON_LOG_ENCODING = 'utf8';
}

log.info('应用启动中...');

// 初始化存储
const store = new Store();

// [重建版适配] 数据持久区：把后端业务数据根目录指到 userData/backend-data
// （默认 %APPDATA%/KnowlyRecon/backend-data），与程序目录解耦——
// 项目更新/替换/重装不会丢会话与配置。后端子进程经环境变量继承（server/store.js）。
process.env.KNOWLY_DATA_ROOT = process.env.KNOWLY_DATA_ROOT
  || require('path').join(app.getPath('userData'), 'backend-data');

// API 基础URL
// [重建版适配] 端口迁移：原版为 18099，重建版默认 28099，避免与已安装原版冲突；env 可覆盖
const API_PORT = Number(process.env.KNOWLY_BACKEND_PORT) || 28099;
const API_BASE_URL = `http://localhost:${API_PORT}`;

// 应用状态
const appState = {
  pythonServerRunning: false,
  serverUrl: API_BASE_URL
};

// Microsoft Store 版（appx）由商店负责更新，不走 OSS 自更新
const isStoreVersion = process.platform === 'win32' && !!process.windowsStore;

// EMAS配置
const EMAS_CONFIG = {
  spaceId: 'mp-f71314a3-8e1f-4006-a851-35291a8ced09',
  /** 统计上报 HTTP 触发地址（需在控制台为 emas-statistics 开启 HTTP 触发） */
  statisticsEndpoint: 'https://fc-mp-f71314a3-8e1f-4006-a851-35291a8ced09.next.bspapp.com/emas-statistics',
  serverSecret: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCrxtq89H3sVzIV7ACufSgTECjdx6kP9K9USIHRZx3Aq30rqsslyLwlFrR67BiZ7lpBwXBhfcomntA/oLsTdblGk6MS+u2Cuqx5d4kWPoKbuFNlqpsdzgDYh/sz2pYmtGvkJdawnhiISN9J2J94562xSpL83nCFKNnLnqgKt2hjuwG0xMQ5eoMhgi987bEBs5paJIcEuBap7Hc5Nu9PL1S6J3T1YEkpRRXL99iEPyEya8FehaT+J/MJ35C4HobFCaDGOn4Y9v3EVAM/G0hRjfhlwTL7wJ7wuBQyOuP14VvT8WYn5DIbF/I6USno1SWdYdqJ8pw6cy/Ym2pWziIuB6+/AgMBAAECggEAIw/e3AzHmzMdHQ5kATm4sVNuE/7KCmC2XOzD2rtCfm5CiWQ+PQMhLCzbP+/rAZh+Qce7KZskZQermCE1rj4sSDSgZ6JiUnnJ9K0qhSjTPfe8xhaxvL6su4XeB3KJjXLsRtBWZwyOE1tUgF1AB8y6TmLbZ9P7gaKZ+g7zW+Sd4SUX1kZCKCaBzOPRJe+gDOG3f6wqqJTMhf7X+PAB3I1a0T0EF/1DaBMUTtoddoq5mGZHPR2HAyQkMS0Xe+u+47QEBOVbH7Ik+R7mHXLzQK2vct5+/pyVbqAMLWzu0vTQSUJ4qMZI20u56aHL4ZUiilIIoMrmJI1m8T9RdltSMtAYoQKBgQDh/BHySq3lRhm7X24GD2NUsrhZBVG104+iZcr8vAXiRwwpxz/ofoHW4LZcaLtJttg+T1VU0lkCQAvjNIYcJ5HKJCEcX3rHcLcmef9vYp68eqU2h3kdccc6OtZRKJQwJbzrm8zsJInRNUcSAAKsEnacHto/Pth0VOKBZ2AWJBzuMQKBgQDCl5u2ihroit3IpkcKabc+JQvf05X4hhMTo4V2Ih0TyPqesgObTB6K6iNCzDm4YdbEdpKyGmjbD7rmxc5eQ1Bh73u6YwSDu2WbwPlPa2yK9s2j+vTtbScvopfgNu1iOHBD58xM4TS3JShNKVCMk1j1hxBYjbA215ihe5OfQnZQ7wKBgDLZwMQPj9/GjWW/TIeqkMRvTtIhQ0ix6WE2nJ2QRZasPA1um2/af6b1e7OBkZs9vJ0QxvfGOWcrOEGRARh2wvSEerritUMJlvzeeN78hxGMW37Qry0z/AubT7yFcAsBguhVb6A3fJeJ8IsZW4CSywPIYX3Xy2cp7qoFs/Zne+cRAoGALNyQ/ItoWrYxHWIgPKlUopId47M+/vXCDiQDz9FbjMUn6lA1/qaU4AfMq0i0AeskfVSsyzzFccN1nmB6DEdOj9WLW9QaJVidu0PI9mNYuczeafCgaOBiSVwd0YY4Qg2q7CzTb+H3qkV5vhhJRq9tseU6gn/f4TThLlF0HiJPbqcCgYEAvnKjciUFq9Woq87A+EITcj5HgN5u5w9hV8cd/yyzC0zg/5IafGPyVHDqs6Yg4ZCApsRReJYNt3dWMXdSmk324D/VhRGUuAp0CWbEu4mlRDbokb9DY9WCPXR9Oc5fOS1QHt2mCgNqGwroeaWIzxyqWOwaf8RFPO4c1QxTYbA2kcc=\n-----END PRIVATE KEY-----',
  endpoint: 'https://api.next.bspapp.com'
};

module.exports = {
  log,
  store,
  API_BASE_URL,
  appState,
  EMAS_CONFIG,
  isStoreVersion,
}; 