# 请求来源标识与用户侧链接参数

> 本文件是**配置 / 埋点参考**，按需加载：仅在需要**拼接或校验交给用户点击的 ProcessOn 页链接**（付费 / 点数 / 授权页），或排查请求来源标识时读取。常规的生成、编辑、查询、导出**不需要**读本文件。

---

## 一、两个占位符

| 占位符 | 含义 | 取值来源 |
|---|---|---|
| `{BASE}` | **当前环境的站点根** | `node scripts/get-token.mjs processon_env_info` 的 `SITE_BASE` / `LINK_*`（`LINK_*` 是可直接照抄的整条链接），或 `scripts/env.mjs` 的 `siteUrls()` |
| `{CHANNEL}` | **本包对应的载体来源** | 打包时已按包注入（渠道包 = 渠道名，官网包 = `workbuddy`）；**读到本文档时它已是实际值，无需再替换** |

- `{BASE}` 常见形态：正式 `https://www.processon.com` · 灰度 `https://v5hd.processon.com`；用哪个由 `PO_ENV` / 包内默认环境决定（自定义环境由 `envs.json` 定义）。
- **任何文档、话术、新脚本都不得硬编码域名** —— 写死会在切到灰度等其他环境后指错环境。
- 运行时若需临时改变载体来源，用 `PO_SOURCE=<值>` 覆盖 `{CHANNEL}`（见第二节）。

---

## 二、请求来源标识（埋点 source）

后端按宿主做埋点统计，所有出站请求统一携带请求来源：

- **默认值**：`{CHANNEL}`（本包对应的载体来源，随包注入）
- **覆盖方式**：在命令前加 `PO_SOURCE=<值>`，例如 `PO_SOURCE=foo node scripts/orchestrator.mjs ...`（优先级高于包内默认值）
- **携带位置**：HTTP 请求头 `X-Source: <值>`，覆盖三类出站请求：
  1. **MCP 工具调用**（`scripts/mcp.mjs` 的 `callTool`）— `check` / `generatedDsl` / `createProcessOnFile` / `updateProcessOnFile` / `queryProcessOnFile`
  2. **导出图片接口**（`scripts/export.mjs`）— `/api/activity/mcp/skill/feature/export/img`
  3. **授权相关接口**（`scripts/get-token.mjs` 的 `requestJson`）— token 查询与轮询
- **取值来源（按优先级）**：`PO_SOURCE` 环境变量 > 包内 `scripts/channel.json`（仅渠道包带此文件）> 内置默认 `workbuddy`。
- **维护位置**：仅在 `scripts/mcp.mjs` 的 `readSkillSource()` / `SKILL_SOURCE` 一处定义；其余脚本通过 `import { SKILL_SOURCE } from "./mcp.mjs"` 复用，**不要在多文件里硬编码载体值**。
- **调试 / 验证**：跑一条只读命令让任一 MCP 请求带上 `X-Source` 头，例如 `node scripts/query.mjs title=__wb_source_test__`；再回后端日志确认已采集。
- **与用户侧 URL 参数的关系**：`X-Source`（请求头）与 `payPointSource`（URL 参数）是**两条独立通道、同一个值源**——都取自 `SKILL_SOURCE`。前者给后端 API 采集，后者给用户点击的页面（付费链接、授权页）采集。载体变化时，一次 `PO_SOURCE=<值>` 即可让两者同时切换，不存在两处各改一遍的问题。

---

## 三、用户侧链接的追踪参数（付费链接 + 授权页）

凡是要**交给用户点击打开的 ProcessOn 页面链接**，都必须带上两个 query 参数，以便后端按来源追踪。目前有两类：**付费/购买链接**（非会员 / 点数不足场景）与**授权页链接**（打开授权页面时）。

- `source=processon_skill`（**固定值**，标识流量来自本 Skill，所有场景、所有载体都一样）
- `payPointSource=<载体来源>`（**与 `X-Source` 头同源**；取值优先 `PO_SOURCE` 环境变量，否则用包内渠道值 `{CHANNEL}`）

### `payPointSource` 的取值（与 `X-Source` 头对齐，**不可写死**）

| 载体 | `PO_SOURCE` 值 | URL 中 `payPointSource` 的值 |
|---|---|---|
| **本包对应载体** | `{CHANNEL}`（默认） | `payPointSource={CHANNEL}` |
| 其他载体（IDE/示例等） | 调用方在命令前传 `PO_SOURCE=<载体值>` | `payPointSource=<载体值>` |

> 核心约束：`payPointSource` **必须与同时刻下的 `X-Source` 头使用同一个值**——两者都取自 `SKILL_SOURCE`（见第二节）。本包载体下两者都等于 `{CHANNEL}`；改用其他载体时要同时替换两处。

### 适用场景（仅这三种）

下表给出本包对应载体（`payPointSource={CHANNEL}`）的最终链接形态；**改用其他载体时，把链接里的 `payPointSource={CHANNEL}` 整体替换为对应载体值即可**，其他部分不变。

| 触发条件 | 链接原型 | 给用户的完整链接（本包载体 `{CHANNEL}`） |
|---|---|---|
| **免费用户 / 非会员**（`815` 或 `61685` 含「会员/升级」字样） | `{BASE}/setting?paytype=personal` | `{BASE}/setting?paytype=personal&source=processon_skill&payPointSource={CHANNEL}` |
| **VIP 会员 AI 点数不足**（`61685` 仅含「点数/不足/已消耗」，无「会员/升级」） | `{BASE}/setting?paytype=aipoint` | `{BASE}/setting?paytype=aipoint&source=processon_skill&payPointSource={CHANNEL}` |
| **免费用户导出图片带水印**（按返回 `member` 判断） | 同上 `paytype=personal` | 同上 personal 链接 |
| **打开授权页面**（未授权 / 需重新授权，浏览器三层降级） | `{BASE}/thirds/skillauth?uuid=<code>&origin=skill` | `{BASE}/thirds/skillauth?uuid=<code>&origin=skill&source=processon_skill&payPointSource={CHANNEL}` |

> 授权页 URL 由 `scripts/get-token.mjs` 自动拼好（含上述两个参数），AI **不得手工改写** `AUTH_REQUIRED:<url>` 里的链接；无论走载体内置浏览器、系统浏览器还是展示给用户手动打开，都使用脚本输出的原样 URL。

### 不加参数的链接（明确范围，避免误加）

| 链接 | 用途 | 是否加 `source` / `payPointSource` |
|---|---|---|
| `{BASE}/setting` | 账户中心 / 取 apiKey | ❌ 不加 |
| `{BASE}/payment` | AI 点数消耗记录页 | ❌ 不加 |
| 文件链接（`/diagraming/<id>`、`/mindmap/<id>`） | 文件查看与编辑 | ❌ 不加 |
| 文件缩略图链接 | 缩略图 | ❌ 不加 |
| 授权页 `thirds/skillauth` | 登录授权 | ✅ **要加**（脚本自动拼接） |

### 实现要点

- **只在给用户展示的链接上拼接**，参数是**给用户点击的 URL 的一部分**，不是后端 API 请求参数。
- **固定部分**：`source=processon_skill` 永远不变。
- **可变部分**：`payPointSource` 与 `X-Source` 头同源，**取值不可写死**——其他载体部署时通过 `PO_SOURCE` 环境变量覆盖 `SKILL_SOURCE`，URL 中的 `payPointSource` 也改为同一值。
- 参数拼接顺序：`paytype` 必须在前；`source=processon_skill` 与 `payPointSource=<载体值>` 用 `&` 串接，**位置与顺序不得更改**。
- **授权页 URL 的拼接位置**：`scripts/get-token.mjs` 的 `generateAuthUrl()`，输出形如 `?uuid=<code>&origin=skill&source=processon_skill&payPointSource=<SKILL_SOURCE>`。AI 直接使用该输出，不改写、不删参数、不额外追加。
- 不要把这两个参数加到 `scripts/mcp.mjs` / `scripts/export.mjs` / `scripts/get-token.mjs` 的任何 HTTP 请求头或 body 中——那是给后端 API 用的，与本规则互不干扰（HTTP 头走 `X-Source`，URL 参数走 `payPointSource`，**两者值由 `SKILL_SOURCE` 统一提供**）。

> 环境与端点的解析规则（`PO_ENV`、多环境隔离、三套地址）见 `references/auth.md`「多环境隔离」与「服务地址」。
