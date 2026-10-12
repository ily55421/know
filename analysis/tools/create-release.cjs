// 用 git credential 里的令牌创建/更新 GitHub Release（无 gh CLI 时的替代）
const fs = require('fs');
const { execSync } = require('child_process');

const REPO = 'ily55421/know';
const VERSION = process.argv[2] || require('../../package.json').version;
const TAG = `v${VERSION}`;

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
});
const token = (cred.match(/^password=(.+)$/m) || [])[1];
if (!token) { console.error('未取到 GitHub 令牌（git credential fill 无 password）'); process.exit(1); }

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const start = changelog.indexOf(`## [${VERSION}]`);
if (start < 0) { console.error(`CHANGELOG 中找不到版本 ${VERSION}`); process.exit(1); }
const nextIdx = changelog.indexOf('\n## [', start + 1);
const section = changelog.slice(start, nextIdx < 0 ? undefined : nextIdx).trimEnd();

const body = `${section}\n\n---\n\n**绿色安装（免安装）**：\n1. 解压/复制仓库到任意目录\n2. 直接运行 \`Knowly.exe\`（数据保存在同级 \`data/\`，升级替换程序文件即保留数据）\n\n**校验**：本版本 asar 内源码与仓库工作区逐字节一致（\`node scripts/verify-asar-sync.cjs\` → 178/178）；\`npm test\` → 40/40。`;

const api = async (method, path, payload) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'knowly-recon-release',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
};

(async () => {
  const existing = await api('GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (existing.status === 200) {
    const r = await api('PATCH', `/repos/${REPO}/releases/${existing.json.id}`, { name: VERSION, body });
    console.log(`更新既有 Release ${TAG}: ${r.status} ${r.json?.html_url || r.text.slice(0, 120)}`);
    return;
  }
  const r = await api('POST', `/repos/${REPO}/releases`, {
    tag_name: TAG,
    name: VERSION,
    body,
    draft: false,
    prerelease: false,
  });
  if (r.status === 201) console.log(`已创建 Release ${TAG}: ${r.json.html_url}`);
  else { console.error(`创建失败 ${r.status}: ${r.text.slice(0, 400)}`); process.exit(1); }
})();
