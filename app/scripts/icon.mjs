// Draws the product icon from the primary mark in ../logo and writes assets/icon.svg,
// assets/icon.png (1024 px), assets/icon.ico (Windows, 16 to 256 px), the tight mark used
// by the startup window, and the tray marks: assets/tray.ico (Windows), assets/tray.png
// (Linux) and assets/trayTemplate.png with its @2x (macOS).
// Usage: npm run icon. It runs itself again inside Electron, which turns the SVG into PNGs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const assets = join(dirname(here), '..', 'assets')
const brand = join(dirname(here), '..', '..', 'logo')
const brandIcon = readFileSync(join(brand, 'logo.svg'), 'utf8')
const brandMark = readFileSync(join(brand, 'whale.svg'), 'utf8')
const brandSilhouette = readFileSync(join(brand, 'silhouette.svg'), 'utf8')
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]
// The tray icon is small: the sizes a notification area shows, and one plain png for Linux.
const TRAY_ICO_SIZES = [16, 20, 24, 32]
const TRAY_PNG_SIZE = 24
// macOS draws a template image itself, in the colour of the menu bar: a black mark with the
// shape of the whale.
const TRAY_TEMPLATE_SIZES = [16, 32]
const WHALE_INK = '#4D6BFE'

const innerSvg = svg => svg.replace(/^<svg[^>]*>\s*/u, '').replace(/<\/svg>\s*$/u, '')

function iconSvg(size = 1024) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
${innerSvg(brandIcon)}
</svg>
`
}

// The tray mark: the whale alone, so that it still reads at the size of a tray icon. The
// macOS template is the same shape in black, because macOS paints it in the colour of the
// menu bar itself.
function traySvg(size, ink) {
  const width = size * 0.96
  const height = width * 945 / 1600
  const x = (size - width) / 2
  const y = (size - height) / 2
  const whale = innerSvg(brandSilhouette).replaceAll(WHALE_INK, ink)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="0 0 1600 945">${whale}</svg>
</svg>
`
}

// PNG entries in an .ico file, which Windows reads since Vista.
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

// Inside Electron: a page draws each SVG on a canvas of its exact size, so every size is
// drawn from the vectors rather than scaled down from a large bitmap.
async function renderInElectron(jobs) {
  const { BrowserWindow } = await import('electron')
  const page = new BrowserWindow({ show: false })
  await page.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const draw = async (list) => Promise.all(list.map(async ({ svg, size }) => {
    const image = new Image()
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }))
  const pngs = await page.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(jobs)})`)
  page.destroy()
  return pngs.map(data => Buffer.from(data, 'base64'))
}

if (process.versions.electron) {
  const jobs = [
    { svg: iconSvg(), size: 1024 },
    ...ICO_SIZES.map(size => ({ svg: iconSvg(size), size })),
    ...TRAY_ICO_SIZES.map(size => ({ svg: traySvg(size, WHALE_INK), size })),
    { svg: traySvg(TRAY_PNG_SIZE, WHALE_INK), size: TRAY_PNG_SIZE },
    ...TRAY_TEMPLATE_SIZES.map(size => ({ svg: traySvg(size, '#000000'), size })),
  ]
  // Not awaited at the top: Electron is ready only after the main module has run.
  const { app } = await import('electron')
  app.whenReady().then(() => renderInElectron(jobs)).then(([large, ...rest]) => {
    const small = rest.slice(0, ICO_SIZES.length)
    const tray = rest.slice(ICO_SIZES.length)
    writeFileSync(join(assets, 'icon.png'), large)
    writeFileSync(join(assets, 'icon.ico'), icoFile(ICO_SIZES.map((size, index) => ({ size, png: small[index] }))))
    writeFileSync(join(assets, 'tray.ico'), icoFile(TRAY_ICO_SIZES.map((size, index) => ({ size, png: tray[index] }))))
    writeFileSync(join(assets, 'tray.png'), tray[TRAY_ICO_SIZES.length])
    writeFileSync(join(assets, 'trayTemplate.png'), tray[TRAY_ICO_SIZES.length + 1])
    writeFileSync(join(assets, 'trayTemplate@2x.png'), tray[TRAY_ICO_SIZES.length + 2])
    app.exit(0)
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'icon.svg'), iconSvg())
  writeFileSync(join(assets, 'logo.svg'), brandMark)
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which would keep Electron plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const electron = createRequire(import.meta.url)('electron')
  const run = spawnSync(electron, [here], { stdio: 'inherit', env })
  if (run.status !== 0) process.exit(run.status ?? 1)
  console.log('icon: wrote assets/icon.svg, assets/icon.png, assets/icon.ico and the tray marks')
}
