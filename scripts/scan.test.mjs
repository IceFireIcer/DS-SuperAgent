import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scanner = fileURLToPath(new URL('./scan.mjs', import.meta.url))
const scan = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-superagent-scan-'))
  try {
    for (const file of ['LICENSE', 'README.md', 'README.zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md', '.gitignore']) {
      writeFileSync(join(dir, file), '')
    }
    mkdirSync(join(dir, 'superagent', 'dsh'), { recursive: true })
    writeFileSync(join(dir, 'superagent', 'LICENSE'), '')
    writeFileSync(join(dir, 'superagent', 'package.json'), JSON.stringify({
      name: 'ds-superagent', author: 'IceFireIcer', description: 'DS SuperAgent fixture',
      files: ['LICENSE'], repository: 'fixture', homepage: 'fixture', bugs: 'fixture',
      exports: { './client': './dsh/client.js', './web-search': './dsh/web-search.js' },
      dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'requirements.md'), text)
    const result = spawnSync(process.execPath, [scanner, dir], { encoding: 'utf8' })
    assert.equal(result.error, undefined)
    return { code: result.status, output: result.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('published requirements can describe unfinished work and unsaved editor content', () => {
  const result = scan('用户可以区分草稿、待评审与完成。保存冲突必须保留草稿。')
  assert.equal(result.code, 0, result.output)
  assert.doesNotMatch(result.output, /draft-marker/)
})

test('explicit draft markers remain publication failures', () => {
  for (const text of ['# 草稿：设计尚未确认', '状态：草稿', '方案（' + '草稿）', 'DRAFT' + ' for review', 'TB' + 'D(owner)']) {
    const result = scan(text)
    assert.equal(result.code, 1, text)
    assert.match(result.output, /draft-marker/)
  }
})

test('describing editor content does not suppress other publication findings', () => {
  const result = scan('保存冲突保留草稿。\n本地位置 C:\\Users\\ExamplePerson\\private')
  assert.equal(result.code, 1)
  assert.match(result.output, /personal-path/)
})
