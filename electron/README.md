# Electron主进程模块化结构

## 概述

原来的 `main.js` 文件（1051行）已经按功能模块拆分为多个独立的模块，提高了代码的可维护性和可读性。

## 模块结构

### 核心文件
- `main.js` - 主入口文件，负责导入各模块并设置应用生命周期事件
- `main-backup.js` - 原始main.js文件的备份

### 功能模块

#### `config.js` (34行)
- 应用配置和常量定义
- 日志配置
- 存储初始化
- EMAS云服务配置
- 应用状态管理

#### `window-manager.js` (159行)
- 主窗口创建和管理
- 窗口显示/隐藏控制
- 向渲染进程发送事件
- 窗口图标设置

#### `python-server.js` (221行)
- Python后端服务启动和管理
- 进程监控和错误处理
- 环境变量加载
- 服务器状态检查

#### `ipc-handlers.js` (58行)
- 所有IPC通信处理器
- 文件夹选择对话框
- 配置保存/读取
- 云服务相关IPC调用

#### `tray-manager.js` (104行)
- 系统托盘图标创建和管理
- 托盘菜单设置
- 托盘事件处理

#### `cloud-services.js` (237行)
- 用户统计数据上传
- 用户反馈提交
- 公告信息获取
- 邀请码验证
- EMAS云服务集成

#### `auto-updater.js` (89行)
- 自动更新检查和处理
- 更新下载进度
- 更新安装提示

#### `app-lifecycle.js` (209行)
- 应用启动流程管理
- Python服务启动错误处理和重试逻辑
- 应用激活事件处理
- 应用退出清理

## 模块依赖关系

```
main.js
├── config.js (基础配置)
├── ipc-handlers.js (IPC处理器)
└── app-lifecycle.js (应用生命周期)
    ├── window-manager.js (窗口管理)
    ├── python-server.js (Python服务)
    ├── tray-manager.js (托盘管理)
    ├── cloud-services.js (云服务)
    └── auto-updater.js (自动更新)
```

## 优势

1. **模块化**: 每个功能模块职责清晰，便于维护
2. **可读性**: 代码结构更清晰，易于理解
3. **可测试性**: 独立模块便于单元测试
4. **可扩展性**: 新功能可以独立模块形式添加
5. **代码复用**: 模块可以在其他项目中复用

## 使用方式

主文件现在非常简洁，只需要导入模块并设置事件监听器：

```javascript
const { app } = require('electron');

// 导入各个功能模块
require('./src/config');
require('./src/ipc-handlers');
const { handleAppReady, handleAppActivate, ... } = require('./src/app-lifecycle');

// 设置应用生命周期事件
app.whenReady().then(handleAppReady);
app.on('activate', handleAppActivate);
// ...
```

## 注意事项

- 确保所有模块的路径引用正确
- 配置模块必须首先加载，因为其他模块依赖它
- IPC处理器通过导入时的副作用自动注册
- 应用生命周期模块整合了大部分启动逻辑 