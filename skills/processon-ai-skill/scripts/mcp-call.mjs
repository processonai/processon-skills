#!/usr/bin/env node
// mcp-call.mjs — 通用 MCP 工具调用包装
// 供 AI 直接调用单个 MCP 工具（目前主要用于编辑情况一：直接调 updateProcessOnFile）。
// 正常的新建/编辑流程请用 orchestrator.mjs / mindcreate.mjs。
//
// 用法：
//   node mcp-call.mjs <工具名> 参数1=值1 参数2=值2 ...
//
// 示例（编辑情况一：本地改文字，不调 generatedDsl，因此不传 reqId）：
//   node mcp-call.mjs updateProcessOnFile chartId=xxx title='原标题' \
//     content=$(node b64.mjs <<'POB64'
//   <修改后的 DSL>
//   POB64
//   )
//
// 注：heredoc 结束标记 POB64 必须顶格（行首无空格），否则 <<'POB64' 永不结束；
// 情况一未调用 generatedDsl，reqId 一律不传（也不要复用该图上一次的 reqId）。

import { getToolText } from "./mcp.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stdout.write("用法：node mcp-call.mjs <工具名> 参数1=值1 ...\n");
  process.exit(1);
}

const toolName = args[0];
const params = {};
for (const arg of args.slice(1)) {
  const eq = arg.indexOf("=");
  if (eq > 0) params[arg.slice(0, eq)] = arg.slice(eq + 1);
}

try {
  const text = await getToolText(toolName, params);
  process.stdout.write(text);
} catch (e) {
  process.stdout.write(e.message || String(e));
  process.exit(0);
}
