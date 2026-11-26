#!/usr/bin/env node
// Builds the transparent whale marks, square app icons, multi-size Windows icons, and
// the colour set used for product identities. The source logo and vector template are
// kept under source/; everything beside this script is generated.
//
//   node logo/build.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'app', 'package.json'))
const sharp = require('sharp')

const MARK_WIDTH = 1600
const MARK_HEIGHT = 945
const ICON_SIZE = 1024
const ICON_MARK_WIDTH = ICON_SIZE * 0.92
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]

const PALETTES = {
  blue: {
    body: ['#0A35D5', '#0B3CDD', '#0727B2'],
    accent: ['#009DFF', '#0078FF', '#0069FF', '#0099FF'],
    belly: ['#E8F4FF', '#C4E0FF', '#86BDFA'],
  },
  aurora: {
    body: ['#03788C', '#058396', '#024D5C'],
    accent: ['#73FFD9', '#1DE5CE', '#00ACB0', '#58F3D9'],
    belly: ['#E8FFF9', '#B8FCEF', '#75DCD3'],
  },
  rose: {
    body: ['#A90F47', '#B41A55', '#70022D'],
    accent: ['#FFA1BF', '#FF5589', '#E21B5D', '#FF7EA5'],
    belly: ['#FFEAF2', '#FFC7D9', '#F187AE'],
  },
  tangerine: {
    body: ['#B64000', '#C24C00', '#762200'],
    accent: ['#FFC46F', '#FF8C2C', '#F15B00', '#FFAF4F'],
    belly: ['#FFF1DE', '#FFD9AB', '#F7A85F'],
  },
  violet: {
    body: ['#5328B8', '#5D31C8', '#2B0D6E'],
    accent: ['#D6B5FF', '#A272FF', '#7345E5', '#C99BFF'],
    belly: ['#F3E9FF', '#DDC4FF', '#B58DEB'],
  },
  sky: {
    body: ['#066EA8', '#087AC2', '#023E60'],
    accent: ['#72E7FF', '#2ABAFF', '#0789D9', '#5DD9FF'],
    belly: ['#E4FBFF', '#BAF0FF', '#7AC9EA'],
  },
  emerald: {
    body: ['#057546', '#06804D', '#023C27'],
    accent: ['#A5FFCD', '#31DD8C', '#00A961', '#7CF7B8'],
    belly: ['#E5FFEF', '#BCF9D6', '#74DAA3'],
  },
  graphite: {
    body: ['#2C3444', '#343D50', '#11151E'],
    accent: ['#D7DDE8', '#919DAF', '#5A6578', '#C1CAD8'],
    belly: ['#F7F8FA', '#E0E4EA', '#A8B2C2'],
  },
}

const template = readFileSync(join(here, 'source', 'whale.template.svg'), 'utf8')
const silhouetteMask = template.match(/<mask id="mark-mask"[\s\S]*?<\/mask>/u)?.[0]
if (!silhouetteMask) throw new Error('the logo template has no mark mask')

function paint(tokens) {
  const values = {
    BODY_TOP: tokens.body[0],
    BODY_MID: tokens.body[1],
    BODY_BOTTOM: tokens.body[2],
    ACCENT_1: tokens.accent[0],
    ACCENT_2: tokens.accent[1],
    ACCENT_3: tokens.accent[2],
    ACCENT_4: tokens.accent[3],
    BELLY_1: tokens.belly[0],
    BELLY_2: tokens.belly[1],
    BELLY_3: tokens.belly[2],
  }
  return Object.entries(values).reduce((svg, [token, value]) => svg.replaceAll(`@${token}@`, value), template)
}

function productLogoModule(mark) {
  let inner = mark.replace(/^<svg[^>]*>\s*/u, '').replace(/<\/svg>\s*$/u, '')
  inner = inner.replace(/>\s+</gu, '><').trim()
  for (const id of ['mark-mask', 'body', 'accent', 'belly']) {
    inner = inner.replaceAll(`id="${id}"`, `id="__PRODUCT_LOGO_ID__-${id}"`)
      .replaceAll(`url(#${id})`, `url(#__PRODUCT_LOGO_ID__-${id})`)
  }
  return `// Generated from logo/whale.svg. Keep the geometry and palette in step with the
// product logo exports in that directory.
import { createElement as h, useId } from 'react'

export const PRODUCT_LOGO_VIEWBOX = '0 0 1600 945'
const PRODUCT_LOGO_MARKUP = \`${inner}\`

export function productLogoMarkup(id) {
  return PRODUCT_LOGO_MARKUP.replaceAll('__PRODUCT_LOGO_ID__', id)
}

export function ProductLogo({ size = 24, label = 'DS SuperAgent' }) {
  const id = \`bt-logo-\${useId().replaceAll(':', '')}\`
  return h('span', {
    className: 'bt-brand-whale',
    style: { width: \`\${(size * 1600 / 945).toFixed(2)}px\`, height: \`\${size}px\` },
    role: label ? 'img' : undefined,
    'aria-label': label || undefined,
  }, h('svg', {
    viewBox: PRODUCT_LOGO_VIEWBOX,
    focusable: 'false',
    'aria-hidden': true,
    dangerouslySetInnerHTML: { __html: productLogoMarkup(id) },
  }))
}
`
}

function squareIcon(mark) {
  const content = mark
    .replace(/^<svg[^>]*>\s*/u, '')
    .replace(/<\/svg>\s*$/u, '')
  const width = ICON_MARK_WIDTH
  const height = (width * MARK_HEIGHT) / MARK_WIDTH
  const x = (ICON_SIZE - width) / 2
  const y = (ICON_SIZE - height) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" role="img" aria-label="DS SuperAgent">
<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="0 0 ${MARK_WIDTH} ${MARK_HEIGHT}">${content}</svg>
</svg>
`
}

function silhouetteSvg() {
  const mask = silhouetteMask.replace('id="mark-mask"', 'id="silhouette-mask"')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_WIDTH}" height="${MARK_HEIGHT}" viewBox="0 0 ${MARK_WIDTH} ${MARK_HEIGHT}" role="img" aria-label="DS SuperAgent">
<defs>${mask}</defs>
<g mask="url(#silhouette-mask)"><rect width="${MARK_WIDTH}" height="${MARK_HEIGHT}" fill="#4D6BFE"/></g>
</svg>
`
}

// PNG entries in an ICO file. Windows uses each image without scaling it up from one
// bitmap, so small taskbar and file-manager sizes stay crisp.
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

async function render(mark, directory) {
  mkdirSync(directory, { recursive: true })
  const icon = squareIcon(mark)
  writeFileSync(join(directory, 'whale.svg'), mark)
  writeFileSync(join(directory, 'logo.svg'), icon)

  const markPng = await sharp(Buffer.from(mark)).resize({ width: MARK_WIDTH }).png().toBuffer()
  writeFileSync(join(directory, 'whale.png'), markPng)
  const iconPng = await sharp(Buffer.from(icon)).resize(ICON_SIZE).png().toBuffer()
  writeFileSync(join(directory, 'logo.png'), iconPng)

  const images = await Promise.all(ICO_SIZES.map(async size => ({
    size,
    png: await sharp(Buffer.from(icon)).resize(size).png().toBuffer(),
  })))
  writeFileSync(join(directory, 'logo.ico'), icoFile(images))
  return markPng
}

async function writePreview(marks) {
  const cardWidth = 360
  const cardHeight = 380
  const columns = 4
  const gap = 24
  const margin = 80
  const titleHeight = 88
  const width = margin * 2 + columns * cardWidth + (columns - 1) * gap
  const rows = Math.ceil(marks.length / columns)
  const height = titleHeight + margin + rows * cardHeight + (rows - 1) * gap + margin
  const cards = await Promise.all(marks.map(async ({ label, png }, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = margin + column * (cardWidth + gap)
    const y = titleHeight + margin + row * (cardHeight + gap)
    const image = await sharp(png).resize({ width: 300 }).png().toBuffer()
    const imageHeight = Math.round((300 * MARK_HEIGHT) / MARK_WIDTH)
    return `<g>
<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="28" fill="#FFFFFF"/>
<rect x="${x}.5" y="${y}.5" width="${cardWidth - 1}" height="${cardHeight - 1}" rx="27.5" fill="none" stroke="#E4E9F2"/>
<image x="${x + 30}" y="${y + 58 + (200 - imageHeight) / 2}" width="300" height="${imageHeight}" href="data:image/png;base64,${image.toString('base64')}"/>
<text x="${x + cardWidth / 2}" y="${y + 322}" text-anchor="middle" fill="#1B2333" font-family="Segoe UI, sans-serif" font-size="24" font-weight="600">${label}</text>
</g>`
  }))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#F6F8FC"/>
<text x="${margin}" y="78" fill="#111827" font-family="Segoe UI, sans-serif" font-size="38" font-weight="650">DS SuperAgent logo colours</text>
${cards.join('')}
</svg>
`
  await sharp(Buffer.from(svg)).png().toFile(join(here, 'preview.png'))
}

const marks = []
for (const [name, tokens] of Object.entries(PALETTES)) {
  const mark = paint(tokens)
  const directory = name === 'blue' ? here : join(here, 'variants', name)
  const png = await render(mark, directory)
  marks.push({ label: name[0].toUpperCase() + name.slice(1), png })
  console.log(`logo: wrote ${name}`)
}
writeFileSync(join(here, 'silhouette.svg'), silhouetteSvg())
writeFileSync(join(here, '..', 'superagent', 'dsh', 'src', 'client', 'product-logo.js'), productLogoModule(paint(PALETTES.blue)))
await writePreview(marks)
console.log('logo: wrote silhouette.svg, preview.png and the client brand module')
