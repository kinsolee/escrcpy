import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  dts: true,
  publint: false,
  deps: {
    neverBundle: ['@escrcpy/adbx', 'sharp'],
  },
})
