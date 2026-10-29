# 录制 → 编译 → 回放：自动化原型设计

> 前置文档：[escrcpy-copilot-automation-re.md](escrcpy-copilot-automation-re.md)（逆向结论）。
> 本设计是 clean-room 实现：参考的是逆向出来的**行为和接口**，代码全部自己写。

## 1. 目标

让 AI 探索一次 UI，把它的操作编译成一份**可读、可改、可版本管理**的脚本。之后回放时**不调用模型**；只有某一步失败时才让模型修这一步，修好后写回脚本。

### 1.1 功能需求

| #   | 需求                                                                     | 原型是否覆盖                                            |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| F1  | AI agent 通过工具操作 Android（以 UI 树为主，截图为辅）                  | ✅                                                      |
| F2  | 自动记录 agent 的每次工具调用，包括当时的 UI 上下文                      | ✅                                                      |
| F3  | 把记录编译成脚本：控件选择器 + 多级备用定位 + 变量                       | ✅                                                      |
| F4  | 确定性回放：自动等待元素、校验结果、出报告                               | ✅                                                      |
| F5  | 失败自愈：先用不需要模型的手段，最后才调用模型；修复结果写回脚本并留版本 | ✅（M3）                                                |
| F6  | 多设备并发执行 + 多组变量批量执行                                        | ✅（M4）                                                |
| F7  | 集成进 Escrcpy 桌面端（脚本列表、一键运行、看报告）                      | ✅（M4）                                                |
| F8  | 条件分支、循环、子流程                                                   | ❌ 原型不做，只支持 `optional` 和弹窗处理（interrupts） |

### 1.2 非功能需求与假设

- **速度**：回放一步的耗时约等于一次 UI dump。实测（2026-10-26）：简单界面（桌面，约 50 个节点）`yadb -layout` 0.6–0.7 s、`uiautomator dump` 2.2–3.1 s；Pixel 5a 上一个复杂界面 yadb 1.2 s、uiautomator 2.5 s；小米搜索页（约 130 个节点）yadb 也要 2.1 s。yadb 大约快 2–4 倍，耗时随节点数增长。目标是 10 步的流程在 30 s 内跑完；对比之下，现在每次都靠 AI 视觉理解，通常要 1–3 分钟，还要花 token。
- **稳定性**：同一台设备连续回放 10 次，成功率 ≥ 90%；换一台分辨率不同的设备，不改脚本也能跑通。
- **规模**：单机，一次最多十几台设备，不需要分布式。
- **团队**：1 人加 AI 辅助，所以优先选简单、能复用现有代码的方案。
- **技术栈**：跟着 monorepo 走，TypeScript 包 + tsdown 构建，命名用 kebab-case。

## 2. 关键取舍

| 决策                       | 选择                                                               | 备选                                            | 理由                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **D1 用什么 agent 来探索** | **先用 Claude Code（或任意 MCP 客户端）连我们自己的 MCP server**   | 先在桌面端做聊天 UI                             | 探索阶段只需要一个能调工具的 agent，用现成的最快。桌面端的聊天 UI 放到 M4                                                |
| **D2 在哪一层录制**        | **在 MCP server 内部录制**                                         | 订阅 Copilot 的事件 / 读 IndexedDB 里的 journal | server 知道每次调用时真实的 UI 状态，也知道 `ui_tap` 实际命中了哪个元素，这些信息在客户端看不到。另外换任何 agent 都能录 |
| **D3 回放走哪条路**        | **回放器直接调用“设备工具层”的函数，不经过 MCP**                   | 回放器当 MCP 客户端去连 server                  | 少一个进程和一层序列化；MCP server 和回放器共用同一套工具实现，行为一致                                                  |
| **D4 脚本格式**            | **YAML（`*.flow.yaml`）+ zod 校验**                                | JSON                                            | 要人工审阅和 diff，YAML 更好读；另外提供导出成 Escrcpy Automation JSON（只含坐标）的兼容功能                             |
| **D5 定位策略**            | **控件选择器优先，然后依次退到图片、坐标；每步可以有多个定位方式** | 只用坐标（Escrcpy Automation 的做法）           | 选择器不受分辨率影响，抗界面改版的能力也最强                                                                             |
| **D6 等待策略**            | **自动等待（等目标元素出现）+ 动作后校验（expect）**               | 固定 delay                                      | 固定 delay 不是太慢就是太快，正是坐标宏不稳定的主要原因                                                                  |
| **D7 自愈时模型怎么接入**  | **AI SDK，供应商可配置（OpenAI / Anthropic 兼容）**                | 只支持 Claude                                   | 和 Escrcpy 的做法一致；API key 从 1Password 环境变量读取                                                                 |

## 3. 总体架构

```
                    ┌───────────────── 探索（一次） ─────────────────┐
                    │ Claude Code / 其他 MCP 客户端                  │
                    │        │ MCP（stdio）                         │
                    │        ▼                                      │
                    │  flow-mcp ── 工具调用 ──► flow-device         │
                    │     │ 录制器（每次调用记一条）                │
                    │     ▼                                         │
                    │  traces/<id>.jsonl  +  assets/*.png           │
                    └─────┼─────────────────────────────────────────┘
                          ▼
                    flow-core: 编译器 ──► flows/<name>.flow.yaml
                                           │（人工审阅、可改）
                    ┌───────────── 回放（多次） ──────────────────┐
                    │ flow-cli / Escrcpy 桌面模块                 │
                    │   flow-core: 回放器 ──► flow-device ──► adbx ──► 设备
                    │      │ 失败时                               │
                    │      ├─ L0 备用定位   L1 弹窗处理（interrupts）│
                    │      └─ L2 自愈 agent（AI SDK + flow-device） │
                    │   runs/<ts>/report.json + 失败截图 / dump    │
                    └─────────────────────────────────────────────┘
```

### 3.1 包划分（都放在 `packages/` 下）

| 包                                     | 职责                                                                                                                                  | 依赖                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `@escrcpy/flow-device`                 | **设备工具层**：UI dump 与解析、元素查找、snapshot 缓存、坐标换算、按设备串行的输入队列、截图、模板匹配。只有纯函数和服务，不涉及协议 | `@escrcpy/adbx`、sharp、`@techstark/opencv-js`   |
| `@escrcpy/flow-core`                   | 脚本 schema（zod）、YAML 读写、**编译器**、**回放器**、自愈调度、报告                                                                 | flow-device、yaml、zod、`ai`（自愈用，可选加载） |
| `@escrcpy/flow-mcp`                    | MCP server：把 flow-device 暴露成工具，并内置**录制器**                                                                               | flow-device、`@modelcontextprotocol/sdk`         |
| `@escrcpy/flow-cli`                    | 命令行：`flow mcp / compile / run / heal / export`                                                                                    | flow-core、flow-mcp                              |
| `desktop/electron/modules/flow/`（M4） | 桌面端集成：主进程服务 + 渲染端页面                                                                                                   | flow-core                                        |

这样拆的原因：flow-device 可以用 XML fixture 做单元测试，不需要连真机；MCP 和回放共用它，行为不会分叉。

## 4. 数据模型

### 4.1 录制轨迹（trace，JSONL，每行一条事件）

```text
// traces/2026-10-27T10-00-00_wechat.jsonl
{ "type": "session", "id": "tr_01", "task": "给张三发消息：你好", "vars": { "user": "张三", "message": "你好" },
  "device": { "serial": "…", "model": "…", "sdk": 34, "width": 1080, "height": 2400, "density": 440 },
  "startedAt": 1761530400000 }
{ "type": "call", "seq": 7, "ts": 1761530412345, "tool": "ui_tap",
  "args": { "content_desc": "搜索" },
  "ok": true, "kind": "action",                 // action | observe | meta
  "before": { "snapshotId": "snap_5", "app": { "package": "com.tencent.mm", "activity": "…LauncherUI" } },
  "target": {                                   // 只有动作类调用才有：服务端实际命中的元素
    "text": "", "contentDesc": "搜索", "resourceId": "com.tencent.mm:id/j5t",
    "className": "android.widget.ImageView", "bounds": [900,150,1020,210],
    "matchCount": 1, "crop": "assets/tr_01-7.png"
  },
  "durationMs": 412 }
{ "type": "call", "seq": 8, "tool": "get_screen_state", "kind": "observe", "ok": true, "snapshotRef": "snap_6" }
{ "type": "end", "outcome": "completed", "endedAt": 1761530460000 }
```

- 每个 snapshot 的元素列表另外存一份到 `snapshots/<id>.json`，编译时检查“选择器是否唯一”要用。
- 坐标类 `tap`：录制器用当时的 UI 树做**命中测试**，找到点下去的那个元素，也写进 `target`。这样编译器就能把坐标点击升级成选择器点击。

### 4.2 脚本（`*.flow.yaml`）

```yaml
version: 1
name: wechat-send-message
description: 给指定联系人发送一条消息
app: {package: com.tencent.mm}
recordedOn: {model: Pixel 8, sdk: 34, size: [1080, 2400], trace: tr_01}
vars:
  user: {required: true, description: 联系人}
  message: {required: true}
defaults: {timeout: 8000, settle: 300}

interrupts: # 全局弹窗处理：任一步找不到目标时先检查这里
  - when: {text: 以后再说, exact: true}
    do: tap

steps:
  - id: launch
    intent: 打开微信
    do: app_start
    with: {package: com.tencent.mm, restart: true}
    expect: {visible: {content_desc: 搜索}}

  - id: open-search
    intent: 打开搜索
    do: tap
    target: # 按顺序尝试，第一个“唯一命中”的生效
      - {resource_id: 'com.tencent.mm:id/j5t'}
      - {content_desc: 搜索, exact: true}
      - {image: assets/open-search.png, threshold: 0.85}
      - {point: [0.8889, 0.075]}

  - id: type-user
    do: input_text
    with: {text: '{{user}}'}

  - id: pick-contact
    intent: 点击搜索结果中的联系人
    do: tap
    target:
      - {text: '{{user}}', exact: true, index: 0} # 编译器发现文本等于变量值，自动参数化
    optional: false
```

动作集合（原型）：`app_start`、`app_stop`、`open_url`、`tap`、`long_press`、`input_text`、`key`、`swipe`、`scroll`、`scroll_until`（滚到目标出现为止）、`wait_for`、`assert`、`sleep`、`shell`（受安全策略限制）。

`target` 的选择器字段：`resource_id`、`text`、`content_desc`、`class_name`、`exact`、`index`、`within`（父容器选择器，M3 再做），另外两种定位是 `image` 和 `point`。

### 4.3 运行报告

```
runs/2026-10-27T11-00-00_wechat_<serial>/
  report.json      # 每一步：状态、耗时、用的是第几个定位方式、是否自愈、错误
  step-04.png      # 失败或用了备用定位时的截图
  step-04.xml      # 当时的 UI dump
```

`report.json` 里会标出 **drift**：某一步用了备用定位才成功，说明首选定位可能已经失效，提示更新脚本。

## 5. 核心流程

### 5.1 设备工具层（flow-device）

按逆向出来的行为自己实现：

- UI dump：有 yadb 时用 `yadb -layout`，否则用 uiautomator；最多重试 3 次；XML 上限 5 MB。这部分 adbx 里已经有现成实现。
- 解析：元素保留规则、排序规则、输出字段与 madb 保持一致，多存一个 `path`（节点在树中的索引路径），给“父容器选择器”和命中测试用。
- snapshot 缓存：60 s 过期；任何输入动作之后作废。
- 输入：按设备串行队列；坐标统一用 0~1 比例。
- 截图：用 sharp 缩放并转 JPEG。**模板匹配要按设备分辨率缩放模板**，录制和回放设备的宽度比例不同时先缩放模板（这一点 Escrcpy 没做）。

### 5.2 MCP server 与录制（flow-mcp）

工具集合与 madb 的 32 个基本对齐，名字也保持一致，这样逆向文档里的 prompt 思路可以直接用。另外加 3 个录制控制工具：

| 工具                                   | 作用                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `flow_record_start(name, task, vars?)` | 开始录制，写入 session 头                                                |
| `flow_step(intent)`                    | 可选：agent 在每个逻辑步骤开始前声明意图，编译器会把它写成 `intent` 字段 |
| `flow_record_stop(outcome)`            | 结束录制，返回 trace 路径                                                |

另外设了环境变量 `FLOW_TRACE_DIR` 时会自动录制，不需要 agent 配合。

另外提供一份**探索用 prompt**（MCP prompt 资源 `flow/explore`）：要求 agent 优先用 `ui_tap` 按选择器点击，避免坐标点击；每个逻辑步骤前先调用 `flow_step`；完成后用 `assert` 类工具验证最终状态。这样录出来的 trace 更容易编译。

### 5.3 编译器（trace → flow）

```
1. 过滤      只保留 ok 的 action 类调用；observe 和失败的调用丢掉（失败的保留在注释里）
2. 分段      按 flow_step 切分；没有 flow_step 时一个动作一步
3. 合并      连续 input_text 到同一个焦点 → 合并；settle 参数 → 去掉（交给自动等待）
             连续 scroll 之后紧跟着对某个目标的 tap → 改成 scroll_until(target) + tap
4. 定位生成  对每个 target 元素生成候选定位，按稳定性评分排序，只保留在当时 snapshot 中“唯一命中”的：
               resource_id（排除看起来像混淆过的 id，例如 id/a1b）
               > content_desc（精确）
               > text（精确；含数字、时间、金额的动态文本降级）
               > text + index
               > image（元素截图）
               > point（比例坐标，永远作为最后兜底）
5. 参数化    trace 里声明的变量值出现在 input_text 或选择器里时，替换成 {{var}}
6. 期望      每个动作的 expect = 下一步的首选定位可见（隐式）；最后一步取录制结束时屏幕上的显著元素
7. 稳定化    app_start 默认 restart: true
8. 输出      写 YAML，并把用到的 crop 图片拷到 assets/
```

可选：`flow compile --annotate` 调用一次模型，补全每一步的 `name` / `intent`，并建议哪些值应该做成变量。

### 5.4 回放器

```
run(flow, device, vars):
  校验 vars → 渲染 {{var}}
  for step in steps:
    if step 有 target:
      等待：每 500ms dump 一次，直到某个定位“唯一命中”或超时（timeout）
      超时 → 失败处理（见 5.5）
    执行动作（选择器命中用元素中心；image 用匹配中心；point 直接换算）
    sleep(settle)
    if step.expect: 等待 expect 满足，否则 → 失败处理
    记录：耗时、用了第几个定位、是否 drift
  写报告
```

优化：上一步 expect 用的那次 dump 可以直接给下一步定位用，每步最少只要 1 次 dump。

### 5.5 失败处理与自愈

| 层级 | 手段                                                                                                                                                                                           | 要不要模型 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| L0   | 依次尝试备用定位（已经包含在 5.4 里）                                                                                                                                                          | 否         |
| L1   | 检查 `interrupts`（弹窗、权限框、更新提示），处理完重试本步 1 次                                                                                                                               | 否         |
| L2   | **自愈 agent**：输入 = 流程描述 + 当前步骤的 intent 和 expect + 当前屏幕状态 + 失败诊断；可用工具 = flow-device 的工具（不含 shell / 文件 / 安装）；目标 = 让本步的 expect 成立；最多 8 次动作 | 是         |
| L3   | 失败：保存截图和 dump，报告失败                                                                                                                                                                | —          |

L2 成功后：本步的操作被录成一小段 trace，编译成**补丁**（替换或插入步骤），写到 `flows/<name>.flow.yaml.patch-<n>`。**默认不自动覆盖脚本**，需要 `flow heal --apply` 或者在桌面端点确认。这样不会让模型悄悄把脚本改坏。

模型配置用环境变量：`FLOW_LLM_BASE_URL`、`FLOW_LLM_API_KEY`、`FLOW_LLM_MODEL`、`FLOW_LLM_API_TYPE`（messages / responses）。key 从 1Password 环境注入，不写进仓库。

### 5.6 CLI

```bash
flow mcp --trace-dir ./traces                 # 给 Claude Code 用的 MCP server（stdio）
flow compile traces/xxx.jsonl -o flows/ --var user=张三 --var message=你好
flow run flows/wechat.flow.yaml -s <serial> --var user=李四 --var message=hi
flow run flows/wechat.flow.yaml --all --vars-csv rows.csv --concurrency 3
flow heal runs/<ts>/report.json [--apply]
flow export flows/wechat.flow.yaml --format escrcpy-automation   # 导出成坐标宏 JSON
```

Claude Code 的接入方式（项目级 `.mcp.json`）：`{"flow": {"command": "pnpm", "args": ["--filter", "@escrcpy/flow-cli", "exec", "flow", "mcp"]}}`。

## 6. 可靠性与边界

| 场景                         | 问题                | 对策                                                        |
| ---------------------------- | ------------------- | ----------------------------------------------------------- |
| 安全窗口、锁屏、游戏、Canvas | UI dump 失败或为空  | 回退到 image / point 定位；报告里标注这一步“不可树定位”     |
| WebView / Flutter / Compose  | 节点缺少 text 或 id | 优先用 content_desc；必要时用图片                           |
| 动态列表（搜索结果、消息）   | 文本每次都不同      | 用变量参数化选择器（`text: "{{user}}"`）、`index`、`within` |
| 分辨率或 DPI 不同            | 坐标和模板会偏      | 选择器不受影响；坐标是比例；模板按宽度比例缩放              |
| App 改版                     | 选择器失效          | drift 报告 + L2 自愈 + 补丁审阅                             |
| 并发控制同一台设备           | 手势交错            | 每台设备串行队列；同一台设备同时只能跑一个 run              |
| 和 Escrcpy 投屏同时使用      | adb 和输入冲突      | 原型阶段文档注明；M4 集成时和投屏状态互斥或协调             |

## 7. 测试策略

- **flow-device / 编译器**：用真机导出的 UI XML 和 trace 当 fixture，测解析、过滤、定位评分、唯一性检查、参数化。不需要设备，跑在 vitest 上。
- **回放器**：给 flow-device 做一个 mock（按脚本顺序返回 fixture XML），测等待、备用定位、interrupts、报告。
- **端到端（手动）**：在一台真机上验收 M2，例如“设置 → WLAN 页面”“系统浏览器打开网址并搜索”，各回放 10 次；然后换一台分辨率不同的设备再跑。

## 8. 里程碑

| 里程碑              | 内容                                                                                                                    | 验收标准                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** 骨架         | 4 个包的脚手架；flow-device 的 dump / 解析 / 查找 / 输入 / 截图；fixture 单测                                           | `pnpm --filter @escrcpy/flow-device test` 通过；在真机上能 dump 并按选择器点击                                                                                                               |
| **M1** 探索与录制   | flow-mcp 工具集 + 录制器 + 探索 prompt                                                                                  | Claude Code 连上 server 后完成一个任务，生成完整的 trace（含 target 和 snapshot）                                                                                                            |
| **M2** 编译与回放   | 脚本 schema、编译器、回放器、报告、`flow run`                                                                           | 两个示例流程在同一台设备上回放 10 次成功 ≥ 9 次；换一台设备不改脚本也能跑通                                                                                                                  |
| **M3** 自愈         | interrupts、L2 自愈 agent、补丁与 `flow heal`                                                                           | 人为让首选定位失效（例如改掉 resource_id）后，能用备用定位或自愈跑完，并产出补丁                                                                                                             |
| **M3.5** 协调与批量 | DeviceLease 设备租约、flow-mcp 占用标注与 `device_claim` / `device_release`、`flow fleet`、agent 接入指南（见第 10 节） | 两个 MCP 客户端抢同一台设备，后到者收到含持有者的报错；`flow fleet` 在 ≥ 2 台设备上并行跑完清单并产出 `reports/<flow>/<device>/<run>/` 分层报告；持有者进程死亡或 120 s 无活动后租约自动释放 |
| **M4** 桌面集成     | `modules/flow`、脚本列表与运行页、多设备 + 变量批量执行、导出 Escrcpy Automation JSON                                   | 在桌面端选几台设备，加载一份变量 CSV，能一键跑完并查看每台设备的报告                                                                                                                         |

M0 到 M2 是核心价值，做完就能验证“回放比每次都用 AI 视觉理解快、而且稳”。M3、M4 按实际效果再决定投入多少。

## 9. 风险与以后要回头看的地方

- **UI dump 的耗时**是回放速度的上限。如果 yadb 也不够快，可以考虑在设备上常驻一个 accessibility 服务，持续提供 UI 树（复杂度会明显上升）。
- **模型自愈可能越修越偏**：所以补丁默认要人工确认，每份脚本保留版本历史。
- **脚本表达力**：等需要条件分支和子流程时，再在 YAML 里加 `if` / `call`，或者直接让脚本支持 TS 写法（像 Playwright 那样）。现在不提前设计。
- **和上游 Escrcpy 同步**：除 M4 外都是独立包，不碰上游代码；M4 只新增一个 module，冲突面最小。
- **许可证**：工具名和参数结构属于接口层面，保持兼容没问题；实现代码全部自己写。

## 10. M3.5：设备租约、flow fleet 与 agent 接入（介于 M3 与 M4 之间）

> M3 解决"一个流程坏了能自愈"，M4 解决"进桌面端、批量跑"。但多进程并存（agent 的 MCP server、`flow run` / `flow fleet`、以后的桌面模块，甚至投屏）共用一台设备时，"谁在用、谁能用"在 M3 验收时就会暴露。M3.5 用一个**纯文件系统设备租约（DeviceLease）**把这层跨进程协调补上，并加 `flow fleet` 清单式批量派发；它不依赖桌面端，M4 的窗口 / 任务队列直接复用同一套租约（见 10.4）。agent 接入的操作细节见 [flow-agent-onboarding.md](flow-agent-onboarding.md)。

### 10.1 DeviceLease：文件锁式设备租约

目标：多个进程对"一台设备同一时刻只有一个操作者"达成共识，**不需要常驻服务**，只用文件系统。放在 `@escrcpy/flow-device/src/lease.ts`——flow-mcp、flow-cli、未来的 `modules/flow` 都已依赖 flow-device，复用零成本。它和 5.1 的"按设备串行队列"互补：队列管**同一进程内**的手势顺序，租约管**跨进程**的独占。

| API                                               | 语义                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `acquire(serial, {holder?, waitMs?}) → LeaseInfo` | 原子创建锁文件成功即持有；已存在且新鲜 → 抛 `LeaseBusyError`（附持有者信息）；陈旧 → 清理后重试；`waitMs > 0` 时轮询等释放 |
| `release(serial) → boolean`                       | 删除锁文件；本来就没有锁时返回 false（不校验持有者，释放即让位）                                                           |
| `refresh(serial)`                                 | 持有者续约：更新锁文件 mtime（心跳语义）                                                                                   |
| `info(serial) → LeaseInfo \| null`                | 读单台设备的租约，无则 `null`                                                                                              |
| `list() → Record<serial, LeaseInfo>`              | 列出全部租约，给 `device_list` 和 fleet 调度用（读到陈旧锁时顺手清理）                                                     |

- **锁文件**：`<dir>/<serial>.lock`，内容为 JSON：`{ "holder": "claude-code", "pid": 8321, "acquiredAt": 1761530400000 }`（即 `LeaseInfo`）。
- **目录**：默认 `~/.escrcpy/flow/leases`，环境变量 `FLOW_LEASE_DIR` 覆盖（测试和 CI 指到临时目录）。
- **原子创建**：`open(path, 'wx')`（O_EXCL）——创建即持有，创建失败即已被人持有，POSIX 与 Windows 语义一致，没有检查-再创建的竞态窗口。
- **陈旧判定**（读取时惰性执行，满足任一条即视为已释放）：
  - `now - mtime > staleMs`（默认 **120 s**）：持有者必须在窗口内有活动。MCP server 每次 action 调用自动 `refresh`，fleet 每步完成后续约；一次 dump ≤ 3 s、一步含等待 ≤ 8 s（默认 timeout），120 s 至少覆盖十几个连续慢步骤。agent"纯思考"超过 120 s 视为放弃，重新 `acquire` 即可。
  - 锁内 `pid` 已不存在（`process.kill(pid, 0)` 抛 ESRCH）：进程崩了就立刻可抢，不傻等 mtime 过期。
- **破坏陈旧锁的竞态**：多个进程同时发现陈旧时各自 `unlink` 后重走 acquire——重试仍是 `wx` 原子创建，只有一个赢家；输家在下轮循环里读到别人的新锁，按正常 busy 处理。`info()`/`list()` 读到陈旧锁也会顺手清理并视为无锁，fleet 的 busy 预检因此不会对着陈旧锁傻等/错跳。
- **不做的事**：不加密、不做权限（本机单用户假设，见 1.2 的"规模"）；`shell_exec` 等绕过 flow-device 的操作管不住，靠约定。

### 10.2 flow-mcp 增强

`device_list` 的输出给每台设备加 `lease: { status: "free" }` 或 `lease: { status: "busy", holder, pid, acquiredAt }`，agent 一眼看到可用设备。新增两个工具：

| 工具                                       | 作用                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `device_claim(serial?, holder?, wait_ms?)` | 调 `acquire`。`holder` 默认取客户端可读名（如 `claude-code`），`pid` 为 server 进程；`wait_ms > 0` 时轮询等释放 |
| `device_release(serial?)`                  | 调 `release`，任务结束建议显式调用；忘调也不怕，靠陈旧判定兜底                                                  |

server 在 **action 类工具**执行前 `info()` 一次：被他人新鲜持有 → 报 `DEVICE_BUSY`（错误文本含 serial/holder/pid/acquiredAt）；读到陈旧 → 自动清理放行；自己持有 → `refresh`。**observe 类**（`get_screen_state`、`ui_dump`、`ui_find_element`、`ui_wait_for`、`screenshot`、`device_info`、`clipboard_get`）不检查租约——观察无副作用，且"先看一眼再决定抢不抢"更符合探索习惯。

**手势级自动 acquire 的取舍**——action 时要不要替 agent 自动 acquire：

| 方案                                   | 行为                                               | 优点                                 | 缺点                                                                                         |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| A. 手势级自动 acquire                  | 首次 action 自动 acquire、每次 action 自动 refresh | agent 零配合，天然强互斥             | 偶发查看也会长期占设备；agent 思考超过 staleMs 被误清；占用对 agent 不透明（不知道自己持锁） |
| **B. 显式 claim + 手势级强制（选它）** | action 只检查"是否被他人持有"，不主动 acquire      | 语义可推理：报错即答案；观察不需占用 | 双方都不 claim 时仍有竞争窗口（原型接受，靠 onboarding 流程引导 claim）                      |

选 B：接入指南把 `device_claim` 放进标准探索流程的第一环，配合 `device_list` 的 free/busy 标注，引导成本已经够低；A 的"零配合强互斥"留给 M4——那时持有者是桌面任务队列，不存在 agent 心智负担问题。

### 10.3 flow fleet：清单式批量派发

```bash
flow fleet fleet.yaml [--report-dir reports/] [--wait-busy] [--dry-run]
```

清单（manifest）示例：

```yaml
# fleet.yaml — 派发清单
flows:
  - flow: flows/wechat-send-message.flow.yaml
    vars: # 每一项是一行变量，与该 flow 做笛卡尔积；空列表 = 跑一次
      - {user: 张三, message: 你好}
      - {user: 李四, message: 中午吃啥}
  - flow: flows/settings-wlan.flow.yaml
    vars: []
devices: [ABC123XYZ, emulator-5554] # 或 devices: auto，取派发时刻全部在线且 free 的设备
defaults:
  staleMs: 120000 # holder 统一为 fleet:<pid>
```

调度语义：

- **运行项** = flows × vars 行的笛卡尔积；派发时把运行项按顺序分给设备。
- **每台设备并发 = 1**：fleet 对每台设备先 `acquire`（holder = `fleet:<pid>`），跑完当前项再取下一项，同设备天然串行；跨进程互斥由租约保证。
- **跨设备并行**：不同设备同时各跑一项；运行项多于设备时排队。
- 设备被外部占用（agent 正在探索）：默认**跳过并标记 `blocked`**（汇总里含占用者），`--wait-busy` 改为等待释放。
- 失败隔离：单项失败不影响其他项，退出码按汇总结果定。

报告布局——比 4.3 的 `runs/` 多两层固定层级（flow / device），汇总文件列出每个运行项的状态、耗时与报告路径：

```
reports/<flow-name>/<serial>/<run>/report.json   # run = 时间戳，例如 2026-10-29T10-00-00_1
reports/<flow-name>/<serial>/<run>/step-04.png
reports/fleet-2026-10-29T10-00-00.json           # 本次派发汇总
```

**recordedOn 校验**：每个运行项开始前对比 `flow.recordedOn` 与 `device_info`，不一致**只告警不阻断**（分辨率无关正是 D5 的目标），告警写进 `report.warnings` 并打在控制台：

| 不一致项      | 级别    | 含义                                                                           |
| ------------- | ------- | ------------------------------------------------------------------------------ |
| `size` 分辨率 | warning | 选择器不受影响；`point` 兜底可能偏移、`image` 模板按宽度比例缩放后阈值可能要调 |
| `model` 型号  | info    | 提示模板图与系统界面可能不同，失败优先看 image 定位                            |
| `sdk` 版本    | warning | 输入法、keyevent、权限弹窗行为可能有差异                                       |

### 10.4 到 M4 桌面模块的演进路径

- **租约逻辑原样复用**：`lease.ts` 不改一行。变化的只是持有者语义：从 agent（pid = MCP server 进程）换成**窗口 / 任务队列**——`holder = desktop:<windowId>` 或 `desktop:task:<id>`，`pid` = 桌面主进程。
- 桌面"运行"按钮 = 主进程里的一次 fleet 调度（选中设备 + 变量表），走同一套 acquire/release；第 6 节"与投屏互斥"也以租约为仲裁点：镜像窗口启动前 acquire，失败就把占用者展示给用户。
- agent 与桌面并存时，`device_list` 的 free/busy 两边可见——agent 看得到"桌面正在跑"，反之亦然，这是租约放在文件系统而不是进程内存里的直接收益。
- M3.5 **不做**的：桌面 UI、报告渲染、CSV 变量导入（F6 / F7 留给 M4）。
