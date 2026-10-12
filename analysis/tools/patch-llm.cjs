// 给 chatStream 打补丁：budget 递增 + finish_reason 采集 + 长度截断重试
const fs = require('node:fs');
const p = 'E:/data/Knowly/server/llm.js';
let s = fs.readFileSync(p, 'utf8');

function replaceOnce(from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) { console.log('✗ 未找到锚点:', label); return false; }
  s = s.slice(0, i) + to + s.slice(i + from.length);
  console.log('✓', label);
  return true;
}

// 1) 预算变量
if (!s.includes('let budget = maxTokens;')) {
  replaceOnce(
    "  const MAX_ATTEMPTS = 3;\n  let lastError = null;",
    "  const MAX_ATTEMPTS = 3;\n  let lastError = null;\n  let budget = maxTokens; // 长度截断时自动加倍",
    'budget 变量',
  );
}

// 2) 请求用 budget
replaceOnce("        temperature,\n        max_tokens: maxTokens,\n        enable_thinking: enableThinking,\n      }, { retry: true, attempts: 2 });",
  "        temperature,\n        max_tokens: budget,\n        enable_thinking: enableThinking,\n      }, { retry: true, attempts: 2 });",
  'max_tokens -> budget');

// 3) 采集 finish_reason
replaceOnce("    let retryNeeded = false;\n\n    try {",
  "    let retryNeeded = false;\n    let finishReason = null;\n\n    try {",
  'finishReason 变量');

replaceOnce("        if (step?.done) return { content: full, reasoning };\n        const chunk = step?.chunk;\n        const delta = chunk?.choices?.[0]?.delta || {};",
  "        if (step?.done) break;\n        const chunk = step?.chunk;\n        const choice = chunk?.choices?.[0] || {};\n        const delta = choice.delta || {};\n        if (choice.finish_reason) finishReason = choice.finish_reason;",
  'finish_reason 采集');

// 4) 截断检测与重试
replaceOnce("      if (signal?.aborted) return { content: full, reasoning };\n      if (!retryNeeded) return { content: full, reasoning };",
  `      if (signal?.aborted) return { content: full, reasoning };

      // [重建版适配] 推理模型被 max_tokens 截断（推理耗尽预算、正文为空）→ 加倍上限重试
      if (!retryNeeded && finishReason === 'length' && !full.trim()) {
        if (attempt < MAX_ATTEMPTS && budget < 65536) {
          budget *= 2;
          lastError = new Error('模型输出达到长度上限，已自动提高上限重试');
          retryNeeded = true;
        } else {
          throw new Error('模型推理超出长度上限，未能产出正文（请提高模型最大输出长度或简化问题）');
        }
      }

      if (!retryNeeded) return { content: full, reasoning, finishReason };`,
  '截断重试逻辑');

fs.writeFileSync(p, s);
console.log('补丁完成');
