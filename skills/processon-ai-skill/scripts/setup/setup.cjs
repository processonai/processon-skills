#!/usr/bin/env node
/*
 * ProcessOn Skill 环境配置脚本 (Node.js, 跨平台兜底)
 *
 * 作用：把本 Skill 依赖的 MCP 服务注册到 mcporter。
 *   - processon ：生成图数据 / 版本自检 / apiKey 校验 / 新建 / 编辑 / 查询
 *
 * 认证说明：
 *   apiKey 由 get-token.mjs 自动授权获取（浏览器登录 + 轮询换取），本脚本不收集 apiKey。
 *   本脚本负责：确保 mcporter 存在 → 注册 processon 端点。
 *   若检测到已有凭据（可能来自 mcporter 自身或其他宿主导入的配置），
 *   会先直连调用 check 工具实测其是否可用：有效则沿用，失效则丢弃，
 *   并提示由 AI 执行：node get-token.mjs processon_check_and_start_auth
 *
 * 用法：
 *   1) 直接运行：           node setup.cjs
 *   2) 指定环境（正式 / 灰度 等，凭据按环境隔离）：
 *                           PO_ENV=gray node setup.cjs
 *   3) 覆盖端点：           PROCESSON_BASE_URL=http://your-host node setup.cjs
 *
 * 安全：apiKey 仅写入 mcporter 配置，不回显、不写入其他文件。
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { pathToFileURL } = require("url");

// 给无协议头的地址补协议：私有 IP / localhost 补 http://，域名补 https://
function normalizeUrl(url) {
  if (!url) return "";
  const trimmed = String(url).trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  const host = trimmed.split("/")[0].split(":")[0];
  const useHttp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === "localhost" || host === "127.0.0.1";
  return `${useHttp ? "http" : "https"}://${trimmed}`;
}
const PROCESSON_BASE_URL = normalizeUrl(process.env.PROCESSON_BASE_URL || "www.processon.com");

// 以下三项在启动时由 env.mjs 按当前环境解析（正式 / 灰度 / 测试）
let PROCESSON_MCP_URL = `${PROCESSON_BASE_URL}/api/activity/mcp`;
let SERVICE_NAME = "processon";
let ENV_NAME = "prod";

// 从 Skill 根目录 SKILL.md（本脚本上两级）的 frontmatter 读取 version，作为 X-Skill-Version 上报给服务端
// 包内文件名大小写随载体而变（skill.md / SKILL.md），故两种都尝试。
function readSkillText(skillRoot) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const file = path.join(skillRoot, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error("SKILL.md not found");
}

function readSkillVersion() {
  try {
    const text = readSkillText(path.join(__dirname, "..", ".."));
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const m = (fm ? fm[1] : "").match(/^version:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return m ? m[1].trim() : "unknown";
  } catch {
    return "unknown";
  }
}
const SKILL_VERSION = readSkillVersion();

function haveCmd(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [name], { stdio: "ignore" }).status === 0;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
}

function fail(msg) {
  console.error(`  ❌ ${msg}`);
  process.exit(1);
}

function ensureMcporter() {
  if (haveCmd("mcporter")) return;
  if (haveCmd("npm")) {
    console.log("  未找到 mcporter，正在安装...");
    if (run("npm", ["install", "-g", "mcporter"]).status !== 0) {
      fail("mcporter 安装失败，请手动执行：npm install -g mcporter");
    }
    console.log("  mcporter 安装完成");
  } else {
    fail("未找到 mcporter，且当前环境没有 npm，无法自动安装。请先安装 Node.js 后重试。");
  }
}

// 读取已有配置中的 Authorization，注册时保留原 apiKey
function existingAuthorization() {
  const result = runCapture("mcporter", ["config", "get", SERVICE_NAME]);
  if (result.status !== 0 || !result.stdout) return "";
  const match = result.stdout.match(/^\s*Authorization:\s*(.+)$/im);
  return match ? match[1].trim() : "";
}

// 验证 apiKey 是否真实可用（直连调 check，不建临时配置）
// 判据：鉴权失败信号 -32001 / ApiKey解析失败 / Unauthorized
function validateApiKey(rawAuth) {
  const candidate = String(rawAuth || "").replace(/^Bearer\s+/i, "").trim();
  if (!candidate) return Promise.resolve(false);

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(PROCESSON_MCP_URL);
    } catch {
      resolve(false);
      return;
    }
    const client = target.protocol === "https:" ? https : http;
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      params: { name: "check", arguments: {} },
      method: "tools/call",
    });

    const request = client.request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${candidate}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        // 先判成功：check 正常返回含 "result"
        // （其正文本身含 "ApiKey" 字样，故不能用 ApiKey 作为失败判据）
        // 其余一律视为不可用（含 -32001 / ApiKey解析失败 / Unauthorized 等）
        resolve(Boolean(body) && body.includes('"result"'));
      });
    });
    request.on("error", () => resolve(false));
    request.setTimeout(15000, () => { request.destroy(); resolve(false); });
    request.write(payload);
    request.end();
  });
}

async function registerMcp() {
  const existingAuth = existingAuthorization();
  let validAuth = "";

  if (existingAuth) {
    console.log("  检测到已有凭据，正在验证是否可用...");
    if (await validateApiKey(existingAuth)) {
      validAuth = existingAuth;
      console.log("  验证通过，沿用现有凭据");
    } else {
      console.log("  现有凭据已失效，将丢弃");
    }
  }

  console.log(`  注册 ${SERVICE_NAME}（环境：${ENV_NAME}）→ ${PROCESSON_MCP_URL}`);
  // remove 允许失败（配置本来可能不存在），不检查退出码
  run("mcporter", ["config", "remove", SERVICE_NAME]);

  const args = ["config", "add", SERVICE_NAME, PROCESSON_MCP_URL,
    // 只声明 application/json，避免 SDK 试探 SSE（灰度端点对 text/event-stream 回 406 而非规范的 405）
    "--header", "accept=application/json",
    "--header", `X-Skill-Version=${SKILL_VERSION}`,
    "--transport", "http", "--scope", "home"];
  if (validAuth) {
    args.splice(4, 0, "--header", `Authorization=${validAuth}`);
  }
  // config add 必须成功，失败即终止并如实报错（stderr 已透传给用户）
  const added = run("mcporter", args);
  if (added.status !== 0) {
    fail(`注册 ${SERVICE_NAME} 失败（mcporter 退出码 ${added.status}）。请检查 mcporter 是否可用，或手动执行：\n     mcporter ${args.join(" ")}`);
  }

  if (!validAuth) {
    const hint = ENV_NAME === "prod"
      ? "node get-token.mjs processon_check_and_start_auth"
      : `PO_ENV=${ENV_NAME} node get-token.mjs processon_check_and_start_auth`;
    console.log(`  尚未授权：请执行 ${hint} 完成授权`);
  }
}

(async () => {
  console.log("");
  console.log("===== ProcessOn Skill 环境配置 =====");
  console.log("");
  // 按当前环境解析端点与服务名（与授权、调用侧共用同一套解析）
  try {
    const envModule = await import(pathToFileURL(path.join(__dirname, "..", "env.mjs")).href);
    const env = envModule.resolveEnv();
    ENV_NAME = env.envName;
    PROCESSON_MCP_URL = env.mcpUrl;
    SERVICE_NAME = envModule.serviceNameFor(env);
  } catch {
    // env.mjs 不可用 → 退回内置正式环境
  }
  ensureMcporter();
  await registerMcp();
  console.log("");
  console.log(`  配置完成。已注册 MCP：${SERVICE_NAME}（环境：${ENV_NAME}）`);
  console.log(`  验证：可让 AI 调用 ${SERVICE_NAME} 的 check 工具确认 apiKey 是否生效。`);
  console.log("");
})();
