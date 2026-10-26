# @escrcpy/flow-device

Device layer shared by the flow MCP server (recording) and the replayer, so both behave the same.

- **Dump**: `yadb -layout` when `yadbPath` is set, otherwise `uiautomator dump` (via `@escrcpy/adbx`); 3 attempts, 15 s each, 5 MB limit.
- **Parse**: `parseUiTree(xml)` gives a flat, JSON-safe node list with parent ids and index paths. `extractElements(tree)` gives the agent-facing list (madb-compatible fields, reading order, password text masked).
- **Find**: `findAll` / `findOne` with a `Selector` (`resource_id`, `text`, `content_desc`, `class_name`, `exact`, `index`). `hitTest` maps a tap point back to the element under it, for upgrading coordinate taps to selectors.
- **Snapshots**: 60 s TTL; any input on a device invalidates its snapshots.
- **Input**: per-device serial queue; coordinates are 0~1 ratios; selector targets are resolved inside the queue.
- **Screenshot**: sharp scales to ≤ 2560 px and encodes JPEG (quality 80) or PNG; `cropImage` cuts element templates.

```ts
import { createAdbx } from '@escrcpy/adbx'
import { createFlowDevice } from '@escrcpy/flow-device'

const device = createFlowDevice({ adbx: createAdbx({ adb, yadbPath }) })
const { found, match } = await device.waitFor(serial, { text: '连接', exact: true })
if (found)
  await device.tap(serial, { text: '连接', exact: true })
```

Tests use real dumps in `test/fixtures/` (app names on the launcher dumps were replaced) and a fake adbx, so no device is needed:

```bash
pnpm --filter @escrcpy/flow-device test
```
