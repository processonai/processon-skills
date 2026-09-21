# 导出图片 exportImg

> 把一个已存在的 ProcessOn 文件（流程图/思维导图）导出为图片或 PDF，下载到本地，并按用户会员身份决定是否提示去水印。
>
> 下文链接中的 **`{BASE}` = 当前环境的站点根**（正式 / 灰度等，由 `PO_ENV` 或包内默认环境决定），实际值取自 `node scripts/get-token.mjs processon_env_info` 的 `LINK_*`；**`{CHANNEL}` = 本包对应的载体来源**（打包时已注入，读到即实际值）。**不得硬编码域名**，详见 `references/tracking.md`。

## 功能说明

按 `chartId` 调后端导出接口，后端返回该文件每个画布的图片地址与用户会员身份；脚本把每张图片下载到本地 `~/Downloads/`，AI 再把图片 URL 与本地预览一并展示。免费用户额外提示「升级会员去水印」。

**PDF 导出（`type=pdf`）走本地转换链路**：后端导出 **svg** → 本地 `scripts/svg2pdf.mjs` 转成 PDF → 落 `~/Downloads/<name>.pdf`，临时 svg 用完即删。**给用户的文案只呈现 PDF 本地文件，不输出任何 svg/图片链接**（svg 只是中间产物，用户不需要也不应看到）。

## 适用场景

- 用户在新建/编辑/查询到某个文件后，要求「导出 / 下载成图片」。
- 用户想拿到某张图的 PNG/SVG 图片文件。
- **用户要求导出 / 下载成 PDF** → `type=pdf`。

## 操作约束

- **前置检查**：必须已完成 apiKey 校验（见 `references/auth.md`）。导出的是该用户自己账号下的文件，必须有有效 apiKey。
- **必须先定位 chartId**：上下文已有（新建/编辑/查询的返回）直接沿用；没有则先 `node scripts/query.mjs title='关键词'` 定位，多候选先问用户改哪张。
- **type 默认 png**：默认导出 `png`；用户明确要 `svg` 时才传 `type=svg`；**用户要 PDF 时传 `type=pdf`**（内部自动走 svg→PDF 本地转换，AI 不需要也不应该手动先导 svg 再转）。
- **PDF 文案不出现中间链接**：`type=pdf` 的交付只含 PDF 本地路径（内嵌预览用），禁止把 svg URL / 图片 URL 写进给用户的话术。
- **多画布逐条导出**：后端返回的每张画布（`imgInfo[]`）都下载、都展示，不截断。
- **apiKey 不回显**：脚本内部读 apiKey、拼 `X-Mcp-ApiKey` 头，输出中绝不出现 apiKey。

**重试安全性**：导出是只读操作（不改文件内容），可安全重试，不计入写操作重试次数。

---

## 数据流转

```
用户：「导出我那张 XX 图 / 导出成 PDF」（或刚新建/编辑/查询完要导出）
  → 本会话首次文件操作前：node scripts/get-token.mjs processon_check_and_start_auth（通过后不再重复）
  → 定位 chartId（上下文有则沿用；无则 query）
  → node scripts/export.mjs chartId=<文件id> [type=png|svg|pdf]
  → 脚本内部：读 apiKey → GET 导出接口（X-Mcp-ApiKey）→ 解析 member/imgInfo → 下载到 ~/Downloads/
      （type=pdf：后端导 svg → svg2pdf.mjs 本地转 PDF → 删临时 svg → 只输出 PDF 本地路径）
  → 判 member：
      member=true  → 输出 图片URL + 本地预览（pdf 模式仅本地预览，无 URL）
      member=false → 输出 图片URL + 本地预览 + 升级会员去水印提示（带开通链接）
```

---

## 工具调用

```
node scripts/export.mjs chartId=<文件id> type=png|svg|pdf name='<文件标题>'
```

> `type` 可选，省略默认 `png`；`svg` 需求时才写 `type=svg`；**PDF 需求时写 `type=pdf`**。`chartId` 为短参数直接写值即可（不含空格/特殊符号）。
>
> **`type=pdf` 的转换引擎**（`scripts/svg2pdf.mjs` 自动探测，保真优先）：Chrome/Chromium/Edge headless 打印 → `rsvg-convert` → `cairosvg`；可用 `PO_SVG2PDF_CMD='<命令> {} {}'` 强制指定（第一个 `{}` 是输出、第二个是输入）。**本机无任何可用引擎时**，脚本返回 `转换失败:no_engine`，此时按「导出失败的兜底」处理，不得改用导出 png 冒充 PDF。
>
> `name` 可选但**建议总是传**：不传时落盘文件名取画布标题，而多数文件只有一个画布，标题就是「画布1」——用户拿到后无法辨认。传 `name='<文件标题>'` 让下载的图片直接可用。含空格/中文时按平台加引号。

> **站点地址与 MCP 端点同源**：导出接口的站点根地址由 `resolveBaseUrl()` 取**当前环境**的站点根（`env.mjs` 的 `ENV.apiBase`，由 `PO_ENV` 或包内默认环境决定），可用 `PO_API_BASE_URL` 单独覆盖。**切勿把地址写死** —— 站点地址与授权环境同源，写死会打到错误的服务上，并返回与真实原因不符的错误（如 code=401）。

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `chartId` | 是 | 要导出哪个文件，来自新建/编辑/查询的返回 |
| `type` | 否 | 导出类型，`png`（默认）/ `svg` / `pdf`（svg 导出后本地转 PDF） |
| `name` | 否 | 覆盖落盘文件名（建议传文件标题），不传则用画布标题 |

## 脚本返回解析

```
member=true | false          ← 会员身份（false 或非 true 一律按免费处理）
type=pdf | pnghd | png | svg  ← pdf 模式恒为 pdf；其余为后端实际导出的图片类型
canvasNum=2                   ← 画布数量（可选）
canvasLimit=3                 ← 画布上限（可选）
[1]
title=画布2                    ← 画布标题
url=http://…/chart_image/…     ← 图片 URL（png / svg 模式才有；**pdf 模式无此行**）
file=/Users/steven/Downloads/画布2.png   ← 本地保存路径（内嵌预览用；pdf 模式即 .pdf 路径）
[2]
…
```

> `member` / `canvasNum` / `type` / `url` 均为内部字段，**不展示给用户**；`file` 转为本地预览时内嵌。
> **pdf 模式的 `url` 行不存在**是设计使然（不给用户看中间 svg 地址），不要当作异常，也不要向用户询问。

---

## 返回给用户

**每个画布**输出：图片 URL（完整原样）+ 本地预览（用 Markdown/HTML 内嵌本地图片）。多画布按序号依次列出。

**PDF 导出（`type=pdf`）的交付例外**：**只给本地文件预览，不输出任何链接**（无图片 URL、无 svg 链接）。用 `present_files` 打开 PDF 本地路径让用户直接预览；文案说明已保存的位置与画布数即可。免费用户仍附「升级会员可去除水印」（PDF 由 svg 渲染而来，水印 pattern 同样存在）。

本地预览用 HTML `<img>` 内嵌 `file=` 返回的本地绝对路径（转成 `file://` URI，macOS 即 `file://` + 路径），带 `width` 控制尺寸：

```html
<img src="file:///Users/steven/Downloads/画布2.png" alt="画布2" width="480" />
```

**会员判断**：

| 身份 | 输出 |
|------|------|
| `member=true`（会员） | 图片 URL + 本地预览 |
| 其他（免费用户） | 图片 URL + 本地预览 + 一句「升级会员可去除图片水印」，带开通链接 `{BASE}/setting?paytype=personal&source=processon_skill&payPointSource={CHANNEL}` |

**交付话术示例（免费用户，单画布）**：

```
已为你导出图片：

- 图片链接：<图片URL>

<img src="file:///Users/steven/Downloads/画布2.png" alt="画布2" width="480" />

免费用户导出的图片带水印，升级会员即可去除：{BASE}/setting?paytype=personal&source=processon_skill&payPointSource={CHANNEL}
```

> 会员用户省略最后一句「升级会员…」。措辞不含 member / canvasNum / 接口 / apiKey 等内部术语。

**PDF 交付话术示例（单画布）**：

```
PDF 已导出完成：

- 文件：<PDF 本地路径>

（用 present_files 打开该 PDF 供预览；免费用户另起一行附去水印提示，带开通链接）
```

> PDF 交付**不出现**图片链接、svg 链接；也不要提「svg」「转换」「后端」等过程词，只说结果。

---

## 导出失败的兜底

导出接口失败或下载失败时，友好告知「这次没能帮你导出图片」，给出该文件的文件链接（可用 `queryProcessOnFile` 只读取回），引导用户在 ProcessOn 页面中手动导出。不得呈现原始报错或错误码。
