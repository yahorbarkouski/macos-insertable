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
  placeholder:
    '<div id="t" contenteditable="true" aria-placeholder="Ask anything…" ' +
    'style="width:480px;height:240px;font:14px monospace;border:1px solid gray">Ask anything…</div>' +
    '<script>const t=document.getElementById("t");t.focus();' +
    'const sel=getSelection();sel.collapse(t,0)</script>'
}

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  const window = new BrowserWindow({ width: 520, height: 300, show: true })
  await window.loadURL(`data:text/html,${encodeURIComponent(pages[mode] ?? pages.textarea)}`)
  setTimeout(() => {
    if (readyPath) writeFileSync(readyPath, `READY ${process.pid}\n`)
    console.log(`READY ${process.pid}`)
  }, 800)
  setTimeout(() => app.exit(0), 90_000)
})
