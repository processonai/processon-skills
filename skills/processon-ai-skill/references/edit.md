# 编辑文件 updateProcessOnFile

> 用新内容**整体覆盖**一个已存在的 ProcessOn 文件。后端只做整体覆盖，旧内容自动存为历史版本，不做增量合并。

## 功能说明

接收 `chartId`（目标文件 id）、`content`（新内容）、`title`（**传原标题**，后端不会据此改名）；`reqId` 仅在经过 `generatedDsl` 生成时才传（见「参数说明」）。由后端整体覆盖目标文件内容（原内容转为历史版本），返回文件名、类型、chartId、文件链接、文件缩略图链接。

## 适用场景

用户要修改、编辑已在 ProcessOn 的图。

## 操作约束

- **前置检查**：必须已完成 apiKey 校验（见 `references/auth.md`）。
- **必须传 `chartId`**：编辑必须指定目标文件 id。chartId 来自新建/上次编辑/查询的返回结构。
- **必须先分流**：编辑前按下方「分流判断」确定走情况一还是情况二。
- **只有整体覆盖一种方式**：没有「改某块」选项，因此执行前不就「是否覆盖」单独征求同意；但「改哪张」需确认（多张候选/指代不清时问用户）。
- **覆盖后告知历史版本**：返回时附带「原内容已存为历史版本，可在文件历史记录中查看」，让用户安心。
- **沿用原图类型**：编辑不改变文件类型（`updateProcessOnFile` 不传 category）。
- **成功判定**：以返回结构中的文件链接确认更新成功。

**重试安全性**：可重试 — 整体覆盖同一文件，结果以最后一次为准；每次覆盖都会产生一个历史版本。

---

## 分流判断（流程图）

> **本节为内部编排依据，对用户静默执行**（内部术语黑名单见 SKILL.md「严格规则」，「情况一 / 情况二」也在其列）；对用户只说「正在为你修改…」，完成后给结果与链接。

按**两个维度**决定走哪条：上下文是否有该图 DSL + chartId、用户改的是文字还是逻辑。

| 上下文有 DSL + chartId | 用户要改什么 | 走 |
|---|---|---|
| 有 | **只改文字**（不含逻辑/结构变动） | **情况一**（本地改） |
| 有 | 改逻辑 / 结构 | **情况二** |
| 无 | 任何修改 | **情况二** |

> 思维导图编辑不走这套分流，见下方「思维导图的编辑」。

---

## 情况一：本地改文字（不调 generatedDsl）

**条件三者同时满足**：上下文有该图的 DSL、有对应 chartId、用户要改的**仅是文字内容**。

```
步骤1: 确认改哪张
       - 同会话只有一张候选图、指代明确 → 不必询问
       - 同会话有多张候选、或指代不清 → 询问用户「要改的是 X 还是 Y？」
步骤2: AI 在上下文中那份 DSL 里直接修改文字（仅替换文本，不动结构与逻辑）
步骤3: 改完的 DSL 用 b64.mjs 编码 → node scripts/mcp-call.mjs updateProcessOnFile
       chartId=<目标文件id> content="$(node scripts/b64.mjs <<'POB64' ... POB64)" title='<原标题>'
       （不传 reqId）
步骤4: 从返回拿到新的文件链接、文件缩略图链接
步骤5: 返回 文件名 + 类型 + 文件链接 + 文件缩略图链接（点数大于 0 时另加），
       并告知「原内容已存为历史版本，可在文件历史记录中查看」
```

- **不传 `reqId`**：本情况未调用 `generatedDsl`、没有本次生成记录可关联，`reqId` 一律不传（也不要复用该图上一次的 reqId）。
- **不调用 `generatedDsl`**：纯文字替换无需后端重新生成。
- **改动限于文字**：一旦涉及增删节点、改连线、调整流程走向等逻辑变动，**改走情况二**。

---

## 情况二：交给 generatedDsl 重新生成

**触发**：上下文无该图 DSL；或有 DSL 但用户要改逻辑/结构。

```
步骤1: 确定 chartId 与 category
       - 上下文已有 → 直接沿用
       - 上下文没有 → node scripts/query.mjs title='<文件名>' 定位文件，
         从结果拿 chartId 与 category（见 references/query.md）
       - 多张候选/指代不清 → 询问用户要改哪张
步骤2: 通过 orchestrator.mjs 一条命令完成「重新生成 → 落库」：
       node scripts/orchestrator.mjs chartId=<目标文件id> category=<原图类型> title='<原标题>' <<'POB64'
       <修改要求原样写在这>
       POB64
       → 脚本内部：b64 编码 → generatedDsl(带 chartId) → 解析 DSL+reqId → b64 编码 → updateProcessOnFile
       → 返回最终结果
步骤3: 从返回拿到新的文件链接、文件缩略图链接
步骤4: 返回 文件名 + 类型 + 文件链接 + 文件缩略图链接（点数大于 0 时另加），
       并告知「原内容已存为历史版本，可在文件历史记录中查看」
```

- **`chartId` 传给 orchestrator.mjs**：脚本自动传给 `generatedDsl`，后端依据它解析目标文件的原内容。
- **DSL 原封不动**：`dslContent` 由脚本内部原样搬运，AI 不接触 DSL。
- **`reqId` 由脚本内部配对**，AI 无需手工处理。
- **跨会话可编辑**：无原 DSL 也能改——由后端依 chartId 取原内容，不再交还用户自行处理。

---

## 思维导图的编辑（不变）

思维导图编辑**不走上面的分流**，也**不调用 `generatedDsl`**：

```
步骤1: 确认改哪张（指代不清先问用户）
步骤2: 按 references/mindmap.md 采用全量重绘——读对话历史，在原 Markdown 基础上改，
       生成全量更新后的 Markdown
步骤3: 通过 mindcreate.mjs 一条命令完成（脚本内部编码 + 取 theme JSON + 落库）：
       node scripts/mindcreate.mjs \
         chartId=<目标文件id> structure=<mind_*，与原图一致> theme=<主题名> title='<原标题>' \
         <<'POB64'
       <全量更新后的 Markdown>
       POB64
       （不传 reqId）
步骤4: 返回 文件名 + 类型 + 文件链接 + 文件缩略图链接 + 历史版本提示（点数大于 0 时另加）
```

---

## 工具调用

> 情况二与思维导图编辑分别由 `orchestrator.mjs` / `mindcreate.mjs` 一条命令完成：b64 编码、theme JSON 取值均在脚本内部处理，AI 不接触。
> **仅情况一**需直接调 `mcp-call.mjs`：`content` 一律 base64，必须用 `b64.mjs` + heredoc + 命令替换，禁止手工输出 base64；传参只用 `参数=值`。详见 SKILL.md「工具调用方式」。

```
# 流程图 —— 情况一（本地改文字，不传 reqId）—— 用 b64.mjs + mcp-call.mjs 单步 update
node scripts/mcp-call.mjs updateProcessOnFile \
  chartId=<目标文件id> content="$(node scripts/b64.mjs <<'POB64'
<改完的 DSL 原样写在这>
POB64
)" title='<原标题>'

# 流程图 —— 情况二（重新生成）—— 用 orchestrator.mjs 一条命令
node scripts/orchestrator.mjs \
  chartId=<目标文件id> category=<原图类型> title='<原标题>' \
  <<'POB64'
<修改要求原样写在这>
POB64

# 思维导图（全量重绘，不传 reqId）—— 用 mindcreate.mjs 一条命令
node scripts/mindcreate.mjs \
  chartId=<目标文件id> structure=<mind_*，与原图一致> theme=<主题名> title='<原标题>' \
  <<'POB64'
<全量更新后的 Markdown 原样写在这>
POB64
```

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `chartId` | 是 | 目标文件 id（要覆盖哪个文件），来自新建/编辑/查询的返回 |
| `content` | 是 | 新内容整体覆盖。流程图=DSL（情况一为本地改完的、情况二为 generatedDsl 原样返回的）；思维导图=Markdown。**须 base64 编码**（两条生成线由脚本内部完成；情况一用 `b64.mjs`） |
| `reqId` | **仅情况二必传** | 情况二传本次 `generatedDsl` 返回的 reqId（由 orchestrator 内部配对）。**情况一不传**（未调用 generatedDsl）；思维导图不传 |
| `structure` | 思维导图必填 | 7 类之一，与原图保持一致。见 `references/mindmap.md` 第二节 |
| `theme` | 思维导图必填 | **只传主题名**（6 选 1，见 `references/mindmap.md` 第三节）；完整 JSON 由 `mindcreate.mjs` 内部从 `references/mindmap_themes.json` 取用，AI 不接触 JSON |
| `title` | 是 | **传原标题**。后端会忽略此参数的变更 —— 传新值也不会改名，本 Skill 无法修改标题（见 `references/errors.md`「能力边界」）|

---

## 编辑失败的兜底

重试上限 2 次与计数规则见 `references/errors.md`。达上限或 `generatedDsl` 报错后停止写操作：用 `queryProcessOnFile title='<文件名>'`（只读，不计重试）取回该文件信息，友好说明这次没能自动修改成功，并给出 文件名 + 文件链接 + 文件缩略图链接，引导用户到官网手动编辑。

> 措辞示例：「这次没能帮你自动修改，你可以直接打开这个文件手动调整：<文件链接>」；不得呈现原始报错或错误码。

## 返回给用户

按 SKILL.md「统一交付内容」与 `references/examples.md` 的交付模板执行：文件名 + 类型 + 文件链接 + 文件缩略图链接（点数大于 0 时另加）。编辑特有几点：

- **必须附历史版本提示**：「原内容已存为历史版本，可在文件历史记录中查看」。
- `chartId` 仅内部留存（供后续编辑定位），不展示给用户。
- **必须在内置浏览器打开文件链接**：修改成功后，用当前载体的内置浏览器打开**文件链接**（`present_files` 传文件链接，不传缩略图链接），让用户直接在右侧浏览器查看或编辑。
- **必须在新页签打开**：一次只提交当前这一个文件的链接，新文件落在**新页签**，不覆盖、不替换用户此前已打开的其他文件页签。
- **提示语加粗 + 降级**：**仅当内置浏览器确认打开成功时**，另起一段**加粗**输出「**已在右侧浏览器已打开该文件，您可进行查看或编辑→→**」，紧随文件信息块之后；**内置浏览器不可用 / 打开失败 / 未确认成功**时**省略该句**，改说「可点击链接查看与编辑」，严禁谎称已打开。
