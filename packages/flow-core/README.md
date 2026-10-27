# @escrcpy/flow-core

`flow-core` 负责 `*.flow.yaml` 的 schema/YAML 读写、M1 trace JSONL 编译，以及不依赖模型的确定性回放与 run report。

## API

```ts
import {
  compileTraceFile,
  readFlow,
  replayFlow,
  writeFlow,
} from '@escrcpy/flow-core'

const { flow, warnings } = await compileTraceFile('./traces/tr_01.jsonl', {
  snapshots: './traces/snapshots',
})
await writeFlow('./flows/example.flow.yaml', flow)

const report = await replayFlow(await readFlow('./flows/example.flow.yaml'), {
  device,
  serial: 'emulator-5554',
  vars: { user: 'Ada', message: 'Hello' },
  reportDir: './runs/example',
})
```

主要导出如下：

- `flowSchema`、`selectorSchema`、`targetSchema` 以及对应的 `FlowScript`、`FlowStep`、`Target` 类型。
- `parseFlow`、`stringifyFlow`、`readFlow`、`writeFlow`，使用 YAML 并在读入和写出前后执行 zod 校验。
- `parseTrace`、`readTrace`、`compileTrace`、`compileTraceFile`。编译器读取 M1 的 `session/call/end` JSONL，过滤成功 action、按 `flow_step` 绑定 intent、合并连续 `input_text`，生成唯一 locator、变量占位符与隐式 expect。
- `replayFlow`（别名 `runFlow`）。回放器按 locator 顺序等待并执行动作，记录定位序号和 drift；首选 locator 失败时依次使用备用 locator。失败时会记录错误并在 `reportDir` 下保存 `report.json`、截图和 UI XML（设备支持对应能力时）。

## Flow 格式

脚本至少包含 `version: 1`、`name` 与 `steps`。每个 step 支持 `app_start`、`app_stop`、`open_url`、`tap`、`long_press`、`input_text`、`key`、`swipe`、`wait_for`、`sleep`、`shell` 等动作；target 支持 selector、`point: [x, y]` 和 `image`。M2 对 image target 保留类型定义，但回放时会给出明确的 `Image targets are not implemented in M2` 错误。

selector 字段为 `resource_id`、`text`、`content_desc`、`class_name`、`exact`、`index`；多个 target 按数组顺序作为备用定位。字符串中的 `{{variable}}` 会在回放时以 `vars` 渲染，`vars` 中的 `required: true` 变量必须提供值。默认等待时间为 8000ms，默认轮询间隔为 500ms。

`interrupts` 是全局弹窗处理规则。某一步定位超时时，回放器会用零等待探测 interrupt，执行其 `do` 动作后重试原步骤一次；interrupt 处理是基础 best effort 行为，失败仍由原步骤报告错误。

## 限制

M2 直接调用 `flow-device` 的设备能力，shell/app 动作需要 replay device adapter 暴露 `shell`。模板图像匹配、`within`、模型自愈、流程分支与循环属于后续里程碑。设计背景见 [record-replay-prototype-design.md](../../research/record-replay-prototype-design.md)。
