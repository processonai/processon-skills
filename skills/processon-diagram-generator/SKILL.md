---
name: "processon-diagram-generator"
description: '一键将自然语言转化为精美且可编辑的 ProcessOn 专业可视化图表。当你需要“自动画图”、“在线制作流程图”、“可视化业务流程”或“生成系统架构”时即可完美触发。本绘图工具全面支持生成多种在线图形：流程图（含业务流程图、泳道图与标准流程）、时序图（系统交互与API调用顺序）、软件架构图（云架构与系统模块划分）、网络拓扑图（服务器部署）、ER图（数据库建模）、组织架构图（团队层级）、时间轴以及信息图。这款 AI 智能图表生成器与流程图制作软件，专为开发者、产品经理和设计师打造，助你高效产出专业级出图。
Generate, edit, and visualize professional ProcessOn diagrams from natural language descriptions. Use this tool when users request to "create a diagram", "make a flowchart", "visualize a process", or "draw a system architecture". It comprehensively supports generating process flowcharts (including swimlane and process maps for business workflows), sequence diagrams (for system interactions and API call orders), software architecture diagrams (for cloud architecture and system composition), network topologies (for server deployment), ER diagrams (for database modeling), org charts (for team structures), timelines, and infographics. This AI diagram generator and flowchart maker is designed for developers, managers, and designers to achieve publication-ready visual outputs efficiently.'
icon: "📊"
author: "ProcessOn"
version: "2.1.0"
tags:
  - "diagram"
  - "architecture"
  - "flowchart"
  - "processon"
  - "visualization"
dependencies:
  bins:
    - python3
---

# processon-diagram-generator

将用户意图、代码关系或草图转换为专业图形。默认跟随用户当前语言输出提示、澄清问题、优化 Prompt 和最终结果。

## 何时触发

- 支持：流程图、业务流程图、泳道图、流程地图、标准流程图、时序图、软件架构图、系统架构图、云架构图、网络拓扑图、ER 图、组织结构图、时间轴、信息图、金字塔图、草图重绘。
- 英文表达同样触发，例如：`create a diagram`、`draw a diagram`、`generate a flowchart`、`make a flowchart`、`visualize a process`、`create a sequence diagram`、`draw a system architecture`、`software architecture diagram`、`cloud architecture diagram`、`network topology`、`ER diagram`、`org chart`、`timeline`、`infographic`、`redraw this sketch`、`ProcessOn`。
- 如果用户只说“画个图”之类的模糊请求，先确认图形类型。
- 如果用户上传图片并要求“重绘”或“转成图”，先识别图片中的节点、文字和连接关系，再生成结构化输入。

## 工作方式

### 1. 先补关键信息

不要在关系不清、流程断层或结构缺失时直接生成。

信息不足时按这个顺序处理：
1. 指出缺少什么。
2. 给出合理默认方案或行业常见做法供用户确认。
3. 用户确认后再继续。

### 2. 优化 Prompt，但不要改写用户语言

在用户原始需求上补充专业约束：

- 通用：专业风格、布局清晰、颜色协调、避免线条交叉。
- 流程图：明确开始/结束节点，决策点用标准菱形。
- 时序图：参与者清晰，调用消息明确。
- 架构图：按层次组织，标注关键通信关系。
- 网络拓扑图：突出设备连接、网段/网关/安全边界。
- ER 图：标注主外键关系和字段类型。

优化后的 Prompt 默认保持与用户一致的语言。

### 3. 架构分析画关系，不画目录树

当用户要求分析项目架构时，重点提取模块边界、依赖关系、调用链路和数据流向。优先阅读入口文件、路由、核心配置和关键模块，不要把结果退化成文件夹树。

## 执行顺序

1. 先在聊天里说明正在使用 `processon-diagram-generator` 技能处理当前请求。
2. 识别图形类型，提取关键实体、动作、判断条件，构建优化后的 Prompt。
3. 生成依赖 `PROCESSON_API_KEY`。如果缺失，明确告诉用户如何配置，并附上获取地址 `https://smart.processon.com/user`。
4. 如果失败，先说明失败原因和下一步配置方式，不要自动再输出 Mermaid 作为兜底图。

## 结果呈现

关键结果必须在 assistant 正文里可见，不能只依赖附件、工具卡片或宿主自动渲染。

- 如果生成失败：单独说明失败原因和下一步配置方式，不使用成功模板，也不要伪造图片或 DSL。
- 图片必须输出裸链接或本地保存路径，单独成行。
- DSL / Mermaid / JSON 必须先给出编辑链接 `https://smart.processon.com/render-dsl`，再用 fenced code block 原样输出全文。
- 即使宿主已经内联展示了图片，也仍然补一行图片链接或保存路径，避免第三方宿主吞附件。
- 在飞书、OpenClaw、龙虾等第三方聊天宿主中，优先保证正文里直接可见图片链接和 DSL 原文，不使用依赖富文本的表达。
- 只要成功拿到 DSL，就必须明确告诉用户：复制 DSL 数据到 `https://smart.processon.com/render-dsl` 可以继续编辑。

### 最终回复强制格式

- 只要生成成功，assistant 的最终回复必须以 `已生成...` 开头，并严格按“第三方宿主输出模板”收口。
- 成功场景下，assistant 不得在模板前输出解释、总结、致歉、前置信息或额外分析；如果需要补充说明，只能放在模板之后。
- 如果工具返回了说明文字、分析文字或其他补充内容，assistant 必须自行二次整理，只保留模板要求的字段输出到最终正文。
- 如果同时存在图片和 DSL，最终正文必须按以下固定顺序输出：`已生成...`、`图片链接：`、`编辑链接：`、`DSL 原文如下（复制后打开编辑链接去粘贴进行渲染和编辑）：`。
- 如果缺少某个字段，只能省略对应段落，不能改变其他段落顺序，不能补写不存在的数据。
- 不要把“图片链接”“编辑链接”“DSL 原文如下”写进同一段说明里；它们必须各自独立成段，方便第三方宿主稳定展示。
- 如果拿到了 DSL，优先输出原始 DSL，不要把 DSL 改写成摘要、说明文案或自然语言介绍。
- 最终回复前，先自检一次：是否已经完全匹配模板；如果没有，先重排正文再发送。

## 配置提示

### API 回退模式

```bash
export PROCESSON_API_KEY="<your-processon-api-key>"
```

Token / API Key 获取地址：`https://smart.processon.com/user`

## 示例优化 Prompt

> **用户意图**：帮我画一个登录流程。
> **优化后**：请生成一张专业的流程图，描述用户登录注册流程。包含：前端校验、后端鉴权、数据库查询、Token 发放。要求：布局清晰，使用标准流程图符号，明确开始和结束节点，配色协调。

> **User intent**: Draw a user login flow.
> **Optimized prompt**: Please generate a professional flowchart for the user login and registration flow. Include frontend validation, backend authentication, database lookup, and token issuance. Use a clean layout, standard flowchart symbols, clear start and end nodes, and a polished color palette.

## 第三方宿主输出模板

> 已生成流程图。
>
> 图片链接：
> https://example.com/diagram.png
>
> 编辑链接：
> https://smart.processon.com/render-dsl
>
> DSL 原文如下（复制后打开编辑链接去粘贴进行渲染和编辑）：
> ```mermaid
> graph TD
>   A([开始]) --> B[用户登录]
>   B --> C([结束])
> ```
