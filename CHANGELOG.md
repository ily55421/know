# Changelog（重建版）

## [3.13.2-recon.2] — 2026-10-11

### 安全与隐私
- 隐私审计：确认原版常驻遥测面（EMAS 统计/配额同步/云端技能与模型同步/阿里云 RUM 前端监控/OSS 更新检查），重建版逐项处置并默认零云外呼（遥测门 KNOWLY_ENABLE_TELEMETRY，台账 §15）
- 运行时实证：全栈 6 进程 0 条非回环连接

### 数据持久化
- 后端数据迁至 %APPDATA%/KnowlyRecon/backend-data，程序目录更新不丢数据；旧 vector_store/data 自动迁移
- 修复：数据根误用 ready 前 getPath('userData') 导致短暂写入原版目录（已核实未触碰原版数据，已清理）

### 功能与验证
- 自定义 API Key 全链路实测通过（本地 Mock 端点：Key 传递/SSE 流式/标题生成，台账 §16）
- 功能齐全度矩阵落档 docs/FEATURE-MATRIX.md（16 工具：3 完整/3 简化/10 诚实降级）
- 回归测试 29/29；CDP 端到端 PASS；UI 版本号显示 v3.13.2-recon.x

### 验证
- npm test 通过


版本方案：`<上游版本>-recon.<n>`。`3.13.2-recon.1` 表示基于原版 findme/Knowly v3.13.2 的第 1 个重建发布。
上游版本号始终对应还原基线（见 `analysis/EVIDENCE-LEDGER.md` §14 升级参考基线）。

## [3.13.2-recon.1] — 2026-10-11

### 还原基线
- 上游：原版安装包 v3.13.2（Electron 36.7.3，asar 18,768 文件，内置依赖 513 包）

### 还原内容
- Electron 壳层 1:1（主进程 21 模块源码 + preload + 渲染层构建产物）
- Node 后端契约重实现（原 PyInstaller findme.exe）：REST + SSE 智能体、16 工具注册表
  - file_reader / excel_inspector 完整移植（字节码反汇编契约）
  - shell_executor / file_searcher / python_executor 简化实现
  - 11 个模型/向量依赖工具诚实降级
- 渲染层 SSE 事件协议、工具显示名映射反混淆对齐

### 重建版适配（[重建版适配] 标记 diff）
- 端口迁移：后端 18099→28099、LLM 代理 18081→28081、渲染层静态服务 13099→23099（env 可覆盖）
- userData 隔离：%APPDATA%/KnowlyRecon，可与原版并存
- bundle 硬编码回退基址同长度补丁（18099→28099）
- **遥测门（默认关闭）**：统计上报/配额同步/云端技能与模型同步不外呼；`KNOWLY_ENABLE_TELEMETRY=1` 可恢复原版行为
- 数据持久区：后端数据迁移至 `%APPDATA%/KnowlyRecon/backend-data`，程序目录更新不丢数据（旧 vector_store/data 自动迁移）

### 验证
- 29/29 测试（路由集成 + 工具原契约）
- 端到端 PASS：窗口渲染、IPC、渲染层→后端 REST/SSE、CDP 取证（analysis/tools/cdp-verify.js）
- 与运行中原版在线对照：11 端点结构全部一致

### 安全与隐私
- 隐私审计完成（analysis/EVIDENCE-LEDGER.md §15）：重建版默认零云外呼，
  唯一对外流量 = 用户自定义配置的 OpenAI 兼容端点（经本地代理 127.0.0.1:28081）

## 发布流程

```powershell
# 1) 修改代码后，按 semver 递增 recon 位（或升级上游基线时提升主版本）
node scripts/release.cjs patch    # 3.13.2-recon.1 -> 3.13.2-recon.2
node scripts/release.cjs minor    # 3.13.2-recon.1 -> 3.13.3-recon.1（跟随上游小版本）
node scripts/release.cjs --set 3.14.0-recon.1   # 指定版本（上游基线升级时）

# 2) 脚本会：更新 package.json → 在 CHANGELOG.md 顶部插入新版本模板 → git commit → git tag v<版本>
# 3) 手动把变更内容补进 CHANGELOG 对应小节后，amend 该提交
```

数据安全承诺：用户数据只存于两处版本无关位置——
`%APPDATA%/KnowlyRecon/`（electron-store + backend-data）与项目外持久区；
更新/替换程序目录不影响数据（旧项目内 vector_store/data 会在新版首次启动时自动迁入）。
