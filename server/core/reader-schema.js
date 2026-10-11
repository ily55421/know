'use strict';

const crypto = require('node:crypto');

/**
 * 原版对应物：
 *   src/tools/reader_schema.py  —— 共享入参 schema + 紧凑 JSON 序列化
 *
 * 注意：原版 dumps_reader_result 使用 json.dumps(payload, ensure_ascii=False, indent=2)，
 * 但把 [178, 311] 这类“短原始值数组”压成一行，避免上下文浪费。
 */

function readerInputSchema() {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'find', 'inspect'],
        default: 'read',
        description:
          'read（默认）：读取全文，超长时用返回的 cursor 续读；find：关键词定位片段；inspect：章节目录。find/inspect 只在 read 被截断且只需局部内容时使用',
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '绝对路径或相对工作目录的文件路径，可批量',
      },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: 'read 可选：只读这些页码（PDF/PPTX）',
      },
      heading: {
        type: 'string',
        description: 'read 可选：只读该标题下的内容，需与 inspect 返回的 title 完全一致',
      },
      chars: {
        type: 'array',
        items: { type: 'integer' },
        minItems: 2,
        maxItems: 2,
        description: 'read 可选：只读 [起始, 结束] 字符区间，可直接使用 rag_search/find 返回的 chars',
      },
      start_line: { type: 'integer', minimum: 1, description: 'read 可选：起始行，1-based' },
      end_line: { type: 'integer', description: 'read 可选：结束行，包含' },
      cursor: { type: 'string', description: 'read 可选：上次结果 truncated 时返回的 cursor，用于续读' },
      query: { type: 'string', description: 'find 必填：关键词或正则' },
      regex: { type: 'boolean', default: false, description: 'find 可选：query 是否为正则' },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'find 最大命中数',
      },
      context_chars: {
        type: 'integer',
        minimum: 0,
        maximum: 2000,
        default: 200,
        description: 'find 每条命中的前后文字符数',
      },
      max_length: {
        type: 'integer',
        minimum: 1,
        maximum: 200000,
        default: 50000,
        description: 'read 单文件最大返回字符数',
      },
      max_depth: { type: 'integer', minimum: 1, maximum: 6, default: 6, description: 'inspect 最大标题深度' },
      max_entries: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'inspect 最大目录条目数',
      },
      targets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            inner_path: { type: 'string' },
          },
          required: ['file_path'],
        },
        description: '读取压缩包内部文件时代替 file_paths 使用，每项指定压缩包 file_path 和内部文件 inner_path',
      },
    },
    required: ['file_paths'],
  };
}

function isCompactList(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean',
  );
}

function _encodeCompact(value, depth) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const closePad = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isCompactList(value)) {
      return '[' + value.map((item) => _encodeCompact(item, depth + 1)).join(', ') + ']';
    }
    return (
      '[\n' + value.map((item) => pad + _encodeCompact(item, depth + 1)).join(',\n') + '\n' + closePad + ']'
    );
  }

  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (keys.length === 0) return '{}';
  return (
    '{\n' +
    keys.map((key) => pad + JSON.stringify(key) + ': ' + _encodeCompact(value[key], depth + 1)).join(',\n') +
    '\n' +
    closePad +
    '}'
  );
}

/** 复刻 dumps_reader_result：indent=2，短原始值数组保持一行。 */
function dumpsReaderResult(payload) {
  return _encodeCompact(payload, 0);
}

/** 复刻 document_version：sha256(text)[:16]，用于游标失效判断。 */
function documentVersion(text) {
  const value = typeof text === 'string' ? text : '';
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex').slice(0, 16);
}

module.exports = { readerInputSchema, dumpsReaderResult, documentVersion, isCompactList };
