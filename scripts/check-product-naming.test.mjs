import assert from 'node:assert/strict'
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
