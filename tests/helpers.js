'use strict';

/**
 * 测试公共工具：断言计数、样例文件检查与本地 HTTP 服务辅助。
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const express = require('express');
const store = require('../server/store');
const { ToolRegistry } = require('../server/tools/registry');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');

let assertionCount = 0;

/** 与 server/index.js 相同的路由装配（独立端口，供工具级测试使用）。 */
function createApp() {
  process.env.KNOWLY_DATA_ROOT = process.env.KNOWLY_DATA_ROOT || path.join(os.tmpdir(), 'knowly-helpers-');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const registry = new ToolRegistry();
  require('../server/routes/system').register(app, { store, registry });
  require('../server/routes/sessions').register(app, { store });
  require('../server/routes/qa').register(app, { store, registry });
  require('../server/routes/tasks').register(app, { store });
  require('../server/routes/files').register(app, { store });
  require('../server/routes/apps').register(app, { store });
  require('../server/routes/knowledge').register(app, { store });
  return app;
}

function expect(condition, message) {
  assertionCount += 1;
  assert.ok(condition, message);
}

function expectEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepStrictEqual(actual, expected, message);
}

function expectMatch(value, pattern, message) {
  assertionCount += 1;
  assert.match(String(value), pattern, message);
}

function expectIncludes(value, needle, message) {
  assertionCount += 1;
  assert.ok(String(value).includes(needle), `${message}（实际: ${String(value).slice(0, 300)}）`);
}

function assertionTotal() {
  return assertionCount;
}

function printAssertionSummary(label) {
  console.log(`[assertions] ${path.basename(label)}: ${assertionCount}`);
}

/** 样例文件缺失时自动生成，保证 `npm test` 可独立运行。 */
function ensureSamples() {
  const marker = path.join(SAMPLES, 'large.txt');
  if (!fs.existsSync(marker)) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-samples.js')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
  return SAMPLES;
}

function samplePath(name) {
  return path.join(SAMPLES, name);
}

async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getJson(baseUrl, route) {
  const response = await fetch(baseUrl + route);
  let json = null;
  try {
    json = await response.json();
  } catch (err) {
    json = null;
  }
  return { status: response.status, json };
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch (err) {
    json = null;
  }
  return { status: response.status, json };
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

module.exports = {
  ROOT,
  SAMPLES,
  expect,
  expectEqual,
  expectMatch,
  expectIncludes,
  assertionTotal,
  printAssertionSummary,
  ensureSamples,
  samplePath,
  startServer,
  getJson,
  postJson,
  readText,
  samplePathRaw: samplePath,
};
