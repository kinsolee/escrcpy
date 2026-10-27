# @escrcpy/flow-mcp

`@escrcpy/flow-mcp` exposes the `@escrcpy/flow-device` API through an MCP stdio server. It also records exploration sessions as JSONL so a later compiler can turn the trace into a replayable flow.

## Start the server

The package is a Node ESM entry point. MCP protocol messages use stdout; diagnostics are written to stderr.

```bash
pnpm --filter @escrcpy/flow-mcp build
node packages/flow-mcp/dist/index.mjs
```

For a local MCP client, pass the package through pnpm:

```json
{
  "flow": {
    "command": "pnpm",
    "args": ["--filter", "@escrcpy/flow-mcp", "exec", "flow-mcp"]
  }
}
```

The server selects `ANDROID_SERIAL` when it is set, or automatically selects the only connected Android device. `ADB_PATH` and `YADB_PATH` configure the backend in the same way as `@escrcpy/flow-cli`.

## Recording

Set `FLOW_TRACE_DIR` to enable automatic recording. The first device tool call creates an `auto` session, and the trace stays active until `flow_record_stop` is called.

An agent can also control a recording explicitly:

```text
flow_record_start({"name":"settings","task":"Open Settings","vars":{}})
flow_step({"intent":"open settings"})
get_screen_state({})
ui_tap({"content_desc":"设置","exact":true})
flow_record_stop({"outcome":"completed"})
```

A recording directory contains one `<trace-id>.jsonl` and a `snapshots/` directory. The JSONL stream has:

- a `session` record with task, variables and device information;
- one `call` record per observed, action or metadata tool call;
- an `end` record with the outcome.

Action records include the UI snapshot taken before the call, duration and the element target when available. Selector taps preserve the matched node; coordinate `tap` performs a hit test against the before snapshot and records the node under the point. Observation records include `snapshotRef`, and each referenced snapshot is saved as `snapshots/<snapshot-id>.json`.

## Tools and prompt

The server provides device selection and inspection (`device_list`, `device_select`, `device_info`, `get_screen_state`, `ui_dump`, `ui_find_element`, `ui_wait_for`, `get_foreground_app`, `screenshot`), input and navigation (`ui_tap`, `tap`, `long_press`, `swipe`, `key_event`, `input_text`, `app_start`, `app_stop`, `open_url`, clipboard tools), and `shell_exec` for the device backend. Recording adds `flow_record_start`, `flow_step`, and `flow_record_stop`.

The `flow/explore` MCP prompt tells an agent to declare logical steps, prefer selector-based `ui_tap`, use coordinate taps only when necessary, observe after changes and verify the final state.

## Development

```bash
pnpm --filter @escrcpy/flow-mcp typecheck
pnpm --filter @escrcpy/flow-mcp test
pnpm --filter @escrcpy/flow-mcp build
```

Tests inject a fake flow-device backend and verify that an MCP recording creates parseable JSONL plus snapshot files; no Android device is required.
