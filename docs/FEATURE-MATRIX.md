# 功能齐全度矩阵（重建版 3.13.2-recon.1 vs 原版 v3.13.2）

图例：✅ 完整实现 · 🟡 简化实现（可用，语义对齐但非逐字还原）· ⛔ 诚实降级（返回说明性错误，不伪造结果）· ➖ 原版功能，依赖云端/模型服务

## 1. 工具层（原版 16 工具）

| 工具 | 显示名 | 状态 | 说明 |
| --- | --- | --- | --- |
| file_reader | 文件内容读取 | ✅ | read/find/inspect + 游标续读，反汇编契约逐字还原，22 项原契约测试 |
| excel_inspector | Excel结构分析 | ✅ | 表头层级/合并单元格/公式/样式/隐藏行列等，原契约测试通过 |
| file_searcher | 文件搜索 | 🟡 | 文件名递归搜索（通配/子串），原版 schema 未逐字还原 |
| shell_executor | 本地命令执行 | 🟡 | 真实执行（cmd/sh，cwd 限定工作区） |
| python_executor | 代码执行 | 🟡 | 调系统 python -c 执行 |
| ask_user | 询问用户 | ⛔ | 原版经任务执行流等待输入；重建版返回提示 |
| rag_file_reader / rag_search / rag_retriever | 向量库读取/语义搜索/检索 | ⛔ | 依赖向量索引（原版 Python 服务内建） |
| file_converter / image_converter | 文件/图片格式转换 | ⛔ | 原版转换管线未还原 |
| image_generator | AI生成图片 | ⛔ | 依赖生图模型 |
| file_locator | 文件定位 | ⛔ | 可用 file_searcher 替代 |
| env_manager | 环境管理 | ⛔ | 依赖原版执行环境体系 |
| run_subagent | 子Agent | ⛔ | 原版多 Agent 体系未还原 |
| compact_context | 压缩上下文 | ⛔ | 原版上下文管理器未还原 |

## 2. 智能体 / 对话

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 普通对话流（/qa/chat/stream SSE） | 🟡 | metadata/sources/thinking_content/content/complete 事件与渲染层解析器对齐 |
| 工具调用轮 | 🟡 | 模型经 tool_call 代码块发起，执行后二次总结（单轮）；原版为多轮 ReAct |
| 任务模式（/qa/task/*） | 🟡 | execution 生命周期 + calling_tool/tool_result/answer_* 全事件族 |
| ask_user 交互 / 子Agent / 网络搜索 / RAG 检索 | ⛔ | 依赖原版 react_loop 体系 |
| 会话标题生成（/qa/generate-title） | 🟡 | LLM 摘要，失败回退截断 |

## 3. 界面可见的后端面（渲染层实际调用）

| 端点组 | 状态 |
| --- | --- |
| /chat/sessions CRUD + 消息 + 收藏 + localStorage 迁移 | ✅（结构经在线对照） |
| /config、/cache/*、/directories* | ✅（在线对照） |
| /api/models/current、/api/llm/software-default-models(/sync) | ✅（内嵌快照目录） |
| /agents/custom、/api/tools/skills | ✅（内嵌 3 个内建技能快照） |
| /check-membership、/device-transfer/status | ✅（在线对照） |
| /scheduler/*（tasks/enabled-count/notifications）、/tasks CRUD | ✅（调度器简化：仅记录，不真实 cron） |
| /api/directory-stats/*、/files/create_folder、/export/cancel | ✅ |
| /api/toolbox/*（图像修复/公众号导入/图片去隐私） | ⛔ 依赖原版模型服务 |
| /files/upload*、/upload/*（分片上传，手机远程/知识库导入） | ⛔ |
| /export/xmind、/qa/diagram/regenerate | ⛔ |
| /api/ollama/*（本地模型管理）、/api/offline-pack/* | ⛔ |
| /remote-control/*（手机远程控制） | ⛔（仅通知轮询返回空列表） |

## 4. 桌面壳（Electron 主进程，原样复制）

| 能力 | 状态 |
| --- | --- |
| 窗口/托盘/右键菜单/页面缩放/开机启动 | ✅ 原版源码 |
| 文件管理 IPC（打开/定位/回收站）、剪贴板、HTML 截图导出图片 | ✅ |
| 本地图片协议 findme-local://、壁纸/小红书卡片背景 | ✅ |
| 自动更新 | ➖ 有 isPackaged 守卫，重建版不生效（更新源是原厂 OSS） |
| EMAS 统计/公告/邀请码 | ➖ 遥测门默认关闭（见隐私审计） |

## 5. 用户可见结论

- **开箱可用**：界面完整、会话管理、文件读取/Excel 分析/文件搜索/命令执行四类工具、自定义 API Key 对话（问答模式与任务模式）。
- **配置模型后可用**：对话 + 工具调用 + 标题生成（经本地代理直连你配置的 OpenAI 兼容端点）。
- **不可用但明确提示**：知识库语义检索、OCR/图像处理工具箱、手机远程、本地 Ollama 管理、生图、格式转换。
