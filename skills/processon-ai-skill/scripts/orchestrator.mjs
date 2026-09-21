#!/usr/bin/env node
// orchestrator.mjs — 流程图编排脚本
// 把 generatedDsl → createProcessOnFile/updateProcessOnFile 两步串成一条命令
// DSL 在脚本内部流转，不经过 AI 上下文
//
// 用法（新建流程图）：
//   node orchestrator.mjs category=flowbase title='文件名' <<'POB64'
//   <优化后的自然语言需求>
//   POB64
//
// 用法（编辑流程图情况二）：
//   node orchestrator.mjs chartId=xxx category=flowbase title='原标题' <<'POB64'
//   <修改要求>
//   POB64
//
// title 等自由文本在命令行须加引号（posix 单引号 / Windows 双引号）。
// 脚本内部直连 MCP JSON-RPC，不经 shell，无注入风险。
//
// 有 chartId → 编辑模式（generatedDsl + updateProcessOnFile）
// 无 chartId → 新建模式（generatedDsl + createProcessOnFile）

import { getToolText } from "./mcp.mjs";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

// 解析 generatedDsl 返回的文本，提取 dslContent 与 reqId
function parseGenResult(text) {
  const lines = text.split("\n");

  let dslStart = -1, diagramIdx = -1, reqIdIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("dslContent:") && dslStart === -1) dslStart = i;
    if (trimmed.startsWith("diagram:") && dslStart !== -1 && diagramIdx === -1) diagramIdx = i;
    if (trimmed.startsWith("reqId:") && reqIdIdx === -1) reqIdIdx = i;
  }

  if (dslStart === -1 || reqIdIdx === -1) return { dslContent: "", reqId: "" };

  const reqId = lines[reqIdIdx].replace(/^.*?reqId:\s*/, "").trim();

  const dslEnd = diagramIdx > dslStart ? diagramIdx : reqIdIdx;
  const firstLine = lines[dslStart].replace(/^.*?dslContent:\s*/, "");
  const dslLines = [firstLine, ...lines.slice(dslStart + 1, dslEnd)];
  const dslContent = dslLines.join("\n").trim();

  return { dslContent, reqId };
}

// 主逻辑：读 stdin → 编码 → generatedDsl → 解析 → 编码 → create/update
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

  try {
    // 步骤 1：generatedDsl
    const genArgs = {};
    if (params.category) genArgs.category = params.category;
    if (params.title) genArgs.title = params.title;
    if (hasChartId) genArgs.chartId = params.chartId;
    genArgs.content = b64(input);

    const genText = await getToolText("generatedDsl", genArgs);
    const { dslContent, reqId } = parseGenResult(genText);

    if (!dslContent || !reqId) {
      // 步骤 1 失败或输出格式异常 → 原样输出，交由 AI 处理
      process.stdout.write(genText);
      process.exit(0);
    }

    // 步骤 2：create 或 update（DSL 在脚本内部编码，不经过 AI）
    const tool = hasChartId ? "updateProcessOnFile" : "createProcessOnFile";
    const step2Args = {};

    if (hasChartId) {
      step2Args.chartId = params.chartId;
      step2Args.content = b64(dslContent);
      step2Args.reqId = reqId;
      if (params.title) step2Args.title = params.title;
    } else {
      if (params.category) step2Args.category = params.category;
      if (params.title) step2Args.title = params.title;
      step2Args.content = b64(dslContent);
      step2Args.reqId = reqId;
    }

    const step2Text = await getToolText(tool, step2Args);
    process.stdout.write(step2Text);
  } catch (e) {
    // 错误信息原样输出，交由 AI 按 errors.md 处理
    process.stdout.write(e.message || String(e));
    process.exit(0);
  }
});
