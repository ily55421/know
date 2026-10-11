'use strict';

/**
 * 工具注册表。
 *
 * 证据来源（EVIDENCE-LEDGER.md §工具层）：
 * - 显示名映射表：渲染层 bundle.js（偏移 ~6,035,365 / ~6,080,991）内置
 *   `python_executor:代码执行, file_reader:文件读取, rag_file_reader:向量库文件内容读取,
 *    file_converter:文件格式转换, image_converter:图片格式转换, file_searcher:文件搜索,
 *    excel_inspector:Excel结构分析, file_locator:文件定位, shell_executor:本地命令执行,
 *    env_manager:环境管理, rag_search:知识库语义搜索, rag_retriever:知识库检索,
 *    ask_user:询问用户, run_subagent:子Agent, image_generator:AI生成图片, compact_context:压缩上下文`
 * - file_reader / excel_inspector 的完整 schema 与行为：原版 Python 字节码反汇编逐字还原
 *   （见 E:\soft\Knowly\res\ANALYSIS.md §2/§3），实现移植自该复刻版。
 * - 其余工具的 schema 为推断（inferred），实现为诚实降级（返回统一信封错误，不伪造结果）。
 */

const path = require('node:path');
const { FileReaderTool } = require('./file-reader');
const { ExcelInspectorTool } = require('./excel-inspector');

const workspaceFolders = () => {
  const folders = [];
  const fromEnv = process.env.KNOWLY_WORKSPACES;
  if (fromEnv) {
    for (const item of fromEnv.split(path.delimiter)) {
      if (item && item.trim()) folders.push(item.trim());
    }
  }
  folders.push(require('node:os').homedir());
  return [...new Set(folders)];
};

/** 与原版一致的统一响应信封：{success, result, error, metadata} */
const envelope = (result) => ({
  success: Boolean(result && result.success),
  result: result ? (result.result ?? null) : null,
  error: (result && result.error) || null,
  ...(result && result.metadata ? { metadata: result.metadata } : {}),
});

const STUB_TOOLS = [
  {
    name: 'rag_file_reader',
    display_name: '向量库文件内容读取',
    category: 'file_operation',
    description: '读取已建立索引的知识库文件内容（依赖向量索引，重建版未实现）',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'rag_search',
    display_name: '知识库语义搜索',
    category: 'knowledge',
    description: '在工作目录知识库中做语义搜索（依赖向量索引，重建版未实现）',
    parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer' } }, required: ['query'] },
  },
  {
    name: 'rag_retriever',
    display_name: '知识库检索',
    category: 'knowledge',
    description: '检索知识库片段（依赖向量索引，重建版未实现）',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'file_converter',
    display_name: '文件格式转换',
    category: 'file_operation',
    description: '在 .docx/.pptx/.pdf/txt 等格式间转换（重建版未实现）',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, target_format: { type: 'string' } }, required: ['file_path', 'target_format'] },
  },
  {
    name: 'image_converter',
    display_name: '图片格式转换',
    category: 'file_operation',
    description: '图片格式/尺寸转换（重建版未实现）',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, target_format: { type: 'string' } }, required: ['file_path', 'target_format'] },
  },
  {
    name: 'image_generator',
    display_name: 'AI生成图片',
    category: 'generation',
    description: '调用生图模型生成图片（重建版未实现）',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
  {
    name: 'file_locator',
    display_name: '文件定位',
    category: 'file_operation',
    description: '按名称/类型在工作目录中定位文件（重建版未实现，可用 file_searcher 替代）',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'env_manager',
    display_name: '环境管理',
    category: 'environment',
    description: '管理代码执行环境/依赖（重建版未实现）',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  },
  {
    name: 'run_subagent',
    display_name: '子Agent',
    category: 'agent',
    description: '派发子 Agent 任务（重建版未实现）',
    parameters: { type: 'object', properties: { task: { type: 'string' }, agent_name: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'compact_context',
    display_name: '压缩上下文',
    category: 'system',
    description: '压缩会话上下文（重建版未实现）',
    parameters: { type: 'object', properties: {} },
  },
];

/** 真实实现的工具（file_reader / excel_inspector 移植自 E:\soft\Knowly\res 复刻版）。 */
class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.registerClass(FileReaderTool);
    this.registerClass(ExcelInspectorTool);
    for (const stub of STUB_TOOLS) {
      this.tools.set(stub.name, {
        meta: {
          name: stub.name,
          display_name: stub.display_name,
          description: stub.description,
          category: stub.category,
          parameters: stub.parameters,
        },
        execute: async () => envelope({
          success: false,
          error: `工具 ${stub.name}（${stub.display_name}）在重建版中未实现：该能力依赖原版 Python 服务的向量索引/模型服务`,
        }),
        implemented: false,
      });
    }

    // shell_executor / file_searcher / python_executor / ask_user：重建版真实实现（简化）
    this.tools.set('shell_executor', {
      meta: {
        name: 'shell_executor',
        display_name: '本地命令执行',
        description: '在工作目录中执行本地 Shell 命令（重建版简化实现：Windows 用 cmd，类 Unix 用 sh）',
        category: 'system',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '要执行的命令' }, cwd: { type: 'string', description: '工作目录（默认第一个工作区）' }, timeout: { type: 'integer', description: '超时秒数，默认 60' } },
          required: ['command'],
        },
      },
      execute: (params) => this.executeShell(params),
      implemented: true,
    });

    this.tools.set('file_searcher', {
      meta: {
        name: 'file_searcher',
        display_name: '文件搜索',
        description: '按文件名关键字在工作目录中递归搜索文件（重建版简化实现）',
        category: 'file_operation',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文件名关键字或通配符' }, max_results: { type: 'integer', description: '最大返回数，默认 50' } },
          required: ['query'],
        },
      },
      execute: (params) => this.executeFileSearch(params),
      implemented: true,
    });

    this.tools.set('python_executor', {
      meta: {
        name: 'python_executor',
        display_name: '代码执行',
        description: '执行 Python 代码片段（重建版简化实现：调用系统 python）',
        category: 'code_execution',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: 'Python 代码' }, timeout: { type: 'integer', description: '超时秒数，默认 60' } },
          required: ['code'],
        },
      },
      execute: (params) => this.executePython(params),
      implemented: true,
    });

    this.tools.set('ask_user', {
      meta: {
        name: 'ask_user',
        display_name: '询问用户',
        description: '向用户提问并等待回复（原版经任务执行流，重建版直接以错误信封返回提示）',
        category: 'interaction',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要问用户的问题' } },
          required: ['question'],
        },
      },
      execute: (params) => envelope({
        success: false,
        error: `ask_user（重建版）：请直接回复模型回答该问题：${params?.question || ''}`,
      }),
      implemented: false,
    });
  }

  registerClass(ToolClass) {
    this.tools.set(ToolClass.name, {
      meta: ToolClass.schema(),
      execute: (params, context) => ToolClass.execute(params, context),
      implemented: true,
    });
  }

  catalog() {
    return [...this.tools.values()].map((t) => t.meta);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  async execute(name, params) {
    const tool = this.get(name);
    if (!tool) {
      return envelope({ success: false, error: `未知工具: ${name}` });
    }
    const context = { user_selected_folders: workspaceFolders() };
    return tool.execute(params || {}, context);
  }

  async executeShell(params) {
    const { execFile } = require('node:child_process');
    const command = String(params.command || '');
    if (!command.trim()) return envelope({ success: false, error: '命令不能为空' });
    const timeoutSec = Math.min(Math.max(Number(params.timeout) || 60, 1), 600);
    const cwd = params.cwd || (workspaceFolders()[0]);
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    return new Promise((resolve) => {
      execFile(shell, args, { cwd, timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          return resolve(envelope({ success: false, error: error.message, metadata: { cwd, timeout: timeoutSec } }));
        }
        resolve(envelope({
          success: !error,
          result: { stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', exit_code: error ? (error.code ?? 1) : 0, cwd },
          error: error ? `命令退出码非零: ${error.code ?? 'unknown'}` : null,
          metadata: { cwd, timeout: timeoutSec },
        }));
      });
    });
  }

  async executeFileSearch(params) {
    const fs = require('node:fs');
    const query = String(params.query || '').trim();
    if (!query) return envelope({ success: false, error: '搜索关键字不能为空' });
    const maxResults = Math.min(Math.max(Number(params.max_results) || 50, 1), 500);
    const pattern = query.includes('*') || query.includes('?')
      ? new RegExp('^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const results = [];
    const roots = workspaceFolders();
    const walk = (dir, depth) => {
      if (results.length >= maxResults || depth > 8) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'AppData'].includes(entry.name)) walk(full, depth + 1);
          continue;
        }
        if (pattern.test(entry.name)) results.push(full);
      }
    };
    for (const root of roots) {
      try {
        if (fs.statSync(root).isDirectory()) walk(root, 0);
      } catch { /* 根不可读时跳过 */ }
      if (results.length >= maxResults) break;
    }
    return envelope({
      success: true,
      result: { matches: results, total: results.length, truncated: results.length >= maxResults, roots },
    });
  }

  async executePython(params) {
    const { execFile } = require('node:child_process');
    const code = String(params.code || '');
    if (!code.trim()) return envelope({ success: false, error: '代码不能为空' });
    const timeoutSec = Math.min(Math.max(Number(params.timeout) || 60, 1), 600);
    const python = process.platform === 'win32' ? 'python' : 'python3';
    return new Promise((resolve) => {
      execFile(python, ['-c', code], { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr && error.code === 'ENOENT') {
          return resolve(envelope({ success: false, error: '未找到系统 Python，无法执行代码（重建版依赖系统安装的 Python）' }));
        }
        resolve(envelope({
          success: !error,
          result: { stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', exit_code: error ? (error.code ?? 1) : 0 },
          error: error ? `执行出错: ${error.message}` : null,
        }));
      });
    });
  }
}

module.exports = { ToolRegistry, workspaceFolders, envelope };
