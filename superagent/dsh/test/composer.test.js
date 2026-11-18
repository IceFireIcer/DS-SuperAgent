import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The composer bundled with a React stand-in for its conversation hooks.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/composer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
let effectsEnabled = false
let cleanups = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}],
  useRef: current => ({ current }),
  useEffect: effect => {
    if (effectsEnabled) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  },
}
const module = { exports: {} }
const windowObject = {}
const navigatorObject = { language: 'en-US' }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: windowObject, navigator: navigatorObject,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { MainComposer, useDictation } = module.exports

test('browser dictation drops the final result of a discarded recognition', () => {
  const heard = []
  class FakeRecognition {
    start() { FakeRecognition.current = this }
    stop() {}
    abort() {}
    result(text) {
      const result = Object.assign([{ transcript: text }], { isFinal: true })
      this.onresult({ resultIndex: 0, results: [result] })
    }
  }
  windowObject.SpeechRecognition = FakeRecognition
  const dictation = useDictation((text, final) => heard.push([text, final]))
  assert.equal(dictation.start({ continuous: false }), true)
  const first = FakeRecognition.current
  // A natural stop keeps the words the user just said.
  dictation.stop()
  first.result('first')
  assert.deepEqual(heard, [['first', true]])
  // Pause discards the engine, so its late final result never reaches the chat.
  dictation.discard()
  first.result('late')
  assert.deepEqual(heard, [['first', true]])
  // The engine from before the pause is stale even after listening resumes.
  dictation.start({ continuous: false })
  const second = FakeRecognition.current
  first.result('older')
  second.result('second')
  assert.deepEqual(heard, [['first', true], ['second', true]])
})

test('Main discards a speech catalog that resolves after the composer closes', async () => {
  let resolveCatalog
  let microphoneAccesses = 0
  Object.defineProperty(navigatorObject, 'mediaDevices', { configurable: true,
    get() { microphoneAccesses += 1; return undefined } })
  const speech = { catalog: () => new Promise(resolve => { resolveCatalog = resolve }) }
  effectsEnabled = true
  cleanups = []
  const tree = MainComposer({ onSend: async () => true, value: '', speechRemote: () => speech })
  const buttons = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'button') buttons.push(node)
    node.children?.forEach(visit)
  }
  visit(tree)
  const microphone = buttons.find(button => button.props['aria-label'] === 'Start dictation')
  assert.ok(microphone)
  microphone.props.onClick()
  cleanups.forEach(cleanup => cleanup())
  resolveCatalog({ ok: true, value: { providers: [{ id: 'local', preparation: { phase: 'ready' } }],
    selection: { providerId: 'local' }, maxDurationSeconds: 10 } })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(microphoneAccesses, 0)
  effectsEnabled = false
})
