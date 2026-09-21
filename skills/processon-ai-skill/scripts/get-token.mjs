#!/usr/bin/env node
/*
 * ProcessOn Skill 授权脚本 —— 为 processon MCP 获取 apiKey（浏览器登录 + code 轮询换取）
 *
 * 机制（类 OAuth 设备授权流）：
 *   1. 本地生成一个加密 code（AES，密钥与后端约定）
 *   2. 拼授权链接（带 code），用户浏览器打开并登录授权
 *   3. 后端把 apiKey 与该 code 绑定
 *   4. 本地轮询「换取接口」，拿同一个 code 换到 apiKey
 *   5. 写入 mcporter 的 processon 配置（Authorization: Bearer）
 *
 * 本 Skill 只依赖 processon 这一个 MCP，本脚本即其 apiKey 的统一获取入口。
 *
 * 命令：
 *   node get-token.mjs processon_check_and_start_auth   # 已授权→READY；否则自动开浏览器并阻塞轮询（180s）
 *   node get-token.mjs processon_reauthorize            # 强制重新授权（只清当前环境的旧凭据）
 *   node get-token.mjs processon_wait_for_token_auto    # 兜底：浏览器未能自动打开时，展示链接后单独轮询（180s）
 *   node get-token.mjs processon_fetch_token            # 兜底：轮询超时后，用户确认已授权再换取一次
 *   node get-token.mjs processon_env_info               # 查看当前环境与各环境的授权情况（不含凭据）
 *
 * 多环境（正式 / 灰度 等）：
 *   凭据按环境分槽存放（token.json → environments[<envKey>]），互不覆盖；
 *   清理、检查、写入都只作用于当前环境，切换环境不会丢掉其他环境的授权。
 *   用 PO_ENV 切环境：PO_ENV=gray 等（缺省 prod）。
 *   用 PO_MCP_URL / PO_API_BASE_URL / PO_AUTH_BASE_URL 可覆盖单个端点。
 *   环境清单见 ~/.processon-skill/envs.json（可选，覆盖内置预设）。
 *
 * 输出约定（供 AI 解析）：
 *   READY                 已授权，直接使用
 *   TOKEN_READY           已换到 apiKey 并写入配置（授权完成，可继续后续任务）
 *   AUTH_REQUIRED:<url>    浏览器未能自动打开，需用户手动打开该链接登录（随后调 wait_for_token_auto 轮询）
 *   ERROR:auth_timeout    轮询超时未完成授权（uuid 有效期 180s），提示用户后可重新发起
 *   ERROR:*               其他错误
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SKILL_SOURCE, readSkillFile } from "./mcp.mjs";
import {
  resolveEnv, readStore, writeStore, getEnvRecord, setEnvRecord, clearEnvRecord,
  readEnvAuthorization, listEnvRecords, loadEnvironments, serviceNameFor, safeKey,
  originOf, normalizeUrl, siteUrls, PACKAGE_ENVS_FILE,
} from "./env.mjs";

/**
 * 从同目录 SKILL.md 的 frontmatter 读取 version，作为 X-Skill-Version 上报给服务端。
 * 包内文件名大小写随载体而变（skill.md / SKILL.md），故两种都尝试。
 * 读不到时返回 "unknown"（不阻断授权流程）。
 */
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

// 强制禁用 stdout/stderr 缓冲，解决 Windows PowerShell 输出延迟
try {
  if (process.stdout._handle && typeof process.stdout._handle.setBlocking === "function") {
    process.stdout._handle.setBlocking(true);
  }
  if (process.stderr._handle && typeof process.stderr._handle.setBlocking === "function") {
    process.stderr._handle.setBlocking(true);
  }
} catch {
  // 忽略
}

// 当前环境（正式 / 灰度 / 测试）：端点与凭据槽位都由它决定
const ENV = resolveEnv();

const config = {
  // 换取 apiKey 的接口所在服务（与当前环境一致）
  apiBase: ENV.apiBase,
  // 浏览器授权页（当前环境）
  authBase: ENV.authBase,
  // code 换 apiKey 的接口路径
  tokenQueryPath: process.env.PO_TOKEN_QUERY_PATH || "/api/personal/mcp/uuid/apikey",
  // 当前环境的 MCP 端点
  mcpUrl: ENV.mcpUrl,
  // mcporter 中的服务名：按环境区分，避免多环境注册时互相覆盖
  serviceName: process.env.PO_SERVICE_NAME || serviceNameFor(ENV),
  // 默认装 latest，与 setup.sh / setup.ps1 / setup.cjs 保持一致；
  // 需要钉某个版本时用 PO_MCPORTER_VERSION 覆盖（如 PO_MCPORTER_VERSION=0.12.3）
  mcporterVersion: process.env.PO_MCPORTER_VERSION || "latest",
  // 生成 code 的加密密钥（与后端约定，勿改）
  authPsk: process.env.PO_AUTH_PSK || "processon_mcp_psk_2026",
  autoWaitSeconds: Number.parseInt(process.env.PO_AUTO_WAIT_SECONDS || "180", 10),
  autoWaitInterval: Number.parseInt(process.env.PO_AUTO_WAIT_INTERVAL || "2", 10),
  // Skill 版本，注册 MCP 时作为 X-Skill-Version 头上报，供服务端定位版本问题
  skillVersion: readSkillVersion(),
  // 本地 token 快速路径有效期（天）：期内 check 直接 READY，不 spawn 任何进程；
  // token 若在服务端失效，后续 MCP 调用返回 -32001，再走完整重授权（懒校验）
  localTokenTtlDays: Number.parseInt(process.env.PO_LOCAL_TOKEN_TTL_DAYS || "7", 10),
  // mcporter 安装标记有效期（天）：期内跳过 `mcporter --version` 探测
  mcporterMarkerTtlDays: Number.parseInt(process.env.PO_MCPORTER_MARKER_TTL_DAYS || "30", 10),
};

const userId = typeof process.getuid === "function"
  ? String(process.getuid())
  : (process.env.USERNAME || process.env.USER || "user");
const stateDir = path.join(os.tmpdir(), `processon-skill-${userId}`);
// 授权 code 按环境隔离：多环境同时授权时不会互相覆盖
const codeFile = path.join(stateDir, `current-code-${safeKey(ENV.envKey)}`);
const mcporterMarkerFile = path.join(stateDir, "mcporter-ok");

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&<>|^]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function run(command, args, options = {}) {
  const candidates = process.platform === "win32"
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];
  let lastResult;
  for (const candidate of candidates) {
    const result = process.platform === "win32"
      ? spawnSync([candidate, ...args.map(quoteWindowsArg)].join(" "), { encoding: "utf8", shell: true, stdio: options.stdio || "pipe" })
      : spawnSync(candidate, args, { encoding: "utf8", shell: false, stdio: options.stdio || "pipe" });
    lastResult = result;
    if (!result.error) return result;
  }
  return lastResult;
}

function runMcporter(args, options = {}) {
  const direct = run("mcporter", args, options);
  if (direct.status === 0) return direct;
  return run("npx", ["-y", `mcporter@${config.mcporterVersion}`, ...args], options);
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

function cleanup() {
  try { fs.rmSync(codeFile, { force: true }); } catch { /* best effort */ }
}
// 只清当前环境的凭据槽，其他环境的授权原样保留
function cleanupToken() {
  try {
    const { store, removed } = clearEnvRecord(readStore(), ENV);
    if (removed) writeStore(store);
  } catch { /* best effort */ }
}

function normalizeAuthorization(value) {
  if (!value) return "";
  return value.startsWith("Bearer ") ? value : `Bearer ${value}`;
}

// 写入当前环境的槽位（其他环境不受影响）
function saveLocalToken(token) {
  if (!token) return false;
  try {
    const store = setEnvRecord(readStore(), ENV, { authorization: normalizeAuthorization(token) });
    writeStore(store);
    return true;
  } catch {
    return false;
  }
}

// 只读当前环境的凭据；端点不匹配的凭据一律不采用
function readLocalToken() {
  return readEnvAuthorization(ENV);
}

// mcporter 安装标记：命中则跳过 `mcporter --version` 进程探测
function mcporterInstalledCached() {
  try {
    const st = fs.statSync(mcporterMarkerFile);
    const ttlMs = config.mcporterMarkerTtlDays * 24 * 3600 * 1000;
    return Date.now() - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

function markMcporterInstalled() {
  try {
    ensureStateDir();
    fs.writeFileSync(mcporterMarkerFile, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* best effort */ }
}

// 本地 token 快速路径：当前环境槽位存在凭据且在 TTL 内。
// 仅作旁路加速，不做服务端校验——失效时后续 MCP 调用返回 -32001，再走完整授权。
function localTokenFresh() {
  try {
    const record = getEnvRecord(readStore(), ENV);
    if (!record?.authorization) return false;
    const updatedAt = Number(record.updatedAt) || 0;
    if (!updatedAt) return false;
    return Date.now() - updatedAt < config.localTokenTtlDays * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

function checkMcporter() {
  if (mcporterInstalledCached()) return true;

  const existing = runMcporter(["--version"]);
  if (existing.status === 0) { markMcporterInstalled(); return true; }

  const npm = run("npm", ["--version"]);
  if (npm.status !== 0) { console.log("ERROR:no_npm"); return false; }

  const install = run("npm", ["install", "-g", `mcporter@${config.mcporterVersion}`]);
  if (install.status !== 0) { console.log("ERROR:install_failed"); return false; }

  if (runMcporter(["--version"]).status === 0) { markMcporterInstalled(); return true; }
  return false;
}

function parseAuthorizationFromJson(text) {
  try {
    const data = JSON.parse(text);
    return data?.headers?.Authorization || data?.headers?.authorization
      || data?.server?.headers?.Authorization || data?.server?.headers?.authorization || "";
  } catch {
    return "";
  }
}

function parseUrlFromJson(text) {
  try {
    const data = JSON.parse(text);
    return data?.url || data?.server?.url || data?.endpoint || data?.server?.endpoint || "";
  } catch {
    return "";
  }
}

// 读取 mcporter 中当前环境的凭据：服务名按环境区分，且端点必须与当前环境一致，
// 否则视为属于别的环境、不采用（避免拿一个环境的 key 去打另一个环境）。
function getAuthorization() {
  const jsonResult = runMcporter(["config", "get", config.serviceName, "--json"]);
  if (jsonResult.status === 0) {
    const parsed = parseAuthorizationFromJson(jsonResult.stdout);
    if (parsed) {
      const url = parseUrlFromJson(jsonResult.stdout);
      return !url || originOf(url) === ENV.origin ? parsed : "";
    }
  }
  const textResult = runMcporter(["config", "get", config.serviceName]);
  if (textResult.status !== 0) return "";
  const match = textResult.stdout.match(/^\s*Authorization:\s*(.+)$/im);
  if (!match) return "";
  const urlLine = textResult.stdout.match(/^\s*(?:URL|Url|url|Endpoint|endpoint)\s*[:=]\s*(\S+)\s*$/m);
  if (urlLine && originOf(urlLine[1]) !== ENV.origin) return "";
  return match[1].trim();
}

function checkService() {
  const authorization = getAuthorization();
  if (authorization) { saveLocalToken(authorization); return true; }
  return Boolean(readLocalToken());
}

function saveToken(token) {
  if (!token) return false;
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const localSaved = saveLocalToken(authorization);
  const result = runMcporter([
    "config", "add", config.serviceName, config.mcpUrl,
    "--header", `Authorization=${authorization}`,
    "--header", `X-Skill-Version=${config.skillVersion}`,
    // 只声明 application/json，避免 SDK 试探 SSE（灰度端点对 text/event-stream 回 406 而非规范的 405）
    "--header", "accept=application/json",
    "--transport", "http", "--scope", "home",
  ]);
  return (result.status === 0 && checkService()) || localSaved;
}

function generateCode() {
  const byteLen = 4 + Math.floor(Math.random() * 4); // 4~7
  const randomId = crypto.randomBytes(byteLen).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `po_mcp_${randomId}_${timestamp}`;

  const md5Hex = crypto.createHash("md5").update(config.authPsk).digest("hex");
  const ivHex = md5Hex.split("").reverse().join("");
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(md5Hex, "hex"), Buffer.from(ivHex, "hex"));
  const encryptedBuf = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const base64Str = encryptedBuf.toString("base64");
  const result = base64Str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (result.length < 26 || result.length > 49) return generateCode();
  return result;
}

// 跨平台尽力打开系统默认浏览器；成功返回 true，失败（如无图形界面）返回 false
function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      return spawnSync("open", [url], { stdio: "ignore" }).status === 0;
    }
    if (process.platform === "win32") {
      const result = spawnSync(`start "" "${url}"`, { shell: true, stdio: "ignore", windowsHide: true });
      return !result.error && (result.status === 0 || result.status === null);
    }
    return spawnSync("xdg-open", [url], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function generateAuthUrl() {
  ensureStateDir();
  const code = generateCode();
  fs.writeFileSync(codeFile, `${code}\n`, { encoding: "utf8", mode: 0o600 });
  // 授权页是「给用户点击的 URL」，同样携带来源追踪参数：
  //   source=processon_skill     固定值，标识来自本 Skill
  //   payPointSource=<载体值>     与 X-Source 头同源（SKILL_SOURCE / PO_SOURCE）
  return `${config.authBase}?uuid=${code}&origin=skill&source=processon_skill&payPointSource=${encodeURIComponent(SKILL_SOURCE)}`;
}

async function startAuth() {
  cleanup();
  cleanupToken();
  let url;
  try {
    url = generateAuthUrl();
  } catch {
    console.log("ERROR:code_generation_failed");
    return 1;
  }
  // 载体内置浏览器路线：PO_EMBEDDED_BROWSER=1 时跳过系统浏览器，
  // 直接输出授权链接，交由 AI 用当前载体的内置浏览器打开（失败再降级系统浏览器）。
  // 否则：系统浏览器打开成功 → 脚本内阻塞轮询（最长 180s）拿 token；
  //       打开失败（如无图形界面）→ 回退为返回链接，交由 AI 展示、再走 wait_for_token_auto 兜底轮询。
  if (!process.env.PO_EMBEDDED_BROWSER && openBrowser(url)) {
    return waitForTokenAuto();
  }
  console.log(`AUTH_REQUIRED:${url}`);
  return 0;
}

function readCode(explicitCode) {
  if (explicitCode) return explicitCode;
  try {
    const code = fs.readFileSync(codeFile, "utf8").trim();
    return code || "";
  } catch {
    return "";
  }
}

function requestJson(url, extraHeaders = {}) {
  const client = url.protocol === "https:" ? https : http;
  const headers = { "X-Source": SKILL_SOURCE, ...extraHeaders };
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(15000, () => { request.destroy(new Error("request_timeout")); });
  });
}

async function queryToken(uuid) {
  const url = new URL(config.tokenQueryPath, config.apiBase);
  url.searchParams.set("uuid", uuid);
  return requestJson(url);
}

function extractToken(payload) {
  if (payload?.code === "200" && payload?.data) return payload.data;
  return "";
}
function errorCode(payload) { return payload?.code ? String(payload.code) : ""; }
function errorMessage(payload) { return payload?.message ? String(payload.message) : ""; }

async function fetchToken(explicitCode) {
  const code = readCode(explicitCode);
  if (!code) { console.log("ERROR:no_code"); return 1; }

  let payload;
  try { payload = await queryToken(code); } catch { console.log("ERROR:network"); return 1; }

  const token = extractToken(payload);
  if (token) {
    if (saveToken(token)) { cleanup(); console.log("TOKEN_READY"); return 0; }
    console.log("ERROR:save_token_failed");
    return 1;
  }

  const codeValue = errorCode(payload);
  if (codeValue === "401" || codeValue === "403") { cleanup(); console.log("ERROR:invalid_code"); return 1; }
  console.log(`ERROR:api(code=${codeValue || "unknown"},message=${errorMessage(payload) || "unknown"})`);
  return 1;
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function waitForTokenAuto(explicitCode) {
  const code = readCode(explicitCode);
  if (!code) { console.log("ERROR:no_code"); return 1; }

  let waited = 0;
  while (waited < config.autoWaitSeconds) {
    let payload;
    try { payload = await queryToken(code); } catch { console.log("ERROR:network"); return 1; }

    const token = extractToken(payload);
    if (token) {
      if (saveToken(token)) { cleanup(); console.log("TOKEN_READY"); return 0; }
      console.log("ERROR:save_token_failed");
      return 1;
    }
    await sleep(config.autoWaitInterval);
    waited += config.autoWaitInterval;
  }
  console.log("ERROR:auth_timeout");
  return 1;
}

// 环境概览：当前环境 + 各环境的授权情况（不含任何凭据）+ 当前环境的用户侧链接
function envInfo() {
  const profiles = loadEnvironments();
  const records = listEnvRecords();
  const fmtDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");
  const knownOrigins = new Set();
  const urls = siteUrls(ENV, SKILL_SOURCE);

  const lines = [
    `ENV:${ENV.envName}`,
    `ORIGIN:${ENV.origin}`,
    `MCP_URL:${ENV.mcpUrl}`,
    `AUTHORIZED:${readEnvAuthorization(ENV) ? "true" : "false"}`,
    `DEFAULT_ENV:${profiles.default}${fs.existsSync(PACKAGE_ENVS_FILE) ? " (包内 envs.json 声明)" : ""}`,
    "---",
    // 交给用户点击的链接一律取这里的值，禁止在文档或话术里硬编码域名
    "SITE_LINKS:",
    `- SITE_BASE\t${urls.base}`,
    `- ACCOUNT\t${urls.account}`,
    `- PAYMENT\t${urls.payment}`,
    `- UPGRADE\t${urls.upgrade}`,
    `- BUY_POINTS\t${urls.buyPoints}`,
    `- AUTH_PAGE\t${urls.auth}`,
    "---",
    "ENVIRONMENTS:",
  ];

  for (const [name, profile] of Object.entries(profiles.environments)) {
    const origin = originOf(profile.base || profile.apiBase || profile.mcpUrl || "");
    knownOrigins.add(origin);
    const record = records.find((r) => r.origin === origin);
    const isDefault = name === profiles.default ? " (默认)" : "";
    lines.push(`- ${name}${isDefault}\t${origin}\tauthorized=${record?.authorized ? "yes" : "no"}\tupdated=${fmtDate(record?.updatedAt)}`);
  }
  // 自定义环境（不在预设表内的已授权槽位）
  for (const record of records) {
    if (knownOrigins.has(record.origin)) continue;
    lines.push(`- ${record.envName}\t${record.origin}\tauthorized=${record.authorized ? "yes" : "no"}\tupdated=${fmtDate(record.updatedAt)}`);
  }

  console.log(lines.join("\n"));
  return 0;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  switch (command) {
    case "processon_check_and_start_auth":
      // 快速路径（旁路）：mcporter 安装标记有效 + 当前环境 token 在 TTL 内 → 直接 READY，
      // 不 spawn 任何进程。任一条件不满足则完整走下方原流程（探测 → 配置校验 → 授权）。
      if (mcporterInstalledCached() && localTokenFresh()) {
        console.log("READY");
        return 0;
      }
      if (!checkMcporter()) return 1;
      if (checkService()) { console.log("READY"); return 0; }
      return startAuth();
    case "processon_wait_for_token_auto":
      return waitForTokenAuto(arg);
    case "processon_fetch_token":
      return fetchToken(arg);
    case "processon_reauthorize":
      if (!checkMcporter()) return 1;
      return startAuth();
    case "processon_env_info":
      return envInfo();
    default:
      console.log("Usage: node get-token.mjs [processon_check_and_start_auth|processon_wait_for_token_auto|processon_fetch_token|processon_reauthorize|processon_env_info]");
      return 1;
  }
}

process.exitCode = await main();
