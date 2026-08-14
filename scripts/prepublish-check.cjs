/**
 * Refuses to publish a package that would not work when installed.
 *
 * Every failure here has been shipped by somebody: a tarball with no build output, a native
 * package with no prebuilds so every consumer needs a compiler, an entry point that names a file
 * the whitelist excludes. The checks are cheap and run from `prepublishOnly`, where a non-zero
 * exit stops the publish.
 */

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

function require_(relativePath, why) {
  if (!existsSync(join(root, relativePath))) problems.push(`missing ${relativePath} — ${why}`)
}

// Build output the entry points name.
require_('dist/index.js', 'the ESM entry point; run `npm run build`')
require_('dist/index.cjs', 'the CommonJS entry point; run `npm run build`')
require_('dist/index.d.ts', 'the type declarations; run `npm run build`')
require_('dist/cli.js', 'the CLI named in "bin"; run `npm run build`')

// Prebuilt binaries, so installing does not require the Xcode Command Line Tools. N-API keeps
// them ABI-stable, so one per architecture covers every Node and Electron version.
require_(
  'prebuilds/darwin-arm64',
  'Apple Silicon users would have to compile; run `npm run prebuild`'
)
require_('prebuilds/darwin-x64', 'Intel users would have to compile; run `npm run prebuild`')

// The published version should be the one the changelog describes.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const documented = changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1]
if (documented !== pkg.version) {
  problems.push(`CHANGELOG documents ${documented ?? 'nothing'}, package.json says ${pkg.version}`)
}

// An os restriction would make npm refuse to install on Linux and Windows. This package is
// deliberately installable everywhere and reports "unsupported" at runtime instead, so that
// cross-platform applications can depend on it without branching their dependency tree.
if (pkg.os) problems.push('"os" is set, which would break installs on non-macOS platforms')

if (problems.length > 0) {
  console.error('\nRefusing to publish:\n')
  for (const problem of problems) console.error(`  • ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(`macos-insertable ${pkg.version}: ready to publish`)
