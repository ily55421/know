# Knowly（findme）逆向重建 · 证据台账（REA 方法论）

> 目标：`E:\soft\Knowly`（安装目录）→ 还原产物：本目录 `E:\data\Knowly`
> 方法：`E:\code\ai\rea` 的 reverse-engineer-anything 技能（ASAR 路线 + 分阶段工作流 + 证据分级）
> 分析日期：2026-10-11。本文件区分 **观察（O）/ 推断（I）/ 未知（U）**，并给出每条结论的证据出处。

---

## 1. 目标身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| 应用内部名 | `findme` v3.13.2 | O：asar 内 `package.json`（`"name":"findme"`，描述"最懂你的AI知识助手"） |
| 产品名 | Knowly（曾用名 找我呀 / FindMe） | O：exe 产品名 `Knowly`；`device-id.js` 历史配置目录扫描列表 |
| Electron | 36.7.3（Chrome 136.0.7103.177） | O：`Knowly.exe` 内嵌版本字符串 |
| 架成 | Electron 壳（主进程 21 模块 + 渲染层 webpack bundle）+ PyInstaller Python 工具服务（findme.exe，Python 3.13） | O：asar 结构 + `resources/python-server/` |
| 更新源 | `https://findme-app.oss-cn-beijing.aliyuncs.com/resource/win/x64`（阿里云 OSS generic） | O：`resources/app-update.yml` |

## 2. ASAR 提取（O）

- 工具：自写提取器 `analysis/tools/extract-all.js`（头部 JSON 手工解析，数据区基址 `8 + headerSize`）。
- 结果：**18,768 文件 / 2,380 目录 / 51 个 unpacked 文件**，152,283,412 字节。
- 交叉验证：文件数与先前会话（`E:\soft\Knowly\res\ANALYSIS.md` §4）记录的 18,768 完全一致。
- 提取产物：`analysis/extracted/`；清单：`analysis/asar-inventory.txt`；头部：`analysis/asar-header.json`。
- 备注：`@electron/asar` 库的 `statFile/extractFile` 在本归档上对深层路径异常（库内部问题），故使用自写提取器；`listPackage/getRawHeader` 结果与手工解析一致。

## 3. 主进程（O——asar 内即完整未压缩源码，含中文注释）

`electron/main.js`（47 行入口）+ `electron/src/*.js` 21 个模块，共 4,821 行；`electron/README.md` 记录了从 1,051 行 main.js 拆分的历史。**该层是原厂真实源码，按原样复制即还原。**

关键契约（均为主进程源码直接观察）：

| 契约 | 值 | 出处 |
| --- | --- | --- |
| 后端地址 | `http://localhost:18099`（`API_BASE_URL`） | `src/config.js:23` |
| 就绪握手 | 子进程 stdout/stderr 累计包含 `Uvicorn running on`，60s 超时 | `src/python-server.js:216` |
| 生产后端 | `resources/python-server/findme.exe`（PyInstaller） | `src/python-server.js:57` |
| 开发后端 | `python python/api.py`（cwd=appPath） | `src/python-server.js:68` |
| API 代理 | 主进程 Express 5 监听 `127.0.0.1:18081`，OpenAI 兼容：`/api/openai/chat/completions`（stream=true 返回 `stream_id`）、`/api/stream/read`、`/api/stream/cancel`、`/api/openai/embeddings` | `src/api-proxy-handler.js` |
| 通知轮询 | 15s 间隔 GET `/scheduler/notifications?limit=10`、`/remote-control/notifications?limit=10`；退出前 GET `/scheduler/enabled-count` | `src/app-lifecycle.js` |
| 设备 ID | 文件 `<数据根>/data/device_id`；开发模式数据根 = `<appPath>/vector_store`；Windows 打包 = `%PUBLIC%/FindMe` | `src/device-id.js` |
| 渲染层加载 | 打包：`electron/dist/index.html`；开发：`http://localhost:13099`（webpack devServer，失败异步 reject，catch 不生效→白屏，故重建版提供 `scripts/dev-web.js`） | `src/window-manager.js:236` |
| 本地图片协议 | `findme-local://`（privileged，base64url 路径） | `src/local-image-protocol.js`、`main.js:5` |
| IPC 面 | preload 暴露 `electronAPI` 约 50 个方法；ipcMain.handle 40+ 通道（文件/剪贴板/更新/诊断/导出/壁纸等） | `preload.js`、`src/ipc-handlers.js` |
| 云服务 | EMAS（spaceId mp-f71314a3-…）统计与配额同步；商店版不走 OSS 自更新 | `src/config.js`、`src/app-lifecycle.js` |

## 4. SSE 流协议（O——渲染层 bundle.js 解析器反混淆）

`POST /qa/chat/stream`：请求体 `{query, history[{role,content,timestamp,selected_files}], folders, custom_prompt, agent_name, selected_files, enable_web_search, enable_thinking, llm_model?}`，`Accept: text/event-stream`，fetch+ReadableStream 逐行解析 `data: {JSON}`。

普通对话事件（bundle.js @~6,166,000 附近 switch）：

| type | data 形态 | 语义 |
| --- | --- | --- |
| `metadata` | object | 流式元数据 |
| `sources` | array | 引用来源 |
| `thinking_content` | string（直接拼接） | 思考增量 |
| `content` | string（直接拼接） | 回答增量 |
| `complete` | `{answer, ...}` | 终态，`data.answer` 为全文 |
| `quota_exceeded` | string | 额度用尽 |
| `error` | string | 错误 |

任务模式事件（`/qa/task/stream`、`/qa/task/executions/{id}/stream`）：`execution_start`/`execution_status`（data 含 `execution_id`,`status`）、`round_start`、`reasoning_start/chunk/complete`（data 含 `round`,`chunk`,`has_content`）、`preparing_tools`（data 含 `round`）、`calling_tool`（data 含 `tool_name`,`call_id`,`round`,`arguments`）、`tool_output_chunk`（data 含 `call_id`,`chunk`）、`tool_result`/`tool_error`、`thinking_result`、`answer_start`/`answer_chunk`(string)/`answer_commit`、`complete`、`max_iterations`、`cancelled`、`cancelling`、`user_input_timeout`、`quota_exceeded`、`error`；特殊工具 `ask_user`（触发 `waitingUserInput`）。

**I**：以上字段语义为对解析器代码的直读，个别字段（如 `agent_result_complete.documents`）未在运行时验证。

## 5. 后端路由面（O——findme.exe 字节码常量扫描 + 渲染层字面量）

- 工具：`analysis/tools/scan-pyz-routes.py`（22,679 个 zlib 流，18,543 个成功解压，对 marshal 常量做原始路径正则）。
- 结果：456 个去重路径字面量 → `analysis/pyz-routes.txt`（尾部小写字母为 marshal 类型标记噪声）。
- 应用路由（与渲染层字面量交叉印证）：`/qa/chat/stream`、`/qa/task/stream`、`/qa/task/user-input(/cancel)`、`/qa/task/executions[/{id}(/stream|/user-input|/cancel)]`、`/qa/generate-title`、`/qa/diagram/regenerate`、`/chat/sessions[/{id}(/messages|/favorite)]`、`/chat/migrate-from-localstorage`、`/tasks[/{id}(/enabled|/run-now|/runs|/cancel)]`、`/scheduler/*`、`/remote-control/*`、`/config`、`/cache(/status|/enable|/disable)`、`/directories(/add|/remove)`、`/files/*`、`/upload/{initialize,part,complete}`、`/export/{xmind,cancel}`、`/api/models/current`、`/api/llm/software-default-models`、`/api/ollama/*`、`/api/offline-pack/*`、`/api/directory-stats/{start,progress/{id},cancel/{id}}`、`/api/toolbox/*`、`/api/tools/skills(/cloud/install-batch)`、`/agents/custom[/{id}]`、`/api/system/{hardware,score}`。
- **U**：各端点请求/响应体的完整 schema 无法从字节码穷尽（每模块需逐函数反汇编）。

## 6. 在线对照（O——原版应用运行中，只读探测 127.0.0.1:18099）

对**正在运行的原版服务**做只读 GET 探测，将响应形态作为最高等级证据，并以此修正重建版：

| 端点 | 原版形态（观察） | 重建版 | 结构比对 |
| --- | --- | --- | --- |
| `/health` | `{status:"ok"}` | 同 | MATCH |
| `/scheduler/enabled-count` | `{success,data:{count}}` | 同 | MATCH |
| `/cache/status` | `{success,enabled,cache_info:{enabled,total_cached,max_size,last_global_activity,time_since_last_activity,cached_folders}}` | 同（值不同属状态差异） | MATCH |
| `/directories` | `{success,directories:{}}`（map） | 同 | MATCH |
| `/api/models/current` | `{success,data:{source_type,llm:{provider,model,api_base},embedding:{...},vision:{...}}}` | 同 | MATCH |
| `/api/llm/software-default-models` | `{success,data:{defaultModelId:"deepseek-flash",source,version,syncedAt,models:[{id,billingMultiplier,outputBillingMultiplier,tier,supportsWebSearch}]}}` | 同（目录内嵌 data-seed 快照） | MATCH |
| `/api/system/hardware` | `{success,data:{cpu:{cores,frequency,model},memory:{total_gb,available_gb},gpu:{available,name,memory_gb},platform}}` | 同 | MATCH |
| `/api/tools/skills` | `{success,data:[{name,display_name,description,version,author,category,...}]}`（3 个内建技能） | 同（快照内嵌） | MATCH |
| `/agents/custom` | `{success,data:[]}` | 同 | MATCH |
| `/scheduler/tasks` | `{success,data:[]}` | 同 | MATCH |
| `/chat/sessions` | `{success,data:[{id,title,selectedFolders,currentAgentId,source,taskId,isFavorite,createdAt,updatedAt,messages}],pagination:{page,page_size,total,total_pages}}` | 同 | MATCH |
| `/tools`（GET 根路径） | 404 Not Found | 重建版额外提供（用于工具直调与测试，不影响原版客户端） | 额外 |
| `/qa/task/executions`（GET） | 405 Method Not Allowed | 重建版提供 GET（补充能力） | 额外 |

快照存档：`server/data-seed/builtin-skills.json`、`server/data-seed/software-default-models.json`（技能：find_duplicate_outdated / pptx_generator / skill_creator；模型：deepseek-flash（默认）、qwen3.8-max、qwen3.7-plus、qwen3.8-flash）。

## 7. 工具层（O——先前会话反汇编结论 + 移植实现）

16 个工具的显示名映射来自渲染层 bundle.js（两处偏移的字面量表）；`file_reader`、`excel_inspector` 的完整 schema 与行为在先前会话经 Python 3.13 字节码反汇编逐字还原（`E:\soft\Knowly\res\ANALYSIS.md` §2/§3），其 Node 复刻实现整体移植至 `server/tools/`、`server/core/`（含 pdfjs/jszip/exceljs 加载器与游标协议 `v2:{version}:{offset}:{p|r}:{ranges}`）。

重建版工具实现分级：

| 级别 | 工具 | 说明 |
| --- | --- | --- |
| 完整实现（移植） | `file_reader`、`excel_inspector` | 通过 22 项原契约单测 + e2e |
| 简化实现 | `shell_executor`、`file_searcher`、`python_executor` | 行为对齐描述，未逐字还原原版 schema |
| 诚实降级 | `rag_file_reader`、`rag_search`、`rag_retriever`、`file_converter`、`image_converter`、`image_generator`、`file_locator`、`env_manager`、`run_subagent`、`compact_context`、`ask_user` | 返回统一信封错误，说明依赖原版 Python 服务能力 |
| **U** | 以上降级工具的原版入参 schema | 仅从显示名与常识推断，未从字节码还原 |

## 8. 渲染层（O + U）

- `electron/dist/`：108 个文件（bundle.js 7.1MB + 27 个分包 + 字体/图片 + index.html），React + antd + echarts + mermaid + mind-elixir 技术栈（依据 package.json 依赖与 bundle 内容）。**O**：按原样作为构建产物交付。
- **U**：前端源码未还原（minified bundle 反编译超出本次范围）。重建版通过 `scripts/dev-web.js` 以静态服务满足开发模式窗口加载契约。

## 9. 依赖清单（O）

asar 内置 node_modules 共 **513 个包**，逐包读取 package.json 得到精确版本 → `analysis/bundled-node-modules.tsv`。应用 manifest 22 个直接依赖全部命中（如 electron-log 5.4.1、electron-store 8.2.0、express 5.1.0、openai 6.7.0、antd 6.4.4）。重建版 package.json 保留原 manifest 原文，并补充：electron 36.7.3（devDep）、工具层解析库（fast-xml-parser/iconv-lite/jszip@^3.10.1——与原版 asar 内打包版本一致/pdfjs-dist/xlsx/exceljs）、样例生成 devDeps（pdfkit/pptxgenjs）。

## 10. 验证记录（O）

1. `npm test`：**29/29 通过**（路由集成 12 项 + 移植的工具级/导航器 17 项，样例自动生成）。
2. 后端独立启动：stdout 依序输出 uvicorn 风格四行，就绪行 `INFO: Uvicorn running on http://127.0.0.1:<port>`——主进程握手标记检测 PASS。
3. `python/python/api.py` 垫片 → node 后端链路：握手标记 PASS。补充观察：**Node 的 `child_process.spawn('python')` 在本机解析到 scoop 的 python.exe（CreateProcess 追加 .exe，绕过损坏的 pyenv .bat shim）**，因此 `npm start` 的自动拉起在本机可直接工作；pyenv shim 问题只影响 bash/cmd 里的手动调用。
4. 在线结构比对：11 个共享端点全部 MATCH（§6）。
5. **Electron 全栈端到端验证 PASS**（§13），白屏根因已定位并修复。

## 12. 重建版适配改动清单（标记式 diff，[重建版适配] 注释）

为完成与运行中原版并存的全栈验证，重建版对复制层做了以下最小改动（全部可经 env 覆盖/关闭）：

| 文件 | 原版 | 重建版 | 说明 |
| --- | --- | --- | --- |
| `electron/src/config.js` | `API_BASE_URL='http://localhost:18099'` | `KNOWLY_BACKEND_PORT` env，默认 **28099** | 后端地址单点 |
| `electron/src/api-proxy-handler.js` | `API_PROXY_PORT=18081` | env，默认 **28081** | LLM 代理 |
| `electron/src/network-diagnostics.js` | `API_PORT=18099` | env，默认 **28099** | 网络诊断目标 |
| `electron/src/window-manager.js` | dev `localhost:13099` | env，默认 **23099** | 开发模式窗口加载 |
| `electron/main.js` | userData=%APPDATA%/Knowly | **%APPDATA%/KnowlyRecon**（或 `KNOWLY_USER_DATA`） | 单实例锁与 electron-store 隔离，可与原版并存；历史 deviceId 迁移行为保留（device-id.js 显式扫描原版目录） |
| `electron/dist/bundle.js` | 渲染层硬编码回退基址 `http://localhost:18099` | 同长度补丁替换为 **28099** | 字节数不变（22 字节），防止 UI 在后端未就绪时串连原版后端 |
| `server/index.js` / `server/llm.js` / `scripts/dev-web.js` | — | 默认端口同步迁移，env 对齐 | 后端/代理/静态服务 |

端口方案：后端 18099→**28099**、LLM 代理 18081→**28081**、渲染层静态服务 13099→**23099**（`KNOWLY_BACKEND_PORT` / `KNOWLY_PROXY_PORT` / `KNOWLY_WEB_PORT` 可覆盖）。原版进程（18099/18081）全程未受影响。

## 13. 端到端验证记录（O，2026-10-11）

环境：原版 Knowly 正在运行（18099/18081 被占用）；重建版以新端口全栈启动。

启动链路（electron 日志，/tmp/e2e-electron.log）：

```
API 代理服务器已启动: http://127.0.0.1:28081
INFO:     Uvicorn running on http://127.0.0.1:28099
Python服务器已启动: http://localhost:28099
从开发服务器加载应用
```

CDP（--remote-debugging-port）取证（analysis/tools/cdp-verify.js）：

| 检查项 | 结果 |
| --- | --- |
| 页面目标 | `Knowly - 最懂你的AI知识助手 | http://localhost:23099/#/chat` |
| document.readyState / #root children | complete / 1（React 树已渲染） |
| window.electronAPI（preload 桥） | object；`getAppVersion()` 经 IPC 返回 `3.13.2` |
| 页面上下文 fetch 28099 /health、/chat/sessions | ok / success |
| UI 文本 | 侧栏（新建会话/skill技能/百宝箱/知识库）、问答/任务模式切换、deepseek-flash 模型选择器全部渲染 |
| 渲染层主动调用的后端端点 | /scheduler/notifications、/remote-control/notifications、/api/llm/software-default-models(/sync)、/api/models/current、/config、/chat/sessions(GET+POST)、/agents/custom、/device-transfer/status、/check-membership、/api/tools/skills/cloud/install-batch、/directories，15s 轮询节拍与原版一致 |
| 页面上下文 POST /qa/chat/stream | 200 + `text/event-stream`，发出协议内 `error` 事件（未配置模型的诚实提示）——SSE 通路与渲染层解析器对接成功 |

**白屏问题的定位与修复（观察→推断→验证闭环）**：

1. 现象：窗口加载完成、IPC/后端均通，但 `#root` 为空。
2. CDP 异常捕获（analysis/tools/cdp-errors.js）：`TypeError: s.map is not a function`（×4），栈指向 bundle.js 中 Agent 管理组件。
3. 反混淆该组件：`s` 为自定义 Agent 列表，渲染层直接对 `data` 做 `.map`——即原版 `GET /agents/custom` 返回 `{success, data:[]}`（数组直出），重建版误包装为 `data:{agents:[]}`。
4. 修复并补齐启动期端点：`/agents/custom`（data 数组直出）、`/check-membership`（`{success,expired:false}`，原版在线观测）、`/device-transfer/status`（`{success,sync_directive:{mode:'NORMAL',...}}`，原版在线观测）、`POST /api/llm/software-default-models/sync`（返回模型目录）。
5. 修复后：异常捕获 0 条、`#root children: 1`、UI 完整渲染，验收 PASS。
6. 回归防护：`tests/server.test.js` 新增"启动门端点形态"用例（agents 数组断言等）。

## 14. 升级参考基线

本目录的 `analysis/` 同时是原版 **v3.13.2 的完整取证快照**，可用于后续版本的更新审查/升级比对：

- `analysis/asar-inventory.txt`（21,147 条清单）、`analysis/asar-header.json`（完整头部）、`analysis/extracted/`（全量文件）——与新版解包后做文件级 diff；
- `analysis/bundled-node-modules.tsv`（513 包精确版本）——依赖变更审计；
- `analysis/pyz-routes.txt`（456 条后端路由字面量）——API 面变更审计；
- `analysis/tools/`（asar 提取器、PYZ 路由扫描器、端点提取器、CDP 验收脚本）——对新版安装目录重跑即可产出同口径基线，与本目录结果对比得出增量。

## 15. 数据外发（隐私）审计（O，2026-10-11）

### 15.1 原版（打包运行时）的全部对外行为

逐文件审计主进程源码与渲染层 bundle（证据：`cloud-services.js`、`llm-models-sync.js`、`default-skills-sync.js`、`auto-updater.js`、bundle RUM 初始化片段 @~7,072,941）：

| # | 行为 | 目标 | 载荷 | 触发时机 |
| --- | --- | --- | --- | --- |
| 1 | 统计上报 | `fc-mp-…bspapp.com/emas-statistics` | `{userId:设备ID, appVersion, osType, osVersion, timestamp, eventType}` | 启动 + 每小时检查跨天 |
| 2 | 配额同步 | 云函数 `emas-membership` @ `api.next.bspapp.com` | 设备ID + 配额快照 | 启动 + 每小时（**dev 守卫被原厂注释**） |
| 3 | 云端技能同步 | 云函数 `emas-skills` | 无设备信息（拉取） | 启动+5s，**无 dev 守卫** |
| 4 | 云端模型目录同步 | 云函数 `emas-agents` | 无设备信息（拉取） | 启动+5s，**无 dev 守卫** |
| 5 | 公告拉取 | `emas-statistics` | appVersion/osType | 启动（有 dev 守卫） |
| 6 | **阿里云 RUM 前端监控** | `ciykalys4u-default-cn.rum.aliyuncs.com` | **API 调用记录（含本地请求 URL/状态）、console 错误、用户行为、userId(设备ID)** | 页面加载（`isDevMode` 守卫跳过） |
| 7 | 自动更新检查 | `findme-app.oss-cn-beijing.aliyuncs.com` | 标准更新检查 | 打包环境（`isPackaged` 守卫） |
| 8 | 用户主动 | 反馈提交（含联系方式+内容）、邀请码验证、FAQ 外链 | 用户输入 | 用户操作 |

结论：**原版存在未经选择的常驻遥测（#1、#2、#6 最实质），"偷偷上传"的疑虑成立**；内容限于设备 ID/系统信息/使用行为/API 访问记录，未发现聊天内容上传的证据（聊天文本经本地代理直连模型厂商，RUM 的 api 采集只记 URL/状态码）。

### 15.2 重建版的外发状态（默认零云外呼）

| 行为 | 原版状态 | 重建版处置 | 机制 |
| --- | --- | --- | --- |
| 统计上报 | 打包时上传 | 不发生 | 原代码 dev 守卫（`!app.isPackaged → skip`） |
| 公告拉取 | 打包时拉取 | 不发生 | 原代码 dev 守卫 |
| RUM 前端监控 | 采集 API/错误/行为 | **不初始化** | 渲染层 `isDevMode` 守卫（`getIsDevMode=true → return`） |
| 自动更新 | 检查原厂 OSS | 不发生 | `isPackaged` 守卫（且更新源会用原版包覆盖重建版） |
| 云端技能/模型同步 | 启动外呼云函数 | **不发生** | `[重建版适配]` 遥测门（`app-lifecycle.js`，默认关，`KNOWLY_ENABLE_TELEMETRY=1` 开启） |
| 配额同步 | 每小时云函数 | 不发生 | 遥测门 + 后端不实现 `/quota-snapshot`（fail-safe 404） |
| LLM 调用 | 用户配置端点 | 同原版 | 仅连接用户自定义 `base_url`（经本地代理 127.0.0.1:28081） |

**运行时实证**：全栈运行中（electron×4 + node 后端 + python 垫片，6 进程）`netstat` 审计 **0 条非回环 ESTABLISHED 连接**。后端代码自身无任何外呼（`server/` 仅连接 127.0.0.1:28081 代理与用户配置端点）。

### 15.3 已修复的越界写入（观察→修复）

首个数据根实现误用 `app.getPath('userData')`——它在 `app.ready` 前返回 productName 推导的默认值（`Roaming/Knowly`），导致后端数据短暂写入**原版目录**（`Roaming/Knowly/backend-data`，仅本项目自身的 4 个 JSON，未触碰原版 `config.json`；已核实其内容为原版自身 deviceId 且值未变）。已改为镜像 `main.js` 的 `appData/KnowlyRecon` 表达式并清理误写副本。教训入档：userData 相关路径一律显式镜像，不依赖 ready 前的 `getPath('userData')`。

## 16. 自定义 API Key 全链路实测（O，2026-10-11）

链路：`POST /config`（api_key/base_url/model）→ 渲染层/REST 发起对话 → 后端 `llm.js` → 主进程代理 28081（OpenAI SDK）→ 用户端点。

以本地 Mock OpenAI 兼容服务（`analysis/tools/mock-llm.cjs`，:28100）为目标端点验证：

| 步骤 | 结果 |
| --- | --- |
| `POST /config` 写入自定义 Key | `{success:true}`，持久化至 KnowlyRecon/backend-data/config.json |
| `POST /api/test-llm` | Mock 回包原样返回 |
| `POST /qa/chat/stream` | 3 个 `content` 分片 + `sources` + `complete{answer}`（与渲染层解析器对齐） |
| `POST /qa/generate-title` | 返回标题 |
| **Key 传递** | Mock 收到 3 笔请求均为 `Authorization: Bearer test-key-123`（非流式+流式+工具总结轮） |

## 17. 数据持久区与版本安全（O）

| 数据 | 位置 | 版本更新是否丢失 |
| --- | --- | --- |
| 后端业务数据（会话/配置/任务/Agent/目录/技能） | `%APPDATA%/KnowlyRecon/backend-data/*.json` | 不丢失（与程序目录解耦） |
| electron-store（含 deviceId） | `%APPDATA%/KnowlyRecon/config.json` | 不丢失 |
| 设备 ID 副本 | 项目 `vector_store/data/device_id`（原版开发模式约定） | 丢失时自动从 electron-store 回填 |
| 渲染层 localStorage | `%APPDATA%/KnowlyRecon/Local Storage` | 不丢失 |
| 旧项目内 `vector_store/data/*.json` | 后端首次启动自动迁移到新持久区（不覆盖新数据） | 自动保全 |

重建版主进程实改一处（`config.js`）：向子进程注入 `KNOWLY_DATA_ROOT`，指向 `appData/KnowlyRecon/backend-data`；`server/store.js` 惰性解析同名 env 并内置旧数据自动迁移。


## 11. 残余未知清单（U 汇总）

1. 渲染层源码（仅交付构建产物）。
2. 原版多轮 ReAct 循环（`src/agent/react_loop`、`tool_provider`、`subagent_runner`、上下文压缩）的完整语义——重建版为单轮 + 单次工具调用简化循环。
3. RAG/向量索引、OCR、工具箱（图像修复/去隐私）、手机远程控制、离线模型包、Ollama 集成——统一诚实降级。
4. 各端点请求体完整 schema（高频端点与启动门端点已通过在线观测还原；其余仍未知）。
5. 定时任务的真实调度器行为（重建版仅持久化与记录 run-now 请求）。
