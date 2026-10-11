# Changelog（重建版）

## [3.13.2-recon.7] — 2026-10-11

### 新功能：对话窗口拖拽附件（原版无此能力）
- 原版渲染层仅在百宝箱图像工具页有 drop 处理，聊天输入框不支持拖拽；本版在不修改 bundle.js 的
  前提下注入 knowly-drop-shim（index.html 引入）：
  - 拖文件进对话窗口 → 自动取本地路径 → 输入框上方渲染「指定文件」附件条（可单个移除）
  - 发送消息时自动把附件路径合并进请求体 selected_files（问答/任务两模式通吃，去重上限 20）
  - 百宝箱等页面自身的拖拽处理自动让位；拖拽过程有悬浮提示
- 后端消费 selected_files：文本附件按原版编码回退链读入模型上下文（单文件 20k/总量 50k 截断），
  图片提示可用 image_reader 工具，其余文件标注元信息

### 验证
- CDP 真机：附件条渲染 → 发送请求体捕获 selected_files=[真实路径] → 模型回答正确引用文件内容
  （口令 DROP-TEST-8888 命中）→ 发送后附件条自动清空
- 37/37 测试（新增 readFileAttachments 单测：utf8/gbk 编码、图片、缺失文件容错）

### 验证
- npm test 通过


## [3.13.2-recon.6] — 2026-10-11

### 修复：设置-LibreOffice 面板不显示已安装状态
- 根因：面板状态判定为 t.success && t.available（bundle 反混淆 @~7,021,804），
  /libreoffice-status 首版缺 success:true → 恒判定未安装
- /libreoffice-status 补 success:true + version_hint；新增 POST /libreoffice-help-install（引导式安装，
  已安装返回检测路径，未安装返回下载/KNOWLY_SOFFICE_PATH 引导）
- UI 真机验证：面板切换为「已安装」成功态；36/36 测试（含面板契约回归用例）

### 验证
- npm test 通过


## [3.13.2-recon.5] — 2026-10-11

### 修复：全量 UI 端到端测试发现的问题（CDP 逐页抓取，详见台账 §19）
- **任务模式对话 404**：渲染层链路为 POST /qa/task/executions 创建执行 → GET …/{id}/stream 订阅；
  后端缺创建端点。已实现完整生命周期（创建/订阅事件流/取消联动），UI 真实发送验证通过
- 补齐 7 个缺失端点：百宝箱工具清单、知识创作成就 overview/events/run-now、
  Ollama detect/可用模型、MCP 服务器清单、**GET /libreoffice-status**（skill 的 docx 导出前置校验）
- 修复知识创作成就页两处 React 崩溃（overview 数据缺 status.running / summary.today）

### 端到端终态
- 侧边栏 7 页 + 设置抽屉 13 页逐页点击：失败请求 0、控制台异常 0
- 问答模式真实对话（经用户自定义网关）：回答渲染、会话入库
- 任务模式真实发送：执行创建 → 事件流 → 会话入库
- 35/35 测试

### 验证
- npm test 通过


## [3.13.2-recon.4] — 2026-10-11

### 修复：三方大模型配置面板
- 渲染层「三方大模型配置」页调用的是 **GET/POST /api/config + POST /api/config/test**（带 /api 前缀），
  此前后端仅实现 /config 导致保存/测试 404（UI 报「配置保存失败」「连接测试失败」）。
- 从 bundle.js 反混淆还原面板契约并实现：
  - GET /api/config → {provider, custom:{has_api_key, api_key, api_key_preview, api_base, llm_model, use_custom_embedding, ...}}
  - POST /api/config → 双写持久化（面板回显字段 + llm.js 兼容字段 api_key/base_url/model）
  - POST /api/config/test → 用表单当前值经主进程代理实测对话（可选向量测试），返回 {success} 或 {success:false, message}
- GET /api/models/current：custom 配置后 source_type=custom（含 api_base）
- 验证：34/34 测试；真机全链路——保存 → 测试连接通过 → SSE 对话经用户本机网关(18888)返回真实回答

### 验证
- npm test 通过


## [3.13.2-recon.3] — 2026-10-11

### 上游能力对齐（按原版 CHANGELOG 截图清单）
- **file_converter 真实实现**：经本机 LibreOffice 无头转换（pdf/txt/html/rtf/docx/odt/xlsx/csv/ods/pptx/odp）；
  自动探测安装路径：env KNOWLY_SOFFICE_PATH → PATH → 注册表（HKLMSOFTWARELibreOfficeUNOInstallPath，
  值名可含空格）→ 标准路径；独立 UserInstallation 配置目录，不与已打开的 LibreOffice 冲突；
  本机实测：注册表命中 D:softLibreOffice（25.8），txt→pdf 转换成功（运行中应用 + 单测双验证）
- **新增 image_reader（图片阅读）**：本地图片交视觉模型解读（对齐上游 v3.14.0 image-reader；需配置支持视觉的模型）
- **新增 file_batch_rename（文件批量重命名）**：prefix/suffix/replace/sequence 四模式，dry_run 预览默认开，冲突防护（对齐 v3.12.4）
- **数据备份/恢复**：POST /api/backup/export·import，jszip 打包持久区 JSON，导入后自动刷新缓存（对齐 v3.12.6 全量备份迁移）
- GET /api/libreoffice/status：探测状态（路径/来源/版本提示）

### 验证
- 33/33 测试（新增：探测、真实转换、批量重命名、备份往返）
- 运行中应用真机验证：18 工具目录、探测命中注册表、txt→pdf 转换 14KB PDF 生成

### 验证
- npm test 通过


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
