'use strict';

/**
 * 本地资料索引引擎（重建版）。
 *
 * 学习流程（对齐渲染层 /index + /index-progress 契约）：
 *   遍历目录 → 按扩展名分类 → 复用已有文档解析器提取文本（txt/md/json/csv/html/docx/pptx/pdf/xlsx）
 *   → 存入本地索引 JSON（data/backend/index/<folder-hash>.json）→ 推进度状态机。
 *
 * 检索：基于索引文本的关键词全文匹配（多关键词 AND，命中位置生成 <mark> 片段与 confidence 评分）。
 * 说明：原版为向量语义检索（Python 服务 + embedding）；重建版先提供可用的关键词检索，
 * 接口形态与渲染层完全对齐（confidence/snippet/<mark>/source/indexed_folder/inner_path）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseText, looksLikeText } = require('./loaders/text');
const { parsePdf } = require('./loaders/pdf');
const { parseDocx } = require('./loaders/docx');
const { parsePptx } = require('./loaders/pptx');
const { parseExcelPreview } = require('./loaders/excel');

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.html', '.htm', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.css', '.sql', '.sh', '.bat', '.toml', '.env', '.rst', '.tex']);
const DOC_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);
const SKIP_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.ico', '.raw', '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.m4a', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.doc', '.ppt', '.xls', '.wps', '.et', '.dps']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 400000; // 单文件入索引上限（约 40 万字符）
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '$RECYCLE.BIN', 'System Volume Information', 'AppData', '.cache', 'dist', 'build']);

function folderKey(folder) {
  return crypto.createHash('sha1').update(path.resolve(folder).toLowerCase()).digest('hex').slice(0, 16);
}

class IndexEngine {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.state = this._idleState();
    this.abortFlag = false;
  }

  _idleState() {
    return {
      running: false,
      folder: null,
      progress: 0,
      status: '',
      file_stats: { success_count: 0, failure_count: 0, simplified_count: 0, total_count: 0 },
      success_files: [],
      failed_files: [],
      simplified_files: [],
      completed: false,
      error: null,
      doc_parse_failed: false,
    };
  }

  indexDir() {
    const dir = path.join(this.dataRoot, 'index');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  indexPath(folder) {
    return path.join(this.indexDir(), `${folderKey(folder)}.json`);
  }

  loadIndex(folder) {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath(folder), 'utf8'));
    } catch {
      return null;
    }
  }

  listIndexes() {
    const dir = this.indexDir();
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch { /* 跳过损坏索引 */ }
    }
    return out;
  }

  totalIndexedFiles() {
    return this.listIndexes().reduce((n, idx) => n + (idx.files || []).length, 0);
  }

  cleanAll() {
    const dir = this.indexDir();
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) {
        fs.unlinkSync(path.join(dir, f));
        removed += 1;
      }
    }
    this.state = this._idleState();
    return removed;
  }

  cancel() {
    this.abortFlag = true;
  }

  async parseFile(filePath, ext) {
    if (ext === '.pdf') return (await parsePdf(filePath)).text;
    if (ext === '.docx') return (await parseDocx(filePath)).text;
    if (ext === '.pptx') return (await parsePptx(filePath)).text;
    if (ext === '.xlsx') return (await parseExcelPreview(filePath)).text;
    if (TEXT_EXTS.has(ext)) return parseText(filePath).text;
    return null;
  }

  /** 后台索引目录；进度写入 this.state（渲染层轮询 /index-progress 消费）。 */
  async index(folder) {
    const abs = path.resolve(folder);
    this.abortFlag = false;
    this.state = {
      ...this._idleState(),
      running: true,
      folder: abs,
      status: '正在准备学习…',
      progress: 1,
    };
    const files = [];
    const walk = (dir, depth) => {
      if (this.abortFlag || depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (this.abortFlag) return;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
          continue;
        }
        if (entry.isFile()) files.push(full);
      }
    };
    walk(abs, 0);

    this.state.file_stats.total_count = files.length;
    this.state.status = `开始学习，共 ${files.length} 个文件`;

    const indexed = [];
    let i = 0;
    for (const filePath of files) {
      if (this.abortFlag) break;
      i += 1;
      const rel = path.relative(abs, filePath).replace(/\\/g, '/');
      const ext = path.extname(filePath).toLowerCase();
      this.state.progress = Math.min(99, Math.round((i / Math.max(1, files.length)) * 100));
      try {
        const stat = fs.statSync(filePath);
        if (SKIP_EXTS.has(ext) || stat.size > MAX_FILE_BYTES) {
          this.state.file_stats.simplified_count += 1;
          this.state.simplified_files.push(rel);
          continue;
        }
        if (!TEXT_EXTS.has(ext) && !DOC_EXTS.has(ext)) {
          // 未知扩展名：采样判断是否文本
          if (!looksLikeText(filePath)) {
            this.state.file_stats.simplified_count += 1;
            this.state.simplified_files.push(rel);
            continue;
          }
        }
        const text = await this.parseFile(filePath, ext);
        if (!text || !text.trim()) {
          this.state.file_stats.failure_count += 1;
          this.state.failed_files.push(rel);
          continue;
        }
        indexed.push({
          path: filePath,
          rel,
          size: stat.size,
          mtime: stat.mtimeMs,
          text: text.slice(0, MAX_TEXT_CHARS),
        });
        this.state.file_stats.success_count += 1;
        this.state.success_files.push(rel);
      } catch (error) {
        this.state.file_stats.failure_count += 1;
        this.state.failed_files.push(rel);
        if (ext === '.pdf' || ext === '.docx' || ext === '.pptx') this.state.doc_parse_failed = true;
      }
    }

    if (this.abortFlag) {
      this.state.running = false;
      this.state.completed = true;
      this.state.status = '学习已暂停';
      this.state.progress = 0;
      return this.state;
    }

    const payload = {
      folder: abs,
      updated_at: Date.now(),
      files: indexed,
    };
    fs.writeFileSync(this.indexPath(abs), JSON.stringify(payload), 'utf8');

    const { success_count, failure_count, simplified_count } = this.state.file_stats;
    this.state.progress = 100;
    this.state.running = false;
    this.state.completed = true;
    // 文案与渲染层 /index-progress 的完成解析正则严格对齐
    this.state.status = `学习完成！成功 ${success_count} 个，失败 ${failure_count} 个，精简 ${simplified_count} 个`;
    return this.state;
  }

  /** 关键词检索：多关键词 AND；返回渲染层所需字段（confidence / snippet 含 <mark>）。 */
  search(query, folder) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const indexes = folder && folder !== 'all'
      ? [this.loadIndex(folder)].filter(Boolean)
      : this.listIndexes();
    const results = [];
    for (const idx of indexes) {
      for (const file of idx.files || []) {
        const hay = file.text.toLowerCase();
        if (!terms.every((term) => hay.includes(term))) continue;
        const first = hay.indexOf(terms[0]);
        const from = Math.max(0, first - 120);
        const to = Math.min(file.text.length, first + 220);
        let snippet = file.text.slice(from, to);
        for (const term of terms) {
          snippet = snippet.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
        }
        let hits = 0;
        for (const term of terms) {
          let p = 0;
          while ((p = hay.indexOf(term, p)) >= 0) { hits += 1; p += term.length; }
        }
        const nameHit = terms.some((term) => file.rel.toLowerCase().includes(term));
        const confidence = Math.min(100, 40 + Math.min(hits, 10) * 5 + (nameHit ? 15 : 0));
        results.push({
          source: file.path,
          indexed_folder: idx.folder,
          inner_path: null,
          confidence,
          score: Math.max(0, 2 * (1 - confidence / 100)),
          snippet,
          matches: hits,
        });
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence).slice(0, 50);
  }

  /** 命中文件全文（渲染层 /search/file-text 消费 {success, content}）。 */
  fileText(folder, source) {
    const idx = this.loadIndex(folder);
    if (!idx) return null;
    const needle = path.resolve(String(source || ''));
    const file = (idx.files || []).find((f) => path.resolve(f.path) === needle || f.path === source || f.rel === source);
    return file ? file.text : null;
  }
}

module.exports = { IndexEngine, folderKey };
