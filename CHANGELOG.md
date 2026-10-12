# Changelog（重建版）

## [3.13.2-recon.17] — 2026-10-12

### 修复：模型调用莫名失败（上游连接抖动的自愈加固）

- 定性：主进程日志实锤为上游边界偶发 APIConnectionError（本机网关→模型厂商网络抖动），此前无自愈

- 主进程代理：共享 keepAlive Agent（连接复用）、SDK 重试 3 次、流读取 180s 空闲超时、流会话按活动时间清理

- 后端 LLM 层：统一退避重试（网络异常/5xx）；流式首块前失败可重试整个启动（重试前 cancel 旧会话）、
  已出内容失败保留输出不重试；错误消息归一化为指引性文案（不再莫名失败）

### 验证
- 简单请求 6/6 ✓；长历史 ✓；复杂问题长思考（29.4s/2434 字）✓；深度推理 ✓；三路并发 ✓ —— 0 失败
- 40/40 测试


## [3.13.2-recon.16] — 2026-10-12

### 新功能：本地资料学习支持拖拽 + 知识库全链路可用

- 拖拽注入：本地资料学习/知识库页拖入文件或文件夹 → 自动添加目录并开始学习（温和刷新，不打断会话）
- 知识库引擎：复用既有文档解析器（txt/md/docx/pptx/pdf/xlsx 等）建立本地索引；进度文案与渲染层正则严格对齐
- 检索：关键词全文匹配 + <mark> 高亮片段 + confidence 评分（接口形态对齐渲染层；原版为向量语义检索，重建版先关键词版）
- 补齐 14 个知识库端点中的 11 个（index/progress/cancel/clean/monitoring/search/file-text/check-db/monitoring-status/dedup/get-total-files）

### 修复的 8 层问题（详见台账 §30）

- /directories/add 参数名（folder）、/directories/remove 方法（DELETE）、/directories 响应形态
- GET /config 顶层 runtime 缺失（导致「读取运行参数失败」toast + 知识库页初始化中断）
- 云端会员同步中断知识库页启动序列 → 主进程本地模拟成功（不外呼）
- isPythonServerRunning() 永远 false（子进程未登记）→ python-ready 从未发送 → 目录列表永不加载
- 补齐 /check-db、/monitoring-status；python-ready 每 5s 重发（修复后进页面错过事件）

### 验证
- CDP 真机：拖拽添加+自动学习 ✓ 目录列表「已学习」✓ 搜索「风险」共 50 条命中/匹配度 90% ✓
- 40/40 测试


## [3.13.2-recon.15] — 2026-10-12

### 修复：任务模式发送即失败（emit is not a function）
- 现象：任务模式下发消息，AI 未执行即显示「任务已停止 / AI执行了0次」，并有「大模型调用出现问题」toast
- 根因：recon.11 重构任务执行器时，后台模式（POST /qa/task/executions，渲染层主链路）以 emit=null 调用，
  而 track() 内仍是裸调用 `emit(type, data)` → 首条 execution_start 即抛 TypeError → 任务立即失败 →
  渲染层累积不到 answer_chunk，按 bundle 逻辑把空回复保存为「任务已停止」
- 修复：track() 空值保护（与 sseEmit 一致）

### 验证（CDP 真机复现，脚本 analysis/tools/repro-task-send.mjs）
- 修复前：聊天区「任务已停止 / emit is not a function」+ 错误 toast
- 修复后：POST /chat/sessions/{id}/messages → POST /qa/task/executions → GET …/stream 全 200，
  聊天区「任务已完成 / AI执行了1次，调用工具0次 / 收到」，0 toast、0 控制台异常
- 39/39 测试

## [3.13.2-recon.14] — 2026-10-12

### 修复：模型调用错误（正则误删路由事故 + 配置未迁移）
- **事故**：此前用非贪婪正则删除临时调试端点时，误把 /health 与全部 6 组路由注册一并删除，
  server/index.js 只剩裸 express → 后端对所有请求返回 404 HTML → 表现为「调用模型错误」
- **修复**：server/index.js 完整重建（路由/CORS/日志/404 兜底/就绪行）；改代码的纪律更新为
  精确锚点编辑 + 全量接口冒烟（教训入档 §28）
- **模型配置未随数据根迁移**：便携根只有会话、config 未搬 → 已迁入并增强 main.js 迁移逻辑
  （config 逐键补齐、apps 目录复制）

### 验证
- /health ✓ /config 含 api_key+base_url+model+runtime ✓ /qa/chat/stream 经 18888 网关真实回答 ✓
- 39/39 测试


## [3.13.2-recon.13] — 2026-10-12

### 修复：左侧历史对话点击后气泡空白（连环 6 层根因）
1. **消息保存契约**：渲染层 POST /chat/sessions/{id}/messages 的 body 实为 `{messages:[数组]}`
   （一次提交本轮 user+assistant），旧实现按单条解析 → 历史全是空 user 消息、assistant 从未入库。
   已支持数组契约（兼容旧单条）；存量空消息一次性修复（首条以会话标题回填、去重复空条）
2. **数据根分裂**：开发版 `%APPDATA%/KnowlyRecon/backend-data` 与便携版 exe 旁 `data/backend` 错位
3. **config.js 抢先执行（核心）**：main.js 顶部 require local-image-protocol 时会提前加载 config.js，
   在便携化 setPath 之前用默认 userData 写死 KNOWLY_DATA_ROOT；已把该 require 延后到便携化块之后
4. **isPackaged 判据失效**：重命名 electron.exe 的 isPackaged 不可靠；改用"exe 是否在 node_modules 内"
5. **utilityProcess 环境传递**：env 不可靠且严禁 ELECTRON_RUN_AS_NODE（子进程 code=9 退出）；
   数据根改由命令行参数 `--data-root` 传递，fork 前清理占用 28099 的陈旧后端
6. **陈旧进程干扰**：开发模式 electron.exe 及其 node 后端长期占用 28099，导致请求打到旧后端；
   清理策略改为按命令行匹配 electron/node/python

### 打包形态调整
- electron-builder 单文件 portable 因本机杀毒锁目录重命名（EPERM，3 次重试失败）无法重建 →
  采用**文件夹版绿色安装**（项目根 Knowly.exe + resources/app.asar：双击独立启动、数据落项目 data/）
- 桌面快捷方式「Knowly (Recon)」已重指到 Knowly.exe；旧单文件 exe 改名 .old-broken
- .gitignore 补齐 Electron 运行时与构建目录（resources/、locales/、release*/、*.dll 等）

### 验证（真机）
- /debug-env：dataRoot = `E:\data\Knowly\data\backend` ✓
- GET /config：`runtime.max_documents_per_chat = 8` ✓（启动 toast 清零）
- CDP 点击历史项：气泡渲染"（历史会话）你好，简单介绍一下你自己" ✓
- 39/39 测试

## [3.13.2-recon.12] — 2026-10-11

### 新功能：免安装便携 exe + 桌面快捷方式
- 产物：release/Knowly-Portable-<version>.exe（约 126MB，单文件免安装）；项目根 Knowly-Portable.exe 为使用副本；
  桌面快捷方式「Knowly (Recon).lnk」→ 项目根 exe（携带应用图标）
- **数据根随 exe 所在目录**：data/user-data（Electron 存储）+ data/backend（会话/配置/应用等）
  + data/data（设备 ID）；放入项目根即为「数据保存在当前项目目录」；首次运行自动从
  %APPDATA%/KnowlyRecon/backend 迁移历史数据
- 包内适配（标记 diff）：打包版无 findme.exe 时改用**进程内 Node 后端**（主进程直接起 express，
  轮询 /health 就绪，与原版启动握手同构）；绝无 taskkill findme.exe；自动更新器归入遥测门；
  进程内模式端口占用不再连带退出应用

### 验证
- 独立启动 Knowly-Portable.exe：进程内后端 28099 健康 200、代理 28081、数据目录按预期生成，
  用户模型配置经迁移完整保留、示例应用在位、原版应用进程不受影响
- 39/39 测试

### 验证
- npm test 通过


## [3.13.2-recon.11] — 2026-10-11

### 界面：隐藏会员购买入口
- index.html 内联样式隐藏两处购买入口（不改 bundle）：套餐卡购买按钮 ×4、额度卡充值按钮 ×1
- 保留展示：旗舰版（重建版）· 永久有效 · 不限量 · 已拥有标识，三档套餐卡作为能力清单
- 验证：CDP 确认购买按钮 0 可见、状态展示完整、0 失败请求 0 异常

### 验证
- npm test 通过


## [3.13.2-recon.10] — 2026-10-11

### 修复：会员中心白屏 + 最高档位会员状态
- 白屏根因：用量卡 Ee(v.max_total_files) 无空值保护，userStatus 缺会员字段 → React 树整体卸载；
  bundle 的 Ee 助手已打空值保护补丁（null→'—'）
- 会员状态（本地重建版自有状态，模型费用由用户自有网关承担，不涉及原厂云端）：
  **旗舰版（重建版）· 永久有效 · 全能力解锁**——文件/文本/多模态/媒体上限拉满，
  智能问答额度不限量（is_unlimited），supports_multimodal=true（运行参数面板的视觉能力区随解锁）
- 补齐端点：GET /user-status（完整会员字段）、GET /llm-quota、GET /membership-plans（三档，旗舰为当前）、
  GET /get-total-files、POST /verify-offline-activation
- 验证：会员中心 4 端点全 200、页面完整渲染（root 88,799 字符）、0 控制台异常；39/39 测试

### 验证
- npm test 通过


## [3.13.2-recon.9] — 2026-10-11

### 修复：启动报「读取运行参数失败：缺少 max_documents_per_chat」
- 渲染层启动从 GET /config 校验 runtime.max_documents_per_chat（1..15）等字段；
  重建版 /config 未内嵌 runtime 对象 → 每次启动必报错
- GET /config 现返回完整 runtime 默认值（max_iterations=20 / max_documents_per_chat=8 /
  chat_confidence_threshold=55 / file_search_confidence_threshold=30 / OCR 两开关）
- POST /config 支持参数面板的扁平保存体（自动归位到 runtime，非法值钳制）
- 新增 GET /user-status（多面板消费 userStatus 字段）
- 修复离线模型包面板的 options 形态（需 data.bundles 分组）

### 验证方法补强
- UI 扫描器新增**界面 toast 捕获**（此前只抓网络层错误，200 响应内的字段校验失败不可见）：
  现按 error/warning 分类逐页收集
- 全页复扫：0 失败请求、0 界面错误 toast、0 控制台异常；39/39 测试

### 验证
- npm test 通过


## [3.13.2-recon.8] — 2026-10-11

### 修复：对话回答展示思考链
- reasoning 增量始终透传渲染层（问答 thinking_content / 任务 reasoning_chunk，UI 折叠展示）；
  此前仅 enable_thinking 为真时透传，渲染层未开启即被吞
- 请求默认携带 enable_thinking:true（经本地代理到模型网关），部分模型据此返回思考增量
- 真机验证：回答区出现「深度思考」折叠块，0 失败请求

### 修复：应用管理（更多 → 业务应用管理）
- 补齐整组端点：GET/DELETE/PUT /apps、POST /apps/import、POST /apps/open、GET/PUT /apps/content
- 导入 HTML 文件或整个文件夹（复制到持久区，入口自动识别 index.html）
- 「打开」经系统默认浏览器打开入口 HTML

### 新增：预置示例应用
- 首次启动自动导入 3 个自包含示例：计算器、时钟、待办清单
- seeded 标记保证删除后不复活；38/38 测试（新增 apps CRUD 全链路用例）

### 验证
- npm test 通过


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
