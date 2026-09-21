# 认证配置与鉴权降级

> 本文件仅在**鉴权失败、MCP 工具未注册、需要手动配置**时读取。正常调用（已授权）不需要读本文件。

**鉴权失败信号**：MCP 调用返回 `{"error":{"code":-32001,...}}`（"ApiKey解析失败" / "Unauthorized"），即 apiKey 缺失或失效。

| 环境 | MCP 服务名 | 端点 | 鉴权 header |
|------|-----------|------|------------|
| 正式 | `processon` | MCP 端点 = 正式站 `/api/activity/mcp` | `Authorization: Bearer <apiKey>`（也兼容 `X-Mcp-ApiKey`） |
| 灰度 | `processon-gray` | MCP 端点 = 灰度站 `/api/activity/mcp` | 同上 |

> 具体地址见下文「服务地址」表，实际值用 `node scripts/get-token.mjs processon_env_info` 查看（**不硬编码**）。
> 各环境的 apiKey **互不通用**，凭据按环境隔离存放；切换环境不会覆盖其他环境的授权。详见下文「多环境隔离」。

---

## MCP 注册与配置（三层降级）

仅当调用发现 MCP 工具**根本不存在**（未注册）时才处理。按下列顺序降级，**每层只试一次，最多两次自动尝试**，第三层交还用户自助：

**第 1 层（主路径）**：`node scripts/get-token.mjs processon_check_and_start_auth`
一条命令完成：安装 mcporter（如缺）→ 注册 processon → 自动开浏览器授权取 apiKey。全平台通用。成功即重试原任务。
> 为灰度环境授权时，在命令前加 `PO_ENV=gray`（缺省即正式 `prod`）；**授权与之后的调用必须带同一个 `PO_ENV`**。

**第 2 层（失败后重试一次）**：先按系统注册，再补授权
```
mac/Linux : bash scripts/setup/setup.sh
Windows   : powershell -ExecutionPolicy Bypass -File .\scripts\setup\setup.ps1
任意平台   : node scripts/setup/setup.cjs   # Node 兜底
随后      : node scripts/get-token.mjs processon_check_and_start_auth   # setup/* 只注册端点、不取 apiKey，须再授权
```
成功即重试原任务。

**第 3 层（两次都失败）**：停止自动尝试，友好告知用户并**交出手动配置信息**
- 给出 MCP 配置 json，请用户自行加入所用工具的 MCP 配置（服务名与 `url` 都取**当前环境**的：正式 `processon`、灰度 `processon-gray`；端点见 `processon_env_info` 的 `MCP_URL`）：

  ```json
  {
    "mcpServers": {
      "processon": {
        "type": "http",
        "url": "<当前环境的 MCP 端点，见 processon_env_info 的 MCP_URL>",
        "headers": {
          "Authorization": "Bearer <你的 apiKey>"
        }
      }
    }
  }
  ```

- 告知 apiKey 获取方式：登录 ProcessOn **账户中心**获取，替换上面的 `<你的 apiKey>`。
- 提示配置后需重启所用工具使其生效。
- 不得呈现原始报错或错误码，也不要说明尝试了几次。

> `scripts/setup/` 下的 `setup.sh` / `setup.ps1` / `setup.cjs` 三端行为一致：确保 mcporter 已安装（缺则 `npm install -g mcporter`）→ 注册 processon 端点（若已有有效 apiKey 则保留）。**三者都不会取 apiKey**，授权一律由 `scripts/get-token.mjs` 完成。
>
> **mcporter 仅用于鉴权注册与凭据存储**；实际的工具调用（生成、新建、编辑、查询）由 `scripts/mcp.mjs` 直连 MCP JSON-RPC 接口完成，不经 mcporter（规避 SSE 406 问题）。

---

## apiKey 获取 —— 自动授权（get-token.mjs）

### 浏览器选择（三层降级）

| 优先级 | 浏览器 | 做法 |
|--------|--------|------|
| 1（首选） | 载体内置浏览器 | `PO_EMBEDDED_BROWSER=1 node scripts/get-token.mjs processon_check_and_start_auth` → 输出 `AUTH_REQUIRED:<url>` → AI 用当前载体的内置浏览器打开 |
| 2（降级） | 系统外置浏览器 | `node scripts/get-token.mjs processon_check_and_start_auth`（不带开关）→ 脚本自动打开系统浏览器并阻塞轮询 |
| 3（兜底） | 用户手动复制链接 | 脚本输出 `AUTH_REQUIRED:<url>` 时，把 `<url>` 展示给用户自行打开 |

> 为灰度环境授权时，命令前加 `PO_ENV=gray`（缺省正式）——授权页与换取接口都会自动使用该环境的地址，凭据也写入该环境的槽位。

- **打开成功的判据**：内置浏览器打开动作的**返回结果明确表示成功**（返回中出现该授权链接/页面）才算打开成功；返回为空、异常、超时、载体无内置浏览器能力、返回不含该链接，一律视为**未确认成功 = 失败**。后续轮询超时只代表"用户未完成授权"，**不能反推浏览器是否打开**。
- **话术**：打开成功才提示「已在右侧浏览器打开授权页，请登录并点击授权」；失败 / 未确认成功时**不得说"已打开"**，直接走降级。
- **提示必须附带兜底链接**：内置浏览器**无法保证真实显示**（2026-09-18 实测：http + 私有 IP 地址时打开动作返回成功但面板不显示）。因此**无论打开动作是否报告成功**，提示语之后都必须紧跟一句：「如果未打开内置浏览器，请点击以下链接进行授权：<脚本输出的原样授权链接>」。链接原样输出，不得删改参数。
- 内置浏览器打开失败（工具不可用 / 打开失败 / 页面异常 / 未确认成功）→ 降级到第 2 层（重新调用会重新生成 code，旧 code 作废、无害），不反复重试内置浏览器。
- 系统浏览器也打不开（无图形界面）→ 脚本自动回退输出 `AUTH_REQUIRED:<url>`，走第 3 层。
- **授权页 URL 自带来源追踪参数**：`generateAuthUrl()` 输出的链接已包含 `source=processon_skill&payPointSource=<载体值>`（`payPointSource` 与 `X-Source` 头同源，取自 `SKILL_SOURCE` / `PO_SOURCE`；默认用本包渠道值 `{CHANNEL}`）。**AI 必须原样使用脚本给出的链接**——三层降级（内置浏览器 / 系统浏览器 / 展示给用户手动打开）都不得删改、重排或补写这些参数。

执行 `node scripts/get-token.mjs processon_check_and_start_auth`，该命令一次完成：检查是否已授权 → 打开浏览器 → 阻塞轮询（最长 180 秒，即 uuid 有效期）→ 写入配置。

**打开动作执行后**，以打开结果决定提示：系统浏览器成功打开（脚本进入阻塞轮询）才提示「正在为你打开浏览器完成授权，请在弹出的页面中点击确认」；脚本输出 `AUTH_REQUIRED:<url>`（打开失败）时**不得说"已打开"**，按下方输出表走第 3 层。
**执行时**须允许 ≥ 180 秒的超时，不要中途打断。

按输出结果处理：

| 输出 | 处理 |
|------|------|
| `READY` / `TOKEN_READY` | 授权就绪，**直接继续用户的原任务**，不要再问「授权好了吗」 |
| `AUTH_REQUIRED:<url>` | **按是否带 `PO_EMBEDDED_BROWSER=1` 分两种上下文**：①**带**（本 Skill 的固定路径）——脚本按设计**不自己开浏览器**，此标记表示「请 AI 用载体内置浏览器打开该链接」，打开失败/不可用再按上文「浏览器选择」降级；②**不带**——脚本已尝试系统浏览器且**失败**，把 `<url>` 原样、友好地展示给用户请其手动登录（话术如「请打开这个链接登录授权」，不提 code/轮询）。两种上下文随后都执行 `processon_wait_for_token_auto` 等待 |
| `ERROR:auth_timeout` | **不等于授权失败** —— code 仍有效，用户可能刚好在超时前后完成了授权。先执行 `processon_fetch_token` 补取：成功即继续原任务；仍失败则询问用户是否已在页面点击授权，答"已完成"再补取一次，答"未完成"才执行 `processon_reauthorize` |
| 其他 `ERROR:*` | 按 `references/errors.md`「错误速查」处理 |

- `processon_reauthorize`（清旧凭据、重新开浏览器）是**最后手段**：它会丢弃仍然有效的 code、让用户重新授权一遍。鉴权失败需要重新授权时才用。
- 仅当浏览器无法自动打开、或补取后仍未授权时，才需要用户介入。

**校验**：`check` 工具可确认 apiKey 是否就绪。

> ⚠️ **`check` 的返回体中含完整明文 apiKey**（形如 `API BaseUrl: ..., ApiKey: ...`）。**仅用于内部判断是否已配置，返回内容一律不得回显给用户**：不得原样展示、不得摘录、不得复述其中的 apiKey，也不得写入任何文件或日志。对用户只说结论（如「配置正常」），不带 apiKey 值。
>
> ⚠️ **用载体内置浏览器打开授权页后，AI 只等待用户授权**：禁止读取授权页的 cookie / localStorage / sessionStorage / 页面文本（含登录态或任何密钥）；apiKey 仅由脚本换取并写本地，禁止回显、摘录、复述、写文件。

| 场景 | 处理 |
|------|------|
| 无 apiKey / 未配置 | 走 `scripts/get-token.mjs` 自动授权（见上） |
| **已登录成功但 apiKey 不可用** | **再次弹出授权链接，请用户再次授权**：预告后执行 `node scripts/get-token.mjs processon_reauthorize`；浏览器未自动打开时，把 `AUTH_REQUIRED:<url>` 中 `<url>` 原样发给用户手动打开，随后执行 `processon_wait_for_token_auto` 等待；拿到 `TOKEN_READY` 即授权完成，直接继续原任务 |
| 调用返回鉴权失败（`-32001` / 401 / ApiKey 解析失败） | 先执行 `scripts/get-token.mjs processon_check_and_start_auth`；**若返回 `READY` 但重试仍失败** → **立即执行 `scripts/get-token.mjs processon_reauthorize`** 强制重新授权 |
| 授权连续失败两次 | 停止自动尝试，按「MCP 注册与配置（三层降级）」第 3 层交出手动配置信息 |
| apiKey 有效 | 直接执行能力 |

---

## 多环境隔离（正式 / 灰度 / 自定义）

各环境的 apiKey 互不通用。Skill 已按环境隔离，**不需要**为了切环境而删除或重做授权。

### 环境怎么定

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `PO_ENV` | 显式指定环境（内置 `prod` / `gray`，也接受别名 `grey`、`正式`、`灰度`；自定义环境名同样可用） |
| 2 | `PO_MCP_URL` / `PO_API_BASE_URL` / `PO_AUTH_BASE_URL` | 单独覆盖某个端点 |
| 3 | **包内 `scripts/envs.json`** | 随包分发，声明**这个包默认跑哪套环境**（`default` 字段）。主技能不带此文件 → 默认 `prod` |
| 4 | 用户级 `~/.processon-skill/envs.json` | 覆盖地址 / 扩充环境（模板：`scripts/envs.example.json`） |
| 5 | 内置预设 | `prod` / `gray` 两个环境的默认地址 |

> `PO_ENV` 指定的环境若既没有定义、也没给端点覆盖，脚本会**直接报错**而不是回落到默认环境——避免「以为在 A 环境、实际打到 B 环境」。

### 默认环境（不带 `PO_ENV` 时用哪套）

```
包内 scripts/envs.json 的 default  >  用户级 ~/.processon-skill/envs.json 的 default  >  prod
```

- **包内声明优先**：它代表「这个包就是为哪套环境准备的」；主技能无此文件 → 默认正式。
- 用户级文件的 `default` 只在包内未声明时生效（它主要用于覆盖地址、扩充环境）。
- 用 `processon_env_info` 的 `DEFAULT_ENV` 行确认当前默认环境（会标注是否来自包内声明）。
- 需要一套自定义环境（如内部环境）时，在用户级 `~/.processon-skill/envs.json` 里定义它的 `base` 即可，无需改包内文件。

### 隔离机制

- **凭据分槽**：`~/.processon-skill/token.json` 按环境分别存放（`environments[<环境>]` 各自独立），切换环境只影响自己的槽位。
- **只清本环境**：重新授权前的清理只作用于当前环境，其他环境的授权原样保留——**不再需要删授权来切环境**。同 origin 的别名字槽也只在「本次 `envKey` 是该 origin 的规范环境名」时才一并清理，避免 `PO_ENV` 与 `PO_MCP_URL` 指向不一致时误删别的环境。
- **读取强校验**：读到的凭据必须与当前端点同源，不匹配一律视为未授权并引导授权，**不会**拿 A 环境的 apiKey 去请求 B 环境的端点。
- **mcporter 服务名分环境**：正式 `processon`、灰度 `processon-gray`，注册时不会互相覆盖。
- **自动迁移**：旧版单份凭据会在首次写入时按其记录的端点归入对应环境槽（按端点判归属，**不会**因为包默认环境不同而误归）；迁移前自动留一份 `token.json.v1.bak`，权限同样为 `600`。

### 站点链接跟随环境

**所有交给用户点击的 ProcessOn 页面链接都以当前环境的站点根为前缀**（付费 / 点数购买 / 账户中心 / 点数记录 / 授权页），下文统一记作 `{BASE}`：

- 实际值取自 `node scripts/get-token.mjs processon_env_info` 输出的 `SITE_BASE` 与 `LINK_*`（`LINK_*` 是可直接照抄的整条链接）；
- 或由 `env.mjs` 的 `siteUrls(env, source)` 生成（授权页 URL 由 `generateAuthUrl()` 按当前环境自动拼好）；
- **不得**在文档、话术或新脚本里硬编码 `www.processon.com` / `v5hd.processon.com` 或其他环境的地址 —— 否则切到别的环境后链接会指错环境。

### 常用命令

```bash
node scripts/get-token.mjs processon_env_info                                                  # 当前环境、默认环境、各环境授权情况、当前环境的用户侧链接
PO_ENV=gray PO_EMBEDDED_BROWSER=1 node scripts/get-token.mjs processon_check_and_start_auth    # 为灰度环境授权
```

> **一轮任务内环境必须一致**：`PO_ENV` 要同时作用于授权与后续所有调用，否则会落到不同环境的槽位。
> **不要手工编辑凭据文件**；换环境只用 `PO_ENV`（或端点环境变量）。

---

## 服务地址

| 用途 | 地址 |
|------|------|
| 站点根 `{BASE}` | 正式 `https://www.processon.com` · 灰度 `https://v5hd.processon.com`（**当前用哪个由 `PO_ENV` 或包内默认环境决定**；自定义环境由 `envs.json` 定义） |
| MCP 端点 | `{BASE}/api/activity/mcp` |
| 授权页 | `{BASE}/thirds/skillauth?uuid=<code>&origin=skill&source=processon_skill&payPointSource=<载体值>`（实际 URL 由 `generateAuthUrl()` 按当前环境自动拼好） |
| 账户中心（取 apiKey） | `{BASE}/setting` |
| AI 点数记录页 | `{BASE}/payment` |
| 开通会员（免费用户付费） | `{BASE}/setting?paytype=personal&source=processon_skill&payPointSource={CHANNEL}` |
| AI 点数购买（VIP 会员） | `{BASE}/setting?paytype=aipoint&source=processon_skill&payPointSource={CHANNEL}` |

> **以上全部随环境切换**：`{BASE}` 由 `PO_ENV`（或包内 / 用户级 `envs.json` 的 `default`）决定。不必自己拼——`node scripts/get-token.mjs processon_env_info` 会直接列出当前环境的 `SITE_BASE` 与 `LINK_*`（整条可用链接），照抄即可。**任何文档、话术、新脚本都不得硬编码域名。**
> 脚本中的端点统一由 `scripts/env.mjs` 按 `PO_ENV` 解析，可用 `PO_MCP_URL` / `PO_API_BASE_URL` / `PO_AUTH_BASE_URL` 单独覆盖；`scripts/setup/` 下的 `setup.sh` / `setup.ps1` / `setup.cjs` 同样支持 `PO_ENV`，另可用 `PROCESSON_BASE_URL` 兜底指定地址。
