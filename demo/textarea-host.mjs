/**
 * A Chromium textarea target for external probing: real Electron window, accessibility tree
 * enabled from inside, focused <textarea>. Writes "READY <pid>" to the file given as argv, then
 * serves until killed (dead-man exit after 90s so a stuck probe can't leak it).
 *
 *   npx electron textarea-host.mjs /tmp/ready-file
 */

import { writeFileSync } from 'node:fs'
import { BrowserWindow, app } from 'electron'

const readyPath = process.argv[2]

const mode = process.argv[3] ?? 'textarea'

// The placeholder mode mirrors how rich composers (Lexical/ProseMirror-style) really behave:
// the placeholder is a literal text node INSIDE the editable plus aria-placeholder, so the
// accessibility value reads as the placeholder text while the field is semantically empty.
const pages = {
  textarea:
    '<textarea id="t" autofocus style="width:480px;height:240px;font:14px monospace"></textarea>',
  staticfocus:
    '<div id="t" tabindex="0" style="width:480px;height:240px;font:14px monospace">just some readable text, focusable but not editable</div>' +
    '<script>document.getElementById("t").focus()</script>',
  // A Google-Docs-shaped decoy: a contenteditable strip one pixel tall and full width, holding
  // two zero-width spaces — the measured signature of the real thing. Pastes land in it (it is
  // a genuine contenteditable), but no human-usable box exists.
  docsdecoy:
    '<div id="t" contenteditable="true" aria-label="Document content" ' +
    'style="width:625px;height:1px;overflow:hidden;font:14px monospace">​​</div>' +
    '<script>const t=document.getElementById("t");t.focus();' +
    'const sel=getSelection();sel.collapse(t.firstChild,2)</script>',
  // The variant that escaped the exact-equality guard: the contenteditable keeps a trailing
  // <br>, so the accessibility value reads "Ask anything…\n" — placeholder plus artifact —
  // and the caret parks INSIDE the phantom.
  placeholder2:
    '<div id="t" contenteditable="true" aria-placeholder="Ask anything…" ' +
    'style="width:480px;height:240px;font:14px monospace;border:1px solid gray">Ask anything…<br></div>' +
    '<script>const t=document.getElementById("t");t.focus();' +
    'const sel=getSelection();sel.collapse(t.firstChild,5)</script>',
  placeholder:
    '<div id="t" contenteditable="true" aria-placeholder="Ask anything…" ' +
    'style="width:480px;height:240px;font:14px monospace;border:1px solid gray">Ask anything…</div>' +
    '<script>const t=document.getElementById("t");t.focus();' +
    'const sel=getSelection();sel.collapse(t,0)</script>'
}

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  const window = new BrowserWindow({ width: 520, height: 300, show: true })
  // charset is load-bearing: without it Chromium decodes the percent-escapes as Latin-1 and
  // every multi-byte character (zero-width spaces, ellipses) becomes mojibake.
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(pages[mode] ?? pages.textarea)}`
  )
  setTimeout(() => {
    if (readyPath) writeFileSync(readyPath, `READY ${process.pid}\n`)
    console.log(`READY ${process.pid}`)
  }, 800)
  setTimeout(() => app.exit(0), 90_000)
})
