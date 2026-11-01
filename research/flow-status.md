# Flow 自动化：任务帐本

> 这是 flow 自动化（录制 → 编译 → 回放）**唯一的任务入口**。新任务、状态变化都改这一份；设计细节仍以 [record-replay-prototype-design.md](record-replay-prototype-design.md) 为准。
>
> 状态：**已完成** / **待修** / **需真机验证** / **环境问题** / **不做**。
> 最后更新：2026-11-02（分支 `claude/flow-ledger-followups`，基于 main `59d7eba8`）。

## 1. 里程碑

设计文档 §8 只定义了 M0–M4（含 M3.5）；M5–M7 是之后追加的，范围以对应 commit message 为准。

| 里程碑                 | 内容                                                                                                                                   | 状态                                                                             | 依据                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **M0** 骨架            | 4 个包的脚手架；flow-device 的 dump / 解析 / 查找 / 输入 / 截图；fixture 单测                                                          | 已完成                                                                           | `6cf3b19b`，`a5de6a47`（dump 可靠性、输入队列）；设计 §8                                           |
| **M1** 探索与录制      | flow-mcp 工具集 + 录制器 + 探索 prompt                                                                                                 | 已完成                                                                           | `436712c6`，`120307f8`                                                                             |
| **M2** 编译与回放      | 脚本 schema、编译器、回放器、报告、`flow run`；extract 步骤 + xlsx 输出                                                                | 已完成，已在真机上验证（Pixel 5a：Settings 搜索、TikTok 置顶作品两个案例）       | `521737f8`，`cd0b7119`，`f98d7e64`                                                                 |
| **M3** 自愈            | interrupts、L2 自愈 agent、补丁与 `flow heal`                                                                                          | 已完成，已在真机上验证（L0 备用定位 / L1 弹窗 / L2 补丁，外加一次真实 LLM 冒烟） | `d8fd2e25`，`beb90215`，`06d1ba88`（heal probe 改为 5 s、接受单对象 target）                       |
| **M3.5** 协调与批量    | DeviceLease、`device_claim` / `device_release`、`flow fleet`、agent 接入指南                                                           | 已完成，已在 4 台真机上 E2E 验证                                                 | `8fa09af1`，`458e7f0b`，`2010f8a8`；设计 §10；[flow-agent-onboarding.md](flow-agent-onboarding.md) |
| **M4** 桌面集成        | 共享 LLM 配置 + 偏好设置里的「AI 自愈模型」对话框；流程页、脚本库、导出官方 Automation JSON；多设备 × 变量表批量执行 + CSV 导入        | 已完成，已在真机和运行中的 app 里验证                                            | `5732d79f`，`f44affd0`，`385ed8f4`，`9259d6ff`                                                     |
| **M5** 目标驱动自愈    | 回放失败后朝 `flow.description` 自由探索并产出补丁；action 预算；在流程页应用补丁                                                      | 已完成，已在真机上验证                                                           | `1d9183e2`，`17849943`，`4c5deefa`，`9b3e126c`（ui-drive skill）                                   |
| **M6** 应用内 Copilot  | AI 助手页（in-process flow MCP + agent loop）、存为流程；yadb 默认开启                                                                 | 已完成，已在真机上验证                                                           | `cd3b946e`，`599a47b5`                                                                             |
| **M7** 外部 agent 接入 | 自包含的 `agent.mjs`（33 个工具）、「接入外部 Agent」对话框，随 app 打包                                                               | 已完成，已在空目录和打包后的 app 里验证                                          | `bc4953a9`，`9e8a1a6c`，`8315816c`                                                                 |
| M2–M7 收尾修复         | 每次 dump 使用唯一远端路径；临时 CLI 命令的租约提示；跨 OEM 回放（结尾 expect 改为 `{app}`）；heal 后 step id 保持稳定；内置 yadb 回落 | 已完成                                                                           | `78e9b114`，`0ed62503`，`81efedb4`，`c9cd717a`（AGENTS.md）                                        |

## 2. 本轮收尾（settings-polish）

| 项目                                                                            | 状态                                  | 依据                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移除旧 worktree `escrcpy-automation-reverse-eng-4ca72b`，删除本地 + origin 分支 | 已完成                                | 删除前 `git rev-list --count main..<branch>` = 0                                                                                                                |
| `flow-mcp/src/context.ts:36` ESLint operator-linebreak                          | 已完成                                | `f3f63b6f`                                                                                                                                                      |
| flow-core typecheck 失败（`heal.ts` TS2322 ×3，`81efedb4` 引入）                | 已完成                                | `4b7d45da`：`HealLlmEndpoint` 字段改为可选，与运行时检查一致                                                                                                    |
| Copilot agent 可以 `device_select` 到其他 serial                                | 已完成，app 内效果需真机验证（见 §3） | `38e67fc2`：flow-mcp `lockedSerial` 选项（其他 serial → `SERIAL_LOCKED`），Copilot session 用 `lockedSerial` 打开 + system prompt 写明绑定的设备；新增 4 个测试 |
| Orca 里的旧 repo 登录项 `dc832aad-…`（escrcpy-automation-reverse-eng-4ca72b）   | 环境问题                              | `orca repo` 只有 list/add/show/set/set-base-ref/search-refs，没有移除指令；需在 Orca GUI 里手动移除（路径已不存在）                                             |

## 3. 待修

| #   | 问题                                                                                                                                                                            | 位置                                                                                                                | 备注                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 已完成：切换设备 / 页面卸载 / 渲染层重载时关闭旧的 Copilot session（新增 `copilot:close`：中止运行中的 loop 并 close MCP client）；设备下拉框只在运行中禁用，不再一开会话就锁死 | `desktop/src/views/copilot/index.vue` `closeSession`；`desktop/electron/modules/copilot/service.js` `copilot:close` | 原来会话一开就不能换设备，只能重启 app；app 内效果和 #2 一起需真机验证                     |
| 2   | 需真机验证：Copilot 页里让模型去选另一台设备，应收到 `SERIAL_LOCKED`，并继续在原设备上执行                                                                                      | Copilot 页                                                                                                          | 单测已覆盖 MCP 层；还没在运行中的 app 里验证                                               |
| 3   | 已完成：`control-bar` 的 `Install` 组件改名为 `InstallApp`，`pnpm lint` 全部通过                                                                                                | `desktop/src/components/control-bar/index.vue`                                                                      | `59d7eba8`                                                                                 |
| 4   | 投屏（scrcpy）没有接入设备租约：设计 §6 / §10.4 写的是镜像窗口启动前 acquire，目前只有流程页（`modules/flow/scripts.js`）在用租约                                               | `desktop/electron/modules/flow/scripts.js` 之外                                                                     | 可选；agent / 流程运行时，投屏和输入仍可能互相干扰                                         |
| 5   | 已完成：turbo 新增 `typecheck` / `test` 任务（依赖 `^build`），根目录 `pnpm typecheck` / `pnpm test` 只跑四个 flow 包                                                           | `turbo.json`；根 `package.json`                                                                                     | 合并前跑 `pnpm typecheck && pnpm test && pnpm lint`                                        |
| 6   | 上游 `electron-ipcx` 不在门禁里：typecheck 报 TS2578/TS2339（`shared/errors.ts:180`），vitest 2.1.9 在当前 vite 下 `__vite_ssr_exportName__ is not defined`                     | `packages/electron-ipcx`                                                                                            | 来自上游 v3.3.1（`e35972b4`），不是 flow 引入的；修要升级它的 vitest，属于依赖改动，先不动 |

## 4. 环境问题 / 不做

| 项目                                                        | 分类                       | 说明                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit 签名                                                 | 环境问题（用户已选择不签） | 1Password SSH 签名通道卡死（"failed to fill whole buffer"）；从 `4c5deefa` 起所有 commit 都用 `--no-gpg-sign`                                                                                                                                                                                                 |
| `packages/madb/dist` 闭源缺口                               | 环境问题 / 不做            | `desktop/electron-builder.config.js:25` 的 extraResources 引用 `../packages/madb/dist`，但 madb 是闭源、仓库里没有。打包前需要放一个占位文件 `packages/madb/dist/index.mjs`（只有 `export {}`，不含任何闭源代码；in-app Copilot 用的是 flow MCP，用不到它）。新 worktree 默认没有这个占位文件。不复制闭源代码 |
| F8 条件分支 / 循环 / 子流程                                 | 不做                       | 设计 §1.1；目前只支持 `optional` 和 interrupts                                                                                                                                                                                                                                                                |
| 打包版和 dev 版共用 `~/Library/Application Support/escrcpy` | 环境问题                   | 不要同时运行两者（第二个实例会白屏或卡住）                                                                                                                                                                                                                                                                    |
| 打包命令                                                    | 环境问题（已写进文档）     | 必须 `npx electron-builder --config=./electron-builder.config.js`，详见 AGENTS.md Gotchas                                                                                                                                                                                                                     |
| 新 worktree 需要先 build                                    | 环境问题                   | 包之间通过 `dist` 互相引用：`pnpm install` 后先跑 `pnpm --filter @escrcpy/shared --filter @escrcpy/adbx --filter "@escrcpy/flow-*" build`，flow-mcp 测试和 desktop dev 才能正常工作                                                                                                                           |

## 5. 验证基线（2026-11-01，本分支）

| 包          | typecheck                | test                     | eslint                                                      |
| ----------- | ------------------------ | ------------------------ | ----------------------------------------------------------- |
| flow-device | 通过                     | 94 / 94                  | 通过                                                        |
| flow-mcp    | 通过                     | 19 / 19（+4 个锁定测试） | 通过                                                        |
| flow-core   | 通过（修复前：3 个错误） | 70 / 70                  | 通过                                                        |
| flow-cli    | 通过                     | 24 / 24                  | 通过                                                        |
| desktop     | —                        | —                        | `modules/copilot` 通过；`pnpm lint` 只剩 §3 #3 这个上游错误 |
