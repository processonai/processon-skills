# processon-ai-skill

ProcessOn 官方研发的 AI 作图技能：用自然语言在 ProcessOn 中**新建、编辑、查询、导出**流程图与思维导图，生成的图可在线继续编辑。

## 安装与更新

```bash
# 安装
npx skills add https://github.com/processonai/processon-skills.git --skill processon-ai-skill

# 更新
npx skills add https://github.com/processonai/processon-skills.git --skill processon-ai-skill --force -g -y
```

如果你的宿主不会自动刷新技能，安装后重启对应工具；首次运行时按提示完成浏览器授权即可。

## 支持的图形

**流程图类**

- 流程图、业务流程图、泳道图、BPMN
- 时序图、UML 图、ER 图
- 系统 / 软件 / 云架构图、网络拓扑图
- 韦恩图、电路图、平面图
- 图表、UI 原型 / 界面图
- 路线图、信息图、金字塔图、草图重绘

**思维导图类**

思维导图、脑图、组织结构图、鱼骨图、时间轴、树形图、逻辑图、表格图 / 树形表格、提纲、知识整理

## 能力

| 能力 | 说明 |
| --- | --- |
| 新建 | 用一句话或一段材料生成可在 ProcessOn 在线编辑的图 |
| 编辑 | 修改已有图的内容，原内容自动存为历史版本 |
| 查询 | 按文件名搜索账号下的文件 |
| 导出 | 导出为图片（PNG / SVG）或 PDF 并下载到本地，多张画布逐张导出 |
| 草图重绘 | 上传草图或图片，识别内容后重绘为可编辑图形 |

## 提示词示例

```text
画一个电商订单支付的流程图，包含库存校验和支付失败回滚
把这份会议纪要整理成思维导图，突出结论、待办和责任人
用鱼骨图分析这次线上故障的根因
把这张手绘草图重绘成可编辑的流程图
把这张图导出成 PDF
```

## 输出

- 文件链接（可在 ProcessOn 在线查看与编辑）
- 文件缩略图
- 思维导图类额外输出 Markdown 正文
- 导出时给出本地的图片或 PDF 文件

## 版本与更新日志

当前版本 **2.1.0**（更新于 2026-09-20）

- 新增导出能力：已保存的图可以导出为图片（PNG / SVG）或 PDF 并下载到本地，多张画布会逐张导出
- 支持更多图形类型：韦恩图、网络拓扑图、电路图、平面图、UI 原型图、路线图、信息图、金字塔图等
- 思维导图新增组织结构图、鱼骨图、时间轴、树形图、逻辑图、表格图等结构
- 支持上传草图或图片，识别内容后重绘为可编辑的图形
- 支持查找我在 ProcessOn 已有的图并直接修改，原内容会自动存为历史版本

## 下载

| 包 | 下载地址 |
| --- | --- |
| 官网包 | https://pocdn.processon.com/agent/processon_skill.zip |
| WorkBuddy 渠道包 | https://pocdn.processon.com/agent/processon_skill_workbuddy.zip |
| 千问渠道包 | https://pocdn.processon.com/agent/processon_skill_qwen.zip |
| dumate 渠道包 | https://pocdn.processon.com/agent/processon_skill_dumate.zip |

## 目录结构

```text
SKILL.md          # 主文件：frontmatter + 每次调用都需要的核心规则
references/       # 按需加载的详细规则（按任务类型只读对应一个）
scripts/          # 执行脚本
scripts/setup/    # 各平台 MCP 注册脚本
version/          # 各平台版本号
```

## 本地开发

想在本地迭代这个 skill 而不是从 GitHub 安装，可以把该目录放到本地 skills 目录，例如：

```text
~/.agents/skills/processon-ai-skill
```
