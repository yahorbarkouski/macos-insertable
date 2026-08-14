import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // import.meta/__dirname interop for locating the compiled addon from both output formats.
  shims: true,
  target: 'node20'
})
