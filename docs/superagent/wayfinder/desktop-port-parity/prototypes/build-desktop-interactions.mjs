import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from '../../../../../superagent/node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const source = name => new URL(name, import.meta.url)
const result = await build({
  absWorkingDir: root,
  entryPoints: [fileURLToPath(source('desktop-preview.jsx'))],
  nodePaths: [fileURLToPath(new URL('../../../../../superagent/node_modules', import.meta.url))],
  bundle: true,
  minify: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  legalComments: 'inline',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
})

const javascript = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const license = await readFile(new URL('../../../../../superagent/node_modules/react/LICENSE', import.meta.url), 'utf8')
const preview = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><title>DS SuperAgent</title><div id="preview"></div><script>${javascript}</script>`
const template = await readFile(source('desktop-review.template.html'), 'utf8')
const previewLiteral = JSON.stringify(preview).replaceAll('<', '\\u003c')
await writeFile(source('desktop-interactions.html'), template.replace('/* PREVIEW_HTML */ null', () => previewLiteral).replace('<!-- REACT_LICENSE -->', () => `<!--\nReact, React DOM and Scheduler\n\n${license.trimEnd()}\n-->`))
