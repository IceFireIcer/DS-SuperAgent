import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { namingFindings } from './check-product-naming.mjs'

test('runtime naming rejects stale storage, environment, route, and bridge identifiers', () => {
  assert.deepEqual(namingFindings('superagent/dsh/client.js', [
    'const appearance = "ds-bot:appearance"',
    'const bridge = window.dshDesktop || window.dsBotApp',
    'const queue = window.dshBotQueue',
    'const setup = process.env.DS_BOT_HOME',
    'fetch("/api/bot/send")',
    'var copy = "needs both a key and certificate"',
    'var style = ".bt-chat{color:var(--bt-ink)}"',
  ].join('\n')).rejected, [1, 2, 3, 4, 5])
})

test('only the attribution line and exact known boundary literals are exempt', () => {
  assert.deepEqual(namingFindings('app/src/product.mjs', [
    '// Adapted from DS Bot 0.3.8 (Apache-2.0)',
    "const root = join(homedir(), '.ds-bot'); const branding = 'DS Bot'",
    '// Adapted from DS Bot 0.3.8 (Apache-2.0)',
  ].join('\n')), { rejected: [2, 3], attributions: 1, boundaries: 1 })
  assert.deepEqual(namingFindings('app/src/unrelated.mjs', "join(homedir(), '.ds-bot')").rejected, [1])
})

test('ported desktop source recognizes its versioned attribution line', () => {
  assert.deepEqual(namingFindings('superagent/dsh/src/client/settings-shell.js', [
    '// The settings surface follows DS Bot 0.3.10\'s grouped console.',
    'const label = "DS Bot settings"',
  ].join('\n')), { rejected: [2], attributions: 1, boundaries: 0 })
})

test('the CI command requires runtime bundles and rejects legacy names in desktop HTML and asset paths', context => {
  const temp = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(temp, 'ds-superagent-naming-')))
  assert.equal(dirname(root), temp)
  context.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const scanner = join(root, 'scripts', 'check-product-naming.mjs')
  mkdirSync(dirname(scanner))
  copyFileSync(new URL('./check-product-naming.mjs', import.meta.url), scanner)
  const write = (file, content = '') => {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    execFileSync('git', ['add', '--', file], { cwd: root })
  }
  const run = () => spawnSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8', timeout: 10000 })
  write('superagent/dsh/client.js')
  write('superagent/dsh/web-search.js')
  const missing = run()
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stderr, /Missing runtime bundle: superagent\/dsh\/office\.js/u)

  write('superagent/dsh/office.js')
  write('docs/port.md', 'Ported from DS Bot.')
  const clean = run()
  assert.equal(clean.status, 0, clean.stderr)

  write('app/ui/index.html', '<title>DS Bot</title>')
  write('app/assets/ds-bot.png')
  const rejected = run()
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.match(rejected.stderr, /app\/ui\/index\.html:1/u)
  assert.match(rejected.stderr, /app\/assets\/ds-bot\.png \(filename\)/u)
  assert.doesNotMatch(rejected.stderr, /docs\/port\.md/u)
})
