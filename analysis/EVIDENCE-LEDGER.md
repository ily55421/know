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

## 18. 上游能力对齐（recon.3，O——按原版 CHANGELOG 截图清单落地）

| 来源 | 能力 | 重建实现 | 验证 |
| --- | --- | --- | --- |
| 用户需求 | file_converter 真实化（本机有 LibreOffice） | `server/core/libreoffice.js` 探测器：env `KNOWLY_SOFFICE_PATH` → PATH(where) → 注册表 `HKLM\SOFTWARE\LibreOffice\UNO\InstallPath`（值名可含空格，如 "LibreOffice 25.8"）→ 标准路径；转换用 `-env:UserInstallation` 独立配置目录，避免与已打开实例冲突；探测阶段**不运行** `soffice --version`（Windows 下会挂起） | 本机实测命中 `D:\soft\LibreOffice\program\soffice.exe`（source=registry，25.8）；txt→pdf 真实转换测试通过 |
| 上游 v3.14.0 | image-reader | `image_reader` 工具：本地图片 → base64 → 视觉模型（chat/completions 多模态消息，经本地代理） | 未配置模型时诚实报错；载荷结构符合 OpenAI 视觉协议 |
| 上游 v3.12.4 | 文件批量重命名 | `file_batch_rename`：prefix/suffix/replace/sequence，dry_run 默认开，冲突防护 | 单测覆盖预览/执行/序号 |
| 上游 v3.12.6 | 全量数据备份迁移 | `POST /api/backup/export|import`：jszip 打包持久区 JSON，导入后 `store.clearCache()` | 导出/导入/回滚往返单测通过 |
| — | 工具目录 | 原版 16 工具 + 上游对齐新增 2（image_reader/file_batch_rename）= 18 | `GET /tools` 断言 |

上游暂不落地项（依赖原厂模型/云服务）：关键词+语义混合检索、知识库术语、动态上下文压缩、图像去水印/打码、word 排版模板体系、OCR 并发、离线模型包。

## 19. 全量 UI 端到端测试与修复（O，2026-10-11，CDP Network 抓取）

方法：应用以 --remote-debugging-port 启动，CDP 挂真实界面（analysis/tools/ui-sweep.mjs / ui-sweep2.mjs），
逐页点击 + Network 域抓取全部状态码 ≥400 的请求与 Runtime 异常；含问答/任务两种模式的真实输入发送。

### 发现与修复清单

| # | 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 任务模式发送报「HTTP error! status: 404」 | 渲染层任务链路为 POST /qa/task/executions 创建执行 → GET …/{id}/stream 订阅；后端缺创建端点 | qa.js 实现 POST /qa/task/executions（立即返回 execution_id，后台执行）+ GET …/{id}/stream 事件重放与实时跟随 + cancel 联动 AbortController | UI 真实发送：SENT，0 失败；单测覆盖创建→订阅→终态 |
| 2 | 百宝箱页「工具列表加载失败」 | 缺 GET /api/toolbox/tools | 返回 {success,data:[],ocr:null}（优雅空态） | 页面点击 0 失败 |
| 3 | 知识创作成就页白屏崩溃（console: reading 'running'） | 缺 GET /knowledge-activity/overview，组件读 t.status.running 无可选链 | 实现 overview（summary/status/activityDays/folders/lastError 全字段）+ events + run-now | 崩溃消失，页面渲染 |
| 4 | 知识创作成就二次崩溃（reading 'today'） | overview 缺 summary.{today,last7Days,last30Days} | 补全字段（按 bundle fmt 组件字段面挖掘） | 同上 |
| 5 | 本地大模型配置页报「检测失败」 | 缺 GET /api/ollama/detect | 返回 {installed:false,running:false}（诚实降级） | 0 失败 |
| 6 | 离线模型包页报错 | 缺 GET /api/ollama/models/available | 返回空目录列表 | 0 失败 |
| 7 | MCP 工具页加载失败 | 缺 GET /api/tools/mcp/servers | 返回本地存储清单（默认空） | 0 失败 |
| 8 | LibreOffice 设置页报错；skill 的 docx 导出前置校验失败 | 缺 GET /libreoffice-status（渲染层路径无 /api 前缀） | 返回 {available:true, path, source}（探测命中本机 25.8） | 0 失败；导出前置校验通过 |

### 终态

- 侧边栏 7 页 + 设置抽屉 13 页逐页点击：**失败请求 0、控制台异常 0**
- 问答模式真实对话：回答渲染、会话入库
- 任务模式真实发送：执行创建 → 事件流 → 会话入库
- 回归：35/35 测试

## 20. LibreOffice 设置面板状态修复（O，2026-10-11）

- 现象：设置 → LibreOffice 面板恒显示「一键安装」，不显示已安装状态
- 根因：面板状态判定为 t.success && t.available 两个字段（bundle @~7,021,804），而
  /libreoffice-status 首版只返回 {available,...} 缺 success:true → 恒为 false
- 修复：/libreoffice-status 增加 success:true（保留 available/path/source/version_hint）；
  补实现 POST /libreoffice-help-install（原版亦为引导式安装：成功后 info toast + 刷新状态；
  已安装时返回检测路径，未安装时返回下载与 KNOWLY_SOFFICE_PATH 引导）
- 验证：UI 真机读取面板文本为「已安装」成功态（一键安装按钮消失）；36/36 测试含契约回归用例

## 21. 对话窗口拖拽附件（recon.7，原版无此能力）

- 事实核对：原版渲染层的 drop 处理仅存在于百宝箱图像工具页（getPathForFile 的唯一包装
  mwt() 只被 image-redact/image-inpaint/photo-collage 消费）；聊天输入框原版不支持拖拽。
- 实现（不改 bundle.js）：index.html 注入 electron/dist/knowly-drop-shim.js ——
  1) 文档级 dragover/drop：拖入文件经 electronAPI.getPathForFile 取路径，渲染「指定文件」附件条
    （可单个移除）；百宝箱等自带处理的页面 preventDefault 后自动让位；无聊天输入框的页面不接管
  2) fetch 包装：/qa/chat/stream、/qa/task/executions、/qa/task/stream 发送时把附件路径
    合并进请求体 selected_files（与「附件」按钮产生的字符串数组同构，去重、上限 20）
- 后端：agent.js readFileAttachments 消费 selected_files —— 文本类按原版编码回退链读取入上下文
  （单文件 20k / 总量 50k 截断），图片提示可用 image_reader，其余标注元信息；问答与任务两链路接入
- 验证（CDP 真机）：合成 drop 事件链（悬浮提示出现）；附件路径注入 → 附件条渲染 →
  问答模式发送 → 请求体捕获 selected_files=[真实路径] → 模型回答正确引用文件内容（口令命中）
  → 发送后附件条自动清空；37/37 测试（新增 readFileAttachments 单测：utf8/gbk/图片/缺失容错）

## 22. 思考链展示 + 应用管理修复与示例（recon.8，O，2026-10-11）

### 思考链
- 现象：回答不显示思考过程。根因两处——agent 仅在 body.enable_thinking 为真时透传 reasoning
  （渲染层未开启即被吞）；且向网关的请求未带 enable_thinking 参数，部分模型不返回 reasoning 增量。
- 修复：reasoning 增量始终透传（问答 thinking_content / 任务 reasoning_chunk，UI 折叠展示）；
  chatStream/chatOnce 默认携带 enable_thinking:true（OpenAI 兼容端点会忽略未知字段）。
- 验证（真机问答模式）：回答区出现「深度思考」折叠块 + 正确答案（9.9 与 9.11 比较），0 失败请求。

### 应用管理
- 现象：更多 → 业务应用管理 页「加载应用失败」。
- 根因：缺整组端点。渲染层契约（bundle 反混淆）：GET /apps（列表项 id/name/entry/created_at）、
  POST /apps/import {source_path,name}、POST /apps/open {app_id}、DELETE /apps {app_id}、
  PUT /apps {app_id,name,entry}、PUT /apps/content {app_id,entry,html}（在线编辑保存）。
- 实现：server/routes/apps.js —— 文件/文件夹导入复制到持久区 backend-data/apps/<id>/，
  文件夹入口自动识别 index.html→首个 .html；open 经系统默认浏览器打开入口文件。
- 示例：预置 3 个自包含示例应用（计算器/时钟/待办清单），首次启动种子导入，
  seeded 标记保证用户删除后不复活。
- 验证：GET /apps 200（3 个示例）、UI 导航 0 失败请求；38/38 测试（新增 apps CRUD 全链路用例）。

## 23. 运行参数缺失修复 + 验证方法补强（recon.9，O，2026-10-11）

- 用户指出的盲区：此前的 UI 扫描只抓网络层（≥400）与控制台异常，
  而「读取运行参数失败：缺少 max_documents_per_chat」是 **200 响应内的字段校验失败**——网络层不可见。
- 扫描器补强：ui-sweep 每步后捕获界面 toast（.ant-message-notice，按 error/warning 分类）。
- 契约还原（bundle @~6,127,690 / @~6,867,052）：
  - GET /config 必须内嵌 runtime 对象：max_iterations(1..100)、max_documents_per_chat(1..15)、
    chat_confidence_threshold(1..100)、file_search_confidence_threshold(1..100)、
    enable_document_ocr(bool)、ocr_store_images(bool)；渲染层启动校验失败即 toast 报错
  - 参数面板保存为**扁平** POST /config body → 后端归位到 config.runtime（非法值钳制）
  - GET /user-status → {success, userStatus:{supports_multimodal, remote_channel_limit,...}}
  - GET /api/offline-pack/options 的 data 需要 {bundles:[{id,name,models}], models}
    （首版 {options:[]} 缺 bundles 导致面板抛「加载离线模型包选项失败」）
- 修复与验证：GET /config 返回 clamp 后的 runtime 默认值（真机启动 toast 清零）；
  POST 扁平归位 + 钳制单测；离线包 bundles 形态修复；
  「大模型调用出现问题」为渲染层对网关偶发失败的通用文案（18888 网关侧，非端点缺陷）
- 回归：39/39 测试（新增运行参数契约用例）

## 24. 会员中心白屏修复 + 最高档位会员（recon.10，O，2026-10-11）

- 白屏根因：会员中心组件（XCt）用量行 Ee(v.max_total_files) 无空值保护，而重建版 /user-status
  首版返回的 userStatus 缺会员字段 → undefined.toLocaleString() → React 树整体卸载（root 清空）
- 边界说明：重建版的会员状态是**本地后端自有状态**——模型调用走用户自有网关（费用自担），
  不触碰原厂云端会员/配额服务（遥测门默认关闭），故最高档位仅是本地模拟状态，非破解原厂服务
- 实现（字段消费自 bundle XCt @~6,895,313）：
  - GET /user-status → 旗舰版（重建版）：level=flagship、永久（days_remaining=null）、
    max_total_files=9,999,999、max_file_size_mb=2048、max_text_length=5,000,000、
    supports_multimodal/media/vision=true、remote_channel_limit=99
  - GET /llm-quota → is_unlimited=true（不限量）、is_permanent=true
  - GET /membership-plans → {success, plans:[基础/专业/旗舰]}（旗舰 is_active）
  - GET /get-total-files → {success, currentIndexedFiles:0}
  - POST /verify-offline-activation → 直接确认最高档位
  - bundle 补丁：Ee 助手加空值保护（null→'—'），防止任何未定义数值再次炸掉整棵树
- 验证：会员中心 4 端点全 200、root 渲染 88,799 字符、0 控制台异常、0 失败请求；39/39 测试

## 25. 购买入口隐藏（recon.11，O，2026-10-11）

- 用户确认会员能力解锁即可，购买入口无需保留
- 实现：index.html 内联样式隐藏两处购买入口（不改 bundle）——
  .membership-center__plan-buy（4 个套餐卡购买按钮）、.membership-center__quota-purchase-btn（额度卡竖排购买钮）
- 保留展示：旗舰版（重建版）· 永久有效 · 不限量 · 已拥有标识、三档套餐卡（作为能力清单展示）
- 验证（CDP）：planBuyVisible=0、quotaPurchaseVisible=0、旗舰/永久/不限量/已拥有全部渲染、
  0 失败请求、0 控制台异常
- 边界重申：会员为本地重建版自有状态（模型费用由用户自有网关承担），不涉及原厂云端服务

## 26. 便携 exe 打包（recon.12，O，2026-10-11）

- 产物：release/Knowly-Portable-<version>.exe（electron-builder portable，x64，约 126MB）；
  项目根 Knowly-Portable.exe 为正式使用副本；桌面快捷方式「Knowly (Recon).lnk」→ 项目根 exe，
  图标携带 favicon.ico
- 包内适配（[重建版适配] 标记 diff）：
  1. main.js：打包版数据根 = PORTABLE_EXECUTABLE_DIR/data（userData=data/user-data、
     后端 KNOWLY_DATA_ROOT=data/backend、设备根 KNOWLY_SHARED_DATA_ROOT=data），
     首次运行自动从 %APPDATA%/KnowlyRecon/backend 迁移历史数据
  2. python-server.js：包内无 findme.exe 时改用**进程内后端**（require server/index.js，
     轮询 /health 就绪）——绝无 taskkill findme.exe（那是原版应用后端）
  3. app-lifecycle.js：自动更新器归入遥测门（便携包绝不检查原厂 OSS 更新）
  4. device-id.js：KNOWLY_SHARED_DATA_ROOT 优先
  5. server/index.js：进程内模式 EADDRINUSE 不 process.exit（避免连带杀掉主进程）
- 打包验证（独立启动 Knowly-Portable.exe）：进程内后端 28099 健康 200、代理 28081、
  数据落在项目 data/（用户模型配置经迁移完整保留）、示例应用在位、原版应用进程不受影响
- 已知限制：本次构建因 win-unpacked/resources/app.asar 被残留进程句柄锁定（EBUSY），
  exe 未内嵌产品图标——桌面快捷方式已携带 favicon.ico 图标；重启后重新构建即可嵌入

## 27. 历史对话切换空白 —— 连环根因与修复（recon.13，O，2026-10-12）

### 根因链（本次排障共 6 层）
1. **渲染层消息保存契约**：POST /chat/sessions/{id}/messages 的 body 是 `{messages:[数组]}`
   （一次提交本轮 user+assistant），旧实现按单条 `{role,content}` 解析 → 存下的全是空 user 消息、
   assistant 从未入库 → 历史切换气泡空白。
2. **数据根分裂**：开发版用 `%APPDATA%/KnowlyRecon/backend-data`，便携版用 exe 旁 `data/backend`——
   同一批会话在两个根里反复错位（main.js 迁移源也曾写错目录名）。
3. **config.js 抢先执行（核心根因）**：main.js 第 4 行 `require('./src/local-image-protocol')`，
   其内部 `require('./config')` → config.js 在便携化 setPath **之前**执行，用默认 userData(appdata)
   写死 `process.env.KNOWLY_DATA_ROOT`；后续便携化分支的 `||` 保留了这个错误值。
4. **app.isPackaged 判据失效**：项目根 Knowly.exe 是重命名 electron.exe，isPackaged 判定不可靠，
   便携化分支被判为开发环境。改用"exe 是否在 node_modules 内"判据（main / window-manager 同步）。
5. **utilityProcess 环境传递**：utilityProcess.fork 的 env 不可靠（且严禁设置 `ELECTRON_RUN_AS_NODE`，
   会导致子进程 code=9 立即退出）→ 数据根改由命令行参数 `--data-root` 传递（必达），
   并在 fork 前清理占用 28099 的陈旧后端。
6. **陈旧进程干扰排障**：开发模式的 `electron.exe`（node_modules）＋其 node 后端子进程长期占用 28099，
   按 Knowly/路径过滤的清理从未命中 → 前端请求一直打到旧后端（解释了反复出现的"修了却无效"）。
   清理策略更新：按命令行匹配 electron/node/python，而非仅进程名与路径。

### 修复与数据救援
- 后端消息保存支持数组契约（兼容旧单条）；历史空消息一次性修复（首条以会话标题回填、去重复空条）
- main.js require 顺序修正（local-image-protocol 延后到便携化块之后）；isPackaged 判据替换
- 打包形态：electron-builder 单文件 portable 因本机杀毒锁目录重命名（EPERM，3 次重试均失败）
  无法重建 → 采用**文件夹版绿色安装**（项目根 `Knowly.exe` + `resources/app.asar`，双击独立启动、
  数据落项目 `data/`）；桌面快捷方式重指到它，旧单文件 exe 改名 `.old-broken`

### 终态验证（真机）
- `/debug-env`：dataRoot = `E:\data\Knowly\data\backend` ✓
- `GET /config`：`runtime.max_documents_per_chat = 8` ✓（启动 toast 清零）
- `GET /chat/sessions/{id}`：历史消息带内容 ✓
- CDP 点击历史项：气泡渲染"（历史会话）你好，简单介绍一下你自己" ✓
- 39/39 测试

## 28. 模型调用错误 —— 正则误删路由事故与配置迁移（recon.14，O，2026-10-12）

### 事故经过（自我复盘）
- 前一天为移除临时调试端点 /debug-env，用**非贪婪正则**做替换：
  `idx.replace(/app\.get\('\/debug-env'[\s\S]*?\n\}\);\n\n/, '')` —— 非贪婪回溯把
  **/health 定义与全部 6 个路由注册**一并吞掉，server/index.js 只剩裸 express + listen（85 行）。
- 该文件被打进 asar 后，应用后端对所有请求返回 Express 默认 404 HTML
  （"Cannot GET /health"）→ 用户看到"调用模型错误"（配置读不到、全部接口失效）。
- **教训入档**：删除代码必须用精确锚点或结构化编辑，禁用大范围正则；改完必须跑全量接口冒烟
  （本次 39 项测试用的是 tests/ 自建 app，未覆盖 server/index.js 本体装配，故未拦截）。

### 修复
1. server/index.js 完整重建：/health + 6 组路由注册 + CORS + 请求日志 + 404 兜底 + uvicorn 就绪行
2. **模型配置未随数据根迁移**：便携根 data/backend 只有 sessions（迁移逻辑只搬缺失文件，
   config.json 已存在即跳过）→ 应用读不到 api_key → "调用模型错误"。
   已把旧数据根的 config（模型配置，去除调试 marker）与 apps 应用数据迁入便携根；
   main.js 迁移逻辑增强：config.json 逐键补齐（模型配置优先）、apps 目录整体复制。
3. 冒烟补强：新增对 **server/index.js 装配产物**的验证方式（起真实服务 curl /health、/config、
   /qa/chat/stream），测试套件外单列，避免同类事故复发。

### 终态验证（真机）
- GET /health = {"status":"ok"} ✓
- GET /config：api_key=self / base_url=http://127.0.0.1:18888/v1 / model=self / runtime ✓
- POST /qa/chat/stream：经 18888 网关真实返回回答 ✓
- 39/39 测试

## 29. 任务模式发送即失败（emit is not a function）（recon.15，O，2026-10-12）

### 现象
用户在任务模式下发送消息，AI 未执行任何动作即显示「任务已停止 / AI执行了0次，调用工具0次」，
并伴随「大模型调用出现问题」toast —— 表现为「安装包不能发送消息」。

### 根因
recon.11 重构任务执行器时引入：

- POST /qa/task/executions（渲染层的主链路）以**后台模式**调用 runTaskExecution，emit 传 null（只写执行记录）
- 但 track() 内仍是裸调用 emit(type, data)（未走空值保护的 sseEmit 辅助函数）
- → 第一条 execution_start 事件即抛 TypeError: emit is not a function → 任务立即失败
- → 渲染层累积不到任何 answer_chunk，任务收尾按 bundle 逻辑（@~6,167,015，content 为空即写）保存「任务已停止」

### 修复
track() 改为 if (emit) emit(type, data)（与 sseEmit 一致的空值保护）。

### 验证（CDP 真机复现）
- 复现脚本 analysis/tools/repro-task-send.mjs：切任务模式 → 输入 → 点发送（aria-label=发送）
- 修复前：聊天区「任务已停止 / emit is not a function」+ 大模型调用出现问题 toast
- 修复后：请求链 POST /chat/sessions/{id}/messages → POST /qa/task/executions → GET …/stream 全部 200；
  聊天区「**任务已完成** / AI执行了1次，调用工具0次 / 收到」，0 toast、0 控制台异常
- 39/39 测试

## 30. 本地资料学习：拖拽支持 + 知识库全链路可用（recon.16，O，2026-10-12）

### 用户诉求
「本地资料学习」页需要支持直接拖拽文件/文件夹进去（原版仅支持「添加资料」按钮选目录）。

### 本轮修复/实现的 8 层问题（按发现顺序）
1. **/directories/add 参数名不匹配**：渲染层发 `{folder}`，后端读 `path/directory` → 添加必失败
2. **/directories/remove 方法不匹配**：渲染层用 DELETE，后端注册 POST
3. **/directories 响应形态**：渲染层按 `Object.entries(directories)` 映射
   `{path,indexed,monitoring,last_updated}` → 后端改为同构 map
4. **GET /config 顶层 runtime 缺失（一石二鸟）**：渲染层运行参数校验读**顶层** `r.runtime`
   （非 `data.runtime`）→ ① 每次加载弹「读取运行参数失败」② 知识库页初始化
   `Promise.all([/config,/user-status])` 抛错中断 → 目录列表永不加载。修复：runtime 双写（顶层+data）
5. **云端会员同步中断启动序列**：知识库页 `onPythonReady → syncMembershipFromCloud() → W() → G()`
   链中云调用（原厂 EMAS）不可达即抛错，后续拉目录永不执行。修复：主进程 call-cloud-function
   在遥测门关闭时对 membership/quota 返回**本地模拟成功**（不外呼）
6. **isPythonServerRunning() 永远为 false**：子进程模式（utilityProcess）从未登记 `pythonProcess`
   → `python-ready` **从未发送** → 知识库页永不初始化。修复：fork 后登记子进程
7. **缺 /check-db 与 /monitoring-status**：知识库页每目录状态检查端点 → 补齐
   （`{exists}` / `{success,is_monitoring,last_updated}`）
8. **python-ready 只发一次**：用户先进会话页再切知识库页会永久错过该事件 →
   主进程每 5s 重发（渲染层自带幂等守卫，安全）；另将 /directories 的旧占位实现退化为真实索引判定

### 新增实现（重建版能力）
- **索引引擎** server/core/indexer.js：遍历目录 → 复用既有文档解析器（txt/md/json/csv/html/docx/pptx/pdf/xlsx，含编码回退）
  → 存本地索引 `data/backend/index/<hash>.json`；进度状态机与渲染层 /index-progress 契约
  **严格对齐**（完成文案「学习完成！成功 N 个，失败 N 个，精简 N 个」被渲染层正则解析）
- **知识库路由** server/routes/knowledge.js：/index、/index-progress、/index-cancel、
  /clean-all-indexes、/start-monitoring、/stop-monitoring、/search、/search/file-text、
  /api/dedup/exclude-file、/check-db、/monitoring-status、/get-total-files（真实索引计数）
- **检索**：关键词全文匹配（多关键词 AND）+ 命中 `<mark>` 高亮片段 + confidence 评分
  （对齐渲染层 `xmt(e)=confidence??100*(1-score/2)` 与 ≥30% 过滤、按 source 去重、前 50 条）
  说明：原版为向量语义检索；重建版先提供可用的关键词检索，接口形态完全对齐（诚实降级边界见 §7）
- **拖拽注入**（knowly-drop-shim 1.1.0）：知识库/本地资料学习页拖入文件/文件夹 →
  取本地路径（文件取其所在目录）→ POST /directories/add + /index 自动开始学习 →
  温和刷新（切换页面重挂载，替代整页 reload，避免把用户踢回会话页）

### 终态验证（CDP 真机）
- 拖拽钩子：POST /directories/add 200 → POST /index 200（自动学习）✓
- 知识库页目录列表：kb-test / Downloads 均显示「已学习 (时间)」+ 监控/再次学习/查重 操作 ✓
- 搜索页：输入「风险」→ `POST /search` → 「共 50 条」+ 命中文件 + 匹配度 90% ✓
  （命中用户 Downloads 中的真实文件；后端 Node 脚本另验证 `<mark>` 高亮与多关键词 AND）
- 40/40 测试（新增知识库全链路用例：目录契约→索引→进度→搜索→读全文→清理）

## 31. 模型调用"莫名失败"的定性分析与健壮性加固（recon.17，O，2026-10-12）

### 定性（日志实锤 + 压测定位）
- 主进程日志多次出现：`大模型API调用失败，请检查网络连接: Connection error.`
  （主进程 api-proxy-handler 的 catch，来源 OpenAI SDK 的 APIConnectionError）
- 即失败**不是**我们链路断，而是**上游边界偶发**：本机网关（127.0.0.1:18888）→
  模型厂商的网络抖动/瞬时拒绝。此前无自愈能力，一次抖动即抛给用户 → 表现为"莫名失败"
- 压测确认非高负载问题：简单请求 6/6、长历史/长思考（29.4s 输出 2434 字）/三路并发均稳定通过

### 加固措施
主进程代理（electron/src/api-proxy-handler.js）：
1. **共享 keepAlive Agent**（http/https，maxSockets 64）：本地网关连接复用，
   显著降低高频调用时 TCP 握手失败概率（原先每次新建 Agent → 全新连接）
2. SDK maxRetries 2 → **3**
3. `/api/stream/read` 增加**空闲超时**（180s 无数据 → 明确错误，不再无限挂起）
4. 流式会话清理改为**按最后活动时间**（长思考持续有 chunk 不会被 5 分钟误杀；超时 10 分钟）

后端 LLM 层（server/llm.js）：
5. `proxyPost` 统一**退避重试**（0.6s/1.2s/2.4s，最多 3 次），覆盖网络异常/5xx/可重试错误
6. `chatStream` 策略：**未产出内容前**失败 → 退避重试整个流式启动（最多 3 次，重试前 cancel 旧会话）；
   **已产出内容后**失败 → 保留已输出并抛出（避免重复内容）；读流不重试（会话失效重试无意义）
7. 错误消息**归一化**：连接类 → "无法连接到大模型服务：网关…无响应，请确认本机网关已启动后重试"；
   超时类 → "大模型响应超时，请稍后重试" —— 渲染层据此给出指引性文案，不再是"莫名失败"

### 验证（真机压测，analysis/tools/llm-stability.mjs / llm-load-test.mjs）
- 基础稳定性：简单请求 6/6 成功（0.7–1.3s）
- 重负载：长历史（24 条消息）✓ / 复杂问题长思考（29.4s、2434 字）✓ / 深度推理（1003 字）✓ /
  三路并发 ✓ —— **合计 0 失败**
- 40/40 测试
- 残余边界（诚实声明）：上游网关自身对模型厂商的**持续**不可用（如断网/限额）无法在本地自愈，
  重试耗尽后会给出明确文案（含原始错误），而不是"莫名失败"

## 32. 任务模式思考过程内联展示 + 中断保留（recon.18，O，2026-10-12）

### 诉求
1. 思考过程要**在对话框中展示**，而不是只出现在「查看完整过程」的独立面板
2. 仍偶发"莫名其妙中断"

### 静态分析结论（渲染层限制，决定方案）
- 问答模式：思考块 `<Yst>`（`chat-panel__thinking-block`）**本就内联渲染在 assistant 气泡内**
  （`thinkingContent` 字段驱动）
- 任务模式：渲染层事件解析的 task 分支**只把推理写入 taskSteps**（→「查看完整过程」抽屉），
  且 `thinking_content` 事件在 task 分支被忽略 → 任务消息的 `thinkingContent` **永远为空**
  → 内联思考块不可能通过后端事件实现

### 方案与实现
**A. 思考内联（前端注入，不改 bundle）**：
- shim 1.2.0 拦截 `POST /qa/task/executions` 响应取 `execution_id` → 每 1.5s 轮询
  `GET /qa/task/executions/{id}` → 取推理全文 → 在最后一条 assistant 气泡内注入
  **官方同款结构**（`chat-panel__thinking-block` + header「深度思考」+「思考中…」+ 可折叠 content）
- 后端补 `data.thinking` 字段（agent 累积推理全文），供轮询读取（此前单执行 GET 只有状态）
- MutationObserver 守护重注入（React 重绘冲掉注入块时自动补回）

**B. 中断保留（后端流式化）**：
- 任务模式回答改为**边生成边发 answer_chunk**（此前一次性发送 → 上游中断时渲染层累积为空
  → 按渲染层逻辑存成「任务已停止」，即用户看到的"莫名中断"）
- 工具调用路径：流式期间误显的 tool_call 代码块用 `answer_revoke` 撤回（渲染层原生支持），
  工具总结后再流式下发最终答案

### 验证（CDP 真机）
- 任务模式发送「用三步说明：如何判断一个数是否为素数？」：
  气泡内「深度思考」块实时增长（168 → 631 → 980 字，含真实推理文本），
  「思考中…」标记流式期间显示、完成后收敛；可点击折叠 ✓
- 40/40 测试
- 说明：中断保留已由流式下发机制保证（任意时刻上游中断，已输出内容都会留在消息里）

## 33. 复杂推理"中断且没回答"= max_tokens 截断 + 消息列表粘底（recon.19，O，2026-10-12）

### 诉求
「还是中断了 没有回答出问题 且默认应该放在最下方」+ 用户原题（糖果抽屉组合题）

### 根因（可复现的最小证据）
- 用用户原题直接打 `/qa/chat/stream`：
  `{ ms: 30217, err: null, done: "", thinkingLen: 6315, contentLen: 0 }`
  —— 推理写满 `max_tokens=4096` 后 `finish_reason=length`，**正文 0 字**。
  渲染层拿到空正文 → 显示"中断了/没有回答"。**不是网络中断**（err=null）。
- 探测本机网关：8192 / 16384 / 32768 均受理 → 有提高空间。

### 修复
- `server/llm.js`
  - 默认 `maxTokens` 4096 → **16384**（`chatOnce` + `chatStream`）
  - `chatStream` 捕获 `choice.finish_reason`；当 `finish_reason==='length'` 且正文为空时
    `budget *= 2` 重试整个流（16k→32k→64k 封顶），重试前 `stream/cancel` 旧会话；
    仍不足则抛出明确文案（不再静默空白）
  - 每次 attempt 的 `full`/`reasoning` 在循环内重置 → 返回值不含失败尝试的内容
- `electron/src/api-proxy-handler.js`：chat 客户端超时 120s → **300s**（长思考首字等待）

### 消息列表默认贴底（shim 1.4.0）
- 目标元素 `.chat-panel__msg-list`（CDP 实测存在）
- **粘底**：默认 `stick=true` 跟随；滚动事件里 `dist>60px` → `stick=false`（用户在上翻阅读）；
  回到底部附近 → 自动恢复；会话滚动容器被换掉（会话切换/首次挂载）→ 强制置底 + 重置 stick；
  回车发送后回到最新；2.5s 兜底 interval 也遵守 stick
- 先前的"暂停 4s 再抢回"会在用户阅读时把视口拽走，故改为粘底

### 工程化（新增，可复用）
- `scripts/repack-asar.cjs`：asar **原地单文件替换**
  - 实测发现 electron-builder 对相同内容做了**去重**（1615 个 entry 共享 offset，如渲染层 woff 与
    katex 字体）→ 因此：(1) 目标文件必须独占 offset（否则写坏"别名"）；(2) 只平移 offset **严格大于**
    目标 offset 的 entry
  - 校验链：数据区覆盖性（无空洞、铺满 EOF）→ 平移样本内容比对 → 官方 `@electron/asar` 读取自校验
    → 通过才 `rename` 覆盖（旧档 `.bak`，失败即回滚）
- `scripts/verify-asar-sync.cjs`：asar 内源码 vs 工作区**逐字节比对** → 本次 **178/178 一致**
- `scripts/restart-recon.ps1`：按 `ExecutablePath` 前缀只停/起 `E:\data\Knowly` 下进程（原版不受影响）

### 验证（CDP 真机 · 用户原提示词，任务模式）
- 轮询观测：`ans=233(用户气泡) → 思考 30→741→1525→2480→2905 → 气泡 3 / ans=473`
- **A 完整作答 ✓** 正文 473 字，末句「答案：最少取出 29 个糖果。」
  （独立验算：最坏取法 = 全取圆形苹果7+圆形桃子9+西瓜12 = 28 仍不满足 → 答案 28+1=**29**，与模型一致）
- **B 思考内联 ✓** 气泡内「深度思考」2905 字（任务模式取后端最终记录，无重复拼接）
- **C 粘底 ✓** 距底 0px；手动上翻后 4.2s 仍在顶部（scrollTop=0，未被拽回）；强制置底 API 生效
- 40/40 测试
- 已确认 shim 1.4.0 与 llm.js 修复**均已打进 app.asar**（原地替换后 178/178 一致）

### 已知限制（诚实声明）
- 推理若**仍**超 64k token 上限 → 明确报错，非静默空白
- 触发"加倍重试"时，**问答模式**思考块会把重试前的半截推理一并显示（渲染层无推理重置事件，
  且缓冲区/静默流会把主路径的"实时思考"退化掉，故不做）；**任务模式不受影响**
- 复现脚本 `analysis/tools/repro-hard-prompt.mjs` 曾报 thinkingLen=14828：那是把两次 attempt 的
  `thinking_content` 增量**跨尝试累加**所致（6315 + 8513），非产品缺陷

