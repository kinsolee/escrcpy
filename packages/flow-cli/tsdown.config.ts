import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  publint: false,
  deps: {
    neverBundle: ['@devicefarmer/adbkit', '@escrcpy/adbx', '@escrcpy/flow-device'],
  },
})
