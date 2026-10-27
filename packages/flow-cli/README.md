# @escrcpy/flow-cli

`flow` is the command line entry point for device inspection, MCP recording, trace compilation, deterministic replay, and M2-compatible JSON export.

```bash
pnpm --filter @escrcpy/flow-cli build
export YADB_PATH=$PWD/desktop/electron/resources/extra/common/yadb/yadb   # optional, ~3x faster dumps
flow --help
flow devices
flow dump -s <serial>
flow tap -s <serial> --text 搜索 --exact
flow screenshot -s <serial> -o screen.jpg
```

The M0 device commands remain available: `devices`, `dump`, `find`, `tap`, `wait`, `text`, `key`, and `screenshot`. Set `ADB_PATH`, `YADB_PATH`, or `ANDROID_SERIAL` to configure the backend and default device; pass `--no-yadb` to force plain adb.

## Record, compile, run

`flow mcp` starts the real `@escrcpy/flow-mcp` stdio server and forwards `ADB_PATH`, `YADB_PATH`, `ANDROID_SERIAL`, and `FLOW_TRACE_DIR` from the environment. CLI options can override those values:

```bash
flow mcp --trace-dir ./traces
flow compile traces/example.jsonl -o flows/example.flow.yaml --var user=张三 --annotate
flow run flows/example.flow.yaml -s <serial> --var user=李四 --report ./runs/example
```

`--annotate` is accepted for compatibility with the prototype command. M2 preserves intents recorded in the trace and prints a warning because model annotation is not implemented.

`flow run` uses `@escrcpy/adbx` and `@escrcpy/flow-device` to create the replay device, then calls `@escrcpy/flow-core`. A report path ending in `.json` writes the report directly; another path is treated as a report directory containing `report.json` plus failure context when available.

## Export

M2 exports a stable, minimal JSON form suitable for Escrcpy Automation clients:

```bash
flow export flows/example.flow.yaml -o automation.json
flow export flows/example.flow.yaml -o automation.json --format escrcpy-automation
```

The result has `format: "escrcpy-automation"`, `version: 1`, the flow name/description, and each supported flow step with `action`, target, arguments, expectations, intent, and optional flag. Unsupported future schema fields are omitted until their execution semantics are available.

## Development

```bash
pnpm --filter @escrcpy/flow-cli typecheck
pnpm --filter @escrcpy/flow-cli test
pnpm --filter @escrcpy/flow-cli build
```

The tests use fake JSONL/YAML inputs and never connect to an Android device.
