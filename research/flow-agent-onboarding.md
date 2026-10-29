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
