import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Arch } from 'electron-builder'
import { archProblem, beforePack, officeRuntimeRequest } from '../scripts/before-pack.mjs'
import { runtimeTarget } from '../scripts/prepare-runtime.mjs'

test('a build for the architecture of this Node goes on', async () => {
  assert.equal(archProblem({ target: 'arm64', platform: 'darwin', host: 'arm64', hostPlatform: 'darwin' }), undefined)
  assert.equal(archProblem({ target: 'x64', platform: 'win32', host: 'x64', hostPlatform: 'win32' }), undefined)
  const asked = []
  const packager = { projectDir: 'app-dir', appInfo: { version: '0.0.0' } }
  await beforePack({ arch: Arch[process.arch], electronPlatformName: process.platform, packager }, async (request) => { asked.push(request) })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].target, runtimeTarget(process.platform, process.arch))
  assert.equal(asked[0].output, join('app-dir', 'build', 'runtime'))
})

test('a build for another architecture stops and says where to build it', async () => {
  assert.equal(archProblem({ target: 'x64', platform: 'darwin', host: 'arm64', hostPlatform: 'darwin' }),
    'This Node runs on arm64, so npm installed arm64 native modules, and an x64 app with them would not start. Install the dependencies and build on an Intel Mac, or under Rosetta with an x64 Node.')
  assert.match(archProblem({ target: 'arm64', platform: 'darwin', host: 'x64', hostPlatform: 'darwin' }), /build on a Mac with Apple silicon\.$/)
  assert.match(archProblem({ target: 'x64', platform: 'win32', host: 'arm64', hostPlatform: 'win32' }), /build with an x64 Node\.$/)
  assert.match(archProblem({ target: 'universal', platform: 'darwin', host: 'arm64', hostPlatform: 'darwin' }), /Build one app per architecture\./)
  const other = process.arch === 'x64' ? 'arm64' : 'x64'
  await assert.rejects(beforePack({ arch: Arch[other], electronPlatformName: process.platform }), new RegExp(`an ${other} app with them would not start`))
})

test('a build for another operating system stops even with the same architecture', async () => {
  assert.equal(archProblem({ target: 'x64', platform: 'win32', host: 'x64', hostPlatform: 'linux' }),
    'This Node runs on linux, so npm installed linux native modules, and a Windows x64 app with them would not start. Install the dependencies and build on Windows with an x64 Node.')
  assert.match(archProblem({ target: 'arm64', platform: 'linux', host: 'x64', hostPlatform: 'darwin' }),
    /and a Linux arm64 app with them would not start\. Install the dependencies and build on Linux with an arm64 Node\.$/)
  assert.match(archProblem({ target: 'x64', platform: 'linux', host: 'x64', hostPlatform: 'win32' }),
    /This Node runs on win32, so npm installed win32 native modules, and a Linux x64 app/)
  await assert.rejects(
    beforePack({ arch: Arch.x64, electronPlatformName: 'win32' }, async () => {}, { arch: 'x64', platform: 'linux' }),
    /a Windows x64 app with them would not start/)
})

test('a requested universal build stops before packing either architecture', async () => {
  // electron-builder's MacPackager.doUniversalPack packs x64 then arm64: the hook sees a concrete
  // arch each time, and the universal request only shows in packager.packagerOptions.targets.
  const packager = { packagerOptions: { targets: new Map([[{ nodeName: 'darwin' }, new Map([[Arch.universal, ['dmg']]])]]) } }
  await assert.rejects(beforePack({ arch: Arch.x64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
  await assert.rejects(beforePack({ arch: Arch.arm64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
})

test('electron-builder runs the check before it packs', () => {
  const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /^beforePack: \.\/scripts\/before-pack\.mjs$/m)
  // The check above is the only protection: a rebuild would replace the native modules.
  assert.match(config, /^npmRebuild: false$/m)
})

test('the Office payload goes next to the asar for a platform the lock pins', () => {
  const request = officeRuntimeRequest({ arch: Arch.x64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir', appInfo: { version: '9.9.9' } } })
  assert.equal(request.target, 'win-x64')
  assert.equal(request.version, '9.9.9')
  assert.equal(request.output, join('app-dir', 'build', 'runtime'))
  assert.throws(() => officeRuntimeRequest({ arch: Arch.arm64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir' } }), /No Office runtime payload for win32 arm64/)
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /from: build\/runtime\/primary-runtime\r?\n\s+to: primary-runtime/u)
})

test('the package reads its runtime cache from the product environment', () => {
  const previous = process.env.DS_SUPERAGENT_RUNTIME_CACHE
  process.env.DS_SUPERAGENT_RUNTIME_CACHE = 'product-runtime-cache'
  try {
    const request = officeRuntimeRequest({ arch: Arch.x64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir' } })
    assert.equal(request.cache, 'product-runtime-cache')
  } finally {
    if (previous === undefined) delete process.env.DS_SUPERAGENT_RUNTIME_CACHE
    else process.env.DS_SUPERAGENT_RUNTIME_CACHE = previous
  }
})
