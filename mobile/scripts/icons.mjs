#!/usr/bin/env node
// Builds the Expo, iOS and Android icons from the transparent blue product mark.
//
//   node scripts/icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const assets = join(here, '..', 'assets')
const require = createRequire(join(root, 'app', 'package.json'))
const sharp = require('sharp')

const mark = readFileSync(join(root, 'logo', 'whale.svg'), 'utf8')
const silhouette = readFileSync(join(root, 'logo', 'silhouette.svg'), 'utf8')
const inner = svg => svg.replace(/^<svg[^>]*>\s*/u, '').replace(/<\/svg>\s*$/u, '')

function markInSquare(source, size, width, background = 'none') {
  const height = width * 945 / 1600
  const x = (size - width) / 2
  const y = (size - height) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${background === 'none' ? '' : `<rect width="${size}" height="${size}" fill="${background}"/>`}
<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="0 0 1600 945">${inner(source)}</svg>
</svg>
`
}

async function render(svg, size, file) {
  writeFileSync(join(assets, file), await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer())
}

await render(markInSquare(mark, 1024, 820, '#F7FAFF'), 1024, 'icon.png')
await render(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#E6F4FE"/></svg>`, 512, 'android-icon-background.png')
await render(markInSquare(mark, 512, 332), 512, 'android-icon-foreground.png')
await render(markInSquare(silhouette.replaceAll('#4D6BFE', '#000000'), 432, 332), 432, 'android-icon-monochrome.png')
await render(markInSquare(mark, 1024, 780), 1024, 'splash-icon.png')
await render(markInSquare(mark, 48, 42, '#F7FAFF'), 48, 'favicon.png')
console.log('mobile: wrote Expo, Android and splash icon assets')
