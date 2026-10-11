'use strict';

/**
 * LibreOffice（soffice）安装路径自动探测。
 *
 * 探测顺序（Windows 实测优先级）：
 *   1. env KNOWLY_SOFFICE_PATH —— 显式指定
 *   2. PATH 中的 soffice / soffice.exe（where）
 *   3. 注册表 HKLM\SOFTWARE\LibreOffice\UNO\InstallPath（值为 <产品版本名>=<program 目录>；
 *      官方安装器总会写这里，且绿色/自定义安装路径也能命中）
 *   4. 标准安装路径（Program Files / Program Files (x86) / %LOCALAPPDATA%\Programs）
 *   5. macOS / Linux 常见路径与 which
 *
 * 注意：不要在探测阶段运行 `soffice --version` —— Windows 下它会挂起不返回；
 * 版本号直接取自注册表键名（如 "LibreOffice 25.8"）。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATE_DIRS_WIN = [
  'C:\\Program Files\\LibreOffice\\program',
  'C:\\Program Files (x86)\\LibreOffice\\program',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program'),
];
const CANDIDATES_UNIX = [
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

let cached = null;

function isExecutable(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function detectViaRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\LibreOffice\\UNO\\InstallPath'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    // 行形如：  LibreOffice 25.8    REG_SZ    D:\soft\LibreOffice\program（注意行首缩进、值名可含空格）
    // 优先取 ASCII 名称行（如 "LibreOffice 25.8"）作为版本提示；"(默认)"/乱码行仅作路径兜底
    let fallback = null;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(.+?)\s+REG_SZ\s+(.+)$/i);
      if (!m) continue;
      const exe = path.join(m[2].trim(), 'soffice.exe');
      if (!isExecutable(exe)) continue;
      const name = m[1].trim();
      const hint = /^[\x20-\x7E]+$/.test(name) && !/^\(/.test(name)
        ? name.replace(/^LibreOffice/i, '').trim()
        : null;
      if (hint) return { path: exe, source: 'registry', versionHint: hint };
      if (!fallback) fallback = { path: exe, source: 'registry', versionHint: null };
    }
    return fallback;
  } catch { /* 无注册表项或 reg 不可用 */ }
  return null;
}

function detectViaWhere() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('where', ['soffice.exe'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (isExecutable(p)) return { path: p, source: 'PATH' };
    }
  } catch { /* PATH 中没有 */ }
  return null;
}

function detectViaUnix() {
  if (process.platform === 'win32') return null;
  for (const p of CANDIDATES_UNIX) {
    if (isExecutable(p)) return { path: p, source: 'standard-path' };
  }
  try {
    const out = execFileSync('which', ['libreoffice'], { encoding: 'utf8', timeout: 8000 });
    const p = out.trim().split(/\r?\n/)[0];
    if (isExecutable(p)) return { path: p, source: 'PATH' };
  } catch { /* which 不可用 */ }
  return null;
}

/** 探测 soffice。返回 {found, path, source, versionHint} 或 {found:false, searched} */
function detectSoffice({ useCache = true } = {}) {
  if (useCache && cached) return cached;

  const searched = [];
  let result = null;

  const envPath = process.env.KNOWLY_SOFFICE_PATH;
  if (envPath) {
    searched.push(`env:${envPath}`);
    if (isExecutable(envPath)) result = { path: envPath, source: 'env' };
  }

  if (!result && process.platform === 'win32') {
    result = detectViaWhere();
    if (result) searched.push('PATH');
  }

  if (!result) {
    result = detectViaRegistry();
    if (result) searched.push('registry');
  }

  if (!result && process.platform === 'win32') {
    for (const dir of CANDIDATE_DIRS_WIN) {
      searched.push(dir);
      const exe = path.join(dir, 'soffice.exe');
      if (isExecutable(exe)) { result = { path: exe, source: 'standard-path' }; break; }
    }
  }

  if (!result) {
    result = detectViaUnix();
    if (result) searched.push('unix-paths');
  }

  cached = result
    ? { found: true, path: result.path, source: result.source, versionHint: result.versionHint || null }
    : { found: false, searched, path: null };

  return cached;
}

/** 独立用户配置目录：避免与用户已打开的 LibreOffice 实例冲突（否则 headless 会静默退出） */
function headlessProfileDir() {
  const dir = path.join(require('node:os').tmpdir(), 'knowly-recon-lo-profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sofficeArgs() {
  return process.platform === 'win32'
    ? ['-env:UserInstallation=file:///' + headlessProfileDir().replace(/\\/g, '/') + '/']
    : ['-env:UserInstallation=file://' + headlessProfileDir() + '/'];
}

module.exports = { detectSoffice, headlessProfileDir, sofficeArgs, isExecutable };
