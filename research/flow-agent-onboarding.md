# flow agent 接入指南（面向任意 MCP 客户端）

> 配套设计：[record-replay-prototype-design.md](record-replay-prototype-design.md)（架构与 M3.5 租约 / fleet 详见其第 10 节）。
> 本指南面向**任何**能连 MCP stdio server 的 agent 客户端——Claude Code、Claude Desktop、Cursor、自研脚本都行，不绑定特定模型。

## 1. 这套工具给你什么

- **探索一次，回放多次**：你用工具操作 Android UI，server 自动录制成 trace；编译成 YAML 流程后，之后回放不再调用任何模型。
- **设备租约**：多 agent / 多进程共用设备池时，谁在用哪台设备一目了然，你的手势不会被别人的手势打断。

## 2. 接入配置（MCP stdio）

Claude Code 项目级 `.mcp.json`，可直接粘贴后改两个绝对路径：

```json
{
  "mcpServers": {
    "flow": {
      "command": "pnpm",
      "args": ["--filter", "@escrcpy/flow-cli", "exec", "flow", "mcp"],
      "cwd": "/abs/path/to/escrcpy",
      "env": {
        "FLOW_TRACE_DIR": "/abs/path/to/escrcpy/traces",
        "FLOW_LEASE_DIR": "/abs/path/to/escrcpy/.flow-leases"
      }
    }
  }
}
```

Claude Desktop / Cursor 等客户端的 `mcpServers` 字段格式相同。

| 环境变量         | 作用                                                                             | 默认                     |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------ |
| `FLOW_TRACE_DIR` | **设置后自动录制**：第一次工具调用即开始记 trace，不需要你调 `flow_record_start` | 不录制                   |
| `FLOW_LEASE_DIR` | 租约锁文件目录（测试 / CI 指到临时目录用）                                       | `~/.escrcpy/flow/leases` |
| `ANDROID_SERIAL` | 默认设备                                                                         | 未设置                   |
| `YADB_PATH`      | yadb 二进制，启用更快的 UI dump 和 Unicode 输入                                  | 未设置                   |
| `ADB_PATH`       | adb 二进制                                                                       | PATH 上的 `adb`          |

## 3. 推荐探索流程（从零到一个可回放脚本）

1. **`device_list`** — 看在线设备和 free/busy（busy 会标注 holder/pid/acquiredAt）。多台设备时记下要用的 serial。
2. **`device_claim`** — 占用设备（多台时传 `serial`，或先 `device_select`）。被占用会收到含持有者的报错，等它释放或换一台。
3. **探索** — 每个逻辑步骤前调 `flow_step(intent)` 声明意图（编译器会写进脚本，人也更好审）；动作优先 `ui_tap` 用选择器（`resource_id` > `content_desc` > `text`），UI 树定位不了再退 `tap`（0~1 比例坐标）；观察用 `get_screen_state` / `ui_find_element`；动画界面 dump 失败时稍等重试或退坐标。最后用 `ui_wait_for` 验证终态。提示词模板可直接用 MCP prompt `flow/explore`。
4. **`flow_record_stop`** — 结束录制，返回 trace 文件路径。
5. **编译**（在 shell 里，不经 MCP）：
   ```bash
   pnpm --filter @escrcpy/flow-cli exec flow compile <trace.jsonl> -o flows/<name>.flow.yaml --var user=张三
   ```
   然后审阅 YAML：`intent` 是否达意、哪些值该参数化成 `vars`，需要就手改。
6. **`device_release`** — 释放设备。忘了调也会在持有者 120 s 无活动或进程退出后自动释放。

工具速查：

| 类别 | 工具                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 租约 | `device_list`（含 free/busy）、`device_claim`、`device_release`、`device_select`                                                                                 |
| 观察 | `get_screen_state`、`ui_dump`、`ui_find_element`、`ui_wait_for`、`screenshot`、`device_info`、`get_foreground_app`、`clipboard_get`                              |
| 动作 | `ui_tap`（选择器优先）、`tap` / `long_press`（坐标兜底）、`swipe`、`key_event`、`input_text`、`app_start`、`app_stop`、`open_url`、`clipboard_set`、`shell_exec` |
| 流程 | `flow_step`、`flow_record_start`（设了 `FLOW_TRACE_DIR` 时可省）、`flow_record_stop`                                                                             |

## 4. 回放派发（不经 MCP）

- **单设备**：
  ```bash
  pnpm --filter @escrcpy/flow-cli exec flow run flows/wechat.flow.yaml -s <serial> --var user=李四 --var message=hi

  裸 `flow run` 也会走租约（holder 默认 `flow-run`，可用 `FLOW_AGENT_NAME` 覆盖）：设备被他人持有时报 `device busy` 并附持有者，`--no-lease` 可跳过。
  ```
- **批量**：写一份 fleet 清单（格式见设计文档 10.3：`flows: [{flow, vars[]}]`，`devices` 为 serial 列表或 `auto`），然后：
  ```bash
  pnpm --filter @escrcpy/flow-cli exec flow fleet fleet.yaml
  ```
  每台设备并发 1、跨设备并行；报告落在 `reports/<flow>/<device>/<run>/`。

## 5. 租约语义（占用、等待、陈旧释放）

- **占用报错**：对 busy 设备执行动作类工具会收到 `DEVICE_BUSY`，错误文本含 `serial / holder / pid / acquiredAt`——据此决定等它、找它协商，还是换设备。
- **等待**：`device_claim` 传 `wait_ms` 轮询等待释放；或稍后重试。
- **陈旧自动释放**：持有者 **120 s 内没有任何工具调用**，或持有进程已退出，租约即自动失效、下次被清理。所以"占用者崩了"不会永久卡死一台设备。
- **观察不受限**：`get_screen_state`、`screenshot` 等 observe 类工具不检查租约，随时可以查看（包括别人占用的设备）；`ui_tap`、`input_text`、`app_start`、`shell_exec` 等动作类会检查。
- **良好习惯**：任务一结束就 `device_release`；长时间任务不用担心——每步工具调用都会自动续约。

## 6. 边界与常见问题

- **动画 / 视频界面 dump 失败**（如短视频 feed）：等动画停或暂停后重试，实在不行退坐标 `tap`；这类步骤在脚本里会以 `point` 兜底。
- **多设备必须显式指定**：连了多台又不传 `serial` / `device_select`，调用会直接报错。
- **`input_text` 原样保留**：录制时输入的用户文本是编译器参数化的依据，不要改写大小写 / 空格。
- **`shell_exec` 受安全策略限制**：危险命令会被拒绝；它也不在租约管辖内，别用它绕过设备占用。

## 7. 视觉 agent 模式（不录制、不回放）

UI 树几乎为空的界面（TikTok 搜索结果网格、Shop 首页、领券弹窗）录制回放只能盲点坐标。视觉 agent 让模型每步看截图直接操作，不产出脚本；安全护栏由 runner 强制执行，不靠模型自觉。

- **入口**：MCP 工具 `vision_agent_run`（`serial` 必填）；CLI `flow agent --serial <s> --goal <text> --json`；库 `runVisionAgent(options)`（`@escrcpy/flow-core`）。
- **每步**：截图（长边 1280，JPEG；无 sharp 时纯 JS 缩放成 PNG）+ 前台包名 / Activity + 2 s 内拿得到的精简元素列表 + 最近动作历史 → 模型返回一个 JSON 动作 → runner 执行并写 `report.json` 和逐步截图。
- **动作空间**：`tap{x,y|element}`（0–1000 归一化坐标）、`long_press`、`swipe`、`scroll{direction}`、`input_text`、`key{back|home|enter}`、`wait`、`read_clipboard`、`done{success,result,reason}`、`fail`。没有 shell / open_url / app_install / app_uninstall / app_stop。
- **护栏**：前台不在 `allowed_packages` 时不执行模型动作，自动拉起第一个允许的包一次，再越界就以 `guardrail` 结束；点击前把落点解析到 UI 元素（含祖先可点击节点、按钮大小的可点击容器的子节点），命中禁用词（Like/Follow/Add to cart/Buy now/Claim/Message…，含中、葡、西语）就拒绝并告诉模型；拿不到 UI 树时照常点击但记 `unverifiedTap`；`maxSteps` / `timeBudgetMs` / `maxModelCalls` 是硬上限；连续 3 次动作后画面不变判为 `stuck`；屏幕息屏（截图全黑）时自动 WAKEUP。
- **结果**：`{status, success, result, reason, steps, modelCalls, tokens, clipboardReads, guardrailBlocks, unverifiedTaps, reportPath}`。`clipboardReads` 是模型声称的链接的证据——调用方应校验 `result` 里的每条链接都出现在其中。
- **模型**：`model` / `--model` 取 `llm.json` 的 `vendor::model`（模型不必在 vendor 的列表里）；缺省用 `active`；都没有时用 `FLOW_LLM_*` 环境变量。vendor 可写 `"apiKeyEnv": "ENV_NAME"`，key 从环境读取，不落盘。
- **恢复预算与超时**：越界后自动拉回的次数默认 1（`--max-foreground-recoveries` / `max_foreground_recoveries`）；第一次调用模型之前的拉回（冷启动时 TikTok 自己退回桌面）不计入，最多 3 次。单次模型请求超时默认 60 s、重试 2 次（`--llm-timeout` / `llm_timeout_ms`）。
- **报告状态**：运行中 `report.json` 的 `status` 为 `running`，带 `pid` 和 `updatedAt`；结束时写入最终状态和 `finishedAt`。`running` 且 `pid` 已不存在 = 进程被杀。
- **`--json`**：`flow agent` / `flow see` / `flow playbook` 带 `--json` 时，stdout 永远只有一个 JSON；没能开始运行时输出 `{"status":"busy"|"error","success":false,"reason":…}`（设备被占用为 `busy`），退出码 1。
- **长任务**：一次运行通常几分钟。MCP 客户端要调大请求超时，或传 `progressToken` 接收每步进度通知；取消请求会中止运行并释放租约。
- **租约**：运行期间持有设备租约；同一进程事先 `device_claim` 过的租约会被复用并保留，不会被释放。

## 8. Jev 决策层与 playbook（代码驱动 + Jev 判断 + 视觉 agent 兜底）

Jev（TypeSafe System One）是判断模型：一个请求带一张截图和若干类型化问题（choice / score / noul / box），约 1 s 内并行返回概率。它不规划、不生成文本——流程、计数、比较都由代码做。

- **配置**：`~/.escrcpy/flow/llm.json` 的 `jev` 段（全部可选）：`{baseUrl, apiKey?, apiKeyEnv?, model?, fallbackBaseUrl?, fallbackApiKey?, fallbackApiKeyEnv?, timeoutMs?}`。缺省走 magpie `http://127.0.0.1:3425/v1/systemone`，key 复用 `magpie` vendor，模型 `typesafe-ai/jev`。环境变量覆盖：`FLOW_JEV_BASE_URL` / `FLOW_JEV_API_KEY` / `FLOW_JEV_MODEL`。
- **图片 / Box**：客户端自动给图片生成 UUID 引用、校验每边 280–1568 px、加 `TypeSafe-Danger-Zone-Images: true` 头。网关若返回 400 "Images are not turned on"，抛 `JEV_IMAGES_BLOCKED`；配置了回落端点（`FLOW_JEV_FALLBACK_BASE_URL` + `FLOW_JEV_FALLBACK_API_KEY`，或 llm.json 的 `fallbackBaseUrl` + `fallbackApiKeyEnv`）时，带图请求自动改走回落端点（默认不启用）。Box 属官方「dreamer-ready」能力，按原型级对待：用之前看 `present` 和 `confidence`。
- **看屏幕**：MCP `visual_locate {serial, description}`（Box + 存在性 Noul，返回 `ratio` 可直接给 `tap`）、`visual_check {serial, questions, state?}`；CLI `flow see --serial <s> --locate "<desc>" | --ask '<json>' --json`。只读，不占租约。
- **playbook**：`flow playbook tiktok-shop-links --serial <s> --keyword "<kw>" --count 3 --json [--model vendor::model] [--skip-ads] [--no-fallback]`；`flow playbook list` 列出可用 playbook。每步一次 Jev 请求同时判断页面类型、弹窗、分享面板、No results 和这一步要点的控件位置，代码决定动作；「商品卡」由代码定义：卡上看得到价格、且没有 LIVE 角标（缩略图带播放图标的商品卡照样算；已售数只记录不强制，因为最下一排常被屏幕边缘截断）；同一商品按解析出的商品 ID 去重（每次分享的短链都不同）；只有解析出商品 ID 的链接才计数（`items` 每项必有 `productId` 与 `finalUrl`，`productIds.length === items.length`），解析不出的进 `unresolved` 并改取下一张卡，凑不够就 `success: false`；TikTok 被强停 / 重新拉起后按当前页面重新定位（首页 → 重新搜索），首页上从不按 BACK，`researched: true` 表示结果跨了两次搜索；TikTok 46.5 的「视频 + 商品半屏」有单独的 Share 规则，点之前必过视觉检查；Jev 不确定或页面不符合预期时，只把这一步交给视觉 agent（≤ 6 步，同样的前台白名单与禁用词，不能改写搜索词），连续 2 次兜底未达成就失败。结果 `{status, success, result:{keyword, links, productIds, noResults, items[{link, productId, finalUrl, position, ad, sold, relevance, searchEpoch, sheet?, productScreenshot{file, sha256, width, height, step}}], duplicates, unresolved[{link, position, searchEpoch, reason}], searchEpochs, researched}, steps, jevCalls, jevLatencyMs, fallbacks, modelCalls, tokens, clipboardReads, guardrailBlocks, visualGuardBlocks, reportPath}`；成功退出码 0。报告默认在 `~/.escrcpy/flow/playbook-runs/<id>/<serial>/<time>/report.json`（`FLOW_PLAYBOOK_RUNS_DIR` 可改），每步记录 Jev 延迟、问题名、答案与概率、动作与护栏、兜底的模型调用与 tokens。
- **视觉护栏**：UI 树拿不到或落点无标签（含 `@2131823611` 这类未解析的资源 ID 标签）时，playbook 和 `flow agent --jev` / `vision_agent_run {jev:true}` 会把落点附近裁一块、画红圈问 Jev「是不是点赞 / 关注 / 评论 / 私信 / 加购 / 购买 / 领取 / 发送类按钮」，> 0.5 拒绝点击。`--jev` 还会在模型宣告 `done` 时复核：结果里的链接必须出现在 `clipboardReads`，`noResults` 需画面上确有无结果提示。
