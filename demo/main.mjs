/**
 * Demo island — a floating, NON-FOCUSABLE panel above every window that live-classifies the
 * focused field of whatever app the user is working in, and fires the library's capabilities
 * at it on button clicks.
 *
 * Non-focusable is the load-bearing property: clicking an island button must not move keyboard
 * focus, or the demo would capture the island instead of the field it points at. The panel also
 * floats above window layer 0, so the library's own frontmost detection structurally ignores it.
 *
 * Zero-build on purpose: plain JS against ../dist (run `pnpm build` at the repo root first).
 * Requiring the parent's build output directly — not a file: dependency — sidesteps package
 * managers caching a stale copy of the native addon.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, ipcMain } from 'electron'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const lib = require(join(here, '..', 'dist', 'index.cjs'))

const POLL_MS = 250
const STREAM_SCRIPT = [
  'their',
  'their going',
  'their going to',
  'their going to love',
  'their going to love this'
]
const STREAM_FINAL = "they're going to love this"

let window = null
let acting = false

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function log(text, tone = 'info') {
  send('log', { text, tone })
}

/** One island state per poll tick: the capture verdict, flattened for display. */
async function pollOnce() {
  if (acting) return
  const access = lib.checkAccess()
  if (!access.supported || !access.trusted) {
    send('state', { status: access.supported ? 'no-permission' : 'unsupported' })
    return
  }
  const capture = await lib.readFocusedField()
  if (capture.status === 'no-element' && capture.app?.pid === process.pid) return
  send('state', {
    status: capture.status,
    app: 'app' in capture ? (capture.app?.name ?? '') : '',
    field:
      capture.status === 'field'
        ? {
            kind: capture.field.kind,
            surface: capture.field.surface,
            label: capture.field.label,
            multiline: capture.field.multiline,
            readOnly: capture.field.readOnly,
            length: capture.field.value.length,
            selected:
              capture.field.selectionStart !== null && capture.field.selectionEnd !== null
                ? capture.field.selectionEnd - capture.field.selectionStart
                : 0
          }
        : null,
    role: 'role' in capture ? capture.role : '',
    secureInput: access.secureInput
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deterministic stand-in for an LLM cleanup, so the demo has no keys and no network. */
function improve(text) {
  const tidy = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bi\b/g, 'I')
    .replace(/\btheir going\b/gi, "they're going")
  const sentences = tidy
    .split(/(?<=[.!?])\s+/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ')
  return sentences && !/[.!?]$/.test(sentences) ? `${sentences}.` : sentences
}

async function withCapturedField(run) {
  const captured = await lib.captureFocusedField()
  if (captured.status !== 'field') {
    log(`refused: nothing insertable (${captured.status})`, 'bad')
    return
  }
  try {
    await run(captured)
  } finally {
    captured.release()
  }
}

const actions = {
  /** One-shot verified insert at the caret. */
  async insert() {
    const outcome = await lib.insertText('Hello from macos-insertable! ')
    log(
      outcome.delivered
        ? `delivered via ${outcome.via}`
        : `refused: ${outcome.reason}${outcome.capture ? ` (${outcome.capture.status})` : ''}`,
      outcome.delivered ? 'good' : 'bad'
    )
  },

  /** Three snippets in a row — repeated verified inserts against one pinned element. */
  async batch() {
    await withCapturedField(async (captured) => {
      for (const line of ['First snippet. ', 'Second snippet. ', 'Third snippet. ']) {
        const result = await captured.insert(line)
        if (!result.delivered) {
          log(`batch stopped: ${result.reason}`, 'bad')
          return
        }
        await wait(350)
      }
      log('batch: 3 inserts, all verified', 'good')
    })
  },

  /** The showpiece: words appear while "spoken", then one word is revised in place. */
  async stream() {
    await withCapturedField(async (captured) => {
      const started = await captured.startDraft()
      if (!started.ok) {
        log(`draft refused: ${started.reason}`, 'bad')
        return
      }
      const timings = []
      for (const partial of STREAM_SCRIPT) {
        const t0 = performance.now()
        const result = await started.draft.update(partial)
        timings.push(performance.now() - t0)
        if (!result.delivered) {
          log(`stream stopped: ${result.reason}`, 'bad')
          return
        }
        send('log', { text: `partial: "${partial}"`, tone: 'dim' })
        await wait(280)
      }
      await wait(500)
      const t0 = performance.now()
      const corrected = await started.draft.update(STREAM_FINAL)
      const correctionMs = performance.now() - t0
      if (!corrected.delivered) {
        log(`correction refused: ${corrected.reason}`, 'bad')
        return
      }
      const median = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)]
      log(
        `corrected "their"→"they're" in ${correctionMs.toFixed(1)}ms · median partial ${median.toFixed(1)}ms`,
        'good'
      )
    })
  },

  /** Stream a wrong take, then update('') — the region empties, nothing else is touched. */
  async scratch() {
    await withCapturedField(async (captured) => {
      const started = await captured.startDraft()
      if (!started.ok) {
        log(`draft refused: ${started.reason}`, 'bad')
        return
      }
      for (const partial of ['umm wait', 'umm wait this is', 'umm wait this is wrong']) {
        const result = await started.draft.update(partial)
        if (!result.delivered) {
          // Without this check a failed stream leaves an empty draft, and the final update('')
          // is a free no-op that would report a green "scratched" for text that never appeared.
          log(`scratch stream stopped: ${result.reason}`, 'bad')
          return
        }
        await wait(260)
      }
      await wait(600)
      const gone = await started.draft.update('')
      log(gone.delivered ? 'scratched — region emptied, rest untouched' : `refused: ${gone.reason}`,
        gone.delivered ? 'good' : 'bad')
    })
  },

  /** Read the whole field, clean it up, replace it — only through the verified write. */
  async improveAll() {
    await withCapturedField(async (captured) => {
      const fresh = await captured.reread()
      if (!fresh || fresh.surface !== 'readable' || fresh.value.length === 0) {
        log('improve needs a readable, non-empty field', 'bad')
        return
      }
      const better = improve(fresh.value)
      if (better === fresh.value) {
        log('already clean — nothing to improve', 'dim')
        return
      }
      const result = await captured.insert(better, { mode: 'all' })
      log(result.delivered ? 'improved the whole field (verified replace-all)' : `refused: ${result.reason}`,
        result.delivered ? 'good' : 'bad')
    })
  },

  /** Improve just the selection — the selection-replacement mode. */
  async improveSelection() {
    await withCapturedField(async (captured) => {
      const fresh = await captured.reread()
      if (!fresh?.selectedText) {
        log('select some text first', 'bad')
        return
      }
      const result = await captured.insert(improve(fresh.selectedText), { mode: 'selection' })
      log(result.delivered ? 'replaced the selection with its cleaned-up form' : `refused: ${result.reason}`,
        result.delivered ? 'good' : 'bad')
    })
  },

  /** Insert, then press the send chord — the dictate-and-send flow. */
  async send() {
    await withCapturedField(async (captured) => {
      const inserted = await captured.insert('Shipped with macos-insertable ✅')
      if (!inserted.delivered) {
        log(`refused: ${inserted.reason}`, 'bad')
        return
      }
      await wait(250)
      const submitted = await captured.submit()
      log(submitted.submitted ? 'inserted and sent (Return)' : `submit refused: ${submitted.reason}`,
        submitted.submitted ? 'good' : 'bad')
    })
  }
}

ipcMain.on('act', async (_event, kind) => {
  const action = actions[kind]
  if (!action || acting) return
  acting = true
  send('acting', kind)
  try {
    await action()
  } catch (err) {
    log(`error: ${err?.message ?? err}`, 'bad')
  } finally {
    acting = false
    send('acting', null)
  }
})

app.whenReady().then(() => {
  app.dock?.hide()
  window = new BrowserWindow({
    width: 420,
    height: 308,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: true,
    alwaysOnTop: true,
    // Load-bearing: clicks on the island must never move keyboard focus off the target field.
    focusable: false,
    type: 'panel',
    vibrancy: 'hud',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true
    }
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.loadFile(join(here, 'island.html'))
  window.showInactive()

  setInterval(() => {
    pollOnce().catch(() => {})
  }, POLL_MS)

  // Wiring self-test for CI-less verification: prove the poll loop produces a state, then exit.
  if (process.argv.includes('--self-test')) {
    setTimeout(async () => {
      await pollOnce().catch(() => {})
      console.log('self-test: access =', JSON.stringify(lib.checkAccess()))
      const capture = await lib.readFocusedField()
      console.log('self-test: focused =', capture.status)
      app.exit(0)
    }, 1500)
  }
})

app.on('window-all-closed', () => app.quit())
