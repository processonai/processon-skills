// mcp.mjs — ProcessOn MCP 直连客户端
//
// 绕过 mcporter，直接用 Node 原生 fetch 调 MCP JSON-RPC 接口。
// 优势：
//   1. Accept 只设 application/json，不发 GET /mcp 试探 SSE
//      → 规避灰度端点对 text/event-stream 回 406 导致的连接超时
//   2. 不依赖 mcporter 进程，少一层 spawn，更快更稳
//   3. 直接拿 JSON 响应，解析更可靠
//
// 多环境：端点与凭据都由 ./env.mjs 按「当前环境」解析——
//   凭据只从当前环境的槽位读取，端点不匹配时视为未授权，
//   绝不把某一环境的 apiKey 用到另一环境的端点上。
//
// 用法：
//   import { callTool, getToolText } from "./mcp.mjs";
//   const text = await getToolText("queryProcessOnFile", { title: "xxx" });
//   const raw  = await callTool("generatedDsl", { category, title, content });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv, readEnvAuthorization, serviceNameFor, DEFAULT_ENV_NAME } from "./env.mjs";

const MCPORTER_CONFIG = path.join(os.homedir(), ".mcporter", "mcporter.json");

// 当前环境（端点 + 凭据槽）
const ENV = resolveEnv();

// MCP 端点：由 env.mjs 按 PO_MCP_URL / 环境 profile / 内置预设解析
const MCP_URL = ENV.mcpUrl;

// 站点根地址（供导出等直连 HTTP 接口复用，与 MCP 端点同源）
export function resolveBaseUrl() {
  return ENV.apiBase;
}

// 当前环境信息（供排查与内部判断，不含凭据）
export function currentEnv() {
  return { envName: ENV.envName, envKey: ENV.envKey, origin: ENV.origin, mcpUrl: ENV.mcpUrl, apiBase: ENV.apiBase };
}

// 从 SKILL.md frontmatter 读版本号，作为 X-Skill-Version 上报
// 包内文件名大小写随载体而变（skill.md / SKILL.md），故两种都尝试，避免在区分大小写的系统上读不到。
function readSkillVersion() {
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const text = readSkillFile(dir);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const m = (fm ? fm[1] : "").match(/^version:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return m ? m[1].trim() : "unknown";
  } catch {
    return "unknown";
  }
}

// 按大小写两种写法查找 Skill 主文件
export function readSkillFile(skillRoot) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const file = path.join(skillRoot, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error(`SKILL.md not found in ${skillRoot}`);
}
const SKILL_VERSION = readSkillVersion();

// 请求来源标识（埋点字段，后端据此区分请求来自哪个宿主）
// 取值优先级：环境变量 PO_SOURCE > 包内渠道声明（渠道包带的 scripts/channel.json）> 内置默认 workbuddy。
// 所有出站请求只在这一处维护；其余脚本通过 import { SKILL_SOURCE } 复用。
function readPackagedChannel() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "channel.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return String(data?.channel || "").trim();
  } catch {
    return ""; // 非渠道包（官网 / 灰度等）无此文件 → 回落默认值
  }
}

function readSkillSource() {
  return (process.env.PO_SOURCE || readPackagedChannel() || "workbuddy").trim() || "workbuddy";
}
const SKILL_SOURCE = readSkillSource();
export { SKILL_SOURCE };

// 读取当前环境存储的 Authorization（Bearer xxx）
// 只有端点与当前环境一致的凭据才会被采用：
//   1) 本地凭据文件中该环境的槽位
//   2) mcporter 配置（服务名与端点 origin 都必须匹配当前环境）
export function readAuthorization() {
  // 1) 本地凭据文件中当前环境的槽位
  const local = readEnvAuthorization(ENV);
  if (local) return local;

  // 2) mcporter 配置：服务名与端点都要匹配当前环境，否则视为不属于本环境
  try {
    const data = JSON.parse(fs.readFileSync(MCPORTER_CONFIG, "utf8"));
    const servers = data?.mcpServers || data || {};
    const server = servers?.[serviceNameFor(ENV)];
    if (server) {
      const url = server.url || server.endpoint || "";
      // 端点不符 → 该凭据属于别的环境，不采用
      if (!url || originOfSafe(url) === ENV.origin) {
        const auth = server?.headers?.Authorization || server?.headers?.authorization || "";
        if (auth) return auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
      }
    }
  } catch { /* 无 mcporter 配置 → 未授权 */ }

  return "";
}

function originOfSafe(url) {
  try {
    return new URL(String(url)).origin.toLowerCase();
  } catch {
    return "";
  }
}

// 读取原始 apiKey（去掉 "Bearer " 前缀）
// 导出接口的 X-Mcp-ApiKey 头需要裸 apiKey，而非 Authorization 头。
export function readApiKey() {
  const auth = readAuthorization();
  if (!auth) return "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
}

// 调 MCP 工具，返回原始 JSON-RPC result 对象
export async function callTool(name, args = {}, { timeoutMs = 60000 } = {}) {
  const authorization = readAuthorization();
  if (!authorization) {
    const hint = ENV.envKey === DEFAULT_ENV_NAME
      ? "node scripts/get-token.mjs processon_check_and_start_auth"
      : `PO_ENV=${ENV.envKey} node scripts/get-token.mjs processon_check_and_start_auth`;
    throw new Error(`当前环境（${ENV.envName}）未授权，请先执行：${hint}`);
  }

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",          // 只声明 JSON，不试探 SSE
        "Authorization": authorization,
        "X-Skill-Version": SKILL_VERSION,
        "X-Source": SKILL_SOURCE,              // 请求来源标识（埋点用）
        "X-Env": ENV.envKey,                   // 环境标识（排查用，非凭据）
      },
      body: payload,
      signal: controller.signal,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`MCP 响应非 JSON: ${body.slice(0, 300)}`);
    }

    if (json.error) {
      throw new Error(`MCP 工具错误: ${json.error.message || JSON.stringify(json.error)}`);
    }

    return json.result;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`MCP 调用超时（${timeoutMs}ms）：${name}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 调工具并提取文本内容（大多数工具返回 text 类型内容）
export async function getToolText(name, args = {}, opts) {
  const result = await callTool(name, args, opts);
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  // 拼接所有 text 类型内容块
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
