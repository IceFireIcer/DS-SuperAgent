#!/usr/bin/env node
// Copies the product's transparent blue mark into the README assets. The same vector is
// used for both colour schemes; its cyan rim and blue body keep their contrast on either
// background.
//
//   node dev/logo.mjs [out dir]        default: <repo>/docs/images (logo.svg, logo-dark.svg)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const source = readFileSync(new URL('../../../logo/whale.svg', import.meta.url), 'utf8')
const out = resolve(process.argv[2] ?? join(import.meta.dirname, '../../../docs/images'))
mkdirSync(out, { recursive: true })
for (const file of ['logo.svg', 'logo-dark.svg']) {
  writeFileSync(join(out, file), source)
  console.log(`wrote ${join(out, file)}`)
}
