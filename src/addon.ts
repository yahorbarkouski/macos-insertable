/**
 * Loader for the compiled addon. Lazy and one-shot: a missing binary is a normal state
 * (non-darwin platforms, a source install without the Xcode CLT), not an error — every public
 * entry point reports it as the `unsupported` status instead of throwing.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { NativeBridge } from './bridge.js'

const require = createRequire(import.meta.url)

let cached: NativeBridge | null = null
let loadAttempted = false

export function loadBridge(): NativeBridge | null {
  if (loadAttempted) return cached
  loadAttempted = true
  if (process.platform !== 'darwin') return null
  try {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const load = require('node-gyp-build') as (dir: string) => NativeBridge
    cached = load(packageRoot)
  } catch {
    cached = null
  }
  return cached
}
