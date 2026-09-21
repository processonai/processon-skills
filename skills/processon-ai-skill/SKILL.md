---
name: processon-ai-skill
description: "ProcessOn 官方作图 Skill，可在 ProcessOn 账号下新建、编辑、查询、导出各类图形文件。覆盖流程图类：流程图、业务流程图、泳道图、BPMN、时序图、UML图、ER图、架构图（系统/软件/云架构）、网络拓扑图、韦恩图、电路图、平面图、图表、UI原型/界面图、路线图、信息图、金字塔图、草图重绘；以及思维导图类：思维导图、脑图、组织结构图、鱼骨图、时间轴、树形图、逻辑图、表格图/树形表格、提纲、知识整理/内容总结。适用于：画流程图、做思维导图、生成图表、可视化流程、把内容整理成图、把图保存到 ProcessOn、修改/查找/导出我的 ProcessOn 文件。"
author: ProcessOn
homepage: https://www.processon.com
version: 2.1.0
metadata: {"file_types":["流程图","思维导图"],"category":"productivity"}
---

# ProcessOn AI Skill 使用指南

本 Skill 让用户通过自然语言对话，完成 ProcessOn **流程图**与**思维导图**的生成与管理：先把需求转成图数据，再落库到用户账号，支持新建、编辑、查询、导出。

> **按需加载**：本文件只含每次调用都需要的核心规则。**按任务类型只读对应的一个 reference 文件**，不要全部读取。仅在出错时读 `references/errors.md`；**需要授权时（首次操作未授权、或鉴权失败 `-32001`）必须先读 `references/auth.md`** —— 授权命令的开关与浏览器优先级只在该文件写明，不读会默认走错路径。**要拼接交给用户点击的付费 / 授权页链接时读 `references/tracking.md`**（埋点与链接参数在该文件）。

## 工具与辅助脚本

本 Skill 编排一个 MCP 服务：**processon**（远端 HTTP 服务），共 5 个工具（`check` / `generatedDsl` / `createProcessOnFile` / `updateProcessOnFile` / `queryProcessOnFile`），参数与职责见文末「工具参数速查」。

**辅助脚本**（在 `scripts/` 目录）：
- **`scripts/mcp.mjs`**：MCP 直连客户端。所有脚本通过它用 Node 原生 fetch 调 MCP JSON-RPC 接口（`Accept: application/json`，不经 mcporter，规避 SSE 406 问题）。
- **`scripts/orchestrator.mjs`**：流程图线专用，把 `generatedDsl → create/update` 两步串成一条命令，DSL 在脚本内部流转不经 AI。
- **`scripts/mindcreate.mjs`**：思维导图线专用，AI 只给 Markdown 与主题名；脚本内部完成 theme JSON 取值、base64 编码与落库（新建/编辑一条命令）。
- **`scripts/query.mjs`**：查询文件，AI 直接调用：`node scripts/query.mjs title='关键词'`。
- **`scripts/export.mjs`**：导出文件为图片 / PDF 并下载到本地 `~/Downloads/`，AI 直接调用：`node scripts/export.mjs chartId=<id> type=png|svg|pdf name='<文件标题>'`（`name` 建议总是传，否则文件名会用画布标题「画布1」；`type=pdf` 时内部走 svg→PDF 本地转换，交付只给 PDF 本地文件、不出现任何链接）。
- **`scripts/svg2pdf.mjs`**：本地 SVG→PDF 转换器（`export.mjs type=pdf` 内部自动调用；也可单独用 `node scripts/svg2pdf.mjs <in.svg> [-o out.pdf]`）。引擎自动探测：Chrome/Chromium/Edge headless → `rsvg-convert` → `cairosvg`，可用 `PO_SVG2PDF_CMD` 覆盖。
- **`scripts/get-version.mjs`**：版本自检（非阻塞）。拉取线上版本信息与本地比对，输出 `STATUS` / `CHANGELOG`，供会话首次成功后决定要不要提示更新。
- **`scripts/b64.mjs`**：base64 编码工具，仅编辑情况一（本地改 DSL，见 `references/edit.md`）直接调用；两条生成线的编码均由上面两个脚本内部完成。
- **`scripts/mcp-call.mjs`**：通用 MCP 工具调用包装，仅供编辑情况一（本地改文字）单步调 `updateProcessOnFile`；正常新建/编辑走 orchestrator / mindcreate。
- **`scripts/env.mjs`**：多环境解析与凭据分槽（正式 / 灰度 / 测试），同时提供当前环境的**用户侧链接表**。当前环境的端点、mcporter 服务名、凭据读写统一由它决定；切换环境用 `PO_ENV`（缺省取**默认环境**，见下文「多环境」）。环境清单分两层：**包内 `scripts/envs.json`**（声明这个包默认跑哪套环境，随包分发）与**用户级 `~/.processon-skill/envs.json`**（覆盖地址 / 扩充环境）；模板：`scripts/envs.example.json`。**各环境凭据互相隔离：切换环境不会覆盖其他环境的授权，也不会把某环境的 apiKey 用到另一环境的端点上。**

### 两条生成线（按图类型分流）

| 线 | 适用图类型 | 内容怎么来 | 落库参数 | 参考 |
|----|-----------|-----------|---------|------|
| **流程图线** | 流程图/UML/ER/泳道图等 | `orchestrator.mjs`（内部调 `generatedDsl` → DSL → 落库） | `category` + `title` + `content` + `reqId`（脚本内部处理） | `references/flowchart.md` |
| **思维导图线** | 思维导图/组织结构图/鱼骨图/时间轴/树形图/逻辑图/表格图 | `mindcreate.mjs`（AI 写 Markdown，脚本内部编码 + 取 theme + 落库，不调 `generatedDsl`） | `category` + `title` + `content(Markdown)` + `structure` + `theme`(只传主题名)（不传 reqId） | `references/mindmap.md` |

> **分流关键词**：流程图/UML/ER/泳道图/时序图/架构图/BPMN/韦恩图/网络拓扑/电路图/平面图/图表/UI原型 → 流程图线；思维导图/脑图/组织结构图/鱼骨图/时间轴/树形图/逻辑图/提纲/表格图/知识整理 → 思维导图线。**仅在分不清走哪条线时才问用户**。**思维导图线绝不调用 `generatedDsl`**。

---

## 工具调用方式

所有工具调用通过 `scripts/mcp.mjs` 直连 MCP JSON-RPC 接口，**不经 mcporter**。AI 侧只需调用对应的包装脚本，参数用 `参数=值` 形式：

| 操作 | 调用方式 |
|------|---------|
| 新建/编辑流程图 | `node scripts/orchestrator.mjs category=flowbase title='文件名' <<'POB64'` |
| 流程图编辑情况一（本地改文字，不调 generatedDsl、不传 reqId） | `node scripts/mcp-call.mjs updateProcessOnFile chartId=<id> content="$(node scripts/b64.mjs <<'POB64')"` title='原标题'，详见 `references/edit.md` |
| 新建/编辑思维导图 | `node scripts/mindcreate.mjs category=mind_free structure=mind_free theme=极简黑白 title='文件名' <<'POB64'` |
| 查询文件 | `node scripts/query.mjs title='关键词'` |
| 导出图片 / PDF | `node scripts/export.mjs chartId=<id> type=png|svg|pdf name='<文件标题>'` |
| 查看当前环境 / 各环境授权情况 / 当前环境的用户侧链接 | `node scripts/get-token.mjs processon_env_info` |
| 版本自检 | `node scripts/get-version.mjs` |

| 参数 | 传法 |
|------|------|
| `content` | **base64 编码**（两条生成线由脚本内部编码；仅情况一用 `b64.mjs`，禁止手搓） |
| `theme` | 思维导图线**只传主题名**给 `mindcreate.mjs`（脚本内部取完整 JSON） |
| `category` / `title` / `chartId` / `reqId` / `structure` | 明文 `参数=值`；**`title` 等自由文本值必须加引号**（mac/Linux 单引号、Windows cmd 双引号），防止其中的 `$`、反引号、`;`、空格被外层 shell 解释 |

> 脚本内部直连 MCP（HTTP POST JSON-RPC），不经 shell，无注入风险；外层（你拼的命令行 → 脚本）这层仍需闭合：`title` 值按平台加引号后再写进命令。`category` / `structure` / `theme` 是固定枚举值，无此问题。**不再需要 `--no-coerce`**。

### content 编码（脚本内部完成，情况一除外）

`content` 含 shell 元字符，一律传 base64（UTF-8、单行、保留 padding，跨平台一致）。两条生成线由 `orchestrator.mjs` / `mindcreate.mjs` 在脚本内部自动编码，**AI 无需手工编码**；**仅编辑情况一**（本地改 DSL，见 `references/edit.md`，命令块含完整 b64 用法）需直接调 `b64.mjs`。**禁止手工输出 base64、禁止用系统 `base64` 命令**（macOS 折行会导致解码失败）。heredoc 定界符 `POB64` 一律单引号包裹（`<<'POB64'`），防止 `$`、反引号被 shell 展开。

### theme 取值（只传主题名）

思维导图线的 `theme` **只传主题名**给 `mindcreate.mjs`（默认「极简黑白」），完整 JSON 由脚本内部从 `references/mindmap_themes.json` 原样取用——**AI 不提取、不手写、不转述 theme JSON**（值错了不报错，会静默产出错误样式）。主题名单与场景对照见 `references/mindmap.md` 第三节。

---

## 鉴权（前置检查）

- 纯问答 / 咨询 → 不触发鉴权，直接回答。
- 需要新建/编辑/查询文件：本会话**首次**操作前执行 `PO_EMBEDDED_BROWSER=1 node scripts/get-token.mjs processon_check_and_start_auth`：
  - **必须带 `PO_EMBEDDED_BROWSER=1`**：不带该开关时脚本会自行拉起**系统默认浏览器**（降级路径），不走载体内置浏览器，属于错误路径。
  - `READY` / `TOKEN_READY` → 继续；**鉴权通过后本会话不再重复检查**。
  - `AUTH_REQUIRED:<url>` → 用**当前载体的内置浏览器**打开该链接，请用户在其中登录授权，随后执行 `node scripts/get-token.mjs processon_wait_for_token_auto` 等待。**打开成功与否以打开动作的返回结果为准**：成功才提示「已在右侧浏览器打开授权页」；失败 / 不可用 / 未确认成功时**不得说「已打开」**，立即按 `references/auth.md` 三层降级切换，不反复重试内置浏览器。
  - **授权页提示必须附带兜底链接**：内置浏览器**无法保证真实显示**（2026-09-18 实测：http + 私有 IP 地址时打开动作返回成功但面板不显示）。因此**无论打开动作是否报告成功**，提示语之后都必须紧跟一句：「如果未打开内置浏览器，请点击以下链接进行授权：<脚本输出的原样授权链接>」。链接原样输出，不得删改。
  - `ERROR:*`、鉴权失败（`-32001`）或 MCP 未注册 → 读 `references/auth.md` 按三层降级处理。

### 多环境（正式 / 灰度 等）

- 各环境的端点与凭据**互相隔离**：凭据按环境分槽存放，切换环境不会覆盖其他环境的授权，也不会把某环境的 apiKey 用到另一环境的端点上。
- 切换环境用 `PO_ENV`（如 `PO_ENV=gray`）。**不传 `PO_ENV` 时用「默认环境」**——由**包内 `scripts/envs.json`** 的 `default` 决定（主技能无此文件 → 默认正式 `prod`），包内未声明时才看用户级 `~/.processon-skill/envs.json`。
- 例：`PO_ENV=gray PO_EMBEDDED_BROWSER=1 node scripts/get-token.mjs processon_check_and_start_auth`。
- **同一轮任务内环境固定**：若中途要换环境，前后所有脚本调用必须带同一个 `PO_ENV`，否则会落到不同环境的凭据槽。
- **所有交给用户点击的链接都跟随当前环境**（**不得硬编码域名**）：付费/开通、AI 点数购买、账户中心、点数记录页、授权页，一律以当前环境的站点根为前缀。下文统一记作 `{BASE}`，实际值取自 `node scripts/get-token.mjs processon_env_info` 输出的 `SITE_BASE` 与 `LINK_*` 行（也可由脚本直接生成），不要凭记忆拼域名。
- 排查用 `node scripts/get-token.mjs processon_env_info`（查看当前环境、默认环境、各环境是否已授权，不含凭据）；改地址用 `~/.processon-skill/envs.json`（模板 `scripts/envs.example.json`）。
- 详细说明见 `references/auth.md`「多环境隔离」。

---

## 严格规则

### MUST

- **前置鉴权**：首次文件操作前检查；纯问答不触发。通过后本会话不再重复。授权命令**必须带 `PO_EMBEDDED_BROWSER=1`**（否则会用系统浏览器），详见 `references/auth.md`。`-32001` 时走 `references/auth.md` 重新授权。
- **环境隔离**：各环境（正式 / 灰度 等）的凭据按环境分槽，脚本已按端点强制校验归属；换环境一律用 `PO_ENV`，**不得**手工编辑凭据文件、**不得**把某环境的 apiKey 手工用于另一环境。
- **链接跟随环境**：所有交给用户点击的 ProcessOn 页链接（付费 / 点数购买 / 账户中心 / 点数记录 / 授权页）都必须以**当前环境的站点根** `{BASE}` 为前缀，取自 `processon_env_info` 的 `SITE_BASE` / `LINK_*` 或脚本输出，**不得硬编码域名**（否则切到其他环境后链接会指错环境）。
- **按线生成内容**：流程图线用 `orchestrator.mjs`（DSL 不经 AI）；思维导图线用 `mindcreate.mjs`（AI 只写 Markdown + 选主题名，编码与 theme JSON 由脚本内部处理），必填 `structure` + `theme`(主题名)，**绝不调 `generatedDsl`**。
- **DSL 原样搬运**：`orchestrator.mjs` 内部原封不动，禁止修改/格式化/截断/重写。
- **`reqId`**：流程图新建、编辑情况二必传（由 orchestrator 内部处理）；编辑情况一与思维导图**不传**。禁止编造或复用旧 reqId。
- **`category` 与 `structure` 分开**：不同参数、取值范围不同，不得混为一谈。
- **仅在分不清走哪条线时才问用户**。已能确定走哪条线时不要追问具体类型，category 取不到值用兜底（`flowbase` / `mind_free`）。
- **一次只生成一个图**。用户要多个时逐个处理。
- **重试上限 2 次**：同一任务累计最多尝试 2 次。仍失败即停止写操作，按 `references/errors.md` 友好告知。
- **写操作后以返回结构确认成功**（chartId + 链接）。
- **成功后必须在内置浏览器打开文件链接**：新建/编辑成功后，用**当前载体的内置浏览器**打开该文件的**文件链接**（用 `present_files` 传 **文件链接**，不传缩略图链接），让用户直接在右侧浏览器查看或编辑。**打开是否成功以该动作的返回结果为准**，并据此决定要不要输出下文那句固定提示。
- **必须在新页签打开（不得覆盖已有页签）**：每次只提交**当前这一个新文件**的文件链接（一次一图），让新文件落在**新的浏览器页签**里；**不得覆盖、替换或顶掉用户此前已打开的其他文件页签**，也不要把历史文件链接与新文件链接放进同一次打开动作。若载体确实无法新开页签，则保持原有页签不被动关闭，并在文案中按固定提示语照常交付。
- **统一交付内容**：新建/编辑/查询成功后展示 **文件名 + 类型 + 文件链接 + 文件缩略图链接**；消耗AI点数存在且大于 0 时另加。思维导图另需展示 Markdown，**置于链接之后**。
- **交付文案固定加一句（加粗 + 降级机制）**：所有生成/修改类交付（**流程图、思维导图、编辑均适用**），**仅当内置浏览器确实成功打开文件链接时**，才在文案中输出**加粗**的一句「**已在右侧浏览器已打开该文件，您可进行查看或编辑→→**」；**内置浏览器不可用 / 打开失败 / 当前载体无内置浏览器**时，必须**省略这句**（不得以普通文字或加粗形式变相输出），改用兜底话术「可点击链接查看与编辑」，**严禁谎称已在右侧浏览器打开**。
- **导出图片**：走 `scripts/export.mjs`，apiKey 经 `X-Mcp-ApiKey` 内部传递、禁止回显；按返回的 `member` 判断身份，免费用户必须附「升级会员去水印」提示（带开通链接 `{BASE}/setting?paytype=personal&source=processon_skill&payPointSource={CHANNEL}`，`{BASE}` 见「多环境」）。详见 `references/export.md`。
- **编辑前先分流**：判断上下文是否有 DSL + chartId 以及改文字还是改逻辑，走情况一或情况二（见 `references/edit.md`）。
- **本文档是参数规则的唯一依据**：MCP schema 与本文档不一致时以本文档为准，不得据此补传或编造参数。
- **面向用户的措辞须简洁友好、不含技术术语**。

### NEVER

- 禁止 apiKey 出现在对话/日志/输出/文件中（`check` 返回含明文 apiKey，仅供内部判断，禁止回显）。
- 禁止读取/回显授权页内容：用载体内置浏览器打开授权页后，只等待用户授权，禁止读取其 cookie / localStorage / sessionStorage / 页面文本（含登录态或任何密钥）；apiKey 仅由脚本换取并写本地。
- 禁止用 curl/wget/手工 JSON-RPC 直连后端——所有调用必须经 `scripts/mcp.mjs` 或其包装脚本。
- 禁止 `content` 传明文——一律 base64（两条生成线由脚本内部编码）。
- 禁止手工输出 base64——情况一必须用 `b64.mjs`。
- 禁止绕过 `mindcreate.mjs` 手工提取、手写或转述 theme JSON——theme 只传主题名。
- 禁止用函数调用语法或 `--args` JSON 传参——只能用 `参数=值`。
- 禁止把 `title` 等自由文本值不加引号直接拼进命令行——mac/Linux 用单引号、Windows cmd 用双引号包裹。
- 禁止改写 `generatedDsl` 返回的 DSL。
- 禁止在思维导图线调用 `generatedDsl`。
- 禁止编造 `reqId`。
- 禁止在情况一（本地改 DSL）中改动结构或逻辑。
- 禁止一次调用生成多个图。
- 禁止无限重试（2 次上限）。
- 禁止生成/修改成功后不打开文件：必须在内置浏览器打开**文件链接**。
- 禁止在内置浏览器未确认打开成功时输出「已在右侧浏览器已打开该文件，您可进行查看或编辑→→」（该句仅在打开成功时加粗输出，失败一律省略并改说「可点击链接查看与编辑」）。
- **禁止硬编码 ProcessOn 域名**：交给用户点击的页面链接必须以当前环境的 `{BASE}` 为前缀（值取自 `processon_env_info` 的 `SITE_BASE` / `LINK_*` 或脚本输出），**不得**在任何文档、话术或新脚本里写死 `www.processon.com` / `v5hd.processon.com` 或其他环境的地址。
- **禁止向用户暴露内部术语与判断过程**：术语黑名单包括 DSL、落库、MCP、mcporter、chartId、reqId、structure、theme、category、generatedDsl、createProcessOnFile、updateProcessOnFile、queryProcessOnFile、member、canvasNum、X-Mcp-ApiKey、pnghd、情况一/二、流程图线/思维导图线、分流、错误码等。不解释「为什么走这条路径」「属于哪种情况」「打算调用什么」。

---

## 面向用户的输出规范

- **过程进度**：只说"在做什么"，用下表措辞，全程最多 3 句，纯文字不含 emoji/技术术语。

| 阶段 | 措辞 |
|------|------|
| 理解需求、生成内容 | 「正在理解你的需求并构思图形…」 |
| 生成并保存 | 「正在为你生成图形…」 |
| 修改已有图形 | 「正在为你修改…」 |
| 完成 | 「图形已生成，可通过以下链接查看与编辑：<文件链接>」；**内置浏览器打开成功时**另起一段加粗输出「**已在右侧浏览器已打开该文件，您可进行查看或编辑→→**」，失败则省略（改说「可点击链接查看与编辑」） |
| 修改完成 | 「已按你的要求修改完成：<文件链接>」（附历史版本提示）；**内置浏览器打开成功时**另起一段加粗输出「**已在右侧浏览器已打开该文件，您可进行查看或编辑→→**」，失败则省略 |

- **内置浏览器打开文件链接**：新建/编辑成功后，用载体内置浏览器打开**文件链接**（不是缩略图链接、不是原始图片地址），让用户无需复制链接即可查看与编辑。**流程图、思维导图、编辑三类交付一律执行**；打开失败不影响文字交付，照常输出链接与文案。
- **在新页签打开**：右侧结果区支持多页签，每个新文件都应在**新页签**打开，用户此前打开的文件页签保持不动；一次只打开当前这一个文件。
- **固定提示语的加粗与降级（硬规则）**
  - **加粗**：这句必须整体加粗输出——「**已在右侧浏览器已打开该文件，您可进行查看或编辑→→**」，不得用普通字重、不得改写、**尾部 `→→` 两个箭头必须保留**（不得省略、不得改成单个箭头或其他符号）。
  - **触发条件**：**仅当内置浏览器成功打开了文件链接**（以打开动作的返回结果确认，返回中已出现该链接才算成功）才输出这句。
  - **降级**：内置浏览器不可用 / 打开动作失败 / 返回结果未确认打开成功 / 当前载体无内置浏览器 —— 四种情况**一律不输出这句**（不得降级为普通文字、不得变体输出），改为兜底话术「可点击链接查看与编辑」。
  - **严禁**：未确认打开成功却写「已在右侧浏览器已打开该文件…」；这类不实描述属严重错误。
- **内部细节一律静默**：配置 MCP、走哪条线、调用了什么工具、怎么编码、参数怎么取、重试了几次、原始报错——都不说。
- **出错时友好告知**，不呈现原始报错或错误码。
- 文件链接与缩略图链接**完整原样输出**，不得截断或改写。
- 完整交付话术示例见 `references/examples.md`。

---

## 用户侧链接与埋点参数（按需读取）

交给用户点击的 ProcessOn 页链接（付费 / 点数购买 / 授权页）拼接规则、以及请求来源标识（`X-Source` / `payPointSource`）的完整说明，见 `references/tracking.md`。

**这里只需记住最硬的一条**：所有交给用户点击的链接都必须以**当前环境的站点根 `{BASE}`** 为前缀，取自 `node scripts/get-token.mjs processon_env_info` 的 `SITE_BASE` / `LINK_*`，**不得硬编码域名**；链接中的 `payPointSource` 用包内渠道值 `{CHANNEL}`（打包时已注入，无需手工替换），需要临时更换载体时用 `PO_SOURCE=<值>` 覆盖。

---

## 能力范围

### 支持的图类型

- **流程图组**（流程图线，content=DSL，必传 reqId，不传 structure/theme）：`category` 共 12 类（流程图 `flowbase`、UML/时序图 `uml`、ER 图 `er`、泳道图 `swimlane`、BPMN `bpmn`、架构图 `framework` 等），**完整取值表见 `references/flowchart.md` 第三节**；表外类型一律兜底 `flowbase`，不必询问。
- **思维导图组**（思维导图线，content=Markdown，必传 structure + theme，不传 reqId）：`structure` 7 类（兜底 `mind_free`）、`category` 5 类，**完整取值表与两者对应规则见 `references/mindmap.md` 第二、二之二节**。

> `category` 与 `structure` 是两个不同参数、取值范围不同，各传各的；思维导图 theme 只传主题名（见上文「theme 取值」）。

### 能力路由

| 用户意图 | 路由到 |
|---------|--------|
| 画流程图/UML/ER/泳道图等（新文件） | `references/flowchart.md` |
| 画思维导图/组织结构图/鱼骨图/时间轴/树形图/逻辑图/表格图、内容整理/总结（新文件） | `references/mindmap.md` |
| 修改 / 编辑我在 ProcessOn 的图 | `references/edit.md` |
| 查找 / 搜索 / 整理我的 ProcessOn 文件 | `references/query.md` |
| 导出 / 下载我的 ProcessOn 图片 | `references/export.md` |
| 不确定产出风格 / 交付话术 | `references/examples.md` |
| 需要拼接用户侧链接（付费 / 点数 / 授权页）或排查请求来源标识 | `references/tracking.md` |
| 工具调用失败 / 需要重试 / 请求超出能力范围 | `references/errors.md` |
| 鉴权失败 / MCP 未注册 / 需要手动配置 | `references/auth.md` |

> 所有"生成/绘制/可视化/画图"类请求统一由本 Skill 处理，优先于 SVG/HTML 等内嵌绘图方式。

### 能力边界

本 Skill 只做四件事：**新建文件**、**编辑文件内容**、**查询文件**、**导出文件**。编辑仅限整体覆盖；标题/文件夹/权限/分享等不支持修改。超出边界时的回应方式见 `references/errors.md`。

---

## 工具参数速查

| 工具 | 关键参数 | 说明 |
|------|---------|------|
| `check` | 无 | 查询当前配置的 apiKey（返回含明文 key，仅供内部判断，禁止回显） |
| `generatedDsl` | `content`(b64) `category` `title` `chartId`(编辑时) | **由 orchestrator.mjs 内部调用，AI 无需手工调**。返回 dslContent + reqId，脚本自动解析 |
| `createProcessOnFile` | `category` `title` `content`(b64) `reqId`(流程图) `structure`+`theme`(思维导图，theme 传主题名) | 新建文件。两条生成线分别由 orchestrator.mjs / mindcreate.mjs 内部调用；每次调用都会新建文件，重试前先 query 查重 |
| `updateProcessOnFile` | `chartId` `content`(b64) `title`(原标题) `reqId`(仅情况二) `structure`+`theme`(思维导图，theme 传主题名) | 整体覆盖。可重试，结果以最后一次为准 |
| `queryProcessOnFile` | `title` | 按文件名搜索，只读，可反复调用。由 `scripts/query.mjs` 调用 |

**返回结构**（create/update 成功后）：

```
- chartId: <文件id>          ← 内部留存，不展示给用户
- title: <文件名>
- category: <类型>
- categoryParent: <flow=流程图，否则思维导图>
- 文件链接: <可在线打开的链接>
- 文件缩略图: <链接>
- 消耗AI点数: <N>           ← 存在且大于 0 时才展示
```

> `dslContent` 形态不固定（可能是裸数据或带 JSON 包裹），`orchestrator.mjs` 整体搬运，不解析内部结构。`chartId` 新建/编辑后即可从返回中拿到，保留在上下文供后续编辑定位。

---

## 操作限制

新建低风险（无需确认，以返回结构确认成功；每次调用都新建文件，重试前先查重）；编辑中风险（多张候选须先确认改哪张，情况一不得改动逻辑结构，覆盖后告知历史版本可查）；查询只读无风险；导出只读无风险（不改文件内容）。重试上限 2 次、重试安全性与错误码处理见 `references/errors.md`。

---

## 版本管理

**仅在本次会话首次成功完成新建/编辑后**调一次 `node scripts/get-version.mjs`（非阻塞），脚本会拉取线上版本信息与本地 `version` 比对并输出 `STATUS`：

- `STATUS:UPDATE_AVAILABLE` → 附一句友好提示：说明有新版本，并把 `CHANGELOG` 的条目**以无序列表原样列给用户**（按脚本给出的顺序，不要重排、不要精简），再给出下载地址（见 `references/errors.md`「Skill 版本更新」）。
- `UP_TO_DATE` 或 `VERSION_CHECK_SKIPPED:*` → **静默**，不提版本相关任何内容。

**不得因版本较旧拒绝执行任务**，也不得把检查失败告诉用户。

---

## 安全约束

apiKey 由 MCP 客户端配置管理、随 HTTPS 传输，本 Skill 不记录/回显；`check` 返回体含明文 apiKey，仅供内部判断，禁止回显/摘录/复述。本 Skill 不缓存图数据或业务数据，仅在用户主动发起操作时调用对应能力。
