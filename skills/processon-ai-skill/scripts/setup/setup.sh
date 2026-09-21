#!/bin/bash
#
# ProcessOn Skill 环境配置脚本 (mac/Linux)
#
# 作用：把本 Skill 依赖的 MCP 服务注册到 mcporter。
#   - processon ：生成图数据 / 版本自检 / apiKey 校验 / 新建 / 编辑 / 查询
#
# 认证说明：
#   apiKey 由 get-token.mjs 自动授权获取（浏览器登录 + 轮询换取），本脚本不收集 apiKey。
#   本脚本负责：确保 mcporter 存在 → 注册 processon 端点。
#   若检测到已有凭据（可能来自 mcporter 自身或其他宿主导入的配置），
#   会先直连调用 check 工具实测其是否可用：有效则沿用，失效则丢弃，
#   并提示由 AI 执行：node get-token.mjs processon_check_and_start_auth
#
# 用法：
#   1) 直接运行：
#        bash setup.sh
#   2) 指定环境（正式 / 灰度 等，凭据按环境隔离）：
#        PO_ENV=gray bash setup.sh
#   3) 覆盖端点：
#        PROCESSON_BASE_URL=http://your-host bash setup.sh
#
# 安全：apiKey 仅写入 mcporter 配置，不回显、不写入其他文件。

set -eu

# 兜底地址（仅当 env.mjs 不可用时使用）：私有 IP / localhost 补 http://，域名补 https://
PROCESSON_BASE_URL="${PROCESSON_BASE_URL:-www.processon.com}"
case "$PROCESSON_BASE_URL" in
  http://*|https://*) ;;
  localhost*|127.0.0.1*|[0-9]*.[0-9]*.[0-9]*.[0-9]*) PROCESSON_BASE_URL="http://$PROCESSON_BASE_URL" ;;
  *) PROCESSON_BASE_URL="https://$PROCESSON_BASE_URL" ;;
esac

# 从 Skill 根目录 SKILL.md（本脚本上两级）的 frontmatter 读取 version，作为 X-Skill-Version 上报给服务端
# 包内文件名大小写随载体而变（skill.md / SKILL.md），两种都尝试。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/../../SKILL.md"
[ -f "$SKILL_FILE" ] || SKILL_FILE="$SCRIPT_DIR/../../skill.md"
SKILL_VERSION="$(sed -n '/^---$/,/^---$/p' "$SKILL_FILE" 2>/dev/null \
  | sed -n 's/^version:[[:space:]]*["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}[[:space:]]*$/\1/p' | head -1)"
SKILL_VERSION="${SKILL_VERSION:-unknown}"

# ── 0. 解析当前环境（正式 / 灰度 / 测试）────────────────
# 与授权、调用侧共用同一套环境解析，服务名按环境区分，避免多环境注册时互相覆盖。
ENV_INFO="$(node -e '
import("'"$SCRIPT_DIR"'/env.mjs").then((m) => {
  const env = m.resolveEnv();
  process.stdout.write([env.envName, env.mcpUrl, m.serviceNameFor(env)].join("\t"));
}).catch(() => {});
' 2>/dev/null || true)"
ENV_NAME="$(printf '%s' "$ENV_INFO" | cut -f1)"
PROCESSON_MCP_URL="$(printf '%s' "$ENV_INFO" | cut -f2)"
SERVICE_NAME="$(printf '%s' "$ENV_INFO" | cut -f3)"
# env.mjs 不可用时回退到内置正式环境
PROCESSON_MCP_URL="${PROCESSON_MCP_URL:-${PROCESSON_BASE_URL}/api/activity/mcp}"
SERVICE_NAME="${SERVICE_NAME:-processon}"
ENV_NAME="${ENV_NAME:-prod}"

say()  { printf '  %s\n' "$@"; }
err()  { printf '  ❌ %s\n' "$@" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── 1. 确保 mcporter 存在 ─────────────────────────────
ensure_mcporter() {
  if need_cmd mcporter; then return; fi
  if need_cmd npm; then
    say "未找到 mcporter，正在安装..."
    npm install -g mcporter >/dev/null 2>&1 || err "mcporter 安装失败，请手动执行：npm install -g mcporter"
    say "✅ mcporter 安装完成"
  else
    err "未找到 mcporter，且当前环境没有 npm，无法自动安装。请先安装 Node.js 后重试。"
  fi
}

# ── 2. 读取已有 apiKey（可能来自 mcporter 自身或其他宿主导入的配置）──
read_existing_auth() {
  mcporter config get "$SERVICE_NAME" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*Authorization:[[:space:]]*(.+)$/\1/p' \
    | head -n1 || true
}

# ── 3. 验证 apiKey 是否真实可用（直连调 check，不建临时配置）──
# 有效返回 0；失效或无法验证返回 1。判据：鉴权失败信号 -32001 / ApiKey解析失败 / Unauthorized
validate_apikey() {
  candidate="$(printf '%s' "$1" | sed -E 's/^[Bb]earer[[:space:]]+//')"
  [ -n "$candidate" ] || return 1
  need_cmd curl || return 1

  response="$(curl -s --max-time 15 -X POST "$PROCESSON_MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${candidate}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check","arguments":{}}}' 2>/dev/null || true)"

  [ -n "$response" ] || return 1
  # 先判成功：check 正常返回含 "result"（注意其正文本身含 "ApiKey" 字样，不能用作失败判据）
  case "$response" in
    *'"result"'*) return 0 ;;
  esac
  # 其余一律视为不可用（含 -32001 / ApiKey解析失败 / Unauthorized 等鉴权失败信号）
  return 1
}

# ── 4. 注册 processon（已有 apiKey 须验证通过才沿用）─────
register_mcp() {
  EXISTING_AUTH="$(read_existing_auth)"
  VALID_AUTH=""

  if [ -n "$EXISTING_AUTH" ]; then
    say "检测到已有凭据，正在验证是否可用..."
    if validate_apikey "$EXISTING_AUTH"; then
      VALID_AUTH="$EXISTING_AUTH"
      say "验证通过，沿用现有凭据"
    else
      say "现有凭据已失效，将丢弃"
    fi
  fi

  say "注册 ${SERVICE_NAME}（环境：${ENV_NAME}）→ ${PROCESSON_MCP_URL}"
  mcporter config remove "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [ -n "$VALID_AUTH" ]; then
    mcporter config add "$SERVICE_NAME" "$PROCESSON_MCP_URL" \
      --header "Authorization=${VALID_AUTH}" \
      --header "accept=application/json" \
      --header "X-Skill-Version=${SKILL_VERSION}" \
      --transport http --scope home >/dev/null
  else
    mcporter config add "$SERVICE_NAME" "$PROCESSON_MCP_URL" \
      --header "accept=application/json" \
      --header "X-Skill-Version=${SKILL_VERSION}" \
      --transport http --scope home >/dev/null
    if [ "$ENV_NAME" = "prod" ]; then
      say "尚未授权：请执行 node scripts/get-token.mjs processon_check_and_start_auth 完成授权"
    else
      say "尚未授权：请执行 PO_ENV=${ENV_NAME} node scripts/get-token.mjs processon_check_and_start_auth 完成授权"
    fi
  fi
}

main() {
  echo ""
  echo "===== ProcessOn Skill 环境配置 ====="
  echo ""
  ensure_mcporter
  register_mcp
  echo ""
  say "✅ 配置完成。已注册 MCP：${SERVICE_NAME}（环境：${ENV_NAME}）"
  say "验证：可让 AI 调用 ${SERVICE_NAME} 的 check 工具确认 apiKey 是否生效。"
  echo ""
}

main
