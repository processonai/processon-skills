#!/usr/bin/env node
// mindcreate.mjs — 思维导图编排脚本
// AI 直接产出 Markdown，本脚本一条命令完成「取 theme → b64 编码 → 落库」。
// theme 只传主题名（6 选 1，默认「极简黑白」），完整 JSON 由脚本从
// references/mindmap_themes.json 原样取出，不经过 AI 上下文。
//
// 用法（新建思维导图）：
//   node mindcreate.mjs category=mind_free structure=mind_free theme=极简黑白 title='文件名' <<'POB64'
//   <Markdown 内容原样写在这，单引号 heredoc 不做转义/变量展开>
//   POB64
//
// 用法（编辑思维导图，全量重绘）：
//   node mindcreate.mjs chartId=xxx structure=mind_free theme=极简黑白 title='原标题' <<'POB64'
//   <全量更新后的 Markdown>
//   POB64
//
// title 等自由文本在命令行须加引号（posix 单引号 / Windows 双引号）。
// 脚本内部直连 MCP JSON-RPC，不经 shell，无注入风险。
//
// 有 chartId → 编辑模式（updateProcessOnFile）；无 chartId → 新建模式（createProcessOnFile）
// 思维导图不传 reqId、不调用 generatedDsl。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolText } from "./mcp.mjs";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

// 从 ../references/mindmap_themes.json 加载主题表
function loadThemes() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(dir, "references", "mindmap_themes.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// 主逻辑：读 stdin → 解析 theme 名 → 编码 → create/update
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  // 解析命令行参数
  const params = {};
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq > 0) params[arg.slice(0, eq)] = arg.slice(eq + 1);
  }

  const hasChartId = !!params.chartId;

  // theme：AI 只传主题名；脚本解析为完整 JSON（缺省走默认「极简黑白」）
  const themes = loadThemes();
  const themeName = params.theme || "极简黑白";
  const themeObj = themes[themeName];
  if (themeObj === undefined) {
    process.stdout.write(
      `ERROR:unknown_theme:${themeName}\n可用主题：${Object.keys(themes).join("、")}\n`,
    );
    process.exit(1);
  }
  const themeJson = JSON.stringify(themeObj);

  // 兜底：structure / category 缺省时取 mind_free
  const structure = params.structure || "mind_free";

  const tool = hasChartId ? "updateProcessOnFile" : "createProcessOnFile";
  const mcpArgs = {};

  if (hasChartId) {
    mcpArgs.chartId = params.chartId;
  } else {
    mcpArgs.category = params.category || "mind_free";
  }
  if (params.title) mcpArgs.title = params.title;
  mcpArgs.content = b64(input);
  mcpArgs.structure = structure;
  mcpArgs.theme = themeJson;

  try {
    const text = await getToolText(tool, mcpArgs);
    process.stdout.write(text);
  } catch (e) {
    process.stdout.write(e.message || String(e));
    process.exit(0);
  }
});
