import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { parse } from 'yaml'

// npm installs the peers that the DSH packages ask for, but electron-builder packs only the
// dependencies it finds through `dependencies` and `optionalDependencies`. A package that npm
// installed only as a peer would be left out of the installer, and the Host would not boot.
test('every package that the app runs on is a dependency, not only a peer', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const peerOnly = Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && entry.peer && !entry.dev && !entry.devOptional)
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//u, '')}@${entry.version}`)
  assert.deepEqual(peerOnly, [], `add these to "dependencies" in app/package.json: ${peerOnly.join(' ')}`)
})

test('sharp native modules and versioned libvips libraries are unpacked together', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const root = resolve('app-fixture')
  const filter = new FileMatcher(root, root, value => value, config.asarUnpack).createFilter()
  const stat = { isDirectory: () => false }
  for (const file of [
    '@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node',
    '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-linux-arm64/lib/sharp-linux-arm64.node',
    '@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
    '@img/sharp-win32-x64/lib/libvips-42.dll',
    'pnpm/bin/pnpm.cjs',
  ]) assert.equal(filter(join(root, 'node_modules', file), stat), true, file)
  assert.equal(filter(join(root, 'node_modules/yaml/dist/index.js'), stat), false)
})

test('Linux leaves the Host and its dependencies readable by plain Node', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(config.linux.asar, false)
  assert.notEqual(config.mac.asar, false)
  assert.notEqual(config.win.asar, false)
})

// A release is tagged with the version of ds-superagent, and the installed apps compare their own
// version with the one in the release's latest.yml.
test('the app has the version of ds-superagent', () => {
  const version = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).version
  assert.equal(version('../package.json'), version('../../superagent/package.json'))
})

test('the desktop shell port retains Fei2411 Apache-2.0 provenance', () => {
  const notice = readFileSync(new URL('../../NOTICE', import.meta.url), 'utf8')
  const packagedNotice = readFileSync(new URL('../assets/NOTICE', import.meta.url), 'utf8')
  const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8')
  const packagedLicense = readFileSync(new URL('../assets/LICENSE', import.meta.url), 'utf8')
  assert.equal(packagedNotice, notice, 'the installer carries the repository NOTICE')
  assert.equal(packagedLicense, license, 'the installer carries the repository Apache license')
  const builder = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.ok(builder.files.includes('assets/**'), 'the license files are part of the packaged app')
  assert.match(notice, /DS Bot \(https:\/\/github\.com\/Fei2411\/DS-Bot\)[\s\S]*Copyright 2026 Fei2411 and the DS Bot contributors[\s\S]*Apache License, Version 2\.0/u)
  assert.match(notice, /tag v0\.3\.8, commit 5e9b7da8882da3b68d8a0624342708c2150a9156/u)
  for (const file of [
    'app/src/main.mjs', 'app/src/preload.cjs', 'app/src/first-run.mjs', 'app/src/start-window.mjs',
    'app/src/place.mjs', 'app/src/picker-host.mjs', 'app/src/folder-picker.mjs', 'app/src/downloads.mjs',
    'app/src/logs.mjs', 'app/src/notifications.mjs', 'app/src/computer-indicator.mjs',
    'app/src/computer-cursor.mjs', 'app/src/material.css', 'app/src/page-card.css', 'app/src/macos.css',
    'app/scripts/dist.mjs', 'app/scripts/release-notes.mjs', 'app/scripts/seed-electron-checksums.mjs',
  ]) assert.ok(notice.includes(file), `${file} is included in the attribution inventory`)
  assert.doesNotMatch(notice, /Feishu2411|Feishu/u)
})

// Tool processes (bash, scripts a Bot runs) connect to devices on the local network;
// macOS blocks them outright when Info.plist has no NSLocalNetworkUsageDescription.
test('the mac package asks macOS for local network access', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(typeof config.mac?.extendInfo?.NSLocalNetworkUsageDescription, 'string')
  assert.notEqual(config.mac.extendInfo.NSLocalNetworkUsageDescription.trim(), '')
})
