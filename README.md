# Knowly（findme）逆向重建版

本目录是对已安装的 Knowly 桌面应用（`E:\soft\Knowly`，内部名 `findme` v3.13.2，"最懂你的AI知识助手"）的**逆向还原项目**，按 REA（Reverse Engineer Anything）方法论执行：解包 → 静态分析 → 契约还原 → 在线对照 → 重建。还原依据与证据分级见 [analysis/EVIDENCE-LEDGER.md](analysis/EVIDENCE-LEDGER.md)。

## 还原策略：三层保真度

| 层 | 保真度 | 内容 |
| --- | --- | --- |
| **保真复制** | 原厂源码 1:1 | `electron/`（主进程 21 模块 + preload，asar 内即未压缩源码）、`public/`（图标）、渲染层构建产物 `electron/dist/`（108 文件）、`package.json` 原 manifest |
| **契约重实现** | 协议级对齐 | `server/`——Node.js 重实现原版 Python 工具服务（findme.exe）的 REST/SSE 契约：端口 18099、uvicorn 就绪行握手、SSE 事件协议、会话/任务/配置/目录等端点响应形态（经与**运行中的原版在线对照，11 端点结构全部一致**） |
| **诚实降级** | 明确标注未实现 | RAG/向量索引、OCR、工具箱图像处理、手机远程、离线模型包等依赖原版模型服务的能力——统一返回带说明的错误信封，不伪造结果 |

## 快速开始

```powershell
npm install

# 完整应用（可与正在运行的原版 Knowly 并存：端口与数据目录已隔离）
npm start          # electron 自动拉起 python/api.py → node 后端(28099) → 窗口

# 手动分起（便于调试）
npm run server     # 后端 :28099
npm run web        # 渲染层静态服务 :23099（开发模式窗口从这里加载）
npm start          # electron 窗口
```

- 应用启动后渲染层通过 IPC 收到 `python-ready`（`http://localhost:28099`）开始工作。
- 对话需在应用设置中配置模型（后端经主进程 API 代理 `127.0.0.1:28081` 调用 OpenAI 兼容接口——与原版架构一致）。

**端到端验证已通过**（2026-10-11，与运行中的原版并存）：窗口加载 `#/chat` 路由、React 完整渲染（侧栏/会话/模式切换/模型选择器）、preload IPC 往返、渲染层→后端 REST 与 SSE 全部连通，证据见 [analysis/EVIDENCE-LEDGER.md](analysis/EVIDENCE-LEDGER.md) §13。

```powershell
# 测试（29 项：路由集成 + file_reader/excel_inspector 原契约用例）
npm test

# 工具服务独立可用（无需 Electron）
curl http://127.0.0.1:28099/health
curl http://127.0.0.1:28099/tools | jq '.data.tools[].name'
curl -X POST http://127.0.0.1:28099/tools/file_reader -H "content-type: application/json" `
  -d '{"action":"read","file_paths":["package.json"],"max_length":2000}'
```

## 目录结构

```
electron/                  【保真复制】主进程源码 + 渲染层构建产物（来自 app.asar）
  main.js  preload.js  src/*.js (21 模块)  dist/ (bundle + index.html)  README.md
public/                    【保真复制】应用图标
server/                    【契约重实现】Node 版后端（替代 python-server/findme.exe）
  index.js                  Express 装配 + 18099 监听 + uvicorn 就绪行
  llm.js                    经主进程代理(18081)的 OpenAI 兼容调用（流式轮询 /api/stream/read）
  agent.js                  SSE 智能体：普通对话与任务模式事件流（协议反混淆自 bundle.js）
  store.js                  JSON 持久化（vector_store/data，沿用原版开发模式数据根约定）
  tools/registry.js         16 工具注册表（显示名/分类映射自渲染层，schema 见台账）
  tools/file-reader.js      file_reader 完整实现（移植自先前反汇编复刻版）
  tools/excel-inspector.js  excel_inspector 完整实现（同上）
  core/                     文档导航器/游标/加载器（read/find/inspect，移植）
  routes/                   system / sessions / qa / tasks / files
  data-seed/                自原版在线 API 快照的内建技能与模型目录
python/api.py              【适配垫片】开发模式入口：保持主进程源码零改动，
                             由它拉起 Node 后端并输出 uvicorn 就绪行
scripts/dev-web.js         渲染层静态服务 :13099（替代原 webpack devServer）
scripts/gen-samples.js     测试样例生成
tests/                     28 项测试（路由集成 + 工具原契约）
analysis/                  REA 证据链
  EVIDENCE-LEDGER.md        证据台账（观察/推断/未知 + 在线对照表）
  extracted/                app.asar 完整提取（18,768 文件，gitignore）
  asar-inventory.txt  asar-header.json  pyz-routes.txt  renderer-endpoints.txt
  bundled-node-modules.tsv  asar 内 513 个包的精确版本清单
  tools/                    本次分析所用脚本（asar 提取/路由扫描/端点提取等）
```

## 与原版的已知差异（诚实声明）

1. **渲染层源码未还原**——交付的是原版 webpack 构建产物（bundle.js 7.1MB，其中硬编码回退基址 18099→28099 做了同长度补丁），前端工程化重建不在本次范围。
2. **智能体简化**——原版为多轮 ReAct 循环 + 子 Agent + 上下文压缩；重建版为单轮生成 + 可选一次工具调用，SSE 事件协议与原版渲染层解析器对齐。
3. **降级工具**——11 个依赖模型/向量服务的工具返回统一错误信封（见 `server/tools/registry.js`），`ask_user` 交互流未接入任务执行器。
4. **调度器简化**——定时任务可建/删/启停/记录，但不做真实 cron 调度。
5. 字符偏移口径——工具层基于 JS UTF-16 码元，emoji 等非 BMP 字符的 `chars`/`cursor` 与原版（Python 码点）不同（详见先前复刻版 ANALYSIS.md §5.3）。
6. **端口与数据目录迁移**（可与原版并存，全部带 `[重建版适配]` 注释、env 可覆盖）：

| 用途 | 原版 | 重建版 | env 覆盖 |
| --- | --- | --- | --- |
| 后端 REST/SSE | 18099 | **28099** | `KNOWLY_BACKEND_PORT` |
| LLM API 代理 | 18081 | **28081** | `KNOWLY_PROXY_PORT` |
| 渲染层静态服务（开发） | 13099 | **23099** | `KNOWLY_WEB_PORT` |
| userData（单实例锁 + electron-store） | %APPDATA%/Knowly | **%APPDATA%/KnowlyRecon** | `KNOWLY_USER_DATA` |

## 已知环境问题

- 本机 pyenv-win 的 `python` shim 在 **bash/cmd 手动调用**时报错；但 Electron 主进程用 Node `spawn('python')` 会解析到 scoop 的 python.exe（追加 .exe，绕过 .bat shim），故 `npm start` 全链路正常。若需在终端手动跑 `python python/api.py`，请用 `py` 或 scoop python 的完整路径。
- 数据目录：后端业务数据在项目内 `vector_store/data`（沿用原版开发模式约定）；electron-store 在 `%APPDATA%/KnowlyRecon`；设备 ID 会自动从原版 `%APPDATA%/Knowly` 的历史配置迁移（原版行为保留）。

## 升级参考基线

`analysis/` 是原版 **v3.13.2 的完整取证快照**，后续版本升级审查时可直接复用：

- 文件级比对：用 `analysis/tools/extract-all.js` 解包新版 `app.asar`，与 `analysis/asar-inventory.txt` / `analysis/extracted/` 做 diff；
- 依赖审计：`analysis/tools/module-versions.js` 重跑 → 与 `analysis/bundled-node-modules.tsv`（513 包精确版本）对比；
- API 面审计：`analysis/tools/scan-pyz-routes.py` 重跑 → 与 `analysis/pyz-routes.txt`（456 条路由）对比；
- 行为验收：`analysis/tools/cdp-verify.js` / `cdp-errors.js` 对新版做同样的窗口/渲染/连通性取证；
- 服务端契约的"活体参照"：同机安装的原版应用运行时（18099/18081）可作为只读对照源，用于核对新版端点形态是否变化。

## 还原方法概要（详见 EVIDENCE-LEDGER.md）

1. **ASAR 路线**：自写提取器解包 18,768 文件（与先前会话记录交叉一致）→ 发现主进程为完整未压缩源码。
2. **渲染层反混淆**：从 bundle.js 提取 SSE 解析器、工具显示名映射、API 路径字面量。
3. **字节码扫描**：对 findme.exe 的 18,543 个 zlib 流做 marshal 常量正则，得到 456 条路由字面量。
4. **在线对照**：原版应用恰在运行——对 18099 做只读探测，以其响应形态修正重建版（最终 11/11 结构一致），并把技能目录、模型目录快照为种子数据。
5. **契约移植**：先前会话反汇编还原的 file_reader / excel_inspector 实现整体移植，28 项测试全过。
