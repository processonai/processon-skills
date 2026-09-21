#!/usr/bin/env node
// query.mjs — 查询 ProcessOn 文件
//
// 用法：
//   node query.mjs title='搜索关键词'
//
// 直连 MCP JSON-RPC，不经 mcporter，规避 SSE 406 问题。

import { getToolText } from "./mcp.mjs";

// 解析命令行参数
const params = {};
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf("=");
  if (eq > 0) params[arg.slice(0, eq)] = arg.slice(eq + 1);
}

const title = params.title || params.t || "";
if (!title) {
  process.stdout.write("用法：node query.mjs title='搜索关键词'\n");
  process.exit(1);
}

try {
  const text = await getToolText("queryProcessOnFile", { title });
  process.stdout.write(text);
} catch (e) {
  process.stdout.write(e.message || String(e));
  process.exit(0);
}
