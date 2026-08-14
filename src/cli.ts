#!/usr/bin/env node
/**
 * Diagnostic CLI. Answers, from the terminal, the question the library answers from code: which
 * applications' focused fields are visible, and how would insertion reach them?
 *
 *   macos-insertable doctor          — platform, permission, secure-input state
 *   macos-insertable watch [secs]    — follow the frontmost app; click into fields to test them
 *   macos-insertable sweep [--all]   — one pass over running apps (their REMEMBERED focus)
 *
 * Prints metadata only — roles, kinds, lengths, labels. Field content never leaves the process.
 */

import { execFileSync } from 'node:child_process'

import { loadBridge } from './addon.js'
import { readFocusedField } from './capture.js'
import { checkAccess } from './index.js'

import type { Capture } from './types.js'

function describe(capture: Capture): string {
  switch (capture.status) {
    case 'field': {
      const f = capture.field
      const label = f.label ? ` label="${f.label.slice(0, 32)}"` : ''
      return `${f.surface === 'readable' ? 'insertable (verified writes)' : 'insertable (paste-only)'} — ${f.kind}${f.multiline ? ', multiline' : ''}${f.readOnly ? ', READ-ONLY' : ''}, ${f.value.length} chars${label}`
    }
    case 'secure-field':
      return 'secure field — refused by design'
    case 'disabled':
      return `disabled ${capture.role}`
    case 'not-a-field':
      return `not a field (${capture.role}${capture.subrole ? `/${capture.subrole}` : ''})`
    case 'no-element':
      return 'no focused element reported'
    case 'no-permission':
      return 'Accessibility permission missing'
    case 'unsupported':
      return 'unsupported platform or addon not built'
  }
}

function doctor(): void {
  const access = checkAccess()
  console.log(`platform supported : ${access.supported}`)
  console.log(`accessibility trust: ${access.trusted}`)
  console.log(`secure input active: ${access.secureInput}`)
  if (!access.supported) {
    console.log('\nThis library reads other applications only on macOS with the addon built.')
  } else if (!access.trusted) {
    console.log(
      '\nGrant Accessibility to this terminal: System Settings → Privacy & Security → Accessibility.'
    )
  }
}

async function watch(seconds: number): Promise<void> {
  const bridge = loadBridge()
  if (!bridge) {
    doctor()
    return
  }
  console.log(`Watching the frontmost application for ${seconds}s — click into fields.\n`)
  const deadline = Date.now() + seconds * 1000
  let last = ''
  while (Date.now() < deadline) {
    const front = bridge.frontmostApp()
    if (front && front.pid !== process.pid) {
      const capture = await readFocusedField({ pid: front.pid })
      const line = `${(front.name || front.bundleId).padEnd(24)} ${describe(capture)}`
      if (line !== last) {
        last = line
        console.log(line)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

interface RunningApp {
  pid: number
  name: string
  kind: string
}

/** Foreground apps are the set a user can be typing into; --all adds menu-bar (UIElement) apps. */
function listApps(includeUIElement: boolean): RunningApp[] {
  const raw = execFileSync('lsappinfo', ['list'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const apps: RunningApp[] = []
  for (const block of raw.split(/^\s*\d+\)\s+/m).slice(1)) {
    const name = block.match(/^"([^"]*)"/)?.[1] ?? ''
    const pid = Number(block.match(/pid = (\d+)/)?.[1] ?? Number.NaN)
    const kind = block.match(/type="([^"]*)"/)?.[1] ?? ''
    if (!Number.isFinite(pid) || pid === process.pid) continue
    if (kind !== 'Foreground' && !(includeUIElement && kind === 'UIElement')) continue
    apps.push({ pid, name, kind })
  }
  return apps
}

async function sweep(includeUIElement: boolean): Promise<void> {
  const apps = listApps(includeUIElement)
  console.log(
    `Sweeping ${apps.length} apps. Background reads show each app's REMEMBERED focus — a` +
      ` "no focused element" verdict may only mean nothing was focused when the user left it;` +
      ` \`watch\` is the ground truth.\n`
  )
  const counts = new Map<string, number>()
  for (const app of apps) {
    const started = performance.now()
    const capture = await readFocusedField({ pid: app.pid, timeoutMs: 1000 })
    const elapsed = Math.round(performance.now() - started)
    counts.set(capture.status, (counts.get(capture.status) ?? 0) + 1)
    console.log(
      `${app.name.slice(0, 24).padEnd(24)} ${String(elapsed).padStart(4)}ms  ${describe(capture)}`
    )
  }
  console.log(`\n${[...counts.entries()].map(([status, n]) => `${status}=${n}`).join('  ')}`)
}

async function main(): Promise<void> {
  const [command = 'doctor', ...rest] = process.argv.slice(2)
  if (command === 'doctor') {
    doctor()
    return
  }
  if (command === 'watch') {
    await watch(Math.max(5, Number(rest[0]) || 30))
    return
  }
  if (command === 'sweep') {
    await sweep(rest.includes('--all'))
    return
  }
  console.error(
    `unknown command: ${command}\nusage: macos-insertable [doctor|watch [secs]|sweep [--all]]`
  )
  process.exit(2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
