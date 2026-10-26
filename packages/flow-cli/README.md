# @escrcpy/flow-cli

Command line for flows. M0 ships the device commands used to check `@escrcpy/flow-device` on a real phone; `mcp`, `compile`, `run` and `heal` arrive in later milestones.

```bash
pnpm --filter "./packages/flow-*" build
export YADB_PATH=$PWD/desktop/electron/resources/extra/common/yadb/yadb   # optional, ~3x faster dumps
node packages/flow-cli/dist/index.mjs dump -s <serial>
node packages/flow-cli/dist/index.mjs tap -s <serial> --text 搜索 --exact
node packages/flow-cli/dist/index.mjs --help
```
