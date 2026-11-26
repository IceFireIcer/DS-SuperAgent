import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const legacyName = /(?<![a-z\d])(?:ds[-_ ]?bot|dsh[-_ ]?bot|deepseek[-_ ]?bot|dshdesktop|fei2411)|\/api\/bot\b/giu
const legacyShellNames = "['DS Bot', 'DeepSeek Bot']"
const legacyBundleNames = "['ds-bot', 'deepseek-bot-engine', 'dsbot-engine', 'ds-superagent-host', 'ds-superagent-ui']"
const sourceNote = /^(?:\/\/|\/\*) (?:(?:Derived|Adapted|Ported) from DS Bot|.*\bDS Bot\b.*\b0\.3\.(?:8|10)\b)/iu
const runtimeText = /\.(?:[cm]?[jt]s|[jt]sx|jsonc?|ya?ml|css|html?|svg|xml|plist|nsh|ps1|sh|cmd|bat|desktop)$/iu
const runtimePaths = [
  'app/src', 'app/ui', 'app/assets', 'app/build/installer.nsh', 'app/electron-builder.yml', 'app/package.json', 'start.ps1',
  'superagent/src', 'superagent/dsh/src', 'superagent/dsh/client.js', 'superagent/dsh/office.js',
  'superagent/dsh/web-search.js', 'superagent/cordis.patch.yml', 'superagent/dsh.client.cordis.yml',
  'superagent/package.json', 'mobile',
]

// These literals identify data to reject, retired packages in the product's own profile, or a user-selected export format.
const boundaryLiterals = new Map([
  ['app/src/computer-driver.mjs', ['|dsbot|']],
  ['app/src/product.mjs', [legacyShellNames, "join(homedir(), '.ds-bot')"]],
  ['app/src/profile.mjs', [legacyBundleNames]],
  ['app/src/product-backups.mjs', ["join(homedir(), '.ds-bot')"]],
  ['superagent/src/local-environment.ts', ["resolve(homedir(), '.ds-bot'),"]],
  ['superagent/src/product-host.ts', ["join(homedir(), '.ds-bot')"]],
  ['superagent/src/product-memory-import.ts', ["root.schema !== 'ds-bot-memory-export'"]],
])

export function namingFindings(file, content) {
  const rejected = []
  let attributions = 0
  let boundaries = 0
  for (const [index, raw] of content.split(/\r?\n/u).entries()) {
    if (index === 0 && sourceNote.test(raw)) { attributions++; continue }
    let line = raw
    for (const literal of boundaryLiterals.get(file) ?? []) {
      if (!line.includes(literal)) continue
      line = line.replace(literal, '')
      boundaries++
    }
    if ([...line.matchAll(legacyName)].length) rejected.push(index + 1)
  }
  return { rejected, attributions, boundaries }
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...runtimePaths], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  }).split('\0').filter(Boolean)
  const files = [...new Set(paths)].filter(file => file === 'app/build/installer.nsh'
    || !/(?:^|\/)(?:node_modules|dist|build|test|tests)\//u.test(file))
  for (const bundle of ['superagent/dsh/client.js', 'superagent/dsh/office.js', 'superagent/dsh/web-search.js']) {
    if (!files.includes(bundle) || !existsSync(join(root, bundle))) throw new Error(`Missing runtime bundle: ${bundle}`)
  }
  let scanned = 0
  let attributions = 0
  const fixedBoundaries = []
  const rejected = []
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    if (file.search(legacyName) !== -1) rejected.push(`${file} (filename)`)
    if (!runtimeText.test(file)) continue
    const findings = namingFindings(file, readFileSync(path, 'utf8'))
    scanned++
    attributions += findings.attributions
    if (findings.boundaries) fixedBoundaries.push(`${file} (${findings.boundaries})`)
    for (const line of findings.rejected) rejected.push(`${file}:${line}`)
  }
  if (rejected.length) {
    console.error(`Unexpected legacy names:\n${rejected.join('\n')}`)
    process.exitCode = 1
  }
  console.log(`Checked ${scanned} runtime text files and product paths: ${rejected.length} unexpected hits, ${attributions} attribution lines.`)
  if (fixedBoundaries.length) console.log(`Explicit compatibility and denial literals:\n${fixedBoundaries.join('\n')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
