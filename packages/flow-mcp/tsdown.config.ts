import { defineConfig } from 'tsdown'

export default defineConfig([
  // Workspace build: dependencies stay external except flow-device, which is
  // bundled because its consumers expect a single-file artifact.
  {
    entry: ['src/index.ts'],
    dts: true,
    publint: false,
    deps: {
      neverBundle: ['@escrcpy/flow-device'],
    },
  },
  // Self-contained build for external agents (the desktop app ships this as
  // extra/common/flow-mcp/agent.mjs): every dependency inlined so a plain
  // `node agent.mjs` works outside the workspace. tsdown keeps plain
  // `dependencies` external by default, so alwaysBundle forces them all
  // into the single file.
  {
    entry: { agent: 'src/index.ts' },
    outDir: 'dist',
    dts: false,
    publint: false,
    platform: 'node',
    deps: {
      alwaysBundle: /.*/,
    },
    // The lazy sharp import must not split into extra chunks: the agent
    // artifact has to stay a single self-contained file.
    outputOptions: { inlineDynamicImports: true },
  },
])
