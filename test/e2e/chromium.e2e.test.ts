/**
 * End-to-end against a live CHROMIUM text field — the engine with every measured quirk: async
 * write mirroring, inert kAXSelectedTextAttribute, and placeholders rendered as literal text in
 * the accessibility value. The host is a real Electron window (the demo's dev dependency; a
 * separate process, because writing AX into one's own process crashes Chromium).
 *
 * Prerequisites reported as skips: macOS + addon, Accessibility grant, and the demo's Electron
 * binary (`cd demo && npm install`). Unlike the AppKit suite this one does not need frontmost —
 * drafts pin by element reference — so it runs without stealing focus.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { loadBridge } from '../../src/addon.js'
import { type CapturedField, captureFocusedField } from '../../src/capture.js'
import { valueCarriesEvidence } from '../../src/classify.js'

const here = dirname(fileURLToPath(import.meta.url))
const demo = join(here, '..', '..', 'demo')
const electron = join(demo, 'node_modules', '.bin', 'electron')
const hostScript = join(demo, 'textarea-host.mjs')

const bridge = process.platform === 'darwin' ? loadBridge() : null
const runnable = bridge !== null && bridge.isAccessibilityTrusted() && existsSync(electron)

let hostProcess: ReturnType<typeof spawn> | null = null

async function startHost(mode: string): Promise<number> {
  const readyPath = join(tmpdir(), `insertable-chromium-e2e-${process.pid}-${mode}`)
  rmSync(readyPath, { force: true })
  hostProcess = spawn(electron, [hostScript, readyPath, mode], { stdio: 'ignore' })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const match = readFileSync(readyPath, 'utf8').match(/READY (\d+)/)
      if (match?.[1]) {
        rmSync(readyPath, { force: true })
        return Number(match[1])
      }
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  rmSync(readyPath, { force: true })
  throw new Error('chromium host never became ready')
}

afterEach(() => {
  hostProcess?.kill('SIGKILL')
  hostProcess = null
})

async function captureHost(pid: number): Promise<CapturedField> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const captured = await captureFocusedField({ pid, timeoutMs: 500 })
    if (captured.status === 'field') return captured
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('chromium host field never became capturable')
}

describe.skipIf(!runnable).sequential('end-to-end against a live Chromium field', () => {
  it('streams a draft into a plain textarea despite the async mirror', async () => {
    const pid = await startHost('textarea')
    using captured = await captureHost(pid)
    const started = await captured.startDraft()
    if (!started.ok) throw new Error(`draft refused: ${started.reason}`)

    for (const partial of ['their', 'their going', "they're going home"]) {
      expect(await started.draft.update(partial)).toEqual({ delivered: true })
    }
    expect((await captured.reread())?.value).toBe("they're going home")
  }, 30_000)

  it.each(['placeholder', 'placeholder2'])(
    'never materializes the rendered placeholder (%s)',
    async (mode) => {
      // `placeholder` exposes value === aria-placeholder exactly; `placeholder2` keeps a
      // trailing newline artifact AND parks the caret inside the phantom — the variant that
      // slipped past an exact-equality guard and typed the placeholder ahead of the stream.
      const pid = await startHost(mode)
      using captured = await captureHost(pid)

      // Decoration must never be reported as content.
      expect(captured.field.value).toBe('')

      const started = await captured.startDraft()
      if (!started.ok) throw new Error(`draft refused: ${started.reason}`)
      // A phantom anchor would place the region at the reported caret — inside decoration.
      expect(started.draft.range).toEqual({ start: 0, end: 0 })

      expect(await started.draft.update('their')).toEqual({ delivered: true })
      expect(await started.draft.update("they're going home")).toEqual({ delivered: true })

      const fresh = await captured.reread()
      expect(fresh?.value ?? '').not.toContain('Ask anything')
      expect(fresh?.value.startsWith("they're going home")).toBe(true)
    },
    30_000
  )
})

describe.skipIf(!runnable).sequential('the Google-Docs-shaped strip decoy', () => {
  it('classifies opaque and delivers exactly once, via clipboard', async () => {
    // The measured Docs signature: full-width, one pixel tall, scratch-only value. Classified
    // readable, AX writes tunneled into the document and the fallback paste landed a SECOND
    // copy, reported as failure. Opaque classification retires the whole chain: one paste,
    // trusted, no rung-1 writes to double it.
    const pid = await startHost('docsdecoy')
    using captured = await captureHost(pid)
    expect(captured.field.surface).toBe('opaque')
    expect(captured.field.value).toBe('')

    const inserted = await captured.insert('landed once ')
    expect(inserted).toEqual({ delivered: true, via: 'clipboard' })

    // Read the raw element (the strip is a real contenteditable, so the paste is visible in
    // its value) and count occurrences: exactly one.
    const bridge = loadBridge()
    if (!bridge) throw new Error('bridge missing')
    const raw = await bridge.readFocusedElement(pid, 500, 4000)
    if (!raw) throw new Error('strip not readable raw')
    const occurrences = raw.value.split('landed once').length - 1
    bridge.releaseElement(raw.token)
    expect(occurrences).toBe(1)
  }, 30_000)
})

describe.skipIf(runnable)('chromium end-to-end prerequisites', () => {
  it('reports why the live suite was skipped', () => {
    const missing = [
      bridge === null ? 'compiled addon (macOS only)' : null,
      bridge !== null && !bridge.isAccessibilityTrusted() ? 'Accessibility grant' : null,
      !existsSync(electron) ? 'demo Electron binary (cd demo && npm install)' : null
    ].filter((entry): entry is string => entry !== null)
    expect(missing.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!runnable).sequential('trust ladder against live Chromium', () => {
  it('inserts into an EMPTY web textarea with a single paste — the untrusted opening move', async () => {
    // An empty Chromium textarea is web + scratch: precise writes against it are undecidable
    // (Chromium reports success for inert writes), so the first delivery is one paste, which
    // creates its own evidence. Exactly one copy may land.
    const pid = await startHost('textarea')
    using captured = await captureHost(pid)
    expect(captured.field).toMatchObject({ surface: 'readable', web: true, value: '' })

    const inserted = await captured.insert('exactly once ')
    expect(inserted).toEqual({ delivered: true, via: 'clipboard' })

    const bridge2 = loadBridge()
    if (!bridge2) throw new Error('bridge missing')
    const raw = await bridge2.readFocusedElement(pid, 500, 4000)
    if (!raw) throw new Error('textarea unreadable raw')
    const occurrences = raw.value.split('exactly once').length - 1
    bridge2.releaseElement(raw.token)
    expect(occurrences).toBe(1)
  }, 30_000)

  it('grants precise writes back once the field carries real content', async () => {
    const pid = await startHost('textarea')
    using captured = await captureHost(pid)
    await captured.insert('seed. ')
    // Re-capture: the field now shows evidence, so the trust rule admits the AX rungs — on
    // Chromium those still fall through to a verified paste, but the ladder is engaged.
    const again = await captureFocusedField({ pid, timeoutMs: 500 })
    if (again.status !== 'field') throw new Error('recapture failed')
    expect(again.field.web).toBe(true)
    expect(valueCarriesEvidence(again.field.value)).toBe(true)
    again.release()
  }, 30_000)
})
