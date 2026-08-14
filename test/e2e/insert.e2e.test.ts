/**
 * End-to-end: a real AppKit application is spawned, focused, captured, written into, and read
 * back — the full path through the compiled addon and the operating system, no fakes anywhere.
 *
 * Requirements, checked up front and reported as skips rather than failures:
 *  - macOS with the addon built
 *  - the Accessibility (TCC) grant on the process tree running this test
 *  - swiftc (ships with the Xcode Command Line Tools)
 *
 * The host app briefly takes real keyboard focus. Runs are serial by design — two hosts fighting
 * over frontmost would test the arbitration, not the library.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadBridge } from '../../src/addon.js'
import { type CapturedField, captureFocusedField } from '../../src/capture.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostSource = join(here, 'TestHost.swift')
// A real .app bundle launched through `open`: modern macOS ignores self-activation from a
// terminal-spawned background binary, while a LaunchServices launch activates reliably.
const hostBundle = join(here, 'host-bin', 'TestHost.app')
const hostBinary = join(hostBundle, 'Contents', 'MacOS', 'TestHost')

const bridge = process.platform === 'darwin' ? loadBridge() : null
const trusted = bridge?.isAccessibilityTrusted() ?? false
const hasSwift = (() => {
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const runnable = bridge !== null && trusted && hasSwift

function compileHost(): void {
  if (existsSync(hostBinary)) return
  mkdirSync(dirname(hostBinary), { recursive: true })
  writeFileSync(
    join(hostBundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>TestHost</string>
  <key>CFBundleIdentifier</key><string>dev.macos-insertable.testhost</string>
  <key>CFBundleName</key><string>InsertableTestHost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
  )
  execFileSync('xcrun', ['swiftc', '-O', '-o', hostBinary, hostSource], { stdio: 'inherit' })
}

let hostPid: number | null = null

async function startHost(mode: string): Promise<number> {
  compileHost()
  const readyPath = join(
    tmpdir(),
    `insertable-host-ready-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  // -n launches a fresh instance every time; LaunchServices performs the activation.
  execFileSync('open', ['-n', hostBundle, '--args', mode, readyPath])
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const match = readFileSync(readyPath, 'utf8').match(/READY (\d+)/)
      if (match?.[1]) {
        rmSync(readyPath, { force: true })
        hostPid = Number(match[1])
        return hostPid
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  rmSync(readyPath, { force: true })
  throw new Error('host never became frontmost')
}

async function stopHost(): Promise<void> {
  if (hostPid === null) return
  const killed = hostPid
  hostPid = null
  try {
    process.kill(killed, 'SIGKILL')
  } catch {
    // Already gone.
  }
  // Killing the frontmost app makes macOS restore focus to the previous one ASYNCHRONOUSLY. A
  // host launched before that lands gets announced frontmost and then robbed by the deferred
  // handoff — and a background app cannot reclaim focus by itself on modern macOS. Waiting the
  // handoff out is what makes each test's activation stick.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && bridge?.frontmostApp()?.pid === killed) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/** The host answers AX calls only once its run loop settles; capture retries briefly. */
async function captureHostField(pid: number): Promise<CapturedField> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const captured = await captureFocusedField({ pid, timeoutMs: 500 })
    if (captured.status === 'field') return captured
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('host field never became capturable')
}

/**
 * Inserts, retrying while the host is fighting focus-stealing prevention for frontmost. An
 * `app-changed` refusal here is the library being right — the host really was not frontmost at
 * that instant — so the test waits for the host's re-activation loop to win and tries again.
 */
async function insertOnceFrontmost(
  captured: CapturedField,
  text: string,
  options?: Parameters<CapturedField['insert']>[1]
): Promise<Awaited<ReturnType<CapturedField['insert']>>> {
  let last: Awaited<ReturnType<CapturedField['insert']>> = {
    delivered: false,
    reason: 'app-changed'
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await captured.insert(text, options)
    if (last.delivered || last.reason !== 'app-changed') return last
    // Only LaunchServices can put a background app back in front; `open` without -n aims it at
    // the already-running instance.
    execFileSync('open', [hostBundle])
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return last
}

beforeAll(() => {
  // A host leaked by an interrupted earlier run keeps re-asserting activation and fights every
  // test here for focus. Clear the field before playing on it.
  try {
    execFileSync('pkill', ['-x', 'TestHost'])
  } catch {
    // pkill exits non-zero when there was nothing to kill.
  }
})

afterEach(async () => {
  await stopHost()
})

describe.skipIf(!runnable).sequential('end-to-end against a live AppKit host', () => {
  it('captures an NSTextView as a readable multiline area and inserts at the caret', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)
    expect(captured.field).toMatchObject({ kind: 'area', surface: 'readable', multiline: true })

    const result = await insertOnceFrontmost(captured, 'hello from the outside')
    expect(result).toEqual({ delivered: true, via: 'accessibility' })

    const fresh = await captured.reread()
    expect(fresh?.value).toBe('hello from the outside')
  }, 30_000)

  it('replaces the whole value only through the verified accessibility write', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)
    await insertOnceFrontmost(captured, 'first draft')
    const replaced = await insertOnceFrontmost(captured, 'final text', { mode: 'all' })
    expect(replaced).toEqual({ delivered: true, via: 'accessibility' })
    expect((await captured.reread())?.value).toBe('final text')
  }, 30_000)

  it('captures an NSTextField as a single-line field', async () => {
    const pid = await startHost('textfield')
    using captured = await captureHostField(pid)
    expect(captured.field).toMatchObject({ kind: 'field', multiline: false, label: 'Host field' })
    expect(await insertOnceFrontmost(captured, 'typed into a field')).toEqual({
      delivered: true,
      via: 'accessibility'
    })
  }, 30_000)

  it('classifies a password field as secure and never captures it', async () => {
    const pid = await startHost('securefield')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const captured = await captureFocusedField({ pid, timeoutMs: 500 })
      if (captured.status === 'secure-field') return
      if (captured.status === 'field') {
        captured.release()
        throw new Error('a secure field must never be captured as a field')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('secure field never classified')
  }, 30_000)

  it('reports a focused button as not-a-field with its role', async () => {
    const pid = await startHost('button')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const captured = await captureFocusedField({ pid, timeoutMs: 500 })
      if (captured.status === 'not-a-field') {
        expect(captured.role).toBe('AXButton')
        return
      }
      if (captured.status === 'field') {
        captured.release()
        throw new Error(`a button must not be a field`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('button never classified')
  }, 30_000)

  it('delivers through the borrowed clipboard and puts the user clipboard back', async () => {
    if (!bridge) throw new Error('bridge missing')
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)

    const sentinel = `user clipboard sentinel ${Date.now()}`
    bridge.pasteboardWriteText(sentinel)

    const result = await insertOnceFrontmost(captured, 'pasted paragraph', {
      strategy: 'clipboard'
    })
    expect(result).toEqual({ delivered: true, via: 'clipboard' })
    expect((await captured.reread())?.value).toContain('pasted paragraph')

    // The borrow must be invisible afterwards: the user's clipboard is exactly what it was.
    const snapshot = bridge.pasteboardSnapshot()
    bridge.pasteboardDiscardSnapshot(snapshot.token)
    const restored = await new Promise<string>((resolve) => {
      // Restoration is asynchronous relative to the paste; poll briefly.
      const started = Date.now()
      const poll = () => {
        const text = execFileSync('pbpaste', { encoding: 'utf8' })
        if (text === sentinel || Date.now() - started > 3000) resolve(text)
        else setTimeout(poll, 100)
      }
      poll()
    })
    expect(restored).toBe(sentinel)
  }, 30_000)

  it('delivers through synthetic keystrokes without touching the clipboard', async () => {
    if (!bridge) throw new Error('bridge missing')
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)

    const sentinel = `clipboard untouched ${Date.now()}`
    bridge.pasteboardWriteText(sentinel)
    const countBefore = bridge.pasteboardChangeCount()

    const result = await insertOnceFrontmost(captured, 'typed characters', {
      strategy: 'keystrokes'
    })
    expect(result).toEqual({ delivered: true, via: 'keystrokes' })

    // Typing settles asynchronously in the host; read until the text shows up.
    let value = ''
    for (let attempt = 0; attempt < 30; attempt += 1) {
      value = (await captured.reread())?.value ?? value
      if (value.includes('typed characters')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(value).toContain('typed characters')
    expect(bridge.pasteboardChangeCount()).toBe(countBefore)
  }, 30_000)

  it('streams a draft: partials appear, a correction revises one word in place', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)

    let started = await captured.startDraft()
    for (
      let attempt = 0;
      attempt < 20 && !started.ok && started.reason === 'app-changed';
      attempt += 1
    ) {
      execFileSync('open', [hostBundle])
      await new Promise((resolve) => setTimeout(resolve, 150))
      started = await captured.startDraft()
    }
    if (!started.ok) throw new Error(`draft refused: ${started.reason}`)
    const draft = started.draft

    // The streaming shape: partial hypotheses land as the user "speaks", each a minimal edit.
    const partials = ['their', 'their going', 'their going home']
    const timings: number[] = []
    for (const partial of partials) {
      const startedAt = performance.now()
      expect(await draft.update(partial)).toEqual({ delivered: true })
      timings.push(Math.round(performance.now() - startedAt))
    }
    expect((await captured.reread())?.value).toBe('their going home')

    // The corrected transcript arrives: one word revised in place, tail untouched.
    expect(await draft.update("they're going home")).toEqual({ delivered: true })
    expect((await captured.reread())?.value).toBe("they're going home")

    // "Scratch that" — reconcile to empty, then the real sentence into the same anchor.
    expect(await draft.update('')).toEqual({ delivered: true })
    expect((await captured.reread())?.value).toBe('')
    expect(await draft.update('On my way.')).toEqual({ delivered: true })
    expect((await captured.reread())?.value).toBe('On my way.')

    console.log(`draft update latency per partial (ms): ${timings.join(', ')}`)
  }, 30_000)

  it('refuses a drifted draft instead of overwriting what the user typed', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)
    const started = await captured.startDraft()
    if (!started.ok) throw new Error(`draft refused: ${started.reason}`)
    expect(await started.draft.update('dictated text')).toEqual({ delivered: true })

    // The "user" rewrites the field through a channel the draft does not control. Typing
    // AFTER the region would not drift it — the region's coordinates survive — so the test
    // rewrites the region itself.
    await captured.insert('the user rewrote all of this', { mode: 'all' })

    expect(await started.draft.update('dictated text more')).toEqual({
      delivered: false,
      reason: 'draft-drifted'
    })
  }, 30_000)

  it('submits with Return after inserting', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)
    await insertOnceFrontmost(captured, 'line one')

    const submitted = await captured.submit()
    expect(submitted).toEqual({ submitted: true })

    // In a text view Return is a newline — proof the chord reached the field.
    let value = ''
    for (let attempt = 0; attempt < 30; attempt += 1) {
      value = (await captured.reread())?.value ?? value
      if (value.includes('\n')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(value).toBe('line one\n')
  }, 30_000)

  it('refuses to insert after the host loses frontmost', async () => {
    const pid = await startHost('textview')
    using captured = await captureHostField(pid)
    await stopHost()
    // The dead host cannot be frontmost; delivery must refuse rather than write elsewhere.
    const result = await captured.insert('must not land anywhere')
    expect(result.delivered).toBe(false)
  }, 30_000)
})

describe.skipIf(runnable)('end-to-end prerequisites', () => {
  it('reports why the live suite was skipped', () => {
    // Not a failure: contract and unit suites still ran. This names what is missing.
    const missing = [
      bridge === null ? 'compiled addon (macOS only)' : null,
      bridge !== null && !trusted ? 'Accessibility grant for this terminal' : null,
      !hasSwift ? 'swiftc (xcode-select --install)' : null
    ].filter((entry): entry is string => entry !== null)
    expect(missing.length).toBeGreaterThan(0)
  })
})
