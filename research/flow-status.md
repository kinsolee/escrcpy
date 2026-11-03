# Flow 自动化：任务帐本

> 这是 flow 自动化（录制 → 编译 → 回放）**唯一的任务入口**。新任务、状态变化都改这一份；设计细节仍以 [record-replay-prototype-design.md](record-replay-prototype-design.md) 为准。
>
> 状态：**已完成** / **待修** / **需真机验证** / **环境问题** / **不做**。
> 最后更新：2026-11-03（分支 `kinsolee/tiktok-shop-links` = `kinsolee/jev-decision-layer` `309cc748` 并入 main `168355ad`；M9 见 §7）。

## 1. 里程碑

设计文档 §8 只定义了 M0–M4（含 M3.5）；M5–M7 是之后追加的，范围以对应 commit message 为准。

| 里程碑                 | 内容                                                                                                                                                                                                                                                                                                | 状态                                                                             | 依据                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **M0** 骨架            | 4 个包的脚手架；flow-device 的 dump / 解析 / 查找 / 输入 / 截图；fixture 单测                                                                                                                                                                                                                       | 已完成                                                                           | `6cf3b19b`，`a5de6a47`（dump 可靠性、输入队列）；设计 §8                                           |
| **M1** 探索与录制      | flow-mcp 工具集 + 录制器 + 探索 prompt                                                                                                                                                                                                                                                              | 已完成                                                                           | `436712c6`，`120307f8`                                                                             |
| **M2** 编译与回放      | 脚本 schema、编译器、回放器、报告、`flow run`；extract 步骤 + xlsx 输出                                                                                                                                                                                                                             | 已完成，已在真机上验证（Pixel 5a：Settings 搜索、TikTok 置顶作品两个案例）       | `521737f8`，`cd0b7119`，`f98d7e64`                                                                 |
| **M3** 自愈            | interrupts、L2 自愈 agent、补丁与 `flow heal`                                                                                                                                                                                                                                                       | 已完成，已在真机上验证（L0 备用定位 / L1 弹窗 / L2 补丁，外加一次真实 LLM 冒烟） | `d8fd2e25`，`beb90215`，`06d1ba88`（heal probe 改为 5 s、接受单对象 target）                       |
| **M3.5** 协调与批量    | DeviceLease、`device_claim` / `device_release`、`flow fleet`、agent 接入指南                                                                                                                                                                                                                        | 已完成，已在 4 台真机上 E2E 验证                                                 | `8fa09af1`，`458e7f0b`，`2010f8a8`；设计 §10；[flow-agent-onboarding.md](flow-agent-onboarding.md) |
| **M4** 桌面集成        | 共享 LLM 配置 + 偏好设置里的「AI 自愈模型」对话框；流程页、脚本库、导出官方 Automation JSON；多设备 × 变量表批量执行 + CSV 导入                                                                                                                                                                     | 已完成，已在真机和运行中的 app 里验证                                            | `5732d79f`，`f44affd0`，`385ed8f4`，`9259d6ff`                                                     |
| **M5** 目标驱动自愈    | 回放失败后朝 `flow.description` 自由探索并产出补丁；action 预算；在流程页应用补丁                                                                                                                                                                                                                   | 已完成，已在真机上验证                                                           | `1d9183e2`，`17849943`，`4c5deefa`，`9b3e126c`（ui-drive skill）                                   |
| **M6** 应用内 Copilot  | AI 助手页（in-process flow MCP + agent loop）、存为流程；yadb 默认开启                                                                                                                                                                                                                              | 已完成，已在真机上验证                                                           | `cd3b946e`，`599a47b5`                                                                             |
| **M7** 外部 agent 接入 | 自包含的 `agent.mjs`（33 个工具）、「接入外部 Agent」对话框，随 app 打包                                                                                                                                                                                                                            | 已完成，已在空目录和打包后的 app 里验证                                          | `bc4953a9`，`9e8a1a6c`，`8315816c`                                                                 |
| **M8** 视觉 agent 模式 | 不录制、不回放：视觉模型每步看截图直接操作（`runVisionAgent` / `flow agent` / MCP `vision_agent_run`），runner 强制前台白名单、禁用词点击拦截、步数 / 时间 / 调用预算、卡住检测；`report.json` + 逐步截图                                                                                           | 已完成，已在真机上验证（Pixel 5a，TikTok 47.5.3，见 §6）                         | 本分支，见 §6                                                                                      |
| **M9** Jev 决策层      | Jev（TypeSafe System One）类型化判断客户端；`visual_locate` / `visual_check` / `flow see`；代码驱动 playbook（`flow playbook tiktok-shop-links`）：每步一次 Jev 请求判页面 / 弹窗 / 分享面板 / 无结果 / 控件位置，只在不确定时把单步交给 M8 视觉 agent；Jev 视觉禁用检查补 V1；M8 `--jev` 复核 done | 已完成，已在真机上验证（Pixel 5a，TikTok 47.5.3，见 §7）                         | `4a34ca21` … `07dfd21a`，见 §7                                                                     |
| M2–M7 收尾修复         | 每次 dump 使用唯一远端路径；临时 CLI 命令的租约提示；跨 OEM 回放（结尾 expect 改为 `{app}`）；heal 后 step id 保持稳定；内置 yadb 回落                                                                                                                                                              | 已完成                                                                           | `78e9b114`，`0ed62503`，`81efedb4`，`c9cd717a`（AGENTS.md）                                        |

## 2. 本轮收尾（settings-polish）

| 项目                                                                            | 状态                                  | 依据                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移除旧 worktree `escrcpy-automation-reverse-eng-4ca72b`，删除本地 + origin 分支 | 已完成                                | 删除前 `git rev-list --count main..<branch>` = 0                                                                                                                |
| `flow-mcp/src/context.ts:36` ESLint operator-linebreak                          | 已完成                                | `f3f63b6f`                                                                                                                                                      |
| flow-core typecheck 失败（`heal.ts` TS2322 ×3，`81efedb4` 引入）                | 已完成                                | `4b7d45da`：`HealLlmEndpoint` 字段改为可选，与运行时检查一致                                                                                                    |
| Copilot agent 可以 `device_select` 到其他 serial                                | 已完成，app 内效果需真机验证（见 §3） | `38e67fc2`：flow-mcp `lockedSerial` 选项（其他 serial → `SERIAL_LOCKED`），Copilot session 用 `lockedSerial` 打开 + system prompt 写明绑定的设备；新增 4 个测试 |
| Orca 里的旧 repo 登录项 `dc832aad-…`（escrcpy-automation-reverse-eng-4ca72b）   | 环境问题                              | `orca repo` 只有 list/add/show/set/set-base-ref/search-refs，没有移除指令；需在 Orca GUI 里手动移除（路径已不存在）                                             |

## 3. 待修

| #   | 问题                                                                                                                                                                                                                     | 位置                                                                                                     | 备注                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 已完成：切换设备 / 页面卸载 / 渲染层重载时关闭旧的 Copilot session（新增 `copilot:close`：中止运行中的 loop 并 close MCP client）；设备下拉框只在运行中禁用，不再一开会话就锁死                                          | 2026-11-03 已在打包版 app 里验证：Pixel 会话问完后切到小米，旧对话清空、新会话直接在小米上执行，无需重启 | 原来会话一开就不能换设备，只能重启 app；app 内效果和 #2 一起需真机验证                     |
| 2   | 已验证：Copilot 会话锁定设备。模型被要求切到另一台设备时，按 system prompt 直接拒绝、不调用工具；绕过模型直接调 MCP 时，`device_select` / 带其他 serial 的工具都返回 `SERIAL_LOCKED`，不传 serial 的调用仍落在绑定设备上 | Copilot 页                                                                                               | 2026-11-03 用 agent-desktop 无障碍接口驱动（不占鼠标）+ 真机 MCP 脚本验证                  |
| 3   | 已完成：`control-bar` 的 `Install` 组件改名为 `InstallApp`，`pnpm lint` 全部通过                                                                                                                                         | `desktop/src/components/control-bar/index.vue`                                                           | `59d7eba8`                                                                                 |
| 4   | 投屏（scrcpy）没有接入设备租约：设计 §6 / §10.4 写的是镜像窗口启动前 acquire，目前只有流程页（`modules/flow/scripts.js`）在用租约                                                                                        | `desktop/electron/modules/flow/scripts.js` 之外                                                          | 可选；agent / 流程运行时，投屏和输入仍可能互相干扰                                         |
| 5   | 已完成：turbo 新增 `typecheck` / `test` 任务（依赖 `^build`），根目录 `pnpm typecheck` / `pnpm test` 只跑四个 flow 包                                                                                                    | `turbo.json`；根 `package.json`                                                                          | 合并前跑 `pnpm typecheck && pnpm test && pnpm lint`                                        |
| 6   | 上游 `electron-ipcx` 不在门禁里：typecheck 报 TS2578/TS2339（`shared/errors.ts:180`），vitest 2.1.9 在当前 vite 下 `__vite_ssr_exportName__ is not defined`                                                              | `packages/electron-ipcx`                                                                                 | 来自上游 v3.3.1（`e35972b4`），不是 flow 引入的；修要升级它的 vitest，属于依赖改动，先不动 |
| 7   | 需真机验证：Copilot 页里模型调 `screenshot` 后能真正「看到」图片（进程内 `callTool` 现在保留图片 block，agent loop 以 user 消息附图） | Copilot 页                                                                                                                  | 单测覆盖 MCP 与 agent loop 两层；`d66fdd80` 合并后一起验证                   |

## 4. 环境问题 / 不做

| 项目                                                        | 分类                       | 说明                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit 签名                                                 | 环境问题（用户已选择不签） | 1Password SSH 签名通道卡死（"failed to fill whole buffer"）；从 `4c5deefa` 起所有 commit 都用 `--no-gpg-sign`                                                                                                                                                                                                 |
| `packages/madb/dist` 闭源缺口                               | 环境问题 / 不做            | `desktop/electron-builder.config.js:25` 的 extraResources 引用 `../packages/madb/dist`，但 madb 是闭源、仓库里没有。打包前需要放一个占位文件 `packages/madb/dist/index.mjs`（只有 `export {}`，不含任何闭源代码；in-app Copilot 用的是 flow MCP，用不到它）。新 worktree 默认没有这个占位文件。不复制闭源代码 |
| F8 条件分支 / 循环 / 子流程                                 | 不做                       | 设计 §1.1；目前只支持 `optional` 和 interrupts                                                                                                                                                                                                                                                                |
| 打包版和 dev 版共用 `~/Library/Application Support/escrcpy` | 环境问题                   | 不要同时运行两者（第二个实例会白屏或卡住）                                                                                                                                                                                                                                                                    |
| 打包命令                                                    | 环境问题（已写进文档）     | 必须 `npx electron-builder --config=./electron-builder.config.js`，详见 AGENTS.md Gotchas                                                                                                                                                                                                                     |
| 新 worktree 需要先 build                                    | 环境问题                   | 包之间通过 `dist` 互相引用：`pnpm install` 后先跑 `pnpm --filter @escrcpy/shared --filter @escrcpy/adbx --filter "@escrcpy/flow-*" build`，flow-mcp 测试和 desktop dev 才能正常工作                                                                                                                           |

## 5. 验证基线（2026-11-01，`kinsolee/settings-polish`）

| 包          | typecheck                | test                     | eslint                                                      |
| ----------- | ------------------------ | ------------------------ | ----------------------------------------------------------- |
| flow-device | 通过                     | 94 / 94                  | 通过                                                        |
| flow-mcp    | 通过                     | 19 / 19（+4 个锁定测试） | 通过                                                        |
| flow-core   | 通过（修复前：3 个错误） | 70 / 70                  | 通过                                                        |
| flow-cli    | 通过                     | 24 / 24                  | 通过                                                        |
| desktop     | —                        | —                        | `modules/copilot` 通过；`pnpm lint` 只剩 §3 #3 这个上游错误 |

## 6. 视觉 agent 模式（M8，2026-11-02）

背景：tk-shop-erp 的真机调研发现录制回放 + L2 heal 在 TikTok 上不可靠（搜索网格 / Shop 首页 / 领券弹窗的 UI 树几乎为空；heal 只看文本树，32 条「成功」链接里 8 条是错商品；按 HOME 或强停后回放跑进了 Shopee / MercadoLibre）。M8 让视觉模型直接接管，不依赖脚本。用法见 [flow-agent-onboarding.md §7](flow-agent-onboarding.md)。

### 6.1 交付

| 项目                                                                                                                                                                                                                                                                                                                                                                                              | 状态                                                   | 位置                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 视觉 runner：截图（长边 1280）+ 前台包 + ≤2 s 的精简元素列表 + 动作历史 → 一个 JSON 动作；0–1000 坐标或元素序号；`read_clipboard` 回传剪贴板；`done` / `fail`                                                                                                                                                                                                                                     | 已完成                                                 | `packages/flow-core/src/vision-agent.ts`                            |
| 三种协议发图（messages image block / chat `image_url` / responses `input_image`），60 s 超时，429/408/5xx/网络错误指数退避重试 2 次（尊重 `retry-after`），usage 统计，宽松解析（代码块、`<think>`、扁平形状、「类型写成键」）失败带错误重问 1 次                                                                                                                                                 | 已完成                                                 | `packages/flow-core/src/vision-llm.ts`                              |
| 护栏：执行前查前台（观测时 + 执行前各一次），越界不执行、自动拉起第一个允许的包 1 次、再越界 `guardrail` 结束；tap / long_press 落点解析到元素（祖先可点击节点 + 按钮大小容器的子节点）命中禁用词即拒绝（默认词覆盖 en / zh / pt / es）；无 UI 树时照常点击并记 `unverifiedTap`；`maxSteps` / `timeBudgetMs` / `maxModelCalls` 硬上限；连续 3 次无画面变化判 `stuck`；息屏（截图全黑）自动 WAKEUP | 已完成                                                 | 同上                                                                |
| 运行报告：`runDir/report.json`（逐步时间、截图、前台包、UI 树耗时、模型延迟 / tokens / 原始输出 / 重问、解析后的动作、执行结果、护栏拦截）+ `step-NNN.jpg`；汇总总耗时、步数、调用数、tokens、结束原因、结构化结果、`clipboardReads`。报告与错误信息中的 key 一律替换成 `***`                                                                                                                     | 已完成                                                 | 同上                                                                |
| CLI `flow agent --serial --goal [--result-schema] [--allow-package]… [--forbid-text]… [--max-steps] [--max-model-calls] [--time-budget] [--observe] [--launch] [--model vendor::model] [--run-dir] --json`；成功退出码 0，否则 1；SIGINT 中止并释放租约                                                                                                                                           | 已完成                                                 | `packages/flow-cli/src/index.ts`                                    |
| MCP `vision_agent_run`（`serial` 必填、遵守 `lockedSerial`、每步发 progress 通知、客户端取消即中止）；共 34 个工具                                                                                                                                                                                                                                                                                | 已完成                                                 | `packages/flow-mcp/src/index.ts`                                    |
| `agent.mjs` 自包含：经软链路径启动（如 `/tmp` → `/private/tmp`）时 `isMainModule` 为假、进程静默退出——改为比较真实路径（`isEntryModule`，CLI 同步修复）                                                                                                                                                                                                                                           | 已完成                                                 | 同上                                                                |
| `screenshot` 同进程第二次起报 "(intermediate value) is not a function"：bundle 内 sharp 是惰性 CJS 闭包，首次加载失败后第二次返回半初始化的空 exports。改为记住首次失败、拒绝非函数导出；无 sharp 时用纯 JS 解码 / 缩放 / 编码 PNG（不再回传原尺寸 PNG），新增画面指纹                                                                                                                            | 已完成，回归测试 `flow-device/test/screenshot.test.ts` | `packages/flow-device/src/screenshot.ts`                            |
| 租约重入：`withLease` —— 本进程已持有就复用、不释放，否则 acquire → 定时 refresh → release。`flow_run`、视觉 agent、`flow agent` 都走它；同进程 `device_claim` 后 `flow_run` 不再被自己挡住，结束也不会释放调用方的租约                                                                                                                                                                           | 已完成                                                 | `packages/flow-device/src/lease.ts`                                 |
| LLM key：vendor 支持 `apiKeyEnv`（环境变量非空时优先）；`saveLlmConfig` 以 0600 写入并收紧已有文件；读取时发现 group/other 可读打印一次警告（不含 key）；`--model` / `model` 可指定 vendor 下未列出的模型                                                                                                                                                                                         | 已完成                                                 | `packages/flow-core/src/llm-config.ts`                              |
| 进程内 MCP `callTool` 保留图片 block：有图时返回 `{text, images}`，Copilot agent loop 把图片作为紧随工具结果的 user 消息发给模型，历史里只保留最新一张。desktop 代码不用改                                                                                                                                                                                                                        | 已完成，app 内效果需真机验证（见 §3 #6）               | `packages/flow-mcp/src/index.ts`、`packages/flow-core/src/agent.ts` |

### 6.2 真机结果（18041JECB02784，Pixel 5a，TikTok 47.5.3 `com.zhiliaoapp.musically`，网关 magpie `chat_completions`）

每次 `--launch restart`（强停后重启 TikTok），`allowedPackages` 只有 TikTok。

| 运行                 | 模型                       | 关键词                 | 结果                   | 步数 / 调用         | tokens（prompt+completion） | 耗时  | 正确性                                                                                                                                                                                                                          |
| -------------------- | -------------------------- | ---------------------- | ---------------------- | ------------------- | --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| astra-1              | `codex/gpt-6-astra`        | removedor de fiapos    | 中止（手动）           | 5 / 5               | 24,008 + 229                | 73 s  | 设备处于 Dozing，截图全黑，模型一直 wait → 新增自动 WAKEUP 后重跑                                                                                                                                                               |
| astra-2              | `codex/gpt-6-astra`        | removedor de fiapos    | done，3 条链接         | 24 / 26（2 次重问） | 170,384 + 2,106             | 449 s | 3 条 `vt.tiktok.com` 短链均 302 到 `tiktok.com/view/product/<id>`（1736942404288415666、1737459860992918548、1735758438214894952），详情页均为除毛球器 / 粘毛滚筒，与关键词相关；搜索词确认为精确的 `removedor de fiapos`       |
| astra-noresult       | `codex/gpt-6-astra`        | pistola massageadora   | done，`noResults=true` | 8 / 8               | 50,071 + 551                | 117 s | 最终画面为 "No results found"，正确                                                                                                                                                                                             |
| sonnet-1             | `claude/claude-sonnet-5-5` | removedor de fiapos    | done，3 条链接         | 20 / 20             | 103,396 + 2,572             | 178 s | 与 astra-2 是同样 3 个商品 ID（顺序不同），canonical、相关；中途一次 back 落到视频页，模型自行再 back 回结果页                                                                                                                  |
| sonnet-2（最终代码） | `claude/claude-sonnet-5-5` | removedor de fiapos    | done，3 条链接         | 19 / 19             | 97,713 + 2,722              | 113 s | 同样 3 个商品 ID；新的禁用词护栏在主流程中零误拦                                                                                                                                                                                |
| bundle-guard         | `claude/claude-sonnet-5-5` | （按 HOME 测前台护栏） | done                   | 3 / 2               | 9,778 + 346                 | 16 s  | 用复制到空目录的 `agent.mjs`（无 node_modules、无 sharp）经 MCP 调 `vision_agent_run`：截图走纯 JS 缩放（576x1280 PNG），progress 通知正常；模型按 HOME 后前台变成 launcher，runner 没把 launcher 截图发给模型，直接拉回 TikTok |

- 两次重问都来自 gpt-6-astra 把动作类型写成键（`{"tap":"element=5"}`）；解析器已兼容，重问后均恢复。
- 运行中模型没去点 Like / Follow / 加购，所以没有运行时拦截记录。禁用词护栏的验收证据是在真机 TikTok UI 树上的只读检查（只 dump、不点击，脚本对每个带禁用词的元素按中心点跑 `checkTapTarget`），过程中发现并修了两个真实缺口：
  - 视频页最上层有一个全屏、不可点击的透明 `FrameLayout`，旧的「最上层节点」命中判断落在它身上，`Follow …` / `Like video` / `Like` 全部判 ok。现在改看「包含落点的最上层可点击节点」+ 落点下所有按钮大小的节点；修复后 feed 上三者均 `blocked`，Home / Search / Share / Profile 等无误伤。
  - 商品详情页（SeaPdpActivity）底栏的加购按钮是没有任何文字的 `FrameLayout`，`Chat`（私信卖家）不在默认词里。现在无标签控件若所在小分组（≤ 屏幕 10%，如购买栏）含禁用词则保守拦截，默认词加了 `Chat` / `Conversar`；修复后底栏：加购图标 `blocked`（grouped）、`Buy now` `blocked`、`Chat` `blocked`、`Shop` ok。
- 前台护栏：bundle-guard 运行是真机证据（越界 → 不调模型 → 自动拉回）；「再次越界就以 `guardrail` 结束」由单测覆盖。
- UI 树：yadb dump 在 TikTok 上通常 0.4–1.5 s，astra-2 有 2 步超过 2 s 被跳过（只发截图），没有卡住任何一步。
- `~/.escrcpy/flow/llm.json` 当前是 644：每次运行打印一次权限警告。没有改用户文件的权限，建议用户自己 `chmod 600` 或改用 `apiKeyEnv`。
- 网关当前没有 `antigravity/claude-sonnet-5-5`（llm.json 里列着），对比改用 `claude/claude-sonnet-5-5`。

### 6.3 待修 / 已知限制

| #   | 问题                                                                                                                                                                                                                   | 备注                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| V1  | 禁用词护栏依赖 UI 树：UI 树超时（报告记 `unverifiedTap`）或落点完全无标签、所在分组也无禁用词（记 `unlabeled`）时无法识别；`Read or add comments` 这类打开评论区的入口不拦（只读，但发评论的发送键可能也是无标签图标） | 可加视觉复核（让模型或小模型判断落点是否为社交 / 购买按钮）；目前靠 prompt + 前台白名单 + 分组规则兜底 |
| V2  | 一次搜 3 个链接：sonnet 约 2–3 分钟、10 万 tokens；astra 约 7.5 分钟、17 万 tokens（每步一张截图 + 元素列表）                                                                                                          | 可降图到长边 1024、缩短元素列表、或把「搜索 → 打开详情」中已知稳定的部分交给脚本，只在空 UI 树处用视觉 |
| V3  | 返回的是 `vt.tiktok.com` 短链；canonical 化（302 到 `/view/product/<id>`）要调用方做                                                                                                                                   | 可选：runner 对 `clipboardReads` 做 HEAD 解析                                                          |
| V4  | MCP 客户端默认 60 s 请求超时，`vision_agent_run` 要几分钟                                                                                                                                                              | 调用方需设长超时或传 `progressToken`（`resetTimeoutOnProgress`）；tk-shop-erp 建议直接用 CLI           |
| V5  | 根 `pnpm typecheck` / `pnpm test` 门禁在未合并的 `d66fdd80` 里；本分支用 `pnpm --filter "@escrcpy/flow-*"` 跑同样的检查                                                                                                | 合并 `claude/flow-ledger-followups` 后自动生效                                                         |
| V6  | 真机运行的副作用：TikTok 搜索历史里多了 `pistola massageadora` 等本轮的搜索词；模型两次都直接点历史建议而不是重新输入关键词（结果仍正确，因为历史项与关键词完全一致）                                                  | 只读范围内可接受；如需每次都重新输入，可在 goal 里明确要求                                             |
| V7  | 设备息屏（Dozing）时截图全黑：已加开始前 + 观测到全黑时自动 WAKEUP（最多 3 次）。锁屏（有密码 keyguard）不处理                                                                                                         | 有 keyguard 时模型会看到锁屏并应 `fail`                                                                |

### 6.4 验证基线（2026-11-02，本分支）

| 包          | typecheck | test                                                                                                                                                                                                                                          | eslint |
| ----------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105（+11：sharp 加载回归、纯 JS PNG、指纹、`withLease`）                                                                                                                                                                                | 通过   |
| flow-core   | 通过      | 95 / 95（+25：视觉 runner 正常完成 / 越界拦截与恢复 / 执行前复查 / 禁用词 / 透明覆盖层 / 购买栏分组 / 无 UI 树 / 解析重问 / 卡住 / 三种预算 / 中止 / key 脱敏 / 唤醒；LLM 三协议发图、超时重试、usage；`apiKeyEnv` 与 0600；agent loop 图片） | 通过   |
| flow-mcp    | 通过      | 25 / 25（+6：`vision_agent_run`、租约复用、busy / SERIAL_LOCKED、`flow_run` 不被自己的 claim 挡住、进程内图片 block、软链入口）                                                                                                               | 通过   |
| flow-cli    | 通过      | 24 / 24                                                                                                                                                                                                                                       | 通过   |

命令：`pnpm --filter "@escrcpy/flow-*" build && pnpm --filter "@escrcpy/flow-*" typecheck`，各包 `pnpm test`，`npx eslint packages/flow-* research`。

## 7. Jev 决策层（M9，2026-11-02）

背景：M8 视觉 agent 每步一次大模型调用（sonnet 约 5–6 s），搜 3 条链接 2 分钟、10 万 tokens（V2）；tk-shop-erp 在 16091 / 46.5.3 上的独立验证（24 个 sonnet 任务）又发现 D1–D7。M9 把「搜索 → 选卡 → 分享 → 复制链接」交给 TypeScript 状态机，每一屏的判断交给 Jev（约 1 s、约 2.8k 输入 token、无生成），大模型只在 Jev 不确定或页面不符合预期时接管单步。用法见 [flow-agent-onboarding.md §8](flow-agent-onboarding.md)。

### 7.1 交付

| 项目                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 状态                              | 位置                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| Jev 客户端：choice / score / noul / box 类型化问题与答案（答案类型由问题推断）；`JevImage` 放在 state / instructions / criteria 任意位置，自动生成 UUID 引用和 `assets`，每边 280–1568 px 校验；带图或 Box 时自动加 `TypeSafe-Danger-Zone-Images: true`；10 s 超时、408/429/5xx/网络错误重试 1 次；每次调用记录延迟、尝试次数、端点、usage；错误信息不含 key                                                                                                                                                                                                                      | 已完成                            | `packages/flow-core/src/jev.ts`                         |
| 配置：llm.json 新增 `jev` 段 `{baseUrl, apiKey?, apiKeyEnv?, model?, fallbackBaseUrl?, fallbackApiKey?, fallbackApiKeyEnv?, timeoutMs?}`；缺省 magpie `http://127.0.0.1:3425` + `magpie` vendor 的 key，模型 `typesafe-ai/jev`；`FLOW_JEV_BASE_URL` / `FLOW_JEV_API_KEY` / `FLOW_JEV_MODEL` 覆盖                                                                                                                                                                                                                                                                                  | 已完成                            | `packages/flow-core/src/llm-config.ts`                  |
| 400 "Images are not turned on" → `JEV_IMAGES_BLOCKED`（说明网关没转发该头、如何配置回落）；配置了回落端点时带图 / Box 请求自动改走回落端点并保持（纯文本仍走主端点）。回落默认不启用                                                                                                                                                                                                                                                                                                                                                                                              | 已完成（单测；真机全程走 magpie） | 同上                                                    |
| 视觉原语：`visualLocate`（一次请求 = Box + 存在性 Noul，返回像素坐标 / 比例 / box / confidence / present）、`visualCheck`（fan-out）；`visualRiskCheck`：纯 JS 在原始截图上裁落点附近方块、画红圈，问一个 Noul「是不是点赞 / 关注 / 评论 / 私信 / 加购 / 打开购物车 / 购买 / 领取 / 发送给好友类按钮」，> 0.5 拒绝                                                                                                                                                                                                                                                                | 已完成                            | `packages/flow-core/src/jev-vision.ts`                  |
| MCP `visual_locate {serial, description}`、`visual_check {serial, questions, state?}`（只读，不占租约）；`vision_agent_run` 新增 `jev`、`max_foreground_recoveries`、`llm_timeout_ms`；共 36 个工具                                                                                                                                                                                                                                                                                                                                                                               | 已完成                            | `packages/flow-mcp/src/index.ts`                        |
| CLI `flow see --serial --locate "<desc>" \| --ask '<json>' --json`；`flow playbook <id> \| list`（`--keyword --count --skip-ads --model --no-fallback --box-threshold --llm-timeout --launch --max-steps --time-budget --run-dir --json`）；`flow agent --jev --max-foreground-recoveries --llm-timeout`                                                                                                                                                                                                                                                                          | 已完成                            | `packages/flow-cli/src/index.ts`                        |
| Playbook 运行时（可扩展：`PlaybookDefinition` 注册到 `PLAYBOOKS`）：每次观测 = 截图后并行取前台 / UI 树（2 s）/ 一次 Jev 请求；点击前复查前台，UI 树禁用词检查，UI 树缺失或落点无标签时走 Jev 视觉检查；单步接管 = `runVisionAgent`（≤ 6 步、同样的白名单与禁用词、`launch: never`、`inputText` 只允许本次关键词）；接管后由下一次观测判定是否达成，连续 2 次未达成以 `failed` 结束；report.json 记录每步 Jev 延迟、问题名、答案与概率、代码的决策、动作、护栏、接管的状态 / 步数 / 模型调用 / tokens / 子报告路径，以及全部问题原文（`questionCatalog`）                         | 已完成                            | `packages/flow-core/src/playbooks/runtime.ts`           |
| `tiktok-shop-links`：页面类型 Choice（含 `other_app` / `other`）+ 弹窗 / 分享面板 / 无结果 Noul + 当前步骤所需 Box 同一请求；「商品卡」由代码定义 = 该位置看得到价格且没有 LIVE 角标（每个位置单独问价格 / 已售数 / LIVE / Ad，不问「是不是视频」）；按网格顺序取第一个未打开的合格位置（每屏记住）；右列 Box 不可靠时镜像同行左卡；复制前只读剪贴板（不写哨兵）、复制后轮询最多 8 s，链接必须是新的；短链解析停在第一个 `/product/<id>`（商品页自身会把无 cookie 请求转到 `/login`），按商品 ID 去重；No results 直接 `noResults=true`，不接管                                   | 已完成                            | `packages/flow-core/src/playbooks/tiktok-shop-links.ts` |
| M8 Jev 辅助（`jev: true` / `--jev`）：只做两件事——无 UI 树 / 无标签落点的视觉禁用检查；`done` 复核（结果里每条链接必须出现在 `clipboardReads`；终屏错误 / 登录页 Noul ≥ 0.85 拒绝；声称 `noResults` 时终屏须有无结果提示；可加 `jevDoneQuestions`）。复核失败告诉模型原因继续，第 3 次以 `failed` 结束。Jev 不参与规划                                                                                                                                                                                                                                                            | 已完成（单测）                    | `packages/flow-core/src/vision-agent.ts`                |
| tk-shop-erp 验证缺陷：D1 按商品 ID 去重（playbook）；D2 见上；D3 `@2131823611` 这类无字母标签视为无标签（走视觉检查，M8 也不再当文字给模型），`Cart` / `Carrinho` / `Carrito` / `购物车` 进禁用词；D4 冷启动回弹（M8：第一次调模型前；playbook：首次见到 TikTok 前）最多 3 次不计入恢复预算，CLI / MCP 可配预算；D5 运行中 report.json 为 `status: "running"` + `pid` + `updatedAt`，结束才写最终状态与 `finishedAt`；D6 `flow agent / see / playbook --json` 在没能开始运行时也输出 `{"status":"busy"\|"error","success":false,"reason"}`；D7 `--llm-timeout` / `llm_timeout_ms` | 已完成                            | `1afb71bb`、`07dfd21a`                                  |

### 7.2 真机对照（18041JECB02784，Pixel 5a，TikTok 47.5.3，Jev 与接管模型都经 magpie）

playbook：`flow playbook tiktok-shop-links --count 3 --model magpie::claude/claude-sonnet-5-5`，默认 `--launch restart`。M8：`flow agent --model magpie::claude/claude-sonnet-5-5 --launch restart --allow-package com.zhiliaoapp.musically --max-steps 40`，goal 写明「Shop → 精确搜索关键词 → 前 3 个商品 → Share → Copy link → read_clipboard」。正确性用独立脚本对每条链接 `curl` 一次，看 301 是否指向 `/view/product/<id>`、同一次运行内 ID 是否重复、链接是否出现在 `clipboardReads`。playbook 为最终代码（`07dfd21a`；`pistola massageadora` 为 `1afb71bb`，无结果路径此后未改），M8 为同一设备上 `f00b3fe5` 时的 runner（M8 主流程此后只改了标签过滤与报告字段）。

| 关键词               | 方式          | 结果                   | 耗时 s       | 步数         | Jev 调用（延迟 ms）                          | 兜底次数 / 大模型 tokens | 正确性                                                                                                     |
| -------------------- | ------------- | ---------------------- | ------------ | ------------ | -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| removedor de fiapos  | playbook ×3   | 3/3 done，各 3 条      | 66 / 65 / 64 | 16 / 15 / 15 | 20 / 19 / 19（p50 963–1003 / p90 1126–1267） | 0 / 0                    | 3/3 次全部 302 到 `/view/product/<id>`、无重复、来自剪贴板；卡位均为 左上 / 右上 / 左下；Jev 相关性 ≥ 0.85 |
| removedor de fiapos  | M8 视觉 agent | done，3 条             | 125          | 20           | —                                            | — / 104,213              | 3 条均 302 到商品、无重复、来自剪贴板                                                                      |
| pistola massageadora | playbook ×3   | 3/3 `noResults=true`   | 19 / 20 / 19 | 6 / 6 / 6    | 7 / 7 / 7（p50 793–867 / p90 1005–1128）     | 0 / 0                    | 终屏为 No results found，未触发兜底                                                                        |
| pistola massageadora | M8 视觉 agent | done，`noResults=true` | 26           | 4            | —                                            | — / 19,292               | 同上                                                                                                       |
| massageador tens     | playbook ×3   | 3/3 done，各 3 条      | 62 / 63 / 62 | 15 / 15 / 14 | 20 / 20 / 18（p50 901–1003 / p90 1156–1265） | 0 / 0                    | 3/3 次全部 302 到商品、无重复、来自剪贴板；卡位均为 左上 / 右上 / 左下；相关性 ≥ 0.93                      |
| massageador tens     | M8 视觉 agent | done，3 条             | 127          | 21           | —                                            | — / 109,507              | 3 条均 302 到商品、无重复、来自剪贴板                                                                      |
| iluminador led rgb   | playbook ×3   | 3/3 done，各 3 条      | 60 / 63 / 62 | 14 / 14 / 15 | 19 / 19 / 19（p50 978–1020 / p90 1249–1470） | 0 / 0                    | 3/3 次全部 302 到商品、无重复、来自剪贴板；卡位均为 左上 / 右上 / 左下；相关性 ≥ 0.92                      |
| iluminador led rgb   | M8 视觉 agent | done，3 条             | 126          | 22           | —                                            | — / 116,137              | 3 条均 302 到商品、无重复、来自剪贴板                                                                      |

- 有结果的关键词：playbook 平均 63 s（60–66）、0 个大模型 token；M8 平均 126 s、10.4–11.6 万 tokens。无结果：19–20 s 对 26 s。
- Jev：每次调用约 2.8k 输入 token，单次 p50 约 1.0 s、p90 约 1.2–1.5 s；一次 3 链接运行约 19 次调用、约 5 万 Jev 输入 token。Jev 时间约占运行时间的三分之一，其余是 TikTok 页面加载、点击后等待和剪贴板轮询。
- 护栏：三批共 36 次 playbook 运行（含后来修掉的 3 次）中，视觉禁用检查共执行 133 次（无标签的卡片 / 弹窗 X / 搜索框等），误拦 0 次；无越界，无前台拦截。主动对照（真机截图上用 Jev 定位后裁块判断）：领券弹窗「Claim all」0.96 / 0.99、顶栏购物车 0.98、底栏加购 0.99 均拒绝；Share 箭头 0.19、Copy link 0.03、弹窗 X 0.02 均放行；16 个真实裁块 16/16。
- 不同运行拿到的商品有差异（例如 `removedor de fiapos` 的第 3 个是 `1738207196967962568` / `1738133996644173587` 等）：TikTok 的结果排序和广告位每次加载都在变；playbook 与 M8 拿到的商品 ID 有重叠但不完全相同（如 `massageador tens` 两者都有 `1738132028816000464`、`1737660200969930116`）。

迭代过程（问题都在真机上暴露，修复后有回归单测）：

| 轮次                            | 结果                                                                            | 发现并修复                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r1–r3（调试）                   | r1 1 条后 `guardrail`、r2 1 条后 `guardrail`、r3 3 条成功（1 次接管）           | Box 置信度对正确的 Share 图标只有 0.42–0.59、卡片 0.19–0.35 → 按预期区域 / 尺寸放宽到 0.15；写剪贴板哨兵会弹出 Android 剪贴板预览、挡住 Copy link 并抢焦点（`com.android.systemui`）→ 只读不写、等待 / BACK 关掉该浮层；分享面板滑入期间再点 Share 会关掉它 → 等待；商品页右下的悬浮小视频窗被当成弹窗 → 弹窗 X 必须是 X 大小 |
| 第 1 批（12 次）                | 10 done，`iluminador led rgb` 2 次崩溃（`reading 'noul'`），重跑 3/3；接管 1 次 | 卡片点了没打开时，在只含商品页问题的观测上选卡 → 改为下一次观测选；短链解析一路跟到 `/login` → 停在 `/product/<id>`；右列 Box 常为整行宽 → 镜像左卡                                                                                                                                                                           |
| 第 2 批（12 次，D2 新选卡规则） | 12/12 done，接管 1 次                                                           | 复制后剪贴板预览盖住左下卡价格，4/12 次第 3 条取成右下 → 每屏记住出现过价格的位置，按网格顺序取第一个未打开的                                                                                                                                                                                                                 |
| 第 3 批（9 次，最终代码）       | 9/9 done，0 接管，0 大模型 token                                                | —                                                                                                                                                                                                                                                                                                                             |

### 7.3 待修 / 已知限制

| #   | 问题                                                                                                                                                                                                                    | 备注                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| J1  | ~~magpie 不转发 `TypeSafe-Danger-Zone-Images`，带图请求 400~~ **已解决**：magpie 的 `vercel-jev` provider 已配置转发该头；本轮所有带图 / Box 请求都走 magpie。`JEV_IMAGES_BLOCKED` 识别和可选回落端点保留（默认不启用） | 若换网关再遇到 400，配 `FLOW_JEV_FALLBACK_BASE_URL` + `FLOW_JEV_FALLBACK_API_KEY`                          |
| J2  | Jev 的图片与 Box 官方标注为 dreamer-ready（原型级，非生产级），请求格式、答案和精度可能随版本变化。本轮 TikTok 上正确的 Box 置信度经常只有 0.2–0.6，靠「预期区域 + 尺寸」和右列镜像兜住                                 | 换 TikTok 版本 / 机型（尤其非 1080×2400 竖屏）时要重看 `TIKTOK_BOX_REGIONS` 和阈值；`--box-threshold` 可调 |
| J3  | 选卡只看当前屏的 2×2 四个位置；滚动后按「底行移到页眉下」估算距离，没有跨屏核对同一张卡（靠商品 ID 去重兜底）                                                                                                           | 3 条链接通常不需要滚动；`--count` 大时会多一些重复打开                                                     |
| J4  | 剪贴板预览浮层（Android 13+）会挡住屏幕左下角几秒；playbook 已规避，M8 仍可能受影响                                                                                                                                     | 已写进 AGENTS.md Gotchas                                                                                   |
| J5  | 已在 18041 / 47.5.3 和 16091 / 46.5.3（tk-shop-erp 复测 + §7.5）上验证；没测并发多设备、其他市场 / 语言界面                                                                                                             | 题目都是英文界面描述；葡语界面的页面名 Choice 需重测                                                       |
| J6  | playbook 的 `relevant` 只是商品页与关键词同类的 Noul（记录，不拦截）；「同款」判定不在本轮范围                                                                                                                          | —                                                                                                          |
| J7  | 搜索词进入 TikTok 搜索历史（同 V6）；playbook 总是清空输入框后重新输入，不点历史建议                                                                                                                                    | 只读范围内可接受                                                                                           |
| —   | M8 待修项变化：V1 由 Jev 视觉检查补上（playbook 默认开启，M8 需 `--jev`）；V2 对这类固定任务由 playbook 解决（约 2× 快、无大模型 token）；V3 playbook 结果里有 `productId` 和 `finalUrl`，M8 仍返回短链                 | D1–D7 处理见 §7.1 最后一行；D8 / D9 未改（同 V6 / llm.json 644 警告）                                      |

### 7.4 验证基线（2026-11-02，本分支 `07dfd21a`；最新见 §7.5.4）

| 包          | typecheck | test                                                                                                                                                                                                                                                                                                                                                                        | eslint |
| ----------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                                                                                                                                                                                                                   | 通过   |
| flow-core   | 通过      | 125 / 125（+30：Jev 客户端 11 项含 `JEV_IMAGES_BLOCKED` 回落 / 超时重试 / 尺寸 / key 脱敏 / 配置解析；playbook 14 项含正常完成 / 低置信度接管 / 接管失败 / No results / LIVE 卡跳过 / 重复商品去重 / 越界前台拦截 / 视觉禁用检查拦截 / 右列镜像 / 卡片未打开 / 剪贴板浮层 / 冷启动回弹 / 短链停在商品页；M8 Jev 辅助 3 项；`@` 标签与购物车、冷启动与 running 报告各 1 项） | 通过   |
| flow-mcp    | 通过      | 26 / 26（+1：`visual_locate` / `visual_check`）                                                                                                                                                                                                                                                                                                                             | 通过   |
| flow-cli    | 通过      | 26 / 26（+2：see / playbook / agent --jev 参数，`--json` 出错时输出 JSON）                                                                                                                                                                                                                                                                                                  | 通过   |

命令同 §6.4：`pnpm --filter "@escrcpy/flow-*" build && pnpm --filter "@escrcpy/flow-*" typecheck`，各包 `pnpm test`，`npx eslint packages/flow-* research`。

### 7.5 tk-shop-erp 复测缺陷修复（16091 / TikTok 46.5.3，2026-11-02）

tk-shop-erp 在 16091JECB01791（46.5.3）上独立复测 M9：24 次 + 5 次故障注入，42/42 链接正确，但发现两个流程缺陷（其笔记 07 §4–§6 的 P1 / P2）。修复在 `1b22dc73`、`27a169b2`。

#### 7.5.1 修复

| 缺陷                                          | 原因                                                                                                                                                                                                                                            | 修复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 `DetailActivity` 半屏商品页的 Share 走兜底 | 46.5.3 上带视频缩略图的商品卡打开「视频 + 商品半屏」，Share 在半屏右上（≈0.71, 0.30），紧挨购物车（≈0.825）。Jev 其实框对了，但不在 PDP 顶栏预期区域，两次 miss 后交给视觉 agent（每次 +11–22 s、约 1 万 token；兜底 agent 还试图点购物车一次） | 半屏作为独立页面变体：Jev `product_sheet` Noul ≥ 0.85，或前台为 `DetailActivity` 且（`product_sheet` ≥ 0.25 或半屏图标框落在半屏区域）。47.5.3 的 `DetailActivity` 是全屏商品页，不会被判成半屏，仍走原来的 PDP 顶栏规则（未放宽）。半屏有自己的 Box 问题（`sheet_share_icon` / `sheet_cart_icon`）和区域；候选点从左到右：Share 框中心（落在购物车上的丢弃），再是「购物车往左一个图标」。每个候选点击前**必须**过视觉检查，同一裁块同一请求里再问「红圈里是不是 Share 箭头」（< 0.5 不点）；被判为禁用控件（购物车）的点，再试它左边一个图标。80 张真机截图标定：半屏 Share 处「是 Share」0.82–0.96、风险 ≤ 0.20；两图标间空隙风险 0.59–0.88；购物车风险 0.97。链接仍按本次新复制、解析出的商品 ID 绑定，与半屏标题截断无关 |
| P2 强停恢复后在首页连按 BACK                  | TikTok 被强停后冷启动到 For You 首页，代码沿用恢复前的步骤目标，把首页当成「卡片打开了视频」，连按 3 次 BACK；兜底再按 1 次后失败，才回落到重新搜索（每次 +50–90 s；如果 BACK 退到桌面就会第二次离开 App → `guardrail`）                        | 运行时记录重新拉起次数；每次重新拉起后（以及任何时候看到首页）按页面重新定位：首页 / Shop → 重新进入搜索、搜索页 → 输入、结果页 → 选卡、商品页 → 复制。首页 = 前台 `SplashActivity`（主信号）或 Jev `home_feed` ≥ 0.85；首页上一律不按 BACK，每次 BACK 前再查一次实时前台（必须是 TikTok，且没有刚切到首页 Activity）。「卡片打开了视频 / LIVE」只在上一动作是点卡片时按 1 次 BACK。重新搜索后已拿到的商品按 ID 去重保留；结果新增 `searchEpochs`、`researched`、`items[].searchEpoch`（半屏商品另有 `items[].sheet: true`），调用方能看出「前 3 张」跨了两次搜索                                                                                                                                                             |
| 附带：冷启动黑屏走兜底                        | 冷启动头几秒是黑屏（只有状态栏），页面判断为 `other`，第 2 次 miss 交给兜底（本轮 1 次、2.7 万 token；tk-shop-erp 第 2 遍 `pistola` 同样一次）                                                                                                  | Jev `loading` Noul ≥ 0.85 时等待（最多 4 次），不算 miss                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

#### 7.5.2 真机前后对照（16091，TikTok 46.5.3）

「修复前」为 tk-shop-erp 的复测证据（`case-evidence/jev-playbook`），「修复后」为本轮。半屏访问数按「点卡片后的下一屏是 `DetailActivity` 商品页」统计；正确性由独立脚本对每条链接 `curl`，核对 301 指向的商品 ID 与 playbook 返回一致、无重复、来自剪贴板。

| 场景                       | 修复前                                                                                                                                   | 修复后                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有结果的关键词运行（合计） | 14 次：半屏访问 7 次，其中 5 次走兜底（tk-shop-erp 统计含故障批次：59 次点卡 11 次进半屏、9 次兜底）；共 5 次兜底、5.5 万 token；59–89 s | 11 次（3 个关键词各 3 + 确认轮 2）：半屏访问 7 次，**0 次兜底**；唯一 1 次兜底是 k1-2 的冷启动黑屏（修复前代码，2.7 万 token，已由 `27a169b2` 修掉，确认轮 0 次）；62–74 s（含兜底那次 102 s）；33/33 链接正确                                                    |
| `massageador tens`         | 2 次：72 / 79 s，1 次兜底                                                                                                                | 3 次：70 / 71 / 102 s（102 s 为冷启动黑屏兜底）+ 确认轮 68 / 71 s；半屏 5 次 0 兜底；k1-3 有一个半屏候选被判「不是 Share」（0.19），改选下一个点（0.92），未兜底                                                                                                  |
| `cordao luzes LED`         | 2 次：65 / 89 s，1 次兜底（兜底 agent 试图点购物车，被视觉检查 p=0.97 拦下）                                                             | 3 次：65 / 68 / 74 s，0 兜底                                                                                                                                                                                                                                      |
| `massageador digital`      | 2 次：62 / 65 s                                                                                                                          | 3 次：62 / 63 / 63 s                                                                                                                                                                                                                                              |
| 强停注入                   | 2 次（PDP 点 Share 后、点卡片后）：158 / 119 s，首页 BACK 各 3 次，兜底 2 次（1 次失败）+ 1 次                                           | 5 次（点 Share 后 ×2、点卡片后 ×3，含确认轮 1 次）：92 / 98 / 102 / 103 / 107 s，**首页 BACK 0、兜底 0**；恢复后直接「re-locate to reach_search」重新搜索，结果均 `researched: true`、`searchEpochs: 2`；15/15 链接正确，重搜后再次遇到的商品按 ID 记为 duplicate |

- 强停额外耗时：无故障运行约 62–74 s，强停运行 92–107 s，即约 +25–40 s，主要是重新进 Shop → 搜索 → 等网格（不可省）；修复前为 +50–90 s。
- 18041（47.5.3）回归：`removedor de fiapos` 72 / 71 / 63 s、`pistola massageadora` 22 / 23 / 19 s（无结果），全部 0 兜底、0 首页 BACK、链接正确。前两次 `removedor` 比 §7.2 多 6–7 s：那一轮网格多等了一次、跳过了 LIVE 卡、多一张卡进 `DetailActivity` 视频页（多 1 次 BACK）；每步耗时与 §7.2 相同。
- 有几次运行跳过了某张前排卡（`cordao luzes LED` k2-1 与 `massageador digital` k3-2 跳左上、18041 `removedor` r1-1 跳右上）：截图核实都是带红色 LIVE 角标的卡，按 D2 规则排除。
- 视觉检查在半屏上照常执行；本轮无误拦。tk-shop-erp 的 P5（M8 `--jev` 不改变规划行为）、P6 / P7（剪贴板被关键词覆盖、长链带账号参数）未改，仍是调用方注意事项。

#### 7.5.3 待修 / 已知限制

| #   | 问题                                                                                                      | 备注                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| J8  | 半屏 Share 的候选点之一是「购物车往左 0.11 屏宽」（Pixel 5a 实测图标间距）；不同屏宽 / 字体缩放下间距会变 | 每个候选都要过「是不是 Share 箭头」+ 禁用检查，错了只多一次 Jev 调用，不会误点；换机型时重测 `SHEET_ICON_SPACING` |
| J9  | 首页判断主要靠 Activity 名（`SplashActivity`），Jev `home_feed` 是备用（18041 上有 3/8 只有 0.23–0.40）   | TikTok 改 Activity 名时要更新 `HOME_ACTIVITY_RE`；BACK 前的实时前台复查兜底                                       |
| J10 | 强停后不再是「同一次网格的前 3 张」：重搜后排序会变                                                       | 结果里 `researched` / `items[].searchEpoch` 标明；要求严格位置的调用方应丢弃 `researched: true` 的结果重跑        |

#### 7.5.4 验证基线（2026-11-02，本分支 `27a169b2`；最新见 §7.6.5）

| 包          | typecheck | test                                                                                                                                                                      | eslint |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                 | 通过   |
| flow-core   | 通过      | 131 / 131（+6：半屏 Share 正常点击、半屏框落在购物车被拦后改选左侧、PDP 点 Share 后强停 → 首页直接重搜无 BACK、点卡后强停同上、视频卡只 BACK 一次、冷启动黑屏等待不兜底） | 通过   |
| flow-mcp    | 通过      | 26 / 26                                                                                                                                                                   | 通过   |
| flow-cli    | 通过      | 26 / 26                                                                                                                                                                   | 通过   |

### 7.6 未解析出商品 ID 的链接不再计数（2026-11-03，`25c4e97a`）

tk-shop-erp 复测 7.5 的修复时（两项都通过：16091 0/16 兜底、5 次强停后首页 BACK 0），在 18041 / `removedor de fiapos` 上发现：一条短链 `store()` 里两次解析都没拿到 `/product/<id>`，代码仍把它存为第 1 条（没有 `productId`，去重 key 退回短链），最终 `links` 3 条、`productIds` 2 个、`done`。51 条链接里出现 1 次；事后不带 cookie 的 GET 能正常 301 到商品页。

#### 7.6.1 原因调查

- 该步骤从开始到下一步只有约 5.5 s（含剪贴板轮询和 BACK），两次解析都是「很快失败」，不是 8 s 超时。
- 用同一条短链、与 playbook 相同的 UA 复现：

| 方式                                                                | 失败                                   |
| ------------------------------------------------------------------- | -------------------------------------- |
| Node `fetch`（undici 连接池）同进程顺序 30 次 / 10 次               | 7 / 3 次，全部 `ECONNRESET`，0.1–0.4 s |
| Node `fetch` 并发 4，30 次                                          | 8 次 `ECONNRESET`                      |
| Node `fetch` 每次新进程（第一个请求）                               | 0 / 15                                 |
| `curl` 30 次                                                        | 0 / 30                                 |
| `node:https` 不用连接池（`agent: false`）连续 30 次 / 间隔 5 s 8 次 | 1 / 30、0 / 8                          |
| Node `fetch` 间隔 5 s 8 次                                          | 2 / 8                                  |

- 判断：TikTok 短链域名（`vt.tiktok.com` → Akamai 边缘）会重置部分 Node 客户端的连接；复用 keep-alive 连接或请求成串时明显更多（约 1/4），新连接也偶发（约 1/30）。失败是瞬时的、重试即可。原事件发生时 16091 与 18041 两台在同一出口并发解析，符合「成串请求」的情形。不是超时、不是 429 / 5xx、不是 DNS（解析到真实 Akamai 地址）。

#### 7.6.2 修复

- **解析器**（`playbooks/link-resolver.ts`，`resolveLinkDetailed`）：每一跳用新连接（`node:https`，`agent: false`，不进连接池）；超时、网络错误、429、5xx 最多重试 3 次（退避 0.5 / 1 / 2 s），总时长上限 20 s 且不超过本次运行剩余预算；一旦出现 `/product/<id>` 立即返回；200 / 其他 4xx 不重试。`resolveRedirects` 保留为兼容封装。
- **诊断**：每次解析在该步写一条 `resolve_link`：`{link, ok, attempts, ms, to, reason, hops[{attempt, url, status | error(timeout/network/status), code, ms, to}]}`；所有 URL 只保留 origin + path（商品长链的查询参数里有 `user_id`、`device_id`）。
- **不计数**：解析后仍没有商品 ID 的链接不进 `items`、不算进 `count`、不进去重集合，放入 `result.unresolved: [{link, position, searchEpoch, reason}]`，回到结果页取下一张合格卡片；凑不够时按原有「卡片用完 / 预算用完」规则以 `failed` / `budget_exhausted` 结束，`success: false`、退出码 1，不会 `done`。同一商品之后解析成功照常按 ID 去重。
- **不变量**：`items[]` 每项都有 `productId` 和 `finalUrl`（`https://www.tiktok.com/view/product/<id>`，且其中的 ID 等于 `productId`）；`links` / `productIds` 都由 `items` 逐项生成，长度相等、下标对应。构造结果时 `assertItemsResolved` 断言。
- 选卡、半屏、强停恢复、护栏未改。

用新解析器对 3 条真实短链做 60 次成串解析（顺序 30 + 并发 4 × 30）：60/60 成功，3 次首跳 `ECONNRESET` 均在第 2 次尝试恢复，最长 1.9 s。

#### 7.6.3 真机回归（16091 与 18041 同时运行）

| 设备           | 关键词                 | 结果                   | 耗时 s   | 兜底  | 解析（次数 / 耗时）           |
| -------------- | ---------------------- | ---------------------- | -------- | ----- | ----------------------------- |
| 18041 / 47.5.3 | removedor de fiapos ×2 | done，各 3 条          | 60 / 65  | 0 / 0 | 6 次全部首次成功，250–1598 ms |
| 18041 / 47.5.3 | pistola massageadora   | done，`noResults=true` | 22       | 0     | —                             |
| 16091 / 46.5.3 | cordao luzes LED ×2    | done，各 3 条          | 71 / 135 | 0 / 1 | 6 次全部首次成功，255–304 ms  |
| 16091 / 46.5.3 | removedor de fiapos    | done，3 条             | 68       | 0     | 3 次首次成功，251–481 ms      |

- 15 条链接经独立 `curl` 核对，商品 ID 与 `productIds` 一一对应、无重复；所有结果满足上面的不变量；`unresolved` 均为空（本轮真机没有遇到解析失败）。
- `cordao luzes LED` 第 2 次的兜底与本修复无关：滚动后右上卡实为 LIVE 卡但没被识别为 LIVE，点开进了直播间，又弹出无 X 的政策提示，BACK 关不掉 → 兜底 5 步（点了政策弹窗的「Got it」——实际是替账号确认通知，不是只读动作，见 §7.7——以及关闭商品卡）、2.4 万 token，之后回到结果页继续。记为 J12。

#### 7.6.4 待修 / 已知限制

| #   | 问题                                                                                                           | 备注                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| J11 | 短链解析依赖公网访问 `vt.tiktok.com`；连续 4 次失败（或 20 s 内没拿到）时该链接进 `unresolved`，会多打开一张卡 | 原因见 7.6.1；`unresolved[].reason` 与 report 里的 `resolve_link.hops` 可查 |
| J12 | ~~滚动后的卡片 LIVE 角标偶尔漏判，点开进直播间；直播间的无 X 弹窗要靠兜底关闭~~ 护栏已补，见 §7.7              | —                                                                           |

#### 7.6.5 验证基线（2026-11-03，本分支 `25c4e97a`）；最新见 §7.7.6

| 包          | typecheck | test                                                                                                                                                                                                                                                     | eslint |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                                                                                                | 通过   |
| flow-core   | 通过      | 138 / 138（+7：解析器重试超时 / 429 / 重置 / 5xx 与退避、URL 去查询参数、200 不重试、总时长上限；首次超时第二次成功计数；三次都失败进 `unresolved` 并取下一张后 done；全部失败直到卡片用完为非 success；失败过的商品后来解析成功按 ID 去重；不变量断言） | 通过   |
| flow-mcp    | 通过      | 26 / 26                                                                                                                                                                                                                                                  | 通过   |
| flow-cli    | 通过      | 26 / 26                                                                                                                                                                                                                                                  | 通过   |

### 7.7 J12 护栏：直播间直接退出，同意类弹窗不许点（2026-11-03，`a5cfd906`、`3788d699`）

7.6 回归里 `cordao luzes LED` 第 2 次误进直播间，直播间弹出无 X 的「Virtual Items and Rewards Policies update」（正文「By continuing to use TikTok after that date, you agree to these policies」），兜底 agent 点了「Got it」——等于替账号确认了政策通知。「Got it」不在禁用词里、又有标签，所以没走视觉检查。项目规则：接受条款 / 协议 / 同意类动作必须由人确认。

#### 7.7.1 新护栏与触发条件

| 护栏                           | 触发                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 动作                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直播间直接退出（playbook）     | Jev 页面为 `live_room`，或前台 `LivePlayActivity`                                                                                                                                                                                                                                                                                                                                                                                                                      | 不交给兜底、不关弹窗、**不点任何东西**；画面仍是黑屏加载帧（`loading` ≥ 0.85）时先等最多 2 帧（加载中按的 BACK 会被吞掉）；然后 BACK 一次，下一次观测仍在直播间就 force-stop + 重启，走已有「relaunch → 按页面重新定位 → 重搜」。该卡在本 searchEpoch 标为 LIVE 并跳过；一次运行第 3 次进直播间以 `failed` 结束。结果新增 `liveRoomEntries` |
| 同意类弹窗识别（`consent.ts`） | UI 树可见文字：强短语（agree、continuing to use、consent、ao continuar、al continuar、concordo、aceito、acepto、同意、继续使用即 等）单独即命中；弱词（policy / policies / terms / privacy / política / termos / privacidade / términos / 条款 / 政策 / 隐私 / 协议）需与确认按钮（Got it、OK、Continue、Entendi、知道了、确定 等）同屏。或 Jev `consent_dialog` Noul > 0.5（playbook 每次观测同一请求里问；兜底 / `flow agent --jev` 每次触碰前 UI 树判不出时问一次） | 弹窗在屏时拒绝**所有**点击（按钮、弹窗外暗区）、滑动和 ENTER；只由代码执行 BACK，再 force-stop + 重启一次；重启后仍在 → `failed`，`reason: consent_dialog_needs_human`，结果与 report 里记录那一帧截图文件名。兜底 agent：UI 树命中时不问模型直接结束；触碰前命中也以 `consent_dialog_needs_human` 结束，被拒后没有机会换方式点             |
| 明确同意词进默认禁用词         | Agree、I agree、Accept、Accept all、Concordo、Aceito、Aceitar、Acepto、Aceptar、同意、接受、我同意                                                                                                                                                                                                                                                                                                                                                                     | 任意页面、任意路径都拒绝                                                                                                                                                                                                                                                                                                                    |
| 提示词                         | M8 系统提示与兜底 goal                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 保留「用 X 或 back 关闭弹窗」，加一句：条款 / 政策 / 隐私 / 同意类弹窗不要处理，直接 `fail`                                                                                                                                                                                                                                                 |

选卡、半屏、强停恢复、短链解析、unresolved 规则、其他护栏未改；普通领券弹窗的 X 照常点击（原有单测仍通过）。

#### 7.7.2 离线截图的 Jev `consent_dialog` 概率（经 magpie，每张 3 次）

| 截图                                                                            | 内容                                         | 概率                   |
| ------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| `jevres/runs/16091/b2/takeover-1/step-003.jpg`                                  | 直播间政策弹窗（Got it）                     | 1 / 1 / 1              |
| 同一事件的其他 6 帧（`takeover-1/step-001/002`、`b2/step-014…017`）             | 同一政策弹窗                                 | 0.99–1                 |
| `jev/img/live.jpg`                                                              | tk-shop-erp 基准里的「直播间 Got it 对话框」 | 1 / 1 / 1              |
| `jev/img/popup.jpg`、`jevruns/r2/step-006.jpg`                                  | 领券弹窗（Claim all + X）                    | 0.01–0.02              |
| `jev/img/share.jpg`                                                             | 分享面板                                     | 0.01                   |
| `takeover-1/step-004.jpg`                                                       | 政策弹窗关闭后的直播间                       | 0.02                   |
| 43 张普通页面（PDP、半屏、视频、首页、Shop 首页、搜索、结果页、无结果、Shopee） | —                                            | 最高 0.08（Shop 首页） |

- 基准里那张「直播间 Got it」核对截图后就是同一份「Virtual Items and Rewards Policies update」政策通知，不是互动提示，所以 1.0 是正确的。本轮没有拿到真正的直播互动类「Got it」提示做对照；按偏保守处理：即使误判为同意类，后果也只是拒绝点击、playbook 退出直播间。

#### 7.7.3 真机（16091 / 46.5.3、18041 / 47.5.3）

回归（默认 CLI，无测试开关）：

| 设备  | 关键词                                                      | 结果             | 耗时 s       | 兜底 |
| ----- | ----------------------------------------------------------- | ---------------- | ------------ | ---- |
| 16091 | cordao luzes LED / massageador tens / removedor de fiapos   | done，各 3 条    | 65 / 61 / 65 | 0    |
| 16091 | pistola massageadora                                        | `noResults=true` | 23           | 0    |
| 18041 | iluminador led rgb / massageador tens / removedor de fiapos | done，各 3 条    | 63 / 60 / 66 | 0    |
| 18041 | pistola massageadora                                        | `noResults=true` | 21           | 0    |

直播间退出验证：用仓库外的测试脚本（`/tmp/jevconsent/live-test.mjs`，包一层 Jev 客户端，把首屏第一张 LIVE 卡的 LIVE 答案改成否，只一次），让 playbook 点进直播间；这个开关不在仓库代码和 CLI 里。

| 运行                                     | 结果                           | 耗时 s | 直播间内动作                     | 直播间内点击 |
| ---------------------------------------- | ------------------------------ | ------ | -------------------------------- | ------------ |
| 16091 cordao luzes LED                   | done，3 条，`researched: true` | 115    | BACK → 仍在 → 重启               | 0            |
| 16091 cordao luzes LED（加「等加载」后） | done，3 条                     | 128    | 等加载 1 帧 → BACK → 仍在 → 重启 | 0            |
| 18041 iluminador led rgb                 | done，3 条                     | 95     | BACK → 仍在 → 重启               | 0            |
| 18041 removedor de fiapos                | done，3 条                     | 98     | BACK → 仍在 → 重启               | 0            |
| 16091 iluminador led rgb                 | 首屏没有 LIVE 卡，未进直播间   | 71     | —                                | —            |

- 4 次进直播间都是 0 点击、0 兜底；4 次 BACK 都没离开直播间（截图里没有弹窗，只是 TikTok 直播间第一次 BACK 不退出），都靠重启 + 重搜完成，额外约 30–60 s。本轮没碰到同意类弹窗（账号已确认过），该路径靠离线截图和单测。
- 真机上 `consent_dialog` 在全部观测里最高 0.02 量级（直播间帧 0.01–0.02），没有误拦普通流程。

#### 7.7.4 J12 根因

滚动后，被页眉截断的上一行卡片的答案（价格 / LIVE）与从下一行镜像来的点击框配对错位，点到了相邻的 LIVE 卡。修它要改选卡 / 镜像逻辑，本轮按要求不动；改为保证误进直播间时安全退出（上表），并在本次搜索里把该位置记为 LIVE。

#### 7.7.5 待修 / 已知限制

| #   | 问题                                                                                                           | 备注                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| J12 | ~~误进直播间要靠兜底关弹窗，兜底点了政策弹窗的 Got it~~ **已修**（7.7.1）；滚动后的 LIVE 漏判本身未修（7.7.4） | 误进一次约 +30–60 s；一次运行第 3 次即 `failed`         |
| J13 | 直播间里 BACK 在本轮 4/4 次都没离开，实际总是走重启                                                            | 可考虑直接重启省一次观测；行为正确，只是慢              |
| J14 | 同意类弹窗的 Jev 识别只在离线截图上标定过（真机账号已确认，复现不了）；关键词表覆盖 en / pt / es / zh          | 真遇到时 `consent_dialog_needs_human`，需人工处理后重跑 |

#### 7.7.6 验证基线（2026-11-03，本分支 `3788d699`）；最新见 §7.8.4

| 包          | typecheck | test                                                                                                                                                                                                                                                                                                                                                                                                                                   | eslint |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                                                                                                                                                                                                                                                                              | 通过   |
| flow-core   | 通过      | 149 / 149（+11：点卡进直播间 → BACK 离开、不点、取下一张；直播间加载中先等再 BACK；BACK 无效 → 重启重搜；第 3 次进直播间 → failed；UI 树命中同意类弹窗时连 X 都不点、BACK 关掉后继续；仅 Jev 命中且重启后仍在 → `consent_dialog_needs_human`；运行时在同意弹窗下拒绝所有点击和滑动；兜底 agent：UI 树命中不问模型直接结束、仅 Jev 命中时拒绝暗区点击并结束、系统提示含同意类弹窗规则；明确同意词任意页面拒绝、同意弹窗与普通页面区分） | 通过   |
| flow-mcp    | 通过      | 26 / 26                                                                                                                                                                                                                                                                                                                                                                                                                                | 通过   |
| flow-cli    | 通过      | 26 / 26                                                                                                                                                                                                                                                                                                                                                                                                                                | 通过   |

### 7.8 坐标规则 B：UI 树优先 + 标签一致检查（2026-11-03，`de27707b`、`67fdff38`）

tk-shop-erp 定了 Jev 坐标规则（`jev-mobile-decision-loop.md`「点击坐标的来源」），并统计了 76 次 playbook 真机运行、644 次 Jev Box 点击：唯一一次点错是 `18041-07-massageador-digital` 第 1 步，冷启动 Shop 页签 box 0.35 靠区域放行，落点 UI 树标签是 `Following`；原来的 `checkTapTarget` 只拦禁用词，所以照点了。

#### 7.8.1 规则与实现

- 坐标来自本次观测（同一截图），只用一次（原本如此）。
- **UI 树优先**（`playbooks/tree-target.ts` `findTreeTarget`）：对有期望标签的目标，在本次观测的 UI 树里找自身 text / content-desc 匹配期望标签（大小写不敏感、整词）、边界非零、中心落在该目标 `TIKTOK_BOX_REGIONS` 区域里的元素。元素可点且不是极小（< 0.04% 屏幕）就用它的中心，否则用按钮大小（≤ 3% 屏幕）的最近可点祖先的中心；解析到同一控件、或边界互相包含对方中心的元素算一个（18041 的 PDP 顶栏同一个图标上有 `Share` 和 `share` 两个元素）。**恰好一个**控件 → 用它（`coordSource: 'tree'`）；零个或多个 → Jev Box（`'jev_box'`）。半屏 Share 只用 `sheet_share_icon` 区域（视频右侧栏的 Share 在区域外）；弹窗 X 没有固定位置，元素须在 Jev 框中心 ±0.1 内。
- **期望标签**（`TIKTOK_EXPECTED_LABELS`）：Shop 页签 `Shop` / `Loja` / `Tienda`；Share 与半屏 Share `Share` / `Compartilhar` / `Compartir`；复制链接 `Copy link` / `Copiar link` / `Copiar enlace`；弹窗 X `Close` / `Fechar` / `Cerrar` / `Dismiss`。商品卡（结果网格不在 UI 树里）、Shop 搜索框（轮换的推荐搜索词）、Search 按钮不检查。
- **标签一致检查**（运行时 `tap` 的 `expectLabels`）：落点 `checkTapTarget` 的 `labels` 非空且没有一个匹配期望标签 → 不点，action 记 `blocked: 'label mismatch: …'`，计入 `labelMismatchBlocks` 和 `guardrailBlocks`。落点无标签或没有 UI 树时行为不变（视觉风险检查等）。Shop 页签被拒走 miss 路径（同一目标连续 2 次 → 接管；接管关闭时以 `failed` 结束），Share / 复制链接 / 弹窗 X 原本就会落到 miss / BACK，不会死循环。
- 每次点击记录 `coordSource`：`tree` / `jev_box` / `jev_box_mirrored`（右列镜像卡）/ `derived`（半屏由购物车推算的点）；结果和 report 汇总新增 `coordSources`（实际执行的点击按来源计数）和 `labelMismatchBlocks`。
- 其他护栏不管坐标从哪来都照常：前台、禁用词、同意弹窗、半屏 Share 的视觉确认（`SHEET_SHARE_CONFIRM`）。Jev 问题集未改，Box 照常问。选卡、半屏识别、强停恢复、短链解析、unresolved、同意 / 直播间护栏未改。

#### 7.8.2 真机回归（每次运行前默认 `--launch restart` 强停重启；标 * 的另在运行前手动 `am force-stop`）

| 设备           | 运行 | 关键词                            | 结果             | 耗时 s | 兜底 | coordSources（tree / jev_box / mirrored / derived） | labelMismatchBlocks |
| -------------- | ---- | --------------------------------- | ---------------- | ------ | ---- | --------------------------------------------------- | ------------------- |
| 16091 / 46.5.3 | c1*  | cordao luzes LED                  | done，3 条       | 71     | 0    | 7 / 3 / 2 / 0                                       | 0                   |
| 16091          | c2*  | massageador tens                  | done，3 条       | 71     | 0    | 7 / 3 / 1 / 0                                       | 0                   |
| 16091          | c3   | removedor de fiapos               | done，3 条       | 64     | 0    | 6 / 4 / 1 / 0                                       | 0                   |
| 16091          | c4   | pistola massageadora              | `noResults=true` | 24     | 0    | 0 / 2 / 0 / 0                                       | 0                   |
| 18041 / 47.5.3 | c1*  | massageador digital               | done，3 条       | 64     | 0    | 4 / 7 / 0 / 0                                       | 0                   |
| 18041          | c2*  | removedor de fiapos               | done，3 条       | 66     | 0    | 7 / 3 / 1 / 0                                       | 0                   |
| 18041          | c3   | iluminador led rgb                | done，3 条       | 62     | 0    | 5 / 6 / 1 / 0                                       | 0                   |
| 18041          | c4   | pistola massageadora              | `noResults=true` | 21     | 0    | 1 / 1 / 0 / 0                                       | 0                   |
| 18041          | c5*  | massageador digital（`67fdff38`） | done，3 条       | 63     | 0    | 7 / 4 / 0 / 0                                       | 0                   |
| 18041          | c6   | iluminador led rgb（`67fdff38`）  | done，3 条       | 62     | 0    | 7 / 3 / 1 / 0                                       | 0                   |

- c1–c4 用 `de27707b`，c5–c6 用 `67fdff38`。10 次全部 0 兜底、0 大模型 token；有结果 62–71 s、无结果 21–24 s；24 条链接经独立 `curl` 都解析出商品 ID 且与 `productIds` 一致，`unresolved` 全空。16091 c1 的 71 s 里含一次 Shop 搜索框第一次点击没打开搜索页、又点了一次（与本改动无关，搜索框不做标签检查）。
- 按目标的坐标来源（10 次合计，实际执行的点击）：

| 目标                 | tree              | jev_box                                                                                      | jev_box_mirrored |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| Shop 页签            | 8                 | 2（16091 冷启动 UI 树 2 s 超时，走视觉风险检查）                                             | —                |
| PDP Share            | 15                | 5（`de27707b` 时 18041 PDP 顶栏同图标两个元素被当成 2 个候选；`67fdff38` 后 6/6 来自 UI 树） | —                |
| 半屏 Share           | 4（仍做视觉确认） | 0                                                                                            | —                |
| 复制链接             | 24                | 0                                                                                            | —                |
| 弹窗 X               | 0                 | 1（无标签）                                                                                  | —                |
| Shop 搜索框 / 商品卡 | —                 | 11 / 17                                                                                      | 7                |

- 合计 tree 51、jev_box 36、jev_box_mirrored 7、derived 0。
- **标签检查在真机上没有触发过**（`labelMismatchBlocks` 全为 0）：Shop 页签有 UI 树时 8/8 直接用 `Shop` 元素，没再出现靠 Box 落到 `Following` 的情况；那次点错的场景由单测覆盖（Box 落在 `Following` → 拒绝 → 下次观测点对）。

#### 7.8.3 待修 / 已知限制

| #   | 问题                                                                                                              | 备注                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| J15 | 冷启动时 UI 树经常 2 s 超时（16091 本轮 2/4 次首步），这时 Shop 页签仍靠 Jev Box + 视觉风险检查，标签检查无从做起 | 与规则一致（无元素时用 Box）；tk-shop-erp 统计里 45/83 次 Shop 页签点击属于这种 |
| J16 | 期望标签只覆盖 en / pt / es；界面语言换成别的语言时，有标签的落点会被判不一致而拒绝（偏保守，走 miss / 接管）     | 新语言要在 `TIKTOK_EXPECTED_LABELS` 补词                                        |
| J17 | 「同一控件」按边界互相包含中心来合并；两个真正不同、但重叠的同名控件会被当成一个                                  | 区域约束 + 标签检查 + 其他护栏仍在；本轮没见到                                  |

#### 7.8.4 验证基线（2026-11-03，本分支 `67fdff38`）；最新见 §7.9.4

| 包          | typecheck | test                                                                                                                                                                                                                                                                                                                                      | eslint |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                                                                                                                                                                                 | 通过   |
| flow-core   | 通过      | 158 / 158（+9：Shop 页签 Box 落在 `Following` → 拒绝、下次观测点对；有 `Shop` 元素时用元素中心（Box 偏了也点对）；无 UI 树仍用 Box；半屏同时有右侧栏和半屏 `Share` 只选半屏的且仍做视觉确认；两个不同的同名元素回退 Box；复制链接用元素中心；商品卡与搜索框不做标签检查；同一目标连续被拒走 miss 不死循环；元素查找与标签匹配的单元用例） | 通过   |
| flow-mcp    | 通过      | 26 / 26                                                                                                                                                                                                                                                                                                                                   | 通过   |
| flow-cli    | 通过      | 26 / 26                                                                                                                                                                                                                                                                                                                                   | 通过   |

命令：`pnpm --filter "@escrcpy/flow-*" build && pnpm --filter "@escrcpy/flow-*" typecheck`，各包 `pnpm test`，仓库根目录 `npx eslint packages/flow-device packages/flow-core packages/flow-mcp packages/flow-cli research`。证据：`/tmp/jevcoord/runs/`、`/tmp/jevcoord/runs2/`（各运行的 report.json、截图、stdout JSON），汇总 `/tmp/jevcoord/summary.json`。

### 7.9 每条结果附商品页原图（2026-11-03，`f0762111`，tk-shop-erp KIN-90）

tk-shop-erp 拿到链接后要用「复制链接时的那一屏商品页」做链接绑定（商品页截图 vs 链接 OG 主图）和多通道同款投票；report 里的 `step-NNN.jpg` 是缩到 576×1280 的 JPEG，不能当证据。

#### 7.9.1 实现

- `items[].productScreenshot: { file, sha256, width, height, step }`：原始 screencap PNG 字节（`obs.screen.png`，不缩放、不重编码），写到 runDir 的 `item-<n>-product.png`，`sha256` 为文件字节的 hex，`step` 为该帧所在的 step 序号。
- 取帧：该卡片打开后、**最后一次执行成功的 Share 点击（顶栏 Share 或半屏 Share）所在的那次观测**——商品页、Share 面板未开。同一卡片点了两次 Share（第一次没开面板）取第二次；不会取到其他卡片、Share 面板已开或已回到结果页的帧（卡片切换时帧随卡片清空）。接管（视觉 agent）替代打开了面板时，退而用该卡片最近一次「商品页、面板未开」的观测；连这样的帧都没有的链接进 `unresolved`（reason `no product-page frame was observed for this card`），不计入 items。
- 只给计入 `items` 的条目写文件；重复、unresolved 不写。
- 不变量：构造结果时 `assertItemScreenshots` 断言每个 item 都有截图、文件存在、哈希与 PNG 尺寸一致。
- 没有 runDir 的调用：`runPlaybook` 改为自动建临时目录（`$TMPDIR/flow-playbook-<id>-*`），结果里的 `runDir` 指向它，保证文件引用总是真实存在；CLI 和 MCP 本来就总是给 runDir。
- 权限 0600（截图显示的是已登录账号的屏幕）；runDir 其他产物原先没有统一权限，未改。
- 选卡、坐标来源、半屏、护栏、短链解析未改。

#### 7.9.2 真机核对（`removedor de fiapos` @ 16091 / 46.5.3，`massageador digital` @ 18041 / 47.5.3）

两次都 done、0 兜底，66 s / 60 s。

| 设备  | item | productId           | 卡位 | 文件               | 尺寸      | 哈希 | 权限 | step / 页面                                  | 面板 | 画面标题                                                                            | 与 productId 对应                                                    |
| ----- | ---- | ------------------- | ---- | ------------------ | --------- | ---- | ---- | -------------------------------------------- | ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 16091 | 1    | 1737459860992918548 | 左上 | item-1-product.png | 1080×2400 | 一致 | 0600 | 7 / SeaPdpActivity，顶栏 Share               | 未开 | Papa Bolinhas Eletrico Tira Pelos de Roupas Removedor Aparador Sem Fio Recarregável | 是（tk-shop-erp 解析记录的 OG 标题相同）                             |
| 16091 | 2    | 1738134049752712979 | 右上 | item-2-product.png | 1080×2400 | 一致 | 0600 | 10 / SeaPdpActivity，顶栏 Share              | 未开 | Papa Bolinhas Elétrico USB Sem Fio Portátil, Removedor de Pêlos e Fiapos…           | 无现成 OG 记录；下一步复制链接时面板后面是同一商品（同图、R$ 17,99） |
| 16091 | 3    | 1733367568851371065 | 左下 | item-3-product.png | 1080×2400 | 一致 | 0600 | 13 / DetailActivity，视频 + 半屏，半屏 Share | 未开 | Papa Bolinhas Eletrico Tira Pelos de Roup…                                          | 是（OG 标题相同）                                                    |
| 18041 | 1    | 1737660200969930116 | 左上 | item-1-product.png | 1080×2400 | 一致 | 0600 | 8 / SeaPdpActivity，顶栏 Share               | 未开 | Massageador Portátil Recarregável Multifuncional para Uso Doméstico…                | 是（OG 标题相同）                                                    |
| 18041 | 2    | 1738312809302492466 | 右上 | item-2-product.png | 1080×2400 | 一致 | 0600 | 11 / SeaPdpActivity，顶栏 Share              | 未开 | Aparelho Massageador Muscular Fisioterapia Portátil Digital Com Pulso Elétrico      | 是（OG 标题相同）                                                    |
| 18041 | 3    | 1738324867441002197 | 左下 | item-3-product.png | 1080×2400 | 一致 | 0600 | 14 / SeaPdpActivity，顶栏 Share              | 未开 | Munhequeira Elétrica Massageadora com Aquecimento…                                  | 无现成 OG 记录；下一步复制链接时面板后面是同一商品（同图、R$ 58,99） |

- 6 条链接经独立 `curl` 解析的商品 ID 都与 `productIds` 一致。公开商品页（`tiktok.com/view/product`、`shop.tiktok.com/br/pdp`）未登录时只返回 Security Check，拿不到 OG 标题；4 条与 tk-shop-erp 之前解析记录（`case-evidence/*/host/links-resolved.json`）里的标题对上，另 2 条只能用「截图帧 → 下一步复制链接」的连续性核对。
- 证据：`/tmp/jevshot/runs/{16091,18041}/s1/`（report.json、`item-*-product.png`、step 截图），核对脚本 `/tmp/jevshot/check.py`。

#### 7.9.3 待修 / 已知限制

| #   | 问题                                                                                                              | 备注                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| J18 | 截图是全屏原始 PNG（约 1–3 MB / 张），含状态栏和已登录账号的界面                                                  | 文件 0600；下游只存需要的部分                           |
| J19 | 接管打开面板时用的是该卡片最近一次「商品页、面板未开」的观测，不是「Share 点击帧」（那次点击发生在视觉 agent 里） | 本轮真机没有出现；没有任何此类帧时该链接进 `unresolved` |

#### 7.9.4 验证基线（2026-11-03，本分支 `f0762111`）

| 包          | typecheck | test                                                                                                                                                                                                             | eslint |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| flow-device | 通过      | 105 / 105                                                                                                                                                                                                        | 通过   |
| flow-core   | 通过      | 164 / 164（+6：顶栏 Share 帧；半屏 Share 帧；Share 第一次没开面板取第二次的帧；强停重搜后的 item 用新搜索的帧；只给计入的 item 写文件 + 不变量断言（缺文件 / 哈希不符 / 无截图）+ 0600；无 runDir 时写临时目录） | 通过   |
| flow-mcp    | 通过      | 26 / 26                                                                                                                                                                                                          | 通过   |
| flow-cli    | 通过      | 26 / 26                                                                                                                                                                                                          | 通过   |
