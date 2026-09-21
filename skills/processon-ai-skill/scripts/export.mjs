#!/usr/bin/env node
// export.mjs — 导出 ProcessOn 文件为图片 / PDF 并下载到本地
//
// 用法：
//   node export.mjs chartId=<文件id> type=png
//
// type 可选 png / svg / pdf，默认 png。
// 调导出接口（普通 HTTP GET，header X-Mcp-ApiKey），把返回的每张画布图片下载到 ~/Downloads/。
// type=pdf 时的链路：后端导出 svg → 本地 scripts/svg2pdf.mjs 转 PDF → 落 ~/Downloads/<name>.pdf；
//   临时 svg 用完即删，输出中只含 PDF 本地路径、不含任何图片 URL。
// 输出结构化文本供 AI 解析：member / type / canvasNum / canvasLimit + 每个画布的 title/url/file（pdf 模式无 url）。

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readApiKey, resolveBaseUrl, currentEnv, SKILL_SOURCE } from "./mcp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const EXPORT_BASE_URL = resolveBaseUrl();
const EXPORT_PATH = "/api/activity/mcp/skill/feature/export/img";
const DOWNLOAD_DIR = process.env.PO_EXPORT_DIR || path.join(os.homedir(), "Downloads");

// 按协议选 http / https 模块（下载图片地址可能是 https）
function pickClient(url) {
  return /^https:/i.test(url) ? https : http;
}

// 解析命令行参数（参数=值）
function parseArgs(argv) {
  const params = {};
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq > 0) params[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return params;
}

// 净化后端返回的 title，作为安全文件名（去路径非法字符，防路径穿越）
function sanitizeTitle(title) {
  return String(title || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.{2,}/g, "_")
    .trim();
}

// GET 请求（文本/JSON 场景）
function getText(url, headers) {
  return new Promise((resolve, reject) => {
    const req = pickClient(url).get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("request_timeout")));
  });
}

// 下载二进制文件到 dest，成功返回 true
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = pickClient(url).get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          fs.writeFileSync(dest, Buffer.concat(chunks));
          resolve(true);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("download_timeout")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 组装绝对图片地址（后端可能返回相对路径）
function absoluteUrl(u) {
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `${EXPORT_BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  const chartId = params.chartId || "";
  // pdf 模式：后端导 svg，本地转 PDF
  const wantPdf = params.type === "pdf";
  const type = params.type === "svg" ? "svg" : "png";
  const ext = wantPdf ? "pdf" : type;
  // 可选：覆盖落盘文件名。默认取画布标题（多为「画布1」这类无意义名字），
  // 传 name=<文件标题> 可让下载到的图片直接可辨认。
  const nameOverride = sanitizeTitle(params.name || "");

  if (!chartId) {
    process.stdout.write("用法：node export.mjs chartId=<文件id> type=png|svg|pdf [name=<文件名>]\n");
    process.exit(1);
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    const env = currentEnv();
    const hint = env.envKey === "prod"
      ? "node scripts/get-token.mjs processon_check_and_start_auth"
      : `PO_ENV=${env.envKey} node scripts/get-token.mjs processon_check_and_start_auth`;
    process.stdout.write(`当前环境（${env.envName}）未找到授权凭据，请先执行：${hint}\n`);
    process.exit(1);
  }

  // ① 调导出接口
  const exportUrl = new URL(EXPORT_PATH, EXPORT_BASE_URL);
  exportUrl.searchParams.set("chartId", chartId);
  exportUrl.searchParams.set("type", wantPdf ? "svg" : type);

  let payload;
  try {
    const { status, body } = await getText(exportUrl, {
      "X-Mcp-ApiKey": apiKey,
      "Accept": "application/json",
      "X-Source": SKILL_SOURCE,
    });
    if (status !== 200) {
      process.stdout.write(`导出接口 HTTP ${status}: ${body.slice(0, 300)}`);
      process.exit(0);
    }
    try {
      payload = JSON.parse(body);
    } catch {
      process.stdout.write(`导出接口响应非 JSON: ${body.slice(0, 300)}`);
      process.exit(0);
    }
  } catch (e) {
    process.stdout.write(e.message || String(e));
    process.exit(0);
  }

  if (String(payload?.code) !== "200") {
    // 带上 code 便于区分 401（授权）/ 61685（点数）/ 815（会员）等，msg 单独看容易误判
    process.stdout.write(`导出失败: code=${payload?.code ?? "?"} ${payload?.msg || JSON.stringify(payload)}`);
    process.exit(0);
  }

  // 兼容 data 为字符串或对象两种形态
  let data = payload.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* 保留原字符串 */ }
  }
  if (!data || typeof data !== "object") {
    process.stdout.write("导出成功但未返回图片信息");
    process.exit(0);
  }

  const member = String(data.member) === "true" ? "true" : "false";
  const canvasNum = data.canvasNum != null ? String(data.canvasNum) : "";
  const canvasLimit = data.canvasLimit != null ? String(data.canvasLimit) : "";
  const imgInfo = Array.isArray(data.imgInfo) ? data.imgInfo : [];

  process.stdout.write(`member=${member}\n`);
  process.stdout.write(`type=${wantPdf ? "pdf" : (data.type || type)}\n`);
  if (canvasNum) process.stdout.write(`canvasNum=${canvasNum}\n`);
  if (canvasLimit) process.stdout.write(`canvasLimit=${canvasLimit}\n`);

  if (imgInfo.length === 0) {
    process.stdout.write("导出成功但未返回图片列表");
    process.exit(0);
  }

  // ② 逐个下载到本地（多画布之间串行并留 1 秒间隔，贴合后端限频）
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const usedNames = new Set();

  for (let i = 0; i < imgInfo.length; i++) {
    const item = imgInfo[i] || {};
    const base = nameOverride || sanitizeTitle(item.title);
    let filename = `${base || `chart-${i + 1}`}.${ext}`;
    if (usedNames.has(filename)) filename = `${base || `chart-${i + 1}`}-${i + 1}.${ext}`;
    usedNames.add(filename);

    const dest = path.join(DOWNLOAD_DIR, filename);
    const url = absoluteUrl(item.url);

    if (i > 0) await sleep(1000);

    // pdf 模式：svg 先落到临时目录，本地转 PDF，转换成功后删除临时 svg
    if (wantPdf) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "po-export-pdf-"));
      const tmpSvg = path.join(tmpDir, `canvas-${i + 1}.svg`);
      try {
        try {
          await download(url, tmpSvg);
        } catch (e) {
          process.stdout.write(`[${i + 1}]\ntitle=${item.title || ""}\nfile=下载失败:${e.message || e}\n`);
          continue;
        }
        const conv = spawnSync(process.execPath, [
          path.join(scriptDir, "svg2pdf.mjs"), tmpSvg, "-o", dest,
        ], { stdio: "pipe", timeout: 120_000, env: { ...process.env } });
        const convOut = String(conv.stdout || "");
        if (conv.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0 || convOut.includes("[FAIL]")) {
          const reason = (convOut.match(/error=([^\n]+)/) || [, "convert_failed"])[1];
          process.stdout.write(`[${i + 1}]\ntitle=${item.title || ""}\nfile=转换失败:${reason}\n`);
          continue;
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
      }
      // pdf 模式不输出 url —— 用户不需要、也不应看到中间 svg 地址
      process.stdout.write(`[${i + 1}]\ntitle=${item.title || ""}\nfile=${dest}\n`);
      continue;
    }

    try {
      await download(url, dest);
    } catch (e) {
      process.stdout.write(`[${i + 1}]\ntitle=${item.title || ""}\nurl=${url}\nfile=下载失败:${e.message || e}\n`);
      continue;
    }

    process.stdout.write(`[${i + 1}]\ntitle=${item.title || ""}\nurl=${url}\nfile=${dest}\n`);
  }
}

process.exitCode = await main();
