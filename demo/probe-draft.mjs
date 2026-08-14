/**
 * Chromium draft probe: launches the textarea host (a separate Electron process — writing AX
 * into one's own process crashes Chromium), pins its textarea by pid, and characterizes exactly
 * what the draft hot path depends on: how Chromium answers setSelectedTextRange over time, and
 * how each casRangeEdit step fares. No other application is touched and no focus is stolen —
 * drafts pin by element reference and do not require frontmost.
 *
 *   node probe-draft.mjs
 */

import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const lib = require(join(here, '..', 'dist', 'index.cjs'))
const bridge = require('node-gyp-build')(join(here, '..'))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const mode = process.argv[2] ?? 'textarea'
const readyPath = join(tmpdir(), `insertable-textarea-ready-${process.pid}`)
rmSync(readyPath, { force: true })
const electron = join(here, 'node_modules', '.bin', 'electron')
const host = spawn(electron, [join(here, 'textarea-host.mjs'), readyPath, mode], {
  stdio: 'ignore'
})

let hostPid = null
try {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && hostPid === null) {
    try {
      const match = readFileSync(readyPath, 'utf8').match(/READY (\d+)/)
      if (match) hostPid = Number(match[1])
    } catch {
      // Not ready yet.
    }
    await wait(100)
  }
  if (hostPid === null) throw new Error('textarea host never became ready')
  console.log('PROBE host pid:', hostPid)

  const raw = await bridge.readFocusedElement(hostPid, 500, 4000)
  if (!raw) throw new Error('host reports no focused element')
  console.log(
    'PROBE element:',
    raw.role,
    'settable(v/s):',
    raw.valueSettable,
    '/',
    raw.selectedTextSettable,
    'value:',
    JSON.stringify(raw.value),
    'placeholder:',
    JSON.stringify(raw.placeholder)
  )
  bridge.releaseElement(raw.token)

  if (mode === 'placeholder') {
    // The regression that materialized placeholders: stream into a composer whose AX value IS
    // its placeholder; the streamed text must land alone.
    const captured = await lib.captureFocusedField({ pid: hostPid })
    console.log(
      'PROBE capture:',
      captured.status,
      captured.status === 'field' ? `surface=${captured.field.surface} value=${JSON.stringify(captured.field.value)}` : ''
    )
    if (captured.status !== 'field') throw new Error('placeholder host not captured')
    const started = await captured.startDraft()
    console.log('PROBE startDraft ok:', started.ok, started.ok ? '' : started.reason)
    if (started.ok) {
      for (const partial of ['their', "they're going home"]) {
        const result = await started.draft.update(partial)
        console.log(`PROBE update("${partial}"):`, JSON.stringify(result))
      }
      const fresh = await captured.reread()
      console.log('PROBE final value:', JSON.stringify(fresh?.value))
      console.log(
        'PROBE phantom check:',
        fresh?.value.includes('Ask anything') ? 'FAILED — placeholder materialized' : 'clean'
      )
    }
    captured.release()
  } else {
    await runTextareaProbe(hostPid)
  }
} finally {
  host.kill('SIGKILL')
  rmSync(readyPath, { force: true })
}

async function runTextareaProbe(hostPid) {
  const raw2 = await bridge.readFocusedElement(hostPid, 500, 4000)
  if (!raw2) throw new Error('host reports no focused element')
  const rawToken = raw2.token
  await bridge.setValue(rawToken, 'hello world', 500, 4000)
  await wait(150)
  const aim = await bridge.setSelectedTextRange(rawToken, 3, 4, 500)
  console.log('PROBE setSelectedTextRange same-trip readback:', JSON.stringify(aim))
  for (const delay of [10, 35, 80, 200]) {
    await wait(delay)
    const state = await bridge.readElementState(rawToken, 500, 4000)
    console.log(`PROBE selection after +${delay}ms:`, state?.selectionStart, state?.selectionLength)
  }
  const casProbe = await bridge.casRangeEdit(rawToken, 0, 'hello world', 5, 5, ' brave', -1, -1, 0, 500)
  console.log('PROBE raw casRangeEdit:', JSON.stringify(casProbe))
  const afterCas = await bridge.readElementState(rawToken, 500, 4000)
  console.log('PROBE value after cas:', JSON.stringify(afterCas?.value))
  bridge.releaseElement(rawToken)

  const captured = await lib.captureFocusedField({ pid: hostPid })
  console.log(
    'PROBE capture:',
    captured.status,
    captured.status === 'field' ? captured.field.surface : ''
  )
  if (captured.status === 'field') {
    await captured.insert('', { mode: 'all' }).catch(() => {})
    const started = await captured.startDraft()
    console.log('PROBE startDraft ok:', started.ok, started.ok ? '' : started.reason)
    if (started.ok) {
      for (const partial of ['their', 'their going', "they're going home"]) {
        const t0 = performance.now()
        const result = await started.draft.update(partial)
        console.log(
          `PROBE update("${partial}"):`,
          JSON.stringify(result),
          `${(performance.now() - t0).toFixed(1)}ms`
        )
      }
      const fresh = await captured.reread()
      console.log('PROBE final value:', JSON.stringify(fresh?.value))
    }
    captured.release()
  }
}
