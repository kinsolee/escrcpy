# Escrcpy 3.3.1 Copilot 与 Automation 逆向分析

> 目的：为“AI 探索一次 → 生成可回放脚本 → 之后不依赖视觉模型重复执行”的二次实现做技术参考。
> 本文只描述架构、接口和行为，用自己的话概括；不包含闭源模块的原始代码。实现时请按本文的接口和行为自己重写。

## 0. 结论摘要

1. **Copilot = Vercel AI SDK（`streamText`）+ 每台设备一个 madb MCP 子进程**。LLM 只看工具清单和 system prompt，用 MCP 工具（以 UI 树为主、截图为辅）操作手机。没有自研的 agent 框架，主循环就是 AI SDK 的多步工具调用。
2. **madb 是一个独立打包的 MCP server（stdio，32 个工具）**，放在 `Resources/extra/common/madb/index.mjs`。它的底层 `@escrcpy/adbx` 在开源仓库 `packages/adbx/` 里。
3. **Automation 是一个“坐标宏”执行器**：10 种步骤（tap / swipe / input / key / wait / launch / install / screenshot / record / command），每步可以挂一个 OpenCV 模板匹配作为“前置门控”（匹配不到就跳过这一步）。**它没有控件选择器、没有条件分支、没有断言。**
4. **两者之间没有桥接**：Copilot 跑完的工具调用不能转成 Automation 脚本。不过 Copilot 已经把每次工具调用（名称 + 参数 + 结果）按顺序写进了本地 IndexedDB（`executionJournal`），可以直接拿来当“录制数据源”。
5. 对你的目标，最省事的路线是：**回放器直接复用 madb 的 MCP 工具**（脚本 = 一串带选择器的 MCP 工具调用，回放时由程序依次调用，不经过 LLM），某一步失败时才把上下文交给 LLM 修复。详见第 7 节。

## 1. 分析对象与方法

| 项 | 值 |
| --- | --- |
| 应用 | `/Applications/Escrcpy.app`，版本 3.3.1，Electron 42.1.0 / Chrome 148 |
| 打包 | `app.asar`（12 MB）+ `app.asar.unpacked`（sharp、node-pty、opencv.js） |
| 混淆 | 无。Vite/Rolldown 输出，main / preload 未压缩只改了变量名，并保留 `//#region <源文件路径>` 注释；renderer 已压缩 |
| sourcemap | 无 |
| madb | 单文件 ESM，保留了 TypeScript 源码的 JSDoc 注释 |

分析文件（解包在 scratchpad，未进仓库）：

- `app-extracted/dist-electron/main.js`：主进程（Copilot 会话、MCP client、provider）
- `app-extracted/dist-electron/preload.mjs`：preload（Automation 执行器、OpenCV）
- `app-extracted/dist/assets/{copilot,automation,mirror,runtime-message,index.browser,variables,use-shortcut-schedule}-*.js`：渲染端（已用 prettier 格式化后阅读）
- `Resources/extra/common/madb/index.mjs`：madb MCP server

**可信度**：本文结论全部来自**静态阅读代码**，没有在运行时验证。行号指向上述文件，方便复查。

## 2. 总体架构

```
┌──────────────────────── Renderer ────────────────────────┐
│ pages/copilot  ──ipc invoke "copilot:*"──┐                │
│ pages/automation ──$preload.automation.*─┼─┐              │
│ mirror 键位映射 / 定时任务(schedule) ─────┘ │              │
└─────────────────────────────────────────────┼────────────┘
                                              │
┌──────── Main process ────────┐   ┌──────── Preload ─────────────┐
│ module:copilot:service       │   │ middleware/automation        │
│  └ CopilotService (G$)       │   │  └ Runner (每 sessionId 一个) │
│     └ SessionManager (_$)    │   │      └ steps → adbx 操作      │
│        ├ provider (AI SDK)   │   │      └ opencv matchTemplate   │
│        └ MCPServerManager ───┼─┐ └───────────────┬──────────────┘
└──────────────────────────────┘ │                 │ adbkit / yadb
                                 │ stdio (每设备一个子进程)
                     ┌───────────▼──────────┐      │
                     │ madb MCP server      │      │
                     │  32 tools → adbx ────┼──────┤
                     └──────────────────────┘      ▼
                                              adb server → 设备
```

## 3. Copilot

### 3.1 模块与进程模型

源文件（据 region 注释，`main.js`）：

| 源文件 | 行号 | 作用 |
| --- | --- | --- |
| `electron/modules/copilot/helpers/provider.js` | 57758 | 按 apiType 创建模型；拼 system prompt |
| `electron/modules/copilot/helpers/stream-timeout-manager.js` | 57844 | 流空闲超时 + 心跳超时 |
| `electron/mcp/client.js` | 61071 | 用 stdio transport 连 MCP，缓存 tools |
| `electron/mcp/server-manager.js` | 61123 | 每设备一个 madb 子进程，最多 3 个并发 |
| `electron/modules/copilot/helpers/session.js` | 61221 | 会话管理 + 主循环 `_runToolLoop` |
| `electron/modules/copilot/helpers/session-config.js` | 62253 | 从 electron-store 读供应商/模型配置 |
| `electron/modules/copilot/window.js` | 62338 | 窗口 + IPC 注册 |

**madb 子进程的启动方式**（`main.js` 61123–61208）：

- 命令：`process.execPath`（Electron 二进制本身），参数是 madb 入口文件路径。
- 环境变量：
  - `ELECTRON_RUN_AS_NODE=1`
  - `NODE_PATH` 指向 asar 和 asar.unpacked 的 `node_modules`（madb 要用 sharp）
  - `ANDROID_SERIAL=<设备ID>`（一进程绑定一台设备）
  - `ADB_PATH`、`YADB_PATH`
- 最大并发设备数 3；同一设备复用同一个连接中的 client，进程退出后自动重建。

### 3.2 LLM 调用链

- **供应商映射**（57759）：`apiType` 可以是 `messages`（Anthropic 格式，`@ai-sdk/anthropic`）、`responses` / `chat_completions` / `completions`（OpenAI 格式，`@ai-sdk/openai`）。`baseUrl` 末尾的 `/messages`、`/responses`、`/completions` 会被去掉。
- **主循环**（`_runToolLoop`，61402 行起）调用 AI SDK 的 `streamText`，参数要点：
  - `system`：动态拼出来的 prompt（第 4 节）
  - `messages`：只有一条用户消息，也就是**每个任务都从零开始，不带聊天历史**，靠 system prompt 里的“上一个任务摘要”衔接
  - `tools`：madb 的全部 MCP 工具（经过“敏感工具确认”包装，见 3.6）
  - `stopWhen: stepCountIs(maxSteps)`，maxSteps 默认 500
  - `maxRetries: 0`
  - `prepareStep`：每一步都会裁剪上下文：
    1. 只保留最后一条消息之前的 reasoning；
    2. 只保留最近 7 条消息里的工具调用；
    3. 去掉空消息；
    4. 除最后两条外，把工具结果里的图片替换成一句“已裁剪以节省上下文”的文字。
- **超时**：流空闲 120s、单步心跳 90s（每 30s 检查一次），超时就 abort。
- **结束判定**：`finishReason` 为 `stop` 算完成，`length` 算到达步数上限（暂停），`content-filter` 提示被安全过滤，其他情况算失败。

### 3.3 会话管理

- 每台设备一个 session：`{ id, deviceId, mcpClient, emitter, metadata, stepCounter, executionId, pendingConfirmations, taskContext }`。
- 空闲 30 分钟回收，每 5 分钟检查一次。
- **多设备**：`executeTaskList` 用 p-limit 并发执行，上限读 `common.concurrencyLimit`，默认 5。同一个任务文本分发给每台设备，各自独立跑。
- **跨任务记忆**（`taskContext`）：只记上一个任务的 `{task, outcome, summary, error}`，截断到 200 / 400 / 200 字符，有效期 10 分钟，作为 system prompt 的一段注入。
- copilot 配置里的 `prompts / sessions / active / activeVendorId / activeModelId` 一变就销毁所有会话。

### 3.4 事件协议（main → renderer）

每个事件的形状是 `{ event, payload, context: { stepNumber, sessionId, deviceId, executionId } }`：

| event | payload |
| --- | --- |
| `MCP_SESSION_READY` | `{ toolCount, toolNames }` |
| `TASK_START` | `{ task }` |
| `REASONING_DELTA` / `TEXT_DELTA` | `{ content }` |
| `TOOL_CALL_START` | `{ name, arguments, toolCallId }` |
| `TOOL_CALL_END` | `{ name, result, toolCallId }` |
| `TOOL_CALL_ERROR` | `{ name, error, toolCallId }` |
| `TOOL_CALL_CONFIRM_REQUIRED` | `{ name, arguments, requestId }` |
| `THINKING_COMPLETE` | `{ content }` |
| `TASK_COMPLETE` | `{ message, finishReason, usage }` |
| `TASK_STEP_LIMIT_REACHED` | `{ message, stepCount, maxSteps, usage }` |
| `ABORTED` | `{ message }` |
| `ERROR` | `{ message, code?, statusCode?, guidance? }` |

渲染端会把这些事件逐条写进 IndexedDB 的 `executionJournal` 表（`runtime-message-*.js` 约 283–340 行），用来在窗口重开时恢复未完成的执行。**这份记录就是现成的“AI 操作录像”。**

### 3.5 IPC 通道（`main.js` 62357）

`copilot:execute(task, options)`、`copilot:stop(deviceId, reason)`、`copilot:destroy(deviceId)`、`copilot:destroyAll()`、`copilot:confirmToolCall(deviceId, requestId, approved)`、`copilot:getSessionByDevice(deviceId)`、`copilot:getActiveSessions()`、`copilot:setIdleTimeout(ms)`。

`execute` 的 `options` 包含 `deviceId`（可以是数组）、`deviceName / deviceNames`、`onData`、`onExit`、`onSession`、`concurrency`，以及可覆盖的 `apiKey / model / baseUrl / apiType / maxSteps / lang`。回调函数通过 `@escrcpy/electron-ipcx` 跨进程传递。

### 3.6 敏感工具确认

`_guardSensitiveTools` 会把名单里的工具包一层：执行前发出 `TOOL_CALL_CONFIRM_REQUIRED`，等用户确认（5 分钟超时，超时按拒绝处理）。**3.3.1 的名单是空的**，等于没启用。

### 3.7 配置结构（electron-store key `copilot`）

```jsonc
{
  "maxSteps": 500,
  "active": "<vendorName>::<modelId>",      // 全局默认模型
  "sessions": { "<deviceId>": "<vendorName>::<modelId>" },  // 按设备覆盖
  "vendors": [{
    "name": "…", "vendor": "…", "isBuiltin": false,
    "apiType": "messages|responses",        // 渲染端只提供这两个选项
    "apiKey": "…",
    "models": [{ "id": "…", "name": "…", "url": "<baseUrl>",
                 "maxInputTokens": 0, "maxOutputTokens": 0, "fixed": false }]
  }]
}
```

内置供应商名为 `Gitee`，走 `https://api.moark.com/v1` 的付费 API（有购买弹窗；HTTP 402 会映射成 `API_NOT_PURCHASED`）。自填任意兼容 OpenAI / Anthropic 的 baseUrl + key 也可以用。**本次没有分析付费和授权流程，也不需要。**

### 3.8 错误分类（`_parseApiError`）

错误码：`PROVIDER_ERROR / API_NOT_PURCHASED / NETWORK_ERROR / MCP_ERROR / STREAM_TIMEOUT / UNKNOWN_ERROR`。另外有 `guidance` 字段，取值 `VISION_NOT_SUPPORTED / INSUFFICIENT_BALANCE / INVALID_API_KEY / RATE_LIMITED / SERVER_ERROR / …`，渲染端用它去找对应的 i18n 提示文案。

### 3.9 本地数据库（Dexie，库名 `escrcpy_local_db`，版本 8）

| 表 | 索引 |
| --- | --- |
| `messages` | `++id, sessionId, timestamp, role` |
| `sessions` | `id, deviceId, updatedAt` |
| `executionJournal` | `++id, executionId, sessionId, deviceId, sequence, timestamp` |
| `executionAssets` | `++id, executionId, assetType, createdAt` |
| `automationScripts` | `++id, name, deviceId, createdAt, updatedAt` |
| `schedules` / `shortcuts` / `keyboardDevices` | 定时任务、快捷键、键位映射 |

## 4. System prompt 结构

由 `main.js` 57778 的函数动态拼接，完整原文在 57778–57842 行。按顺序分为以下几段（概括）：

1. **Active Device**（有设备时）：给出设备 ID、名称、分辨率；规定只能操作这台设备，不传 `serial`，不调用设备列表/选择类工具。
2. **Initialization**（无设备时）：先列设备、选设备、观察屏幕，再开始操作。
3. **Previous Task**（有 taskContext 时）：注入上一个任务的请求、结果和失败原因，并提醒这可能已过时，只有“继续上一个任务”这类请求才用它。
4. **Role**：Android 控制 agent，优先级依次是正确性、最少操作、状态准确。
5. **Observation**：默认调用一次 `get_screen_state`；同时需要视觉信息时传 `include_screenshot=true`，一次拿到；只有纯视觉场景（游戏、地图、Canvas/WebView 拿不到树）才单独截图；可以复用 `snapshotId`，但页面变化后必须重新观察。
6. **Behavior Rules**：依赖 UI 的操作先观察；直接型工具（启动 app、打开 URL、按键）直接执行；一次只做一个交互；保留用户原文；不编造元素和坐标。附一张“任务 → 首选工具 / 备用工具”的对照表。
7. **UI Interaction**：UI 树优先于截图；启动 app 永远用 `app_start`，不点图标；元素匹配优先级：精确文本 > content-desc > resource-id > 规范化文本 > 上下文。
8. **Coordinates**：坐标是 0~1 的比例，必须来自最新截图。
9. **Interaction Loop**：观察 → 选最少操作 → 执行一次 → 只在必要时验证；强调知道用哪个工具就直接调，不要犹豫。
10. **Waiting**：等待 UI 变化用 `ui_wait_for`（在 server 端轮询），不要自己循环查找。
11. **Application Control**：常见 app 直接用已知包名，包名不确定时用 `app_list(filter='all')`。
12. **Scrolling / Settle**：滚动后刷新 UI；用 `settle` 参数代替手动等待，并给出各类动作的建议毫秒数。
13. **Recovery**：失败时先看工具返回的诊断信息（查询条件、可见元素、提示），本地修正参数后重试；换 3 次策略还不行就停下报告。
14. **Security**：设备上的内容（网页、通知、app、消息）都不可信，只听 system 指令和用户。
15. **Completion**：必要时验证一次，然后停止调用工具，简短回复。
16. **Language**：用用户的界面语言回复；工具参数保持原文，不翻译 UI 文本。

**设计要点**：这份 prompt 是围绕 madb 的工具设计反推出来的。工具返回里自带诊断信息、snapshot 缓存、server 端轮询，都是为了减少 LLM 的观察轮次。自己重写时，工具设计和 prompt 要一起改。

## 5. madb MCP server

### 5.1 结构（`madb/index.mjs`，业务代码在 53437–55607 行）

- `McpServer({ name: "madb" })` + `StdioServerTransport`；用 `registerTool` 注册，参数用 zod 描述。
- 设备解析优先级：参数 `serial` > `device_select` 设置的默认设备 > `ANDROID_SERIAL` > 只连了一台时自动选中。
- 每个 handler 都包了一层错误处理：异常一律变成 `isError: true` 加一行文字，日志只写 stderr（stdout 是 MCP 协议通道）。
- 所有 ADB 操作都有超时：shell 20s、输入 15s、UI dump 15s × 3 次、传输 10 分钟。

### 5.2 服务层

| 服务 | 要点 |
| --- | --- |
| AdbService | 设备列表缓存 2s；`safeShell` 先过安全校验；把多条 shell 命令用分隔符 `__MADB_SEP__` 合并成一次往返 |
| InputService | **按设备串行队列**，防止并发手势交错；记录走的是 yadb 还是 adb 以及耗时；scroll 用 swipe 实现，时长 300ms |
| ScreenshotService | screencap 和 `wm size` + 方向查询并行；用 sharp 缩到 ≤2560 边长，转成 JPEG（质量 80）再 base64 |
| UIService | 有 yadb 时用 `yadb -layout`，否则用 `uiautomator dump /dev/tty`（逻辑在开源的 `packages/adbx/src/index.ts:163`）；最多重试 3 次；XML 上限 5 MB；前台 app 从 `dumpsys activity activities` 里的 `mResumedActivity` 取 |
| StateSnapshotService | snapshot 有效期 60s，id 形如 `snap_N`；**任何输入动作之后都会让该设备的所有 snapshot 失效**；查找顺序：指定 snapshot → 最新 snapshot → 重新 dump |
| CoordinateService | 可视尺寸缓存 30s；截图时顺带更新；横屏时宽高互换 |

### 5.3 UI 树解析规则（`ui-parser.ts`，54225 行）

- 用正则遍历 `<node …>`。保留条件：类名后缀在“可交互白名单”里（Button / EditText / TextView / ImageView / CheckBox / Switch / RecyclerView / WebView 等 26 种）**或者** `clickable=true`；同时 bounds 面积必须大于 0，且 `text / content-desc / resource-id` 至少有一个非空。
- 密码框的 text 会替换成 `[password field]`。
- 结果排序：先按 y（相差 10px 以内视为同一行），再按 x。
- 输出给 LLM 的字段：`type, text, contentDesc, resourceId, className, bounds{x,y,width,height}, centerX, centerY`，加上值为 true 的布尔状态（clickable / scrollable / focused / checked / selected，以及 `enabled=false`）。
- 过滤（`filterElements`）：多个条件之间是 AND；`text`、`content_desc` 默认不区分大小写的子串匹配，`exact_match` 时改为全等；`resource_id` 永远全等；`class_name` 是子串匹配。

### 5.4 坐标体系

所有坐标类工具的参数都是 **0~1 的比例**，以屏幕左上角为原点，允许 0.005 的浮点误差。半径参数是相对短边的比例。`ui_tap` 例外，它直接用 dump 出来的设备像素中心点。

### 5.5 安全策略

- shell 命令黑名单：会拦截 reboot、关机、格式化、root shell 等危险模式。设 `SHELL_UNSAFE=true` 可以跳过。
- `SHELL_READONLY=true` 时只放行一组只读命令前缀（getprop、dumpsys、`settings get`、`pm list`、`cat`、`ls`、`uiautomator dump` 等）。
- 设备端路径只允许 `/sdcard/`、`/storage/`、`/data/local/tmp/`、`/data/media/`、`/mnt/`；本机路径会做规范化校验。

### 5.6 工具清单（32 个）

除了 `device_list`、`device_select`，所有工具都接受可选参数 `serial`。带 `settle` 的工具都是可选的“动作后等待毫秒数”（0–5000）。

| # | 工具 | 类别 | 参数 | 行为概括 | 标注 |
| --- | --- | --- | --- | --- | --- |
| 1 | `device_list` | 设备 | — | 列出设备（serial、状态、model），强制刷新 | |
| 2 | `device_info` | 设备 | — | 型号、品牌、Android 版本、SDK、分辨率、电量（一次 shell 往返） | |
| 3 | `device_select` | 设备 | `serial`（必填） | 设置默认设备 | |
| 4 | `screenshot` | 感知 | — | JPEG 图片 + 图片尺寸、设备尺寸、来源 | |
| 5 | `get_screen_state` | 感知 | `include_screenshot?` | **核心观察工具**：snapshotId、前台 app、屏幕尺寸、元素列表，可选附带截图 | readOnly |
| 6 | `get_foreground_app` | 感知 | — | 前台包名和 activity | readOnly |
| 7 | `ui_dump` | UI | `format?: xml\|json` | 原始 XML 或解析后的 JSON，同时登记一个 snapshot | readOnly |
| 8 | `ui_find_element` | UI | `text? resource_id? class_name? content_desc? exact_match? snapshot_id?` | 查找元素 | readOnly |
| 9 | `ui_tap` | UI | 同上 + `index? settle?` | **按选择器找到元素并点击中心点**；找不到时返回查询条件、最多 15 个可见元素和提示 | destructive |
| 10 | `ui_wait_for` | UI | 选择器 + `timeout_ms?`（1000–60000，默认 10000）`poll_interval_ms?`（默认 500） | server 端轮询直到元素出现；超时返回 `found:false`，不算错误 | readOnly |
| 11 | `tap` | 输入 | `x y`（0~1） | 坐标点击 | destructive |
| 12 | `swipe` | 输入 | `x1 y1 x2 y2 duration?`（默认 300） | 滑动 | destructive |
| 13 | `long_press` | 输入 | `x y duration?`（默认 1000） | 长按 | destructive |
| 14 | `drag` | 输入 | `x1 y1 x2 y2 duration?`（默认 1000） | 拖拽 | destructive |
| 15 | `scroll` | 输入 | `x y h_scroll v_scroll distance_ratio?`（默认 0.3） | 用 swipe 模拟滚动，正数表示向下/向右 | destructive |
| 16 | `pinch` | 输入 | `center_x center_y start_radius end_radius duration?` | 双指缩放，需要 yadb | destructive |
| 17 | `key_event` | 输入 | `keycode`（数字或名字，如 HOME / BACK / ENTER） | 按键，内置约 40 个名字映射 | destructive |
| 18 | `input_text` | 输入 | `text` | 向焦点输入框输入，yadb 支持 Unicode | destructive |
| 19 | `app_start` | 应用 | `package activity? restart? settle?` | 先 `pm path` 检查是否安装；有 activity 用 `am start -n`，否则用 `monkey -p … LAUNCHER 1`；restart 时先 force-stop | |
| 20 | `app_stop` | 应用 | `package settle?` | force-stop | |
| 21 | `app_list` | 应用 | `filter?: all\|third-party\|system` | 列出包名（已排序） | |
| 22 | `app_install` | 应用 | `path`（本机 APK） | 安装 | |
| 23 | `app_uninstall` | 应用 | `package` | 卸载 | |
| 24 | `open_url` | 导航 | `url settle?` | `am start -a VIEW --uri`，支持 deep link | destructive |
| 25 | `get_orientation` | 导航 | — | 方向、user_rotation、是否自动旋转 | readOnly |
| 26 | `set_orientation` | 导航 | `orientation: portrait\|landscape\|reverse-*\|auto` | 锁定或恢复自动旋转 | destructive |
| 27 | `clipboard_get` | 剪贴板 | — | 通过 yadb 读剪贴板 | |
| 28 | `clipboard_set` | 剪贴板 | `text` | 通过 yadb 写剪贴板 | |
| 29 | `shell_exec` | Shell | `command` | 经安全校验，输出截断到 10 KB | |
| 30 | `file_push` | 文件 | `local_path remote_path` | 推送文件 | |
| 31 | `file_pull` | 文件 | `remote_path local_path` | 拉取文件 | |
| 32 | `file_list` | 文件 | `path` | 列目录（name / size / mode / mtime） | |

> 注：prompt 里提到的 `settle` 是参数，不是单独的工具。

## 6. Automation

### 6.1 组成

| 部分 | 位置 |
| --- | --- |
| 编辑器 UI | `dist/pages/automation`，`automation-*.js` |
| 执行器 | `preload.mjs` 38309–38870（`electron/middleware/automation/helpers/*`） |
| 图像匹配 | `preload.mjs` 38392（`electron/middleware/opencv/index.js`），`@techstark/opencv-js` + sharp |
| 脚本存储 | IndexedDB 表 `automationScripts` |
| 模板图片 | `<common.saveDir 或桌面>/automation-templates/<stepId>-<随机8位>.png` |
| 变量 | Pinia store `app-automation-variables`，**按设备**持久化 |

### 6.2 脚本 schema（据代码整理）

```jsonc
// 数据库中的一条脚本
{
  "id": 1,                       // Dexie 自增
  "name": "string",
  "description": "string",
  "deviceId": "string",          // 有索引
  "steps": [Step],
  "variables": [{ "name": "user", "value": "", "description": "User" }],  // 内置模板里有
  "createdAt": 0, "updatedAt": 0
}

// Step
{
  "id": "string",                // 随机 id
  "name": "string",              // 显示名
  "type": "tap|swipe|input|key|wait|launch|install|screenshot|record|command",
  "params": { /* 见 6.3 */ },
  "loopCount": 1,                // 本步重复次数，最小 1
  "delayBefore": 2000,           // 每次执行前等待毫秒数；UI 新建默认 2000，执行器缺省为 0
  "randomRange": 0,              // 随机抖动档位 N，见 6.4
  "imageMatch": null | {
    "enabled": true,
    "templatePath": "/abs/path.png",
    "threshold": 0.8,            // TM_CCOEFF_NORMED 的最小值
    "followMatchPoint": false,   // 仅对 tap 有效：把点击坐标改成匹配中心
    "stepId": "string"
  }
}
```

**导出格式**：

- 单个导出：直接写出脚本对象。
- 批量导出：每个脚本一个文件，内容是 `{ name, description, steps, variables, exportedAt }`。
- 导入：读 JSON；没有 name 时用文件名。

### 6.3 步骤类型

坐标规则：**值 ≤ 1 视为比例，> 1 视为像素**，换算基准是 `wm size`。

| type | params（UI 默认值） | 执行方式 |
| --- | --- | --- |
| `tap` | `{x:0.5, y:0.5}` | `adbx.input.tap` |
| `swipe` | `{startX:0.5, startY:0.75, endX:0.5, endY:0.25, duration:300}` | `adbx.input.swipe` |
| `input` | `{text:""}` | `adbx.input.text` |
| `key` | `{keyCode:4}` | `adbx.input.key`；UI 提供 9 个常用键 |
| `wait` | `{duration:1000}` | sleep |
| `launch` | `{packageName, appLabel, forceStop:false}` | 可选先 force-stop 并等 300ms，再用 `monkey -p … LAUNCHER 1` 启动 |
| `install` | `{apkPath, uninstallBefore:false, packageName?}` | 已安装时先卸载再安装 |
| `screenshot` | `{saveDir}` | 保存成 `Screencap-<设备>-<时间>.png` |
| `record` | `{duration:10, saveDir, source:"screen"\|"camera", args}` | 调 scrcpy 录屏（`--time-limit`，camera 时加 `--video-source=camera`），**不等待录完** |
| `command` | `{command:"shell …"}` | 只接受以 `shell ` 开头的命令 |

### 6.4 执行器语义（用自己的话描述的伪代码）

```
run(deviceId, steps, {mode, stepIndex, magicVars, onProgress}):
  steps = mode=="step" ? [steps[stepIndex]] : steps
  for step in steps:
    检查 stop / pause
    for i in 1..max(1, loopCount):
      等待 delayBefore（randomRange>0 时加 ±N×500ms 抖动）
      if imageMatch.enabled 且有 templatePath:
        截图 → 模板匹配
        未匹配: 记录 confidence，跳过本次（continue，不算失败）
        匹配且 followMatchPoint 且 type==tap:
          把匹配中心换算成比例坐标，写回 params.x/y
        匹配出错: 记录错误并跳过
      params 中的 {{var}} 替换为变量值
        可用变量：magicVars + deviceId / timestamp / date / stepIndex
      randomRange>0:
        tap/swipe 坐标加 ±N×0.005 抖动并限制在 [0,1]
        swipe 时长加 ±N×500ms 抖动
      按 type 分发执行
    某一步抛异常 → 整个脚本停止，返回 {success:false, error}
```

- 每个 `sessionId` 一个 Runner，状态有 idle / running / paused / stopped。
- 同一个 sessionId 再次执行时，会先停掉旧的 Runner。
- 应用退出前（`quit-before`）停止所有 Runner。
- 进度回调形状：`{ stepId, stepIndex, status: running|success|error, message }`。

### 6.5 图像匹配

截图 base64 → sharp 解码成 raw → OpenCV Mat（RGBA/RGB 转 BGR）→ `matchTemplate(TM_CCOEFF_NORMED)` → `minMaxLoc`。模板比截图大时直接判为未匹配。返回 `{matched, confidence, location{x,y,width,height,centerX,centerY}}`。

（推断，未验证）`followMatchPoint` 用 `wm size` 而不是截图的实际像素尺寸来换算比例，横屏时可能算偏。

### 6.6 调用入口

1. **Automation 窗口**：执行选中步骤或整个脚本，变量来自当前设备的变量 store。
2. **定时任务 / 快捷键**（`use-shortcut-schedule-*.js`）：`{ scriptSteps, variableRows }`。对每台设备按 `common.concurrencyLimit` 限制并发，每台设备内部**依次跑每一行变量**。这就是“批量执行 + 变量注入”功能。
3. **Mirror 键位映射**（`mirror-*.js` 约 12140 行）：一个按键绑定一个脚本，可以设循环次数和多组变量。

所有入口最终都调用 `window.$preload.automation.execute({ deviceId, steps, mode, sessionId, magicVars, onProgress })`。

## 7. 对二次实现的建议

### 7.1 现有能力和你的目标之间的差距

| 你需要的 | 发布版是否具备 |
| --- | --- |
| AI 探索 UI | ✅ Copilot + madb |
| 记录 AI 的每一步 | ⚠️ 已经记录到 `executionJournal`，但只用来恢复聊天窗口 |
| 把记录转成脚本 | ❌ 没有 |
| 按控件（text / resource-id）定位的步骤 | ❌ Automation 只有坐标 |
| 等待元素出现 / 断言 / 条件分支 | ❌ 只有固定 wait，以及“匹配不到就跳过” |
| 回放失败时自愈 | ❌ |
| 多设备批量执行 + 变量 | ✅ 有，可以直接借鉴 |

### 7.2 推荐方案：脚本 = 确定性的 MCP 工具调用序列

关键点：**madb 的工具本身就是确定性的**，LLM 只负责“决定调哪个、传什么参数”。所以：

1. **录制**：订阅 Copilot 的 `TOOL_CALL_START / TOOL_CALL_END`（或者读 `executionJournal`），只保留成功的**动作类**调用（ui_tap、input_text、app_start、key_event、scroll、swipe、open_url、ui_wait_for 等），丢掉观察类调用（get_screen_state、screenshot、ui_find_element）。
2. **编译**：
   - 每个 `ui_tap` 记下选择器（text / resource_id / content_desc / index）；
   - 再从调用前那次 `get_screen_state` 的结果里查到被点元素，补上 bounds 和 className，作为备用定位；
   - 可选：截一块元素区域的图，作为第二备用（模板匹配）；
   - 坐标类 `tap` 记下比例坐标，作为最后的兜底。
3. **回放**：程序直接连 madb，依次调用工具，不经过 LLM。每个动作之后可以插一个 `ui_wait_for`，等下一步要用的元素出现，用来替代固定的 wait。
4. **自愈**：某一步失败（元素找不到 / 等待超时）时，把“脚本目标 + 当前步骤 + madb 返回的诊断信息”交给 LLM，让它只修这一步。修好后回写脚本，并留版本记录。

建议的步骤格式（Automation 原有格式的超集，原有的坐标步骤可以继续用）：

```jsonc
{
  "id": "s3", "name": "点击搜索",
  "action": "ui_tap",                       // 直接对应 madb 工具名
  "args": { "resource_id": "com.tencent.mm:id/search", "settle": 500 },
  "locators": [                             // 回放时按顺序尝试
    { "kind": "selector", "resource_id": "com.tencent.mm:id/search" },
    { "kind": "selector", "content_desc": "搜索", "exact_match": true },
    { "kind": "image", "templatePath": "…/s3.png", "threshold": 0.85 },
    { "kind": "point", "x": 0.8375, "y": 0.0744 }
  ],
  "expect": { "tool": "ui_wait_for", "args": { "text": "搜索", "timeout_ms": 5000 } },
  "onFail": "heal"                          // heal | skip | abort
}
```

### 7.3 自己实现时可以照搬的设计（按“行为”，不是照抄代码）

- 每设备一个 MCP 子进程，用 `ELECTRON_RUN_AS_NODE` 复用 Electron 自带的 Node。
- 工具失败时返回结构化诊断（查询条件 + 可见元素 + 提示），让 LLM 一轮就能修正。
- snapshot 缓存，任何输入后整体失效。
- 按设备串行的输入队列。
- `prepareStep` 里裁剪旧的截图和旧的工具调用，控制上下文长度。
- 坐标统一用 0~1 比例。

### 7.4 能复用的开源部分

- `packages/adbx/`（Apache-2.0，在仓库里）：tap / swipe / text / key / screencap / dumpLayout / yadb。
- `desktop/electron/resources/extra/common/yadb`。
- 第三方依赖都是公开包：`@ai-sdk/*`、`@modelcontextprotocol/sdk`、`zod`、`sharp`、`@techstark/opencv-js`、`dexie`。

## 8. 未验证事项与局限

- 全部来自静态阅读，没有运行时抓包或调试验证。
- 渲染端只读了 Automation 编辑器、执行入口、变量和存储部分；Copilot 聊天 UI 的展示逻辑（消息渲染、工具卡片）没有细读。
- 没有分析 `wscrcpy`、`mirror` 的投屏和键位映射细节，也没有分析付费 / 授权流程。
- `followMatchPoint` 在横屏下可能算偏，这一点是推断。
- 本文基于 3.3.1，后续版本可能变化。

## 9. 许可证提示

开源仓库是 Apache-2.0，但闭源模块（copilot / automation / madb / wscrcpy / mirror）在发布包里没有单独的许可证声明，作者显然是有意不开源的。建议：

- 以本文为规格，自己重新实现；
- 不要把解包出来的代码复制进公开仓库；
- 如果要公开发布衍生版本，先确认相关条款，或者联系作者。

（这不是法律意见。）
