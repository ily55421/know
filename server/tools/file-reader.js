'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

const { DocumentNavigator } = require('../core/document-navigator');
const { readerInputSchema, documentVersion } = require('../core/reader-schema');
const { parseText, looksLikeText } = require('../core/loaders/text');
const { parsePdf } = require('../core/loaders/pdf');
const { parseDocx } = require('../core/loaders/docx');
const { parsePptx } = require('../core/loaders/pptx');
const { parseExcelPreview } = require('../core/loaders/excel');

/**
 * 原版对应物：src/tools/file_reader.py（FileReaderTool）
 *
 * 支持三个 action：read（默认）/ find / inspect，入参契约见 reader_schema.readerInputSchema()。
 */

// 原版常量（file_reader.py 模块级集合）
const TEXT_EXTS = new Set([
  '', '.sql', '.bat', '.rb', '.sass', '.dockerignore', '.ini', '.hpp', '.graphql', '.rst', '.vue', '.cpp', '.proto',
  '.tsx', '.kt', '.env', '.patch', '.markdown', '.lua', '.ps1', '.gitignore', '.ex', '.h', '.bash', '.svg', '.txt',
  '.r', '.groovy', '.c', '.htm', '.less', '.php', '.mm', '.gitattributes', '.dart', '.jl', '.zsh', '.scala', '.fish',
  '.yaml', '.scss', '.adoc', '.swift', '.m', '.cc', '.sh', '.json', '.conf', '.java', '.cmd', '.csv', '.erl', '.tsv',
  '.yml', '.svelte', '.properties', '.ts', '.jsx', '.rs', '.css', '.toml', '.log', '.thrift', '.editorconfig', '.diff',
  '.js', '.exs', '.py', '.cfg', '.md', '.xml', '.html', '.go',
]);
const IMAGE_EXTS = new Set(['.gif', '.heic', '.bmp', '.webp', '.jpg', '.tif', '.tiff', '.jpeg', '.ico', '.raw', '.png']);
const AV_EXTS = new Set([
  '.m4v', '.mov', '.wmv', '.webm', '.mp4', '.mkv', '.avi', '.flv',
  '.mp3', '.aac', '.flac', '.ogg', '.wav', '.wma', '.m4a',
]);
const ARCHIVE_EXTS = new Set(['.bz2', '.7z', '.rar', '.zip', '.gz', '.tgz', '.xz', '.tar']);
const BINARY_EXTS = new Set(['.dylib', '.db', '.dll', '.bin', '.dat', '.sqlite3', '.so', '.exe', '.sqlite']);
const EXCEL_EXTS = new Set(['.xlsx', '.xlsm', '.xls', '.et', '.ods']);
const CONVERT_FIRST_EXTS = new Set(['.doc', '.ppt']);

const DOC_CACHE_LIMIT = 32;
const docCache = new Map();

function formatModifiedTime(date) {
  // 原版：strftime('%Y-%m-%d %H:%M:%S')
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function extensionOf(filePath) {
  return nodePath.extname(filePath).toLowerCase();
}

class FileReaderTool {
  static get name() {
    return 'file_reader';
  }

  static get displayName() {
    return '文件内容读取';
  }

  static schema() {
    return {
      name: 'file_reader',
      display_name: '文件内容读取',
      description: '读取磁盘物理文件的正文。适用于未索引文件、临时产物和 Skill 等文件。',
      category: 'file_operation',
      parameters: readerInputSchema(),
    };
  }

  /** 解析 file_paths / targets 两类入参。 */
  static _parseTargets(parameters) {
    const targets = [];
    const rawTargets = parameters.targets;
    if (Array.isArray(rawTargets)) {
      for (const item of rawTargets) {
        if (!item || typeof item !== 'object') continue;
        const filePath = item.file_path;
        if (typeof filePath !== 'string' || !filePath.trim()) continue;
        targets.push({ file_path: filePath, inner_path: item.inner_path ?? null });
      }
    }
    const rawPaths = parameters.file_paths;
    if (Array.isArray(rawPaths)) {
      for (const item of rawPaths) {
        if (typeof item !== 'string' || !item.trim()) continue;
        targets.push({ file_path: item, inner_path: null });
      }
    } else if (typeof rawPaths === 'string' && rawPaths.trim()) {
      targets.push({ file_path: rawPaths, inner_path: null });
    }
    return targets;
  }

  /** 相对路径在工作目录列表中解析（原版 _resolve_path）。 */
  static _resolvePath(inputPath, userFolders = []) {
    const candidates = [];
    if (nodePath.isAbsolute(inputPath)) {
      candidates.push(inputPath);
    } else {
      for (const folder of Array.isArray(userFolders) ? userFolders : []) {
        if (typeof folder === 'string' && folder) candidates.push(nodePath.resolve(folder, inputPath));
      }
      candidates.push(nodePath.resolve(process.cwd(), inputPath));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** 扩展名 / 内容类型校验（原版 _validate_extension）。 */
  static _validateExtension(ext, filePath) {
    if (IMAGE_EXTS.has(ext)) {
      throw new Error(`未索引图片当前不支持读取: ${ext}。如果图片已建立 OCR 索引，可使用 rag_file_reader 读取文字`);
    }
    if (AV_EXTS.has(ext)) {
      throw new Error(`不支持读取音视频文件: ${ext}`);
    }
    if (ARCHIVE_EXTS.has(ext)) {
      throw new Error(`不支持直接读取压缩包: ${ext}。请先解压，或读取已索引的内部文件`);
    }
    if (BINARY_EXTS.has(ext)) {
      throw new Error(`不支持读取二进制文件: ${ext}`);
    }
    if (CONVERT_FIRST_EXTS.has(ext)) {
      const target = ext === '.doc' ? '.docx' : '.pptx';
      throw new Error(`${ext} 格式不支持直接读取，请先用 file_converter 转为 ${target} 或 txt`);
    }
    if (ext === '' || TEXT_EXTS.has(ext)) return 'text';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.docx') return 'docx';
    if (ext === '.pptx') return 'pptx';
    if (EXCEL_EXTS.has(ext)) return 'excel';
    return looksLikeText(filePath) ? 'text' : `unsupported:${ext}`;
  }

  /** 解析文件为规范化文本（原版 _load_document）。 */
  static async _loadDocument(filePath) {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}::${stat.size}::${stat.mtimeMs}`;
    const cached = docCache.get(cacheKey);
    if (cached) return cached;

    const ext = extensionOf(filePath);
    const kind = FileReaderTool._validateExtension(ext, filePath);
    if (typeof kind === 'string' && kind.startsWith('unsupported:')) {
      throw new Error(`不支持的文件类型: ${ext}`);
    }

    let parsed;
    if (kind === 'pdf') parsed = await parsePdf(filePath);
    else if (kind === 'docx') parsed = await parseDocx(filePath);
    else if (kind === 'pptx') parsed = await parsePptx(filePath);
    else if (kind === 'excel') parsed = await parseExcelPreview(filePath);
    else parsed = parseText(filePath);

    const document = {
      file_path: filePath,
      text: parsed.text,
      version: documentVersion(parsed.text),
      size: stat.size,
      modified_time: formatModifiedTime(stat.mtimeMs ? new Date(stat.mtimeMs) : new Date()),
      extension: ext || '无扩展名',
      kind: 'local_file',
      encoding: parsed.encoding ?? null,
      page_count: parsed.page_count ?? null,
      paragraph_count: parsed.paragraph_count ?? null,
      table_count: parsed.table_count ?? null,
      sheet_names: parsed.sheet_names ?? null,
      note: parsed.note ?? null,
    };

    docCache.set(cacheKey, document);
    while (docCache.size > DOC_CACHE_LIMIT) {
      const oldest = docCache.keys().next().value;
      docCache.delete(oldest);
    }
    return document;
  }

  /** 按 action 生成结果载荷（原版 _execute_action）。 */
  static _executeAction(action, document, parameters) {
    const navigator = new DocumentNavigator(document.text, document.file_path, document.version);
    const base = {
      file_path: document.file_path,
      version: document.version,
      kind: document.kind,
      size: document.size,
      modified_time: document.modified_time,
      extension: document.extension,
      ...(document.note ? { note: document.note } : {}),
    };
    if (action === 'inspect') {
      const payload = navigator.inspect(
        parameters.max_depth ?? 6,
        parameters.max_entries ?? 100,
      );
      return { ...base, ...payload };
    }
    if (action === 'find') {
      const payload = navigator.find({
        query: parameters.query,
        regex: parameters.regex,
        max_results: parameters.max_results,
        context_chars: parameters.context_chars,
      });
      return { ...base, ...payload };
    }
    const payload = navigator.read({
      pages: parameters.pages,
      heading: parameters.heading,
      chars: parameters.chars,
      start_line: parameters.start_line,
      end_line: parameters.end_line,
      cursor: parameters.cursor,
      max_length: parameters.max_length,
    });
    return { ...base, ...payload };
  }

  /**
   * 执行工具。
   * 返回 {success, result?, error?, metadata}，与原版 ToolResult 信封一致。
   */
  static async execute(parameters = {}, context = {}) {
    const action = parameters.action ?? 'read';
    if (!['inspect', 'read', 'find'].includes(action)) {
      return { success: false, error: 'action 只能是 inspect、read 或 find' };
    }
    const targets = FileReaderTool._parseTargets(parameters);
    if (targets.length === 0) {
      return { success: false, error: '必须提供 file_paths（或 targets）' };
    }
    const userFolders = Array.isArray(context.user_selected_folders) ? context.user_selected_folders : [];
    const results = [];
    const sources = [];

    for (const target of targets) {
      const raw = target.file_path;
      const resolved = FileReaderTool._resolvePath(raw, userFolders);
      if (!resolved) {
        results.push({ file_path: raw, error: `文件不存在: ${raw}` });
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch (err) {
        results.push({ file_path: raw, error: `文件不存在: ${raw}` });
        continue;
      }
      if (stat.isDirectory()) {
        results.push({
          file_path: raw,
          error: `路径是目录不是文件: ${raw}。目录浏览请使用 shell_executor`,
        });
        continue;
      }
      try {
        const document = await FileReaderTool._loadDocument(resolved);
        sources.push(resolved);
        results.push(FileReaderTool._executeAction(action, document, parameters));
      } catch (err) {
        results.push({ file_path: raw, error: `读取失败: ${err.message}` });
      }
    }

    const successCount = results.filter((item) => !item.error).length;
    const metadata = {
      sources,
      file_count: results.length,
      success_count: successCount,
      failure_count: results.length - successCount,
    };
    if (successCount === 0) {
      const detail = results.map((item) => item.error).filter(Boolean).join('; ');
      return {
        success: false,
        error: `所有文件均未能读取：${detail}`,
        result: { action, results },
        metadata,
      };
    }
    return { success: true, result: { action, results }, metadata };
  }
}

module.exports = { FileReaderTool, TEXT_EXTS, IMAGE_EXTS, AV_EXTS, ARCHIVE_EXTS, BINARY_EXTS, EXCEL_EXTS };
