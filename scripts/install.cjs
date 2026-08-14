/**
 * Install-time build. On macOS, `node-gyp-build` loads a shipped prebuild when one matches and
 * compiles from source otherwise (requires the Xcode Command Line Tools). Everywhere else the
 * package installs as an inert dependency: the runtime loader reports the platform as
 * unsupported, and cross-platform consumers keep working without a compiler in sight.
 */

if (process.platform !== 'darwin') process.exit(0)

const { execFileSync } = require('node:child_process')

try {
  execFileSync(process.execPath, [require.resolve('node-gyp-build/bin.js')], {
    stdio: 'inherit',
    cwd: require('node:path').join(__dirname, '..')
  })
} catch (err) {
  console.error(
    'macos-insertable: native build failed. Building from source needs the Xcode Command Line ' +
      'Tools (xcode-select --install). The library will report status "unsupported" until the ' +
      'addon is built.'
  )
  process.exit(1)
}
