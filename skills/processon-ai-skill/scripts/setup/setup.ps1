# ProcessOn Skill 环境配置脚本 (Windows PowerShell)
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
#   1) 直接运行：           powershell -ExecutionPolicy Bypass -File .\setup.ps1
#   2) 指定环境（正式 / 灰度 / 测试，凭据按环境隔离）：
#                           $env:PO_ENV="test"; .\setup.ps1
#   3) 覆盖端点：           $env:PROCESSON_BASE_URL="http://your-host"; .\setup.ps1
#
# 安全：apiKey 仅写入 mcporter 配置，不回显、不写入其他文件。

$ErrorActionPreference = "Stop"

$ProcessonBaseUrl = if ($env:PROCESSON_BASE_URL) { $env:PROCESSON_BASE_URL } else { "www.processon.com" }
# 兜底协议补全：私有 IP / localhost 用 http://，域名用 https://
if ($ProcessonBaseUrl -notmatch '^https?://') {
    if ($ProcessonBaseUrl -match '^(localhost|127\.0\.0\.1|(\d{1,3}\.){3}\d{1,3})') {
        $ProcessonBaseUrl = "http://$ProcessonBaseUrl"
    } else {
        $ProcessonBaseUrl = "https://$ProcessonBaseUrl"
    }
}

# 从 Skill 根目录 SKILL.md（本脚本上两级）的 frontmatter 读取 version，作为 X-Skill-Version 上报给服务端
# 包内文件名大小写随载体而变（skill.md / SKILL.md），两种都尝试。
$SkillVersion = "unknown"
try {
    $skillPath = Join-Path $PSScriptRoot "..\..\SKILL.md"
    if (-not (Test-Path $skillPath)) {
        $skillPath = Join-Path $PSScriptRoot "..\..\skill.md"
    }
    if (Test-Path $skillPath) {
        foreach ($line in (Get-Content $skillPath -TotalCount 30)) {
            if ($line -match '^version:\s*["'']?([^"''\r\n]+)["'']?\s*$') {
                $SkillVersion = $Matches[1].Trim()
                break
            }
        }
    }
} catch { }

# ── 0. 解析当前环境（正式 / 灰度 / 测试）────────────────
# 与授权、调用侧共用同一套环境解析；服务名按环境区分，避免多环境注册时互相覆盖。
$EnvName = ""
$ProcessonMcpUrl = ""
$ServiceName = ""
try {
    $envMjs = (Join-Path $PSScriptRoot "..\env.mjs") -replace '\\', '/'
    $envProbe = "import('file:///$envMjs').then((m) => { const e = m.resolveEnv(); process.stdout.write([e.envName, e.mcpUrl, m.serviceNameFor(e)].join('\t')); }).catch(() => {});"
    $envInfo = (node -e $envProbe 2>$null | Out-String).Trim()
    if ($envInfo) {
        $parts = $envInfo -split "`t"
        if ($parts.Count -ge 1) { $EnvName = $parts[0].Trim() }
        if ($parts.Count -ge 2) { $ProcessonMcpUrl = $parts[1].Trim() }
        if ($parts.Count -ge 3) { $ServiceName = $parts[2].Trim() }
    }
} catch { }
# env.mjs 不可用时回退到内置正式环境
if ([string]::IsNullOrWhiteSpace($ProcessonMcpUrl)) { $ProcessonMcpUrl = "$ProcessonBaseUrl/api/activity/mcp" }
if ([string]::IsNullOrWhiteSpace($ServiceName)) { $ServiceName = "processon" }
if ([string]::IsNullOrWhiteSpace($EnvName)) { $EnvName = "prod" }

function Have-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ── 1. 确保 mcporter 存在 ─────────────────────────────
function Ensure-Mcporter {
    if (Have-Cmd "mcporter") { return }
    if (Have-Cmd "npm") {
        Write-Host "  未找到 mcporter，正在安装..."
        npm install -g mcporter | Out-Null
        Write-Host "  mcporter 安装完成"
    } else {
        Write-Error "未找到 mcporter，且当前环境没有 npm，无法自动安装。请先安装 Node.js 后重试。"
        exit 1
    }
}

# ── 2. 读取已有 apiKey（注册时保留）─────────────────────
function Get-ExistingAuthorization {
    try {
        $output = mcporter config get $ServiceName 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $output) { return "" }
        $text = ($output | Out-String)
        $match = [regex]::Match($text, '(?im)^\s*Authorization:\s*(.+)$')
        if ($match.Success) { return $match.Groups[1].Value.Trim() }
    } catch {
        return ""
    }
    return ""
}

# ── 3. 验证 apiKey 是否真实可用（直连调 check，不建临时配置）──
# 判据：鉴权失败信号 -32001 / ApiKey解析失败 / Unauthorized
function Test-ApiKey($rawAuth) {
    $candidate = ($rawAuth -replace '^(?i)Bearer\s+', '').Trim()
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }

    $payload = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check","arguments":{}}}'
    $headers = @{
        "Content-Type"  = "application/json"
        "Accept"        = "application/json"
        "Authorization" = "Bearer $candidate"
    }

    try {
        $response = Invoke-WebRequest -Uri $ProcessonMcpUrl -Method Post -Headers $headers `
            -Body $payload -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
        $body = $response.Content
    } catch {
        return $false
    }

    if ([string]::IsNullOrWhiteSpace($body)) { return $false }
    # 先判成功：check 正常返回含 "result"
    # （其正文本身含 "ApiKey" 字样，故不能用 ApiKey 作为失败判据）
    # 其余一律视为不可用（含 -32001 / ApiKey解析失败 / Unauthorized 等）
    return ($body -match '"result"')
}

# ── 4. 写入 mcporter 配置（已有 apiKey 须验证通过才沿用）──
function Register-Mcp {
    $existingAuth = Get-ExistingAuthorization
    $validAuth = ""

    if (-not [string]::IsNullOrWhiteSpace($existingAuth)) {
        Write-Host "  检测到已有凭据，正在验证是否可用..."
        if (Test-ApiKey $existingAuth) {
            $validAuth = $existingAuth
            Write-Host "  验证通过，沿用现有凭据"
        } else {
            Write-Host "  现有凭据已失效，将丢弃"
        }
    }

    Write-Host "  注册 $ServiceName（环境：$EnvName）→ $ProcessonMcpUrl"
    # remove 允许失败（配置本来可能不存在），不检查退出码
    mcporter config remove $ServiceName 2>$null | Out-Null

    if ([string]::IsNullOrWhiteSpace($validAuth)) {
        mcporter config add $ServiceName $ProcessonMcpUrl `
            --header "accept=application/json" `
            --header "X-Skill-Version=$SkillVersion" `
            --transport http --scope home | Out-Null
        $addExit = $LASTEXITCODE
    } else {
        mcporter config add $ServiceName $ProcessonMcpUrl `
            --header "Authorization=$validAuth" `
            --header "accept=application/json" `
            --header "X-Skill-Version=$SkillVersion" `
            --transport http --scope home | Out-Null
        $addExit = $LASTEXITCODE
    }

    # config add 必须成功，失败即终止并如实报错
    if ($addExit -ne 0) {
        Write-Error "注册 $ServiceName 失败（mcporter 退出码 $addExit）。请检查 mcporter 是否可用，或手动执行：mcporter config add $ServiceName $ProcessonMcpUrl --transport http --scope home"
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($validAuth)) {
        if ($EnvName -eq "prod") {
            Write-Host "  尚未授权：请执行 node get-token.mjs processon_check_and_start_auth 完成授权"
        } else {
            Write-Host "  尚未授权：请执行 PO_ENV=$EnvName node get-token.mjs processon_check_and_start_auth 完成授权"
        }
    }
}

Write-Host ""
Write-Host "===== ProcessOn Skill 环境配置 ====="
Write-Host ""
Ensure-Mcporter
Register-Mcp
Write-Host ""
Write-Host "  配置完成。已注册 MCP：$ServiceName（环境：$EnvName）"
Write-Host "  验证：可让 AI 调用 $ServiceName 的 check 工具确认 apiKey 是否生效。"
Write-Host ""
