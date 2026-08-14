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

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  const window = new BrowserWindow({ width: 520, height: 300, show: true })
  await window.loadURL(
    'data:text/html,<textarea id="t" autofocus style="width:480px;height:240px;font:14px monospace"></textarea>'
  )
  setTimeout(() => {
    if (readyPath) writeFileSync(readyPath, `READY ${process.pid}\n`)
    console.log(`READY ${process.pid}`)
  }, 800)
  setTimeout(() => app.exit(0), 90_000)
})
