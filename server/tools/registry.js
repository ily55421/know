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

    // ---- 上游能力对齐（CHANGELOG：v3.12.4 批量重命名 / v3.12.6 数据备份 / v3.14.0 image-reader）----
    this.tools.set('file_converter', {
      meta: {
        name: 'file_converter',
        display_name: '文件格式转换',
        description: '经本机 LibreOffice（自动探测安装路径）无头转换：docx/pptx/xlsx/txt/html → pdf/txt/html/rtf/docx/odt/xlsx/csv/ods/pptx/odp 等',
        category: 'file_operation',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '待转换文件路径' },
            target_format: { type: 'string', description: '目标格式：pdf/txt/html/rtf/docx/odt/xlsx/csv/ods/pptx/odp' },
            out_dir: { type: 'string', description: '输出目录（默认源文件所在目录）' },
            timeout: { type: 'integer', description: '超时秒数，默认 120' },
          },
          required: ['file_path', 'target_format'],
        },
      },
      execute: (params) => this.executeFileConverter(params),
      implemented: true,
    });

    this.tools.set('image_reader', {
      meta: {
        name: 'image_reader',
        display_name: '图片阅读',
        description: '用视觉模型直接阅读本地图片并回答问题（对齐上游 v3.14.0 image-reader；需配置支持视觉的模型）',
        category: 'file_operation',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '图片路径（png/jpg/jpeg/webp/gif/bmp）' },
            question: { type: 'string', description: '想问关于这张图的问题（默认：详细描述图片内容）' },
          },
          required: ['file_path'],
        },
      },
      execute: (params) => this.executeImageReader(params),
      implemented: true,
    });

    this.tools.set('file_batch_rename', {
      meta: {
        name: 'file_batch_rename',
        display_name: '文件批量重命名',
        description: '对目录内文件批量重命名：支持前缀/后缀/查找替换/序号模式，默认 dry_run 预览（对齐上游 v3.12.4 百宝箱批量重命名）',
        category: 'file_operation',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: '目标目录' },
            mode: { type: 'string', description: 'rename 模式：prefix/suffix/replace/sequence' },
            prefix: { type: 'string', description: 'prefix 模式：文件名前缀' },
            suffix: { type: 'string', description: 'suffix 模式：扩展名前的后缀' },
            find: { type: 'string', description: 'replace 模式：要查找的子串' },
            replace_to: { type: 'string', description: 'replace 模式：替换为（可为空）' },
            base_name: { type: 'string', description: 'sequence 模式：新名基础，如 "报告" → 报告-001.jpg' },
            start_index: { type: 'integer', description: 'sequence 模式起始序号，默认 1' },
            dry_run: { type: 'boolean', description: '只预览不执行（默认 true）' },
          },
          required: ['folder', 'mode'],
        },
      },
      execute: (params) => this.executeBatchRename(params),
      implemented: true,
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

  /** 文件格式转换（LibreOffice 无头，自动探测安装路径） */
  async executeFileConverter(params) {
    const { execFile } = require('node:child_process');
    const { detectSoffice, sofficeArgs } = require('../core/libreoffice');
    const fs = require('node:fs');

    const soffice = detectSoffice();
    if (!soffice.found) {
      return envelope({
        success: false,
        error: '未找到本机 LibreOffice（已探测 env KNOWLY_SOFFICE_PATH → PATH → 注册表 → 标准路径）。'
          + '请安装 LibreOffice 或设置 KNOWLY_SOFFICE_PATH 指向 soffice.exe',
        metadata: { searched: soffice.searched },
      });
    }

    const src = path.resolve(String(params.file_path || ''));
    const fmt = String(params.target_format || '').trim().toLowerCase().replace(/^\./, '');
    const ALLOWED = new Set(['pdf', 'txt', 'html', 'rtf', 'docx', 'odt', 'xlsx', 'csv', 'ods', 'pptx', 'odp']);
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      return envelope({ success: false, error: `文件不存在: ${src}` });
    }
    if (!ALLOWED.has(fmt)) {
      return envelope({ success: false, error: `不支持的目标格式: ${fmt}。支持：${[...ALLOWED].join('/')}` });
    }
    const outDir = params.out_dir ? path.resolve(String(params.out_dir)) : path.dirname(src);
    if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
      return envelope({ success: false, error: `输出目录不存在: ${outDir}` });
    }
    // 同名目标文件先移走，避免 LibreOffice 因已存在而跳过
    const base = path.basename(src, path.extname(src));
    const expected = path.join(outDir, `${base}.${fmt}`);
    const clash = path.join(outDir, `冲突-${Date.now()}-${base}.${fmt}`);
    let prevClash = null;
    if (fs.existsSync(expected)) {
      prevClash = clash;
      fs.renameSync(expected, clash);
    }

    const timeoutSec = Math.min(Math.max(Number(params.timeout) || 120, 5), 600);
    return new Promise((resolve) => {
      const args = [...sofficeArgs(), '--headless', '--norestore', '--convert-to', fmt, '--outdir', outDir, src];
      execFile(soffice.path, args, { timeout: timeoutSec * 1000, windowsHide: true }, (error, stdout, stderr) => {
        if (!fs.existsSync(expected)) {
          // 还原被移走的旧文件
          if (prevClash) { try { fs.renameSync(prevClash, expected); } catch { /* ignore */ } }
          return resolve(envelope({
            success: false,
            error: `转换失败：未生成 ${path.basename(expected)}。${(stderr || error?.message || stdout || '').toString().slice(0, 300)}`,
            metadata: { soffice: soffice.path, source: soffice.source },
          }));
        }
        if (prevClash) { try { fs.unlinkSync(prevClash); } catch { /* ignore */ } }
        resolve(envelope({
          success: true,
          result: {
            output_path: expected,
            format: fmt,
            size: fs.statSync(expected).size,
            source_file: src,
          },
          metadata: { soffice: soffice.path, source: soffice.source, versionHint: soffice.versionHint },
        }));
      });
    });
  }

  /** 图片阅读（视觉模型，经本地代理） */
  async executeImageReader(params) {
    const fs = require('node:fs');
    const { chatOnce } = require('../llm');
    const src = path.resolve(String(params.file_path || ''));
    const OK_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      return envelope({ success: false, error: `图片不存在: ${src}` });
    }
    if (!OK_EXT.test(src)) {
      return envelope({ success: false, error: `不支持的图片格式: ${path.extname(src) || '(无扩展名)'}` });
    }
    const size = fs.statSync(src).size;
    if (size > 20 * 1024 * 1024) {
      return envelope({ success: false, error: `图片过大（${Math.round(size / 1024 / 1024)}MB > 20MB）` });
    }
    const mime = /\.png$/i.test(src) ? 'image/png'
      : /\.jpe?g$/i.test(src) ? 'image/jpeg'
        : /\.webp$/i.test(src) ? 'image/webp'
          : /\.gif$/i.test(src) ? 'image/gif' : 'image/bmp';
    const dataUrl = `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`;
    const question = String(params.question || '请详细描述这张图片的内容。如有文字请转录，如有表格请转成 Markdown。');
    try {
      const store = require('../store');
      const result = await chatOnce(store, {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      });
      return envelope({ success: true, result: { answer: result.content, image: src, size }, metadata: { model: 'user-configured' } });
    } catch (error) {
      return envelope({
        success: false,
        error: error.code === 'LLM_NOT_CONFIGURED'
          ? '未配置模型：请在应用设置中配置支持视觉的模型（API Key/Base URL/模型名）后使用图片阅读'
          : `视觉模型调用失败: ${error.message}`,
      });
    }
  }

  /** 文件批量重命名（dry_run 预览默认开启） */
  async executeBatchRename(params) {
    const fs = require('node:fs');
    const folder = path.resolve(String(params.folder || ''));
    const mode = String(params.mode || '');
    const dryRun = params.dry_run !== false;
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return envelope({ success: false, error: `目录不存在: ${folder}` });
    }
    if (!['prefix', 'suffix', 'replace', 'sequence'].includes(mode)) {
      return envelope({ success: false, error: 'mode 必须是 prefix/suffix/replace/sequence' });
    }
    if (mode === 'replace' && params.find === undefined) {
      return envelope({ success: false, error: 'replace 模式需要 find 参数' });
    }
    if (mode === 'sequence' && !String(params.base_name || '').trim()) {
      return envelope({ success: false, error: 'sequence 模式需要 base_name 参数' });
    }

    const files = fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    if (!files.length) return envelope({ success: false, error: '目录中没有文件' });

    let index = Math.max(Number(params.start_index) || 1, 1);
    const plan = [];
    const used = new Set();
    for (const name of files) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let next;
      if (mode === 'prefix') next = String(params.prefix || '') + name;
      else if (mode === 'suffix') next = stem + String(params.suffix || '') + ext;
      else if (mode === 'replace') next = name.split(String(params.find)).join(String(params.replace_to ?? ''));
      else next = `${String(params.base_name)}-${String(index).padStart(3, '0')}${ext}`;
      if (next === name || used.has(next) || (next !== name && fs.existsSync(path.join(folder, next)))) {
        used.add(next);
        if (next === name) continue; // 无变化
        plan.push({ from: name, to: next, conflict: true, renamed: false });
        index += 1;
        continue;
      }
      used.add(next);
      plan.push({ from: name, to: next, renamed: false });
      index += 1;
    }
    const actionable = plan.filter((p) => p.from !== p.to && !p.conflict);

    if (dryRun) {
      return envelope({
        success: true,
        result: { dry_run: true, total: files.length, would_rename: actionable.length, plan, folder },
      });
    }
    const renamed = [];
    const failed = [];
    for (const item of actionable) {
      try {
        fs.renameSync(path.join(folder, item.from), path.join(folder, item.to));
        item.renamed = true;
        renamed.push(item);
      } catch (error) {
        item.error = error.message;
        failed.push(item);
      }
    }
    return envelope({
      success: failed.length === 0,
      result: { dry_run: false, total: files.length, renamed: renamed.length, failed: failed.length, plan, folder },
      error: failed.length ? `${failed.length} 个重命名失败` : null,
    });
  }
}

module.exports = { ToolRegistry, workspaceFolders, envelope };
