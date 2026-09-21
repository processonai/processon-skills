#!/usr/bin/env node
// svg2pdf.mjs — 把 SVG 文件转换为 PDF（本地转换，不调后端）
//
// 用法：
//   node svg2pdf.mjs <input.svg> [more.svg ...] [-o <output.pdf>]
//
// 行为：
//   - 单输入 + `-o`：转换结果写到 -o 指定路径
//   - 多输入（或不带 -o）：每个 svg 在同目录生成同名 .pdf
//
// 转换引擎按优先级自动探测（保真优先）：
//   1. Chrome / Chromium / Edge（headless 打印，中文回退好、保真最高）
//   2. rsvg-convert（librsvg）
//   3. cairosvg（Python）
// 可用 PO_SVG2PDF_CMD='<命令> <参数...>' 强制指定，输入输出各占一个 {} 占位符，
// 例：PO_SVG2PDF_CMD='rsvg-convert -f pdf -o {} {}'（第一个 {} 是输出，第二个是输入）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHROME_TIMEOUT_MS = 60_000;

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const inputs = [];
  let output = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--output") { output = argv[++i] || ""; continue; }
    if (a.startsWith("-o=")) { output = a.slice(3); continue; }
    if (a === "-h" || a === "--help") { printUsage(); process.exit(0); }
    inputs.push(a);
  }
  return { inputs, output };
}

function printUsage() {
  process.stdout.write("用法：node svg2pdf.mjs <input.svg> [more.svg ...] [-o <output.pdf>]\n");
}

function fail(msg) {
  process.stdout.write(`ERROR:${msg}`);
  process.exit(0);
}

// ---------- 引擎探测 ----------
function findChrome() {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    candidates.push(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    );
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  for (const c of candidates) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    // 用 --version 探测（PATH 上的命令 + 存在的绝对路径都验证一次可执行）
    const probe = spawnSync(c, ["--version"], { stdio: "ignore", timeout: 10_000 });
    if (probe.status === 0 || probe.error === undefined) return c;
  }
  return "";
}

function hasCommand(cmd) {
  const probe = spawnSync(cmd, ["--help"], { stdio: "ignore", timeout: 10_000 });
  return !probe.error;
}

function pickEngine() {
  // 用户强制指定优先
  const forced = (process.env.PO_SVG2PDF_CMD || "").trim();
  if (forced) return { kind: "cmd", value: forced };

  const chrome = findChrome();
  if (chrome) return { kind: "chrome", value: chrome };
  if (hasCommand("rsvg-convert")) return { kind: "rsvg", value: "rsvg-convert" };
  if (hasCommand("cairosvg")) return { kind: "cairosvg", value: "cairosvg" };
  return null;
}

// ---------- SVG 尺寸解析 ----------
function svgSize(svgText) {
  const root = svgText.slice(0, svgText.indexOf(">") + 1 || svgText.length);
  const wAttr = root.match(/\bwidth="([\d.]+)(px)?"/);
  const hAttr = root.match(/\bheight="([\d.]+)(px)?"/);
  if (wAttr && hAttr) return { w: Math.ceil(parseFloat(wAttr[1])), h: Math.ceil(parseFloat(hAttr[1])) };
  const vb = root.match(/viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/);
  if (vb) return { w: Math.ceil(parseFloat(vb[1])), h: Math.ceil(parseFloat(vb[2])) };
  return { w: 800, h: 600 };
}

// ---------- Chrome 打印法 ----------
function convertViaChrome(chromeBin, svgText, dest) {
  const { w, h } = svgSize(svgText);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "po-svg2pdf-"));
  const htmlPath = path.join(tmpDir, "wrap.html");
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@page { size: ${w}px ${h}px; margin: 0; }
html, body { margin: 0; padding: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
svg { display: block; width: ${w}px; height: ${h}px; }
</style></head><body>
${svgText}
</body></html>`;
  fs.writeFileSync(htmlPath, html, "utf8");

  try {
    const result = spawnSync(chromeBin, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${dest}`,
      "--virtual-time-budget=8000",
      `file://${htmlPath}`,
    ], { stdio: "ignore", timeout: CHROME_TIMEOUT_MS });

    if (result.error && result.error.killed) fail("chrome_timeout");
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) fail("chrome_print_failed");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
  }
}

// ---------- 其他引擎 ----------
function convertViaCmd(template, svgPath, dest) {
  const parts = template.split("{}").map(s => s.trim());
  if (parts.length < 3) fail("cmd_template_invalid");
  const [before, mid, ...rest] = parts;
  const argv = [...before.split(/\s+/).filter(Boolean),
                dest,
                ...mid.split(/\s+/).filter(Boolean),
                svgPath,
                ...rest.join(" ").split(/\s+/).filter(Boolean)];
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: CHROME_TIMEOUT_MS });
  if (result.error || !fs.existsSync(dest) || fs.statSync(dest).size === 0) fail("cmd_convert_failed");
}

function convertViaRsvg(svgPath, dest) {
  const result = spawnSync("rsvg-convert", ["-f", "pdf", "-o", dest, svgPath], { stdio: "ignore", timeout: CHROME_TIMEOUT_MS });
  if (result.error || !fs.existsSync(dest) || fs.statSync(dest).size === 0) fail("rsvg_convert_failed");
}

function convertViaCairosvg(svgPath, dest) {
  const result = spawnSync("cairosvg", [svgPath, "-o", dest], { stdio: "ignore", timeout: CHROME_TIMEOUT_MS });
  if (result.error || !fs.existsSync(dest) || fs.statSync(dest).size === 0) fail("cairosvg_failed");
}

// ---------- 主流程 ----------
async function main() {
  const { inputs, output } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0) { printUsage(); process.exit(1); }
  if (output && inputs.length > 1) fail("single_output_only");

  const engine = pickEngine();
  if (!engine) fail("no_engine");

  const results = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) { results.push({ input: abs, error: "input_not_found" }); continue; }
    const dest = path.resolve(output || abs.replace(/\.svg$/i, "") + ".pdf");

    const svgText = fs.readFileSync(abs, "utf8");
    try {
      if (engine.kind === "chrome") convertViaChrome(engine.value, svgText, dest);
      else if (engine.kind === "rsvg") convertViaRsvg(abs, dest);
      else if (engine.kind === "cairosvg") convertViaCairosvg(abs, dest);
      else if (engine.kind === "cmd") convertViaCmd(engine.value, abs, dest);
      results.push({ input: abs, file: dest, engine: engine.kind });
    } catch (e) {
      results.push({ input: abs, error: e.message || String(e) });
    }
  }

  for (const r of results) {
    if (r.error) {
      process.stdout.write(`[FAIL]\ninput=${r.input}\nerror=${r.error}\n`);
    } else {
      process.stdout.write(`[OK]\nfile=${r.file}\nengine=${r.engine}\n`);
    }
  }
}

process.exitCode = await main();
