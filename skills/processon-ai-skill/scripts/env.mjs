// env.mjs — ProcessOn Skill 多环境解析 + 凭据分槽存储
//
// 为什么需要：
//   正式 / 灰度等多套环境的 apiKey 互不通用。若共用一份凭据文件，
//   会出现「拿 A 环境的 key 去请求 B 环境端点」，且切换环境时互相覆盖。
//
// 隔离原则：
//   1. 每套环境的凭据各占一个槽位（token.json → environments[<envKey>]），互不覆盖。
//   2. 读取凭据时必须与当前端点匹配，不匹配即视为未授权，绝不串用。
//
// 环境标识 envKey 判定：
//   1. 显式 PO_ENV（prod / gray / 任意自定义名）
//   2. 无 PO_ENV 时，走「默认环境」（见下）；再由端点 origin 反查环境名
//
// 默认环境判定（无 PO_ENV 时生效）：
//   包内 scripts/envs.json 的 default  >  用户级 ~/.processon-skill/envs.json 的 default  >  prod
//   —— 包内声明代表「这个包默认跑哪套环境」（如某分发包默认 gray），优先级最高；
//      用户级文件主要用于覆盖地址、扩充环境，其 default 仅在包内未声明时生效。
//
// 端点判定（逐项覆盖，未覆盖项取所属环境的默认值）：
//   PO_MCP_URL / PO_API_BASE_URL / PO_AUTH_BASE_URL
//     > 用户级 envs.json（~/.processon-skill/envs.json）
//     > 包内 envs.json（scripts/envs.json）
//     > 内置预设
//
// 用法：
//   import { resolveEnv, readStore, getEnvRecord, setEnvRecord, clearEnvRecord, siteUrls } from "./env.mjs";
//   const env = resolveEnv();
//   const record = getEnvRecord(readStore(), env);   // 只拿当前环境的凭据

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_PATH = "/api/activity/mcp";
const AUTH_PATH = "/thirds/skillauth";

export const SKILL_HOME = path.join(os.homedir(), ".processon-skill");
export const ENVS_FILE = path.join(SKILL_HOME, "envs.json");
export const TOKEN_FILE = path.join(SKILL_HOME, "token.json");
// 包内环境声明（随包分发）。主技能不带此文件 → 默认 prod；
// 需要固定默认环境的分发包可带 {"default":"<环境名>"}。
export const PACKAGE_ENVS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "envs.json");
export const DEFAULT_ENV_NAME = "prod";

// 内置环境预设。base 为站点根，MCP 端点与授权页路径由脚本自动补齐。
// prod=正式，gray=灰度；其他环境由使用者在 envs.json 中自行扩充。
const BUILTIN_ENVIRONMENTS = {
  prod: { base: "https://www.processon.com" },
  gray: { base: "https://v5hd.processon.com" },
};

// 环境名别名归一（方便口头指定：PO_ENV=灰度 / PO_ENV=grey）
const ENV_ALIASES = {
  production: "prod", online: "prod", release: "prod", formal: "prod", 正式: "prod", 线上: "prod",
  grey: "gray", 灰度: "gray",
};

export function normalizeEnvName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return ENV_ALIASES[raw.toLowerCase()] || ENV_ALIASES[raw] || raw.toLowerCase();
}

// 给无协议头的地址补协议：私有 IP / localhost 补 http://，域名补 https://
export function normalizeUrl(url) {
  if (!url) return "";
  const trimmed = String(url).trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  const host = trimmed.split("/")[0].split(":")[0];
  const useHttp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === "localhost" || host === "127.0.0.1";
  return `${useHttp ? "http" : "https"}://${trimmed}`.replace(/\/+$/, "");
}

// 端点身份：scheme://host[:port]，小写。凭据按它归属环境。
export function originOf(url) {
  try {
    return new URL(normalizeUrl(url)).origin.toLowerCase();
  } catch {
    return "";
  }
}

function joinPath(base, sub) {
  return `${String(base || "").replace(/\/+$/, "")}${sub}`;
}

// 环境名 → 可安全作为文件名/服务名后缀的键
export function safeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function profileBase(profile) {
  if (!profile) return "";
  return normalizeUrl(profile.base || profile.apiBase || profile.siteBase || "");
}

function readEnvFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return null;
    const raw = data.environments && typeof data.environments === "object" ? data.environments : {};
    const environments = {};
    for (const [name, cfg] of Object.entries(raw)) {
      const key = normalizeEnvName(name) || String(name).toLowerCase();
      environments[key] = cfg && typeof cfg === "object" ? { ...cfg } : {};
    }
    return { default: normalizeEnvName(data.default), environments };
  } catch {
    return null; // 文件不存在或格式异常 → 该层不生效，不阻断
  }
}

// 三层合并：内置预设 < 包内 envs.json < 用户级 envs.json
// 默认环境：包内 default > 用户级 default > prod（理由见文件头注释）
export function loadEnvironments() {
  const environments = { ...BUILTIN_ENVIRONMENTS };

  const pkg = readEnvFile(PACKAGE_ENVS_FILE);
  for (const [key, cfg] of Object.entries(pkg?.environments || {})) {
    environments[key] = { ...(environments[key] || {}), ...cfg };
  }

  const user = readEnvFile(ENVS_FILE);
  for (const [key, cfg] of Object.entries(user?.environments || {})) {
    environments[key] = { ...(environments[key] || {}), ...cfg };
  }

  const defaultName = pkg?.default || user?.default || DEFAULT_ENV_NAME;
  return { default: defaultName, environments };
}

function findEnvNameByOrigin(profiles, origin) {
  if (!origin) return "";
  for (const [name, profile] of Object.entries(profiles.environments)) {
    const base = profileBase(profile) || (profile?.mcpUrl ? originOf(profile.mcpUrl) : "");
    if (base && originOf(base) === origin) return name;
  }
  return "";
}

let cachedEnv = null;

// 解析当前环境（进程内缓存）
export function resolveEnv() {
  if (cachedEnv) return cachedEnv;

  const profiles = loadEnvironments();
  const rawEnv = String(process.env.PO_ENV || "").trim();
  const explicitName = rawEnv ? (normalizeEnvName(rawEnv) || rawEnv.toLowerCase()) : "";
  const namedProfile = explicitName ? profiles.environments[explicitName] : null;
  const defaultProfile = profiles.environments[profiles.default] || profiles.environments[DEFAULT_ENV_NAME] || {};

  // PO_ENV 指定了一个未定义、又没给端点覆盖的环境名：若不拦下来，会静默回落到默认环境，
  // 把「以为在 A 环境」的请求打到 B 环境上。这里直接报错，要求先把环境定义清楚。
  const hasEndpointOverride = Boolean(process.env.PO_MCP_URL || process.env.PO_API_BASE_URL || process.env.PO_AUTH_BASE_URL);
  if (explicitName && !namedProfile && !hasEndpointOverride) {
    throw new Error(
      `未知环境：${explicitName}。请在 ~/.processon-skill/envs.json 中定义该环境（模板见 scripts/envs.example.json），或用 PO_MCP_URL / PO_API_BASE_URL 指定端点。`
    );
  }

  const mcpFromEnv = process.env.PO_MCP_URL || namedProfile?.mcpUrl || "";
  const mcpUrl = mcpFromEnv
    ? normalizeUrl(mcpFromEnv)
    : joinPath(profileBase(namedProfile) || profileBase(defaultProfile) || BUILTIN_ENVIRONMENTS[DEFAULT_ENV_NAME].base, MCP_PATH);

  const apiBase = normalizeUrl(process.env.PO_API_BASE_URL || profileBase(namedProfile) || profileBase(defaultProfile) || originOf(mcpUrl))
    || originOf(mcpUrl);

  const authBase = normalizeUrl(process.env.PO_AUTH_BASE_URL || namedProfile?.authBase || joinPath(apiBase, AUTH_PATH));

  const origin = originOf(mcpUrl) || originOf(apiBase);
  const envName = explicitName || findEnvNameByOrigin(profiles, origin) || origin || DEFAULT_ENV_NAME;

  cachedEnv = {
    envName,
    envKey: explicitName || envName,
    origin,
    mcpUrl,
    apiBase,
    authBase,
    explicit: Boolean(explicitName),
  };
  return cachedEnv;
}

// mcporter 服务名：正式保持 processon（兼容既有注册），其余环境加后缀避免互相覆盖
export function serviceNameFor(env = resolveEnv()) {
  const key = safeKey(env.envKey);
  return env.envKey === DEFAULT_ENV_NAME ? "processon" : `processon-${key}`;
}

// ── 凭据存储（token.json v2，按环境分槽） ──────────────────────────────

function emptyStore() {
  return { version: 2, active: "", environments: {} };
}

// 旧结构（单份凭据，无环境维度）→ 按其记录的端点归入对应环境槽。
// 端点缺失时归入正式环境（历史默认值），旧文件不会被丢弃。
function migrateLegacy(data) {
  const store = emptyStore();
  const isObject = Boolean(data) && typeof data === "object";
  const authorization = isObject
    ? (data.authorization || data.token || data.apiKey || "")
    : String(data || "");
  if (!authorization) return store;

  const recorded = isObject ? String(data.mcpUrl || "") : "";
  const mcpUrl = recorded
    ? normalizeUrl(recorded)
    : joinPath(BUILTIN_ENVIRONMENTS[DEFAULT_ENV_NAME].base, MCP_PATH);
  const origin = originOf(mcpUrl);
  // 尽量复用预设/自定义环境名作为槽位键，便于与 PO_ENV 切换保持一致
  const key = findEnvNameByOrigin(loadEnvironments(), origin) || origin || DEFAULT_ENV_NAME;

  store.environments[key] = {
    envName: key,
    origin,
    mcpUrl,
    apiBase: origin,
    authorization: authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`,
    updatedAt: Number(isObject ? data.updatedAt : 0) || Date.now(),
  };
  store.active = key;
  return store;
}

export function readStore() {
  let raw = "";
  try {
    raw = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return emptyStore();
  }
  if (!raw) return emptyStore();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return migrateLegacy(raw); // 极早期版本直接存 token 字符串
  }

  const isV2 = data && typeof data === "object"
    && Number(data.version) >= 2
    && data.environments && typeof data.environments === "object";
  if (isV2) {
    return { version: 2, active: String(data.active || ""), environments: { ...data.environments } };
  }
  return migrateLegacy(data);
}

// 首次把旧结构升级为 v2 前，留一份原始备份
// （备份含实时凭据，权限必须与主文件一致，一律 0o600）
function backupLegacyOnce() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    if (/"version"\s*:\s*2/.test(raw)) return;
    const backup = `${TOKEN_FILE}.v1.bak`;
    if (fs.existsSync(backup)) return;
    fs.writeFileSync(backup, raw, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(backup, 0o600);
  } catch {
    // 文件不存在 → 无需备份
  }
}

export function writeStore(store) {
  fs.mkdirSync(SKILL_HOME, { recursive: true, mode: 0o700 });
  backupLegacyOnce();
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

// 取当前环境的凭据槽：先按键精确命中，再按端点 origin 兜底
// （同一环境可能以 PO_ENV 名与端点 origin 两种键写入过）
// 键命中同样要求端点为同一 origin：环境被改名 / 移除、或端点被覆盖时，
// 绝不把旧环境的凭据发到新环境的端点上（宁可判定为未授权）。
export function getEnvRecord(store, env = resolveEnv()) {
  const environments = store?.environments || {};
  const byKey = env?.envKey ? environments[env.envKey] : null;
  if (byKey && (!env?.origin || !byKey.origin || byKey.origin === env.origin)) return byKey;
  if (env?.origin) {
    for (const record of Object.values(environments)) {
      if (record?.origin && record.origin === env.origin) return record;
    }
  }
  return null;
}

// 写当前环境槽，保留其他环境；同一 origin 只留一个槽，避免重复授权。
// 安全约束：只有当本次写入的 envKey 恰好是该 origin 的**规范环境名**时，才清理同 origin 的
// 别名字槽。否则（例如 PO_ENV 与 PO_MCP_URL 指向不一致）宁可多留一个槽，也绝不删掉
// 已有环境的授权 —— 「写入 A 环境不会丢掉 B 环境的凭据」是硬约束。
export function setEnvRecord(store, env, patch) {
  const environments = { ...(store?.environments || {}) };
  const canonical = env?.origin ? findEnvNameByOrigin(loadEnvironments(), env.origin) : "";
  for (const [key, record] of Object.entries(environments)) {
    if (key === env.envKey) continue;
    if (!env.origin || record?.origin !== env.origin) continue;
    if (canonical && canonical !== env.envKey) continue;
    delete environments[key];
  }
  environments[env.envKey] = {
    ...(environments[env.envKey] || {}),
    ...patch,
    envName: env.envName,
    origin: env.origin,
    mcpUrl: env.mcpUrl,
    apiBase: env.apiBase,
    updatedAt: Date.now(),
  };
  return { version: 2, active: env.envKey, environments };
}

// 只清当前环境槽，其他环境授权原样保留。
// 同 origin 的别名字槽同样只在「envKey 是该 origin 的规范名」时才一并清理。
export function clearEnvRecord(store, env = resolveEnv()) {
  const environments = { ...(store?.environments || {}) };
  const canonical = env?.origin ? findEnvNameByOrigin(loadEnvironments(), env.origin) : "";
  const canCollapseAliases = !canonical || canonical === env.envKey;
  let removed = false;
  for (const [key, record] of Object.entries(environments)) {
    const isSelf = key === env.envKey;
    const isAlias = Boolean(env.origin) && record?.origin === env.origin && canCollapseAliases;
    if (isSelf || isAlias) {
      delete environments[key];
      removed = true;
    }
  }
  const active = removed && String(store?.active || "") === env.envKey ? "" : String(store?.active || "");
  return { store: { version: 2, active, environments }, removed };
}

// 只读当前环境的 Authorization；端点不匹配时返回空（绝不跨环境串用）
export function readEnvAuthorization(env = resolveEnv()) {
  const record = getEnvRecord(readStore(), env);
  const authorization = record?.authorization || "";
  if (!authorization) return "";
  return authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`;
}

export function listEnvRecords() {
  const store = readStore();
  return Object.entries(store.environments || {}).map(([key, record]) => ({
    key,
    envName: record?.envName || key,
    origin: record?.origin || originOf(record?.mcpUrl || ""),
    mcpUrl: record?.mcpUrl || "",
    authorized: Boolean(record?.authorization),
    updatedAt: Number(record?.updatedAt) || 0,
  }));
}

// ── 用户侧链接（随环境变化，禁止在文档/话术中硬编码域名） ───────────────
//
// 所有「交给用户点击的 ProcessOn 页面」都以当前环境的站点根为前缀：
// 正式 → https://www.processon.com，灰度 → https://v5hd.processon.com（其他环境由 envs.json 定义）。
// payPointSource 与 X-Source 请求头同源，由调用方传入（脚本内统一取 mcp.mjs 的 SKILL_SOURCE）。

const TRACK_SOURCE = "processon_skill";

// source 省略时不带追踪参数（仅用于取 apiKey / 查点数这类不加参的页面）
export function siteUrls(env = resolveEnv(), source = "") {
  const base = (env?.apiBase || originOf(env?.mcpUrl || "")).replace(/\/+$/, "");
  const track = source ? `source=${TRACK_SOURCE}&payPointSource=${encodeURIComponent(source)}` : "";

  return {
    base,
    account: `${base}/setting`,
    payment: `${base}/payment`,
    // 开通会员 / 升级去水印（免费用户或非会员）
    upgrade: track ? `${base}/setting?paytype=personal&${track}` : `${base}/setting?paytype=personal`,
    // 购买 AI 点数（VIP 会员点数不足）
    buyPoints: track ? `${base}/setting?paytype=aipoint&${track}` : `${base}/setting?paytype=aipoint`,
    // 授权页（授权流程由 get-token.mjs 按当前环境自动拼好，此处仅供展示）
    auth: `${base}${AUTH_PATH}`,
  };
}
