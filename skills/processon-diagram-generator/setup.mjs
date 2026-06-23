#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// 强制禁用 stdout/stderr 缓冲，解决 Windows PowerShell 环境下的输出延迟问题
try {
  if (process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') {
    process.stdout._handle.setBlocking(true);
  }
  if (process.stderr._handle && typeof process.stderr._handle.setBlocking === 'function') {
    process.stderr._handle.setBlocking(true);
  }
} catch (e) {
  // 忽略错误，保持兼容性
}

const config = {
  apiBase: process.env.PO_API_BASE_URL || "https://smart.processon.com",
  authBase: process.env.PO_AUTH_BASE_URL || "https://smart.processon.com/auth",
  tokenQueryPath: process.env.PO_TOKEN_QUERY_PATH || "/v1/token/temporary/query",
  mcpUrl: process.env.PO_MCP_URL || "https://smart.processon.com/mcp",
  serviceName: process.env.PO_SERVICE_NAME || "processon-diagram-generator",
  mcporterVersion: process.env.PO_MCPORTER_VERSION || "0.8.1",
  authPsk: process.env.PO_AUTH_PSK || "processon_mcp_psk_2026",
  autoWaitSeconds: Number.parseInt(process.env.PO_AUTO_WAIT_SECONDS || "90", 10),
  autoWaitInterval: Number.parseInt(process.env.PO_AUTO_WAIT_INTERVAL || "2", 10),
};

const userId = typeof process.getuid === "function" ? String(process.getuid()) : (process.env.USERNAME || process.env.USER || "user");
const stateDir = path.join(os.tmpdir(), `processon-diagram-generator-${userId}`);
const codeFile = path.join(stateDir, "current-code");
const tokenDir = path.join(os.homedir(), ".processon-diagram-generator");
const tokenFile = path.join(tokenDir, "token.json");

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&<>|^]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '\\"')}"`;
}

function run(command, args, options = {}) {
  const candidates = process.platform === "win32"
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];

  let lastResult;
  for (const candidate of candidates) {
    const result = process.platform === "win32"
      ? spawnSync([candidate, ...args.map(quoteWindowsArg)].join(" "), {
        encoding: "utf8",
        shell: true,
        stdio: options.stdio || "pipe",
      })
      : spawnSync(candidate, args, {
        encoding: "utf8",
        shell: false,
        stdio: options.stdio || "pipe",
      });

    lastResult = result;
    if (!result.error) {
      return result;
    }
  }

  return lastResult;
}

function runMcporter(args, options = {}) {
  const direct = run("mcporter", args, options);
  if (direct.status === 0) {
    return direct;
  }

  return run("npx", ["-y", `mcporter@${config.mcporterVersion}`, ...args], options);
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

function ensureTokenDir() {
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
}

function cleanup() {
  try {
    fs.rmSync(codeFile, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

function cleanupToken() {
  try {
    fs.rmSync(tokenFile, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

function saveLocalToken(token) {
  if (!token) {
    return false;
  }

  try {
    ensureTokenDir();
    const payload = {
      serviceName: config.serviceName,
      mcpUrl: config.mcpUrl,
      authorization: normalizeAuthorization(token),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(tokenFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readLocalToken() {
  try {
    const text = fs.readFileSync(tokenFile, "utf8").trim();
    if (!text) {
      return "";
    }

    try {
      const data = JSON.parse(text);
      return data?.authorization || data?.token || data?.apiKey || "";
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

function checkMcporter() {
  const existing = runMcporter(["--version"]);
  if (existing.status === 0) {
    return true;
  }

  const npm = run("npm", ["--version"]);
  if (npm.status !== 0) {
    writeStatus("ERROR:no_npm");
    return false;
  }

  const install = run("npm", ["install", "-g", `mcporter@${config.mcporterVersion}`]);
  if (install.status !== 0) {
    writeStatus("ERROR:install_failed");
    return false;
  }

  return runMcporter(["--version"]).status === 0;
}

function parseAuthorizationFromJson(text) {
  try {
    const data = JSON.parse(text);
    return data?.headers?.Authorization ||
      data?.headers?.authorization ||
      data?.server?.headers?.Authorization ||
      data?.server?.headers?.authorization ||
      "";
  } catch {
    return "";
  }
}

function getAuthorization() {
  const jsonResult = runMcporter(["config", "get", config.serviceName, "--json"]);
  if (jsonResult.status === 0) {
    const parsed = parseAuthorizationFromJson(jsonResult.stdout);
    if (parsed) {
      return parsed;
    }
  }

  const textResult = runMcporter(["config", "get", config.serviceName]);
  if (textResult.status !== 0) {
    return "";
  }

  const match = textResult.stdout.match(/^\s*Authorization:\s*(.+)$/im);
  return match ? match[1].trim() : "";
}

function checkService() {
  const authorization = getAuthorization();
  if (authorization) {
    saveLocalToken(authorization);
    return true;
  }

  return Boolean(readLocalToken());
}

function saveToken(token) {
  if (!token) {
    return false;
  }

  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const localSaved = saveLocalToken(authorization);

  const result = runMcporter([
    "config",
    "add",
    config.serviceName,
    config.mcpUrl,
    "--header",
    `Authorization=${authorization}`,
    "--transport",
    "http",
    "--scope",
    "home",
  ]);

  return (result.status === 0 && checkService()) || localSaved;
}

function shouldFallbackToNodeSpawn(result) {
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}\n${result?.error?.message || ""}`;
  return /Unable to parse --args|Expected property name|npx\.ps1|npm\.ps1|mcporter\.ps1|PSSecurityException|UnauthorizedAccess|not recognized|无法加载文件|无法将.+识别为|ENOENT/i.test(output);
}

function printCommandResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
    if (!result.stdout.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function writeStatus(line) {
  fs.writeSync(1, `${line}\n`, "utf8");
}

function normalizeAuthorization(value) {
  if (!value) {
    return "";
  }
  return value.startsWith("Bearer ") ? value : `Bearer ${value}`;
}

const nodeSpawnHttpScript = String.raw`
const http = require("node:http");
const https = require("node:https");

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

function requestJsonPost(url, payload, headers = {}) {
  const client = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    let responseMeta = null;
    const request = client.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      let responseBody = "";
      responseMeta = {
        statusCode: response.statusCode || 0,
        headers: response.headers || {},
      };
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        const contentLength = Buffer.byteLength(responseBody);
        const bodyPreview = responseBody.slice(0, 2000);
        const details = JSON.stringify({
          statusCode: responseMeta.statusCode,
          headers: responseMeta.headers,
          contentLength,
          bodyPreview,
        });

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error("http_error:" + details));
          return;
        }

        if (!responseBody.trim()) {
          reject(new Error("empty_response:" + details));
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          const eventData = responseBody
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .filter(Boolean)
            .join("\n")
            .trim();

          if (eventData) {
            try {
              resolve(JSON.parse(eventData));
              return;
            } catch {
              reject(new Error("invalid_sse_json:" + details));
              return;
            }
          }

          reject(new Error("invalid_json:" + details));
        }
      });
    });

    request.on("error", (error) => {
      reject(new Error("request_error:" + ((error && error.message) || "unknown")));
    });
    request.setTimeout(60000, () => {
      request.destroy(new Error("request_timeout"));
    });
    request.end(body);
  });
}

function extractMcpContent(result) {
  const content = result && result.result && result.result.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter((item) => item && item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!text) {
    return result;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

(async () => {
  try {
    const input = JSON.parse(await readStdin());
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.argsPayload,
      },
    };
    const result = await requestJsonPost(new URL(input.mcpUrl), payload, {
      Authorization: input.authorization,
    });
    const output = extractMcpContent(result);
    console.log(JSON.stringify(output || result, null, 2));
    process.exitCode = result && result.error ? 1 : 0;
  } catch (error) {
    console.log("ERROR:node_spawn_mcp_failed(" + ((error && error.message) || "unknown") + ")");
    process.exitCode = 1;
  }
})();
`;

async function callToolViaNodeSpawn(toolName, argsPayload) {
  const authorization = normalizeAuthorization(readLocalToken() || getAuthorization());
  if (!authorization) {
    writeStatus("ERROR:no_token_for_node_spawn_mcp");
    return 1;
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", nodeSpawnHttpScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let sawOutput = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      sawOutput = true;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      sawOutput = true;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      writeStatus(`ERROR:node_spawn_failed(${error?.message || "unknown"})`);
      resolve(1);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (!sawOutput && code !== 0) {
        writeStatus(`ERROR:node_spawn_exit_without_output(code=${code})`);
      }
      resolve(code === 0 ? 0 : 1);
    });

    child.stdin.end(JSON.stringify({
      mcpUrl: config.mcpUrl,
      authorization,
      toolName,
      argsPayload,
    }));
  });
}

async function callTool(toolName, argsPayload) {
  if (process.env.PO_FORCE_NODE_SPAWN === "1") {
    return callToolViaNodeSpawn(toolName, argsPayload);
  }

  const result = runMcporter([
    "call",
    `${config.serviceName}.${toolName}`,
    "--args",
    JSON.stringify(argsPayload),
    "--output",
    "json",
  ]);

  if (result.status === 0) {
    printCommandResult(result);
    return 0;
  }

  if (shouldFallbackToNodeSpawn(result)) {
    return callToolViaNodeSpawn(toolName, argsPayload);
  }

  printCommandResult(result);
  return 1;
}

function generateCode() {
  const randomId = crypto.randomBytes(8).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `po_mcp_${randomId}_${timestamp}`;
  const md5Hex = crypto.createHash("md5").update(config.authPsk).digest("hex");
  const ivHex = md5Hex.split("").reverse().join("");
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(md5Hex, "hex"),
    Buffer.from(ivHex, "hex"),
  );
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]).toString("base64");

  return encrypted.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateAuthUrl() {
  ensureStateDir();
  const code = generateCode();
  fs.writeFileSync(codeFile, `${code}\n`, { encoding: "utf8", mode: 0o600 });
  return `${config.authBase}?code=${code}&origin=skill`;
}

function startAuth() {
  cleanup();
  cleanupToken();
  try {
    const url = generateAuthUrl();
    writeStatus(`AUTH_REQUIRED:${url}`);
    return 0;
  } catch {
    writeStatus("ERROR:code_generation_failed");
    return 1;
  }
}

function readCode(explicitCode) {
  if (explicitCode) {
    return explicitCode;
  }

  try {
    const code = fs.readFileSync(codeFile, "utf8").trim();
    return code || "";
  } catch {
    return "";
  }
}

function requestJson(url) {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error("request_timeout"));
    });
  });
}

async function queryToken(code) {
  const url = new URL(config.tokenQueryPath, config.apiBase);
  url.searchParams.set("code", code);
  return requestJson(url);
}

function extractToken(payload) {
  return payload?.data?.token || "";
}

function errorCode(payload) {
  return payload?.code ? String(payload.code) : "";
}

function errorMessage(payload) {
  return payload?.message ? String(payload.message) : "";
}

async function fetchToken(explicitCode) {
  const code = readCode(explicitCode);
  if (!code) {
    writeStatus("ERROR:no_code");
    return 1;
  }

  let payload;
  try {
    payload = await queryToken(code);
  } catch {
    writeStatus("ERROR:network");
    return 1;
  }

  const token = extractToken(payload);
  if (token) {
    if (saveToken(token)) {
      cleanup();
      writeStatus("TOKEN_READY");
      return 0;
    }

    writeStatus("ERROR:save_token_failed");
    return 1;
  }

  const codeValue = errorCode(payload);
  if (codeValue === "401" || codeValue === "403") {
    cleanup();
    writeStatus("ERROR:invalid_code");
    return 1;
  }

  writeStatus(`ERROR:api(code=${codeValue || "unknown"},message=${errorMessage(payload) || "unknown"})`);
  return 1;
}

async function pollTokenOnce(explicitCode) {
  const code = readCode(explicitCode);
  if (!code) {
    writeStatus("ERROR:no_code");
    return 1;
  }

  let payload;
  try {
    payload = await queryToken(code);
  } catch {
    writeStatus("ERROR:network");
    return 1;
  }

  const token = extractToken(payload);
  if (token) {
    if (saveToken(token)) {
      cleanup();
      writeStatus("TOKEN_READY");
      return 0;
    }

    writeStatus("ERROR:save_token_failed");
    return 1;
  }

  writeStatus("TOKEN_PENDING");
  return 0;
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function waitForTokenAuto(explicitCode) {
  const code = readCode(explicitCode);
  if (!code) {
    writeStatus("ERROR:no_code");
    return 1;
  }

  let waited = 0;
  while (waited < config.autoWaitSeconds) {
    let payload;
    try {
      payload = await queryToken(code);
    } catch {
      writeStatus("ERROR:network");
      return 1;
    }

    const token = extractToken(payload);
    if (token) {
      if (saveToken(token)) {
        cleanup();
        writeStatus("TOKEN_READY");
        return 0;
      }

      writeStatus("ERROR:save_token_failed");
      return 1;
    }

    await sleep(config.autoWaitInterval);
    waited += config.autoWaitInterval;
  }

  writeStatus("ERROR:auth_timeout");
  return 1;
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case "processon_check_and_start_auth":
      if (!checkMcporter()) {
        return 1;
      }
      if (checkService()) {
        writeStatus("READY");
        return 0;
      }
      return startAuth();
    case "processon_wait_for_token_auto":
      return waitForTokenAuto(arg);
    case "processon_poll_token_once":
      return pollTokenOnce(arg);
    case "processon_fetch_token":
      return fetchToken(arg);
    case "processon_reauthorize":
      if (!checkMcporter()) {
        return 1;
      }
      return startAuth();
    case "processon_generate_chart":
      if (!arg) {
        writeStatus("ERROR:no_prompt");
        return 1;
      }
      return callTool("generate_chart", { prompt: arg });
    default:
      writeStatus("Usage: node setup.mjs [processon_check_and_start_auth|processon_poll_token_once|processon_wait_for_token_auto|processon_fetch_token|processon_reauthorize|processon_generate_chart]");
      return 1;
  }
}

process.exitCode = await main();
