'use strict';

const { NavigationError } = require('./navigation-error');

/**
 * 原版对应物：src/indexing/document_navigator.py
 *
 * 在“规范化的文档文本”上按页、标题、字符区间、行范围或关键词导航。
 * 规范化文本的约定（由各格式解析器产出）：
 *   - 页标记行：'====第N页===='（前后可带空白），经 _PAGE_RE 识别；
 *   - 标题行：Markdown 风格的 '# ' ~ '###### '，经 _HEADING_RE 识别。
 */

// 原版：_PAGE_RE  = re.compile(r'(?m)^={4,}\s*第\s*(\d+)\s*页\s*={4,}\s*$')
const PAGE_RE_SOURCE = '^={4,}\\s*第\\s*(\\d+)\\s*页\\s*={4,}\\s*$';
// 原版：_HEADING_RE = re.compile(r'(?m)^(#{1,6})[ \t]+(.+?)\s*$')
const HEADING_RE_SOURCE = '^(#{1,6})[ \\t]+(.+?)\\s*$';

const DEFAULT_MAX_LENGTH = 50000;
const MAX_MAX_LENGTH = 200000;
const DEFAULT_MAX_RESULTS = 20;
const MAX_MAX_RESULTS = 100;
const DEFAULT_CONTEXT_CHARS = 200;
const MAX_CONTEXT_CHARS = 2000;

/** 复刻 _clamp_int(value, default, minimum, maximum)。 */
function clampInt(value, defaultValue, minimum, maximum) {
  let parsed;
  if (typeof value === 'boolean') {
    parsed = value ? 1 : 0;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return defaultValue;
    parsed = Math.trunc(value);
  } else if (typeof value === 'string') {
    if (!/^[+-]?\d+$/.test(value.trim())) return defaultValue;
    parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isSafeInteger(parsed)) return defaultValue;
  } else {
    // 原版对 None / dict / list 调用 int() 会抛 TypeError，返回 default
    return defaultValue;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

/** 严格整数解析，语义近似 Python int(text)（失败抛错）。 */
function strictInt(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return Math.trunc(text);
  const raw = String(text).trim();
  if (!/^[+-]?\d+$/.test(raw)) throw new Error(`invalid int: ${text}`);
  return Number.parseInt(raw, 10);
}

/** 复刻 Python str.splitlines(keepends=True) 的行切分。 */
function splitLinesKeepEnds(text) {
  const breaks = new Set(['\n', '\r', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']);
  const result = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && !breaks.has(text[j])) j += 1;
    if (j < text.length) {
      if (text[j] === '\r' && text[j + 1] === '\n') j += 2;
      else j += 1;
    }
    result.push(text.slice(i, j));
    i = j;
  }
  return result;
}

function escapeRegExp(value) {
  // 近似 Python re.escape：转义所有正则元字符
  return String(value).replace(/[\\^$.*+?()[\]{}|/\-]/g, '\\$&');
}

class DocumentNavigator {
  constructor(text, filePath = '', version = '', innerPath = null) {
    this.text = typeof text === 'string' ? text : '';
    this.file_path = filePath;
    this.version = version;
    this.inner_path = innerPath;
    this._pages = this._parsePages();
    this._headings = this._parseHeadings();
  }

  /** 解析页标记 span（number/start/content_start/end）。 */
  _parsePages() {
    const matches = [...this.text.matchAll(new RegExp(PAGE_RE_SOURCE, 'gm'))];
    const pages = [];
    matches.forEach((match, index) => {
      const start = match.index;
      const contentStart = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : this.text.length;
      pages.push({
        number: Number.parseInt(match[1], 10),
        start,
        content_start: contentStart,
        end,
      });
    });
    return pages;
  }

  /** 解析标题 span（level/title/start/content_start/end）。 */
  _parseHeadings() {
    const matches = [...this.text.matchAll(new RegExp(HEADING_RE_SOURCE, 'gm'))];
    const headings = [];
    matches.forEach((match, index) => {
      const level = match[1].length;
      let end = this.text.length;
      for (let i = index + 1; i < matches.length; i += 1) {
        const later = matches[i];
        if (later[1].length <= level) {
          end = later.index;
          break;
        }
      }
      headings.push({
        level,
        title: match[2].trim(),
        start: match.index,
        content_start: match.index + match[0].length,
        end,
      });
    });
    return headings;
  }

  /** 位于 offset 处的页码（含标记行本身之后），无则 null。 */
  _pageAt(offset) {
    let current = null;
    for (const page of this._pages) {
      if (page.start > offset) break;
      current = page.number;
    }
    return current;
  }

  /** 位于 offset 处的标题（严格落在标题 span 内），无则 null。 */
  _headingAt(offset) {
    let current = null;
    for (const heading of this._headings) {
      if (heading.start > offset) break;
      if (offset < heading.end) current = heading.title;
    }
    return current;
  }

  /** 位置描述：'第N页 / 标题A / 标题B'，都为空时退化为 '字符 N'。 */
  locationAt(offset) {
    const parts = [];
    const page = this._pageAt(offset);
    const heading = this._headingAt(offset);
    if (page !== null && page !== undefined) parts.push(`第${page}页`);
    if (heading) parts.push(heading);
    return parts.join(' / ') || `字符 ${Math.max(0, offset)}`;
  }

  /** 章节目录：{total_chars, outline, page_count?, outline_truncated?, note?} */
  inspect(maxDepth = 6, maxEntries = 100) {
    const depth = clampInt(maxDepth, 6, 1, 6);
    const entries = clampInt(maxEntries, 100, 1, 500);
    const eligible = this._headings.filter((heading) => heading.level <= depth);
    const flat = eligible.slice(0, entries).map((heading) => {
      const entry = {
        level: heading.level,
        title: heading.title,
        chars: [heading.start, heading.end],
      };
      const page = this._pageAt(heading.start);
      if (page !== null) entry.page = page;
      return entry;
    });
    const outline = this._nestOutline(flat);
    const pageCount = new Set(this._pages.map((page) => page.number)).size;
    const result = { total_chars: this.text.length, outline };
    if (pageCount) result.page_count = pageCount;
    if (eligible.length > flat.length) result.outline_truncated = true;
    if (this._headings.length === 0) {
      result.note = pageCount
        ? `共 ${pageCount} 页，无标题结构，可按 pages 读取`
        : '无标题结构，可按 chars 或行范围读取';
    }
    return result;
  }

  /** 按 level 把扁平标题列表还原成树；无子节点时不带 children。 */
  _nestOutline(flat) {
    const roots = [];
    const stack = [];
    for (const entry of flat) {
      const level = Number.parseInt(entry.level, 10);
      const node = { ...entry };
      while (stack.length && stack[stack.length - 1][0] >= level) stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1][1];
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
      stack.push([level, node]);
    }
    return roots;
  }

  /** 游标：'v2:{version}:{offset}:{p|r}:{start-end,start-end}' */
  _encodeCursor(offset, ranges, pageMode) {
    const rangeSpec = ranges.map(([start, end]) => `${start}-${end}`).join(',');
    const mode = pageMode ? 'p' : 'r';
    return `v2:${this.version}:${offset}:${mode}:${rangeSpec}`;
  }

  _decodeCursor(cursor) {
    const parts = String(cursor || '').split(':', 5);
    if (
      parts.length !== 5 ||
      parts[0] !== 'v2' ||
      parts[1] !== this.version ||
      !['p', 'r'].includes(parts[3])
    ) {
      throw new NavigationError('续读游标已失效，请重新读取文档');
    }
    let offset;
    let ranges = [];
    try {
      offset = strictInt(parts[2]);
      for (const item of parts[4].split(',')) {
        const dash = item.indexOf('-');
        if (dash === -1) throw new Error('bad range');
        const start = strictInt(item.slice(0, dash));
        const end = strictInt(item.slice(dash + 1));
        if (start < 0 || start >= end || end > this.text.length) throw new Error('bad range');
        ranges.push([start, end]);
      }
    } catch (exc) {
      throw new NavigationError('续读游标格式无效');
    }
    if (ranges.length === 0) throw new NavigationError('续读游标格式无效');
    const pageMode = parts[3] === 'p';
    const selected = this._selectRanges(ranges, pageMode);
    if (offset < 0 || offset > selected.length) throw new NavigationError('续读游标超出文档范围');
    return [ranges, pageMode, offset];
  }

  /** 页模式：各段 strip 后用 '\n\n' 连接；非页模式只取第一段。 */
  _selectRanges(ranges, pageMode) {
    const parts = ranges.map(([start, end]) => {
      const slice = this.text.slice(start, end);
      return pageMode ? slice.trim() : slice;
    });
    return pageMode ? parts.join('\n\n') : parts[0];
  }

  /** 逻辑偏移（相对 selected 文本）→ 原文绝对偏移。 */
  _logicalOffsetToAbsolute(ranges, pageMode, offset) {
    if (!pageMode) {
      return Math.min(ranges[0][1], ranges[0][0] + offset);
    }
    let remaining = Math.max(0, offset);
    for (let index = 0; index < ranges.length; index += 1) {
      const [start, end] = ranges[index];
      const raw = this.text.slice(start, end);
      const segment = raw.trim();
      const leftTrim = raw.length - raw.replace(/^\s+/, '').length;
      if (remaining <= segment.length) {
        return Math.min(end, start + leftTrim + remaining);
      }
      remaining -= segment.length;
      if (index + 1 < ranges.length) {
        if (remaining <= 2) return ranges[index + 1][0];
        remaining -= 2;
      }
    }
    return ranges[ranges.length - 1][1];
  }

  /** 按标题（大小写不敏感、去除首尾空白）定位内容区间。 */
  _headingRange(title) {
    const normalized = String(title || '')
      .trim()
      .toLowerCase();
    const matches = this._headings.filter((heading) => heading.title.toLowerCase() === normalized);
    if (matches.length === 0) {
      throw new NavigationError(`未找到标题: ${title}`);
    }
    if (matches.length > 1) {
      const candidates = matches.slice(0, 10).map((item) => ({
        title: item.title,
        location: this.locationAt(item.start),
        chars: [item.start, item.end],
      }));
      throw new NavigationError(`标题不唯一，请改用 chars 精确读取。候选: ${JSON.stringify(candidates)}`);
    }
    return [matches[0].start, matches[0].end];
  }

  /** 页码列表 → 区间列表（包含页标记行）。 */
  _pageRanges(pageNumbers) {
    const requested = [];
    for (const value of pageNumbers) {
      let number;
      try {
        number = strictInt(value);
      } catch (exc) {
        throw new NavigationError(`页码必须是整数: ${value}`);
      }
      if (!requested.includes(number)) requested.push(number);
    }
    const byNumber = new Map();
    for (const page of this._pages) byNumber.set(page.number, [page.start, page.end]);
    const missing = requested.filter((number) => !byNumber.has(number));
    if (missing.length) throw new NavigationError(`页码不存在: ${JSON.stringify(missing)}`);
    return requested.map((number) => byNumber.get(number));
  }

  /** 行范围（1-based、含端点）→ 字符区间。 */
  _lineRange(startLine, endLine) {
    const lines = splitLinesKeepEnds(this.text);
    const total = lines.length;
    let start;
    let end;
    try {
      start = startLine === null || startLine === undefined ? 1 : strictInt(startLine);
      end = endLine === null || endLine === undefined ? total : strictInt(endLine);
    } catch (exc) {
      throw new NavigationError('start_line/end_line 必须是整数');
    }
    start = Math.max(1, start);
    end = Math.min(total, end);
    if (start > end) {
      throw new NavigationError(`start_line(${start}) 不能大于 end_line(${end})`);
    }
    if (start > total) {
      throw new NavigationError(`文件共 ${total} 行，请求起始行 ${start} 超出范围`);
    }
    const offsets = [0];
    for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length);
    return [offsets[start - 1], offsets[end]];
  }

  /**
   * read：读取正文，超长时返回 cursor 续读。
   * 返回 {content, location, truncated, chars?, cursor?, remaining_chars?}
   */
  read(params = {}) {
    const pages = params.pages ?? null;
    const heading = params.heading ?? null;
    const chars = params.chars ?? null;
    const startLine = params.start_line ?? null;
    const endLine = params.end_line ?? null;
    let cursor = params.cursor ?? null;
    let maxLength = params.max_length ?? DEFAULT_MAX_LENGTH;

    const selectors = [pages, heading, chars, cursor, startLine !== null || endLine !== null].filter(
      (value) => Boolean(value),
    ).length;
    if (selectors > 1) {
      throw new NavigationError('pages、heading、chars、行范围和 cursor 只能选择一种');
    }
    maxLength = clampInt(maxLength, DEFAULT_MAX_LENGTH, 1, MAX_MAX_LENGTH);

    let pageMode = false;
    let selectedOffset = 0;
    let ranges;
    if (cursor) {
      [ranges, pageMode, selectedOffset] = this._decodeCursor(cursor);
    } else if (pages) {
      pageMode = true;
      ranges = this._pageRanges(pages);
    } else if (heading) {
      ranges = [this._headingRange(heading)];
    } else if (chars) {
      if (!Array.isArray(chars) || chars.length !== 2) {
        throw new NavigationError('chars 必须是 [start, end]');
      }
      let start;
      let end;
      try {
        start = strictInt(chars[0]);
        end = strictInt(chars[1]);
      } catch (exc) {
        throw new NavigationError('chars 必须是整数范围');
      }
      start = Math.max(0, start);
      end = Math.min(this.text.length, end);
      if (start >= end) throw new NavigationError('chars 范围无效');
      ranges = [[start, end]];
    } else if (startLine !== null || endLine !== null) {
      ranges = [this._lineRange(startLine, endLine)];
    } else {
      ranges = [[0, this.text.length]];
    }

    const selected = this._selectRanges(ranges, pageMode);
    const remaining = selected.slice(selectedOffset);
    const truncated = remaining.length > maxLength;
    const content = remaining.slice(0, maxLength);
    const nextOffset = selectedOffset + content.length;
    const absoluteStart = this._logicalOffsetToAbsolute(ranges, pageMode, selectedOffset);
    const absoluteEnd = this._logicalOffsetToAbsolute(ranges, pageMode, nextOffset);
    const result = {
      content,
      location: this.locationAt(absoluteStart),
      truncated,
    };
    if (!pageMode) result.chars = [absoluteStart, absoluteEnd];
    if (truncated) {
      result.cursor = this._encodeCursor(nextOffset, ranges, pageMode);
      result.remaining_chars = selected.length - nextOffset;
    }
    return result;
  }

  /** find：关键词/正则定位，返回 {matches, total_matches, truncated?} */
  find(params = {}) {
    const query = String(params.query ?? '');
    if (!query) throw new NavigationError('find 的 query 不能为空');
    let maxResults = clampInt(params.max_results, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS);
    let contextChars = clampInt(params.context_chars, DEFAULT_CONTEXT_CHARS, 0, MAX_CONTEXT_CHARS);
    const isRegex = Boolean(params.regex);

    let pattern;
    try {
      pattern = new RegExp(isRegex ? query : escapeRegExp(query), 'gi');
    } catch (exc) {
      throw new NavigationError(`正则表达式无效: ${exc.message}`);
    }

    const results = [];
    let totalMatches = 0;
    let match;
    while ((match = pattern.exec(this.text)) !== null) {
      totalMatches += 1;
      if (results.length < maxResults) {
        const contextStart = Math.max(0, match.index - contextChars);
        const contextEnd = Math.min(this.text.length, match.index + match[0].length + contextChars);
        results.push({
          match: match[0],
          location: this.locationAt(match.index),
          chars: [contextStart, contextEnd],
          snippet: this.text.slice(contextStart, contextEnd),
        });
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
    }

    const result = { matches: results, total_matches: totalMatches };
    if (totalMatches > results.length) result.truncated = true;
    return result;
  }
}

module.exports = {
  DocumentNavigator,
  clampInt,
  splitLinesKeepEnds,
  PAGE_RE_SOURCE,
  HEADING_RE_SOURCE,
};
