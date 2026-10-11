'use strict';

const fs = require('node:fs');
const iconv = require('iconv-lite');

/**
 * 原版对应物：FileReaderTool._parse_text / _looks_like_text
 *
 * 原版按 ['utf-8', 'gbk', 'gb18030', 'latin-1'] 顺序尝试严格解码，
 * 全部失败后用 utf-8 + errors='replace' 兜底，标签记为 'utf-8(replace)'；
 * 编码标签里 gb2312 / gb18030 统一显示为 'gbk'。
 */
const ENCODING_ORDER = ['utf-8', 'gbk', 'gb18030', 'latin-1'];
const TEXT_DETECT_SAMPLE_BYTES = 100000;

function normalizeEncodingLabel(encoding) {
  if (encoding === 'gb2312' || encoding === 'gb18030') return 'gbk';
  return encoding;
}

function tryDecodeStrict(buffer, encoding) {
  try {
    if (encoding === 'utf-8') {
      // TextDecoder 的 fatal 模式等价于 Python 的严格 utf-8 解码
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    const decoded = iconv.decode(buffer, encoding);
    if (decoded.includes('\uFFFD')) return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

/** 读取文本文件并判定编码。 */
function parseText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const sample = buffer.subarray(0, TEXT_DETECT_SAMPLE_BYTES);
  for (const encoding of ENCODING_ORDER) {
    const decoded = tryDecodeStrict(sample, encoding);
    if (decoded !== null) {
      const full = tryDecodeStrict(buffer, encoding);
      if (full !== null) {
        return {
          text: full,
          encoding: normalizeEncodingLabel(encoding),
          paragraph_count: undefined,
        };
      }
    }
  }
  return {
    text: buffer.toString('utf8'),
    encoding: 'utf-8(replace)',
    paragraph_count: undefined,
  };
}

/**
 * 近似 _looks_like_text：先试严格 utf-8，失败则按可打印字符比例（阈值 0.6）判定。
 * 返回 { is_text, encoding, confidence }。
 */
function looksLikeText(filePath, sampleSize = 8192) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(sampleSize);
  let read = 0;
  try {
    read = fs.readSync(fd, buffer, 0, sampleSize, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sample = buffer.subarray(0, read);
  if (sample.length === 0) return { is_text: true, encoding: 'utf-8', confidence: 1 };
  const strict = tryDecodeStrict(sample, 'utf-8');
  if (strict !== null) return { is_text: true, encoding: 'utf-8', confidence: 1 };

  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e) || byte >= 0x80) {
      printable += 1;
    }
  }
  const confidence = printable / sample.length;
  return { is_text: confidence >= 0.6, encoding: 'unknown', confidence };
}

module.exports = { parseText, looksLikeText, normalizeEncodingLabel, ENCODING_ORDER };
