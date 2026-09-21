#!/usr/bin/env node
// get-version.mjs — Skill 版本自检（非阻塞）
//
// 机制：读取**公开的版本信息 json**，与本地 SKILL.md frontmatter 的 `version` 比对。
//   本地版本       = SKILL.md frontmatter version
//   线上最新版本   = 版本信息 json 的 version（链接见下方 DEFAULT_VERSION_URL / PO_VERSION_URL）
//   json 由发布流程随包放到分组目录（与 zip 同级，不在 zip 内），见 package.mjs
//
// 用法：
//   node get-version.mjs
//
// 输出（供 AI 解析；任何失败都不阻断主流程，退出码一律 0）：
//   CURRENT:<本地版本>
//   LATEST:<最新版本>
//   UPDATED_AT:<更新时间>
//   STATUS:UPDATE_AVAILABLE | UP_TO_DATE
//   CHANGELOG:
//   - <更新内容>           ← 无序列表，按 version.json 里的书写顺序（该文件按时间倒序维护）
//   失败/未配置时只输出一行：VERSION_CHECK_SKIPPED:<原因>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillFile } from "./mcp.mjs";

// 版本信息 json 的公开可访问链接（与渠道包下载地址同域）。
// 也可用环境变量 PO_VERSION_URL 覆盖（临时排查 / 切换环境时用）。
const DEFAULT_VERSION_URL = "https://pocdn.processon.com/agent/version.json";

const TIMEOUT_MS = 8000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function skip(reason) {
  process.stdout.write(`VERSION_CHECK_SKIPPED:${reason}\n`);
  process.exit(0);
}

// 内测包（灰度等）在包内 envs.json 里声明 versionCheck:false → 不做版本自检、不提示更新
function versionCheckDisabled() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(scriptDir, "envs.json"), "utf8"));
    return data?.versionCheck === false;
  } catch {
    return false; // 无此文件（对外发布的包）→ 正常自检
  }
}

// 读本地版本号（SKILL.md frontmatter）
function readLocalVersion() {
  const text = readSkillFile(path.join(scriptDir, ".."));
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = (fm ? fm[1] : "").match(/^version:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return m ? m[1].trim() : "";
}

// 解析 x.y.z（允许前缀 v），解析不出来返回 null
function parseVersion(value) {
  const m = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// remote 是否比 local 新
function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function fetchVersionInfo(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Source": process.env.PO_SOURCE || "workbuddy" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("响应不是对象");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// 更新日志：只取非空字符串，保持文件里的书写顺序（version.json 按时间倒序维护）
function normalizeChangelog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

async function main() {
  if (versionCheckDisabled()) skip("version_check_disabled");

  const url = (process.env.PO_VERSION_URL || DEFAULT_VERSION_URL).trim();
  if (!url) skip("no_version_url");

  let local;
  try {
    local = readLocalVersion();
  } catch {
    skip("local_version_unreadable");
  }
  if (!parseVersion(local)) skip(`local_version_invalid:${local || "empty"}`);

  let info;
  try {
    info = await fetchVersionInfo(url);
  } catch (e) {
    skip(`fetch_failed:${e.message || e}`);
  }

  const latest = String(info.version || "").trim();
  if (!parseVersion(latest)) skip(`remote_version_invalid:${latest || "empty"}`);

  const status = isNewer(latest, local) ? "UPDATE_AVAILABLE" : "UP_TO_DATE";
  const changelog = normalizeChangelog(info.changelog);

  const lines = [
    `CURRENT:${local}`,
    `LATEST:${latest}`,
    `UPDATED_AT:${String(info.updatedAt || "").trim()}`,
    `STATUS:${status}`,
    "CHANGELOG:",
    ...changelog.map((x) => `- ${x}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main();
