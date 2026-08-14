const { readdirSync, readFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const root = join(__dirname, '..')
const nativeRoot = join(root, 'native')
const problems = []

const nativeFiles = readdirSync(nativeRoot)
const implementationFiles = nativeFiles
  .filter((name) => /\.(?:c|cc|cpp|cxx|m|mm)$/.test(name))
  .sort()
const boundaryFiles = nativeFiles.filter((name) => /\.(?:h|c|cc|cpp|cxx|m|mm)$/.test(name)).sort()

const binding = readFileSync(join(root, 'binding.gyp'), 'utf8')
const configuredSources = [...binding.matchAll(/"(native\/[^"]+\.(?:c|cc|cpp|cxx|m|mm))"/g)]
  .map((match) => basename(match[1]))
  .sort()

if (new Set(configuredSources).size !== configuredSources.length) {
  problems.push('binding.gyp contains a duplicate native source')
}

for (const name of implementationFiles) {
  if (!configuredSources.includes(name)) problems.push(`${name} is not compiled by binding.gyp`)
  if (!name.endsWith('.mm')) problems.push(`${name} bypasses the Objective-C++/ARC boundary`)
}

const addon = readFileSync(join(nativeRoot, 'addon.mm'), 'utf8')
const exportedNames = [...addon.matchAll(/Export\(env, exports, "([^"]+)"/g)]
  .map((match) => match[1])
  .sort()
const bridge = readFileSync(join(root, 'src', 'bridge.ts'), 'utf8')
const nativeBridge = bridge.match(/export interface NativeBridge \{([\s\S]*?)\n\}/)?.[1] ?? ''
const contractedNames = [...nativeBridge.matchAll(/^ {2}([A-Za-z]\w*)\(/gm)]
  .map((match) => match[1])
  .sort()
if (exportedNames.join('\n') !== contractedNames.join('\n')) {
  problems.push(
    `addon exports do not match NativeBridge: expected [${contractedNames.join(', ')}], found [${exportedNames.join(', ')}]`
  )
}
for (const name of configuredSources) {
  if (!implementationFiles.includes(name)) problems.push(`binding.gyp names missing source ${name}`)
}

const allowedIncludes = {
  'accessibility.h': [],
  'accessibility_cas.mm': [
    'accessibility.h',
    'accessibility_internal.h',
    'addon_state.h',
    'napi_support.h'
  ],
  'accessibility_edit.mm': [
    'accessibility.h',
    'accessibility_internal.h',
    'addon_state.h',
    'napi_support.h'
  ],
  'accessibility_internal.mm': ['accessibility_internal.h'],
  'accessibility_internal.h': [],
  'accessibility_read.mm': [
    'accessibility.h',
    'accessibility_internal.h',
    'addon_state.h',
    'napi_support.h'
  ],
  'addon.mm': ['accessibility.h', 'addon_state.h', 'input.h', 'pasteboard.h', 'system.h'],
  'addon_state.h': [],
  'addon_state.mm': ['addon_state.h'],
  'input.h': [],
  'input.mm': ['input.h', 'napi_support.h', 'system.h'],
  'napi_support.h': [],
  'napi_support.mm': ['napi_support.h'],
  'pasteboard.h': [],
  'pasteboard.mm': ['addon_state.h', 'napi_support.h', 'pasteboard.h'],
  'system.h': [],
  'system.mm': ['napi_support.h', 'system.h']
}

for (const name of boundaryFiles) {
  const source = readFileSync(join(nativeRoot, name), 'utf8')
  const localIncludes = [...source.matchAll(/^#(?:include|import) "([^"]+)"/gm)]
    .map((match) => match[1])
    .sort()
  const expected = allowedIncludes[name]
  if (!expected) {
    problems.push(`${name} has no declared architecture boundary`)
    continue
  }
  if (localIncludes.join('\n') !== [...expected].sort().join('\n')) {
    problems.push(
      `${name} local includes changed: expected [${expected.join(', ')}], found [${localIncludes.join(', ')}]`
    )
  }
  if (
    name !== 'addon.mm' &&
    /NODE_API_MODULE|Napi::Function::New|napi_(?:add_env_cleanup_hook|define_properties|set_named_property)/.test(
      source
    )
  ) {
    problems.push(`${name} contains addon registration owned by addon.mm`)
  }
}

if (!binding.includes('"CLANG_ENABLE_OBJC_ARC": "YES"')) {
  problems.push('binding.gyp must compile every native implementation with ARC')
}
if (!binding.includes('"NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS"')) {
  problems.push('binding.gyp must make async completion safe during environment teardown')
}
if (nativeFiles.includes('insertable.mm')) {
  problems.push('native/insertable.mm must not return as a catch-all implementation')
}

if (problems.length > 0) {
  console.error('Native architecture check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `Native architecture: ${implementationFiles.length} implementation modules, one-way boundaries verified`
)
