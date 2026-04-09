# processon-diagram-generator

用 ProcessOn 生成专业、可继续编辑的图形，支持自然语言、代码上下文。

## 安装

```bash
npx skills add https://github.com/processonai/processon-skills.git --skill processon-diagram-generator
```

如果宿主不会自动刷新 skill，安装后请重启对应工具。

## 支持的图形类型

- 流程图
- 业务流程图
- 泳道图
- 流程地图
- 标准流程图
- 时序图
- 软件架构图
- 系统架构图
- 云架构图
- 网络拓扑图
- ER 图
- 组织结构图
- 时间轴
- 信息图
- 金字塔图


## 配置

### 推荐方式：配置环境变量

先配置 `PROCESSON_API_KEY`：

```bash
export PROCESSON_API_KEY="<your-processon-api-key>"
```

获取地址：

```text
https://smart.processon.com/user
```


## 提示词示例

```text
生成一个登录注册流程图，要求布局清晰，适合产品和研发沟通
```

```text
生成一个订单创建、支付、库存扣减的时序图
```

```text
分析这个项目的模块关系并生成系统架构图，不要画目录树
```

```text
把这张手绘草图重绘成流程图
```

## 输出

- 图片链接。
- 图形的dsl

dsl编辑链接：

```text
https://smart.processon.com/render-dsl
```

## 本地开发

如果你想在本地迭代这个 skill，而不是从 GitHub 安装，可以把 skill 目录放到本地 skills 目录，例如：

```text
~/.codex/skills/processon-diagram-generator
```
