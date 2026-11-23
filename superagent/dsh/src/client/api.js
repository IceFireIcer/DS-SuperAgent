import { t } from './i18n.js'
import { createUpstreamAdapter } from './product-api-upstream.js'
import { getAppearance, setAppearance } from './appearance.js'

const productEndpoints = new Set(`
  open history send stop-main evidence observe-list observe-read observe-detail
  work-stop work-reconcile-stop work-handoff-prepare work-handoff-verify work-handoff work-retry work-resume
  work-answer work-answer-view work-board work-members work-follow-up supervision supervision-inspect supervision-decide
  settings settings-save settings-efforts provider-key builtin-plugins directory-options directory-pick directory-list
  directory-register directory-default-save execution-options execution-policy-save
  remote-environment-pair remote-environment-pair-read remote-environment-pair-abandon remote-environment-revoke
  artifact-read attachment-read attachment-upload attachment-revoke product-status product-usage
  clients-list client-enroll client-revoke feishu-status feishu-start feishu-stop github-status github-start github-stop
  reconcile-delivery source-deliveries
  browser-list browser-read browser-create browser-grant browser-revoke browser-resolve browser-take browser-return
  browser-plugin browser-plugin-save
  computer-status computer-policy computer-control
  browser-import-list browser-import-read browser-import browser-import-cancel browser-control-view browser-reconcile-take
  credential-import-list credential-import-preview credential-import-commit credential-import-cancel
  mcp-status mcp-save mcp-approve mcp-connect mcp-disconnect mcp-retry
  resource-list resource-read resource-create resource-rename resource-rotate resource-delete resource-cleanup
  resource-request resource-request-read resource-request-list resource-rotation-read resource-grant resource-revoke
  resource-cancel resource-select-feishu resource-select-github
  memory-list memory-read memory-side-query memory-side-read memory-import-list memory-import-preview memory-import-read
  memory-import-commit memory-import-cancel memory-import-retry memory-save memory-share memory-forget
  memory-access-read memory-grant memory-proposals memory-decide
  preset-list preset-create preset-preview preset-select preset-apply preset-application-read preset-applications
  preset-preview-read preset-imports preset-import-read
  proactive-rules proactive-control proactive-list proactive-read proactive-artifact proactive-work-artifact
  proactive-save proactive-pause proactive-stop schedule-list schedule-read schedule-create schedule-cancel
  schedule-source-read schedule-source-set
  scheduled-task-list scheduled-task-read scheduled-task-create scheduled-task-cancel scheduled-task-source-read scheduled-task-source-set
  usage-breakdown
  phone-status phone-set phone-pair phone-pair-cancel phone-remove
  capability-list capability-resolve capability-save capability-delete capability-approve capability-bind
  connector-registry connector-save connector-auth connector-import mailbox-account mailbox-rule mailbox-reply im-accounts
`.trim().split(/\s+/u))

export function createProductApi({ fetch: request = (...args) => globalThis.fetch(...args),
  bridge: getBridge = () => globalThis.window?.dsSuperagentApp?.productClient,
  storage = () => globalThis.window?.localStorage, appearance } = {}) {
  let remote = false

  async function productCall(endpoint, payload = {}, signal) {
    signal?.throwIfAborted()
    if (!productEndpoints.has(endpoint)) {
      throw Object.assign(new Error(t('This product capability is not connected yet.')), { code: 'UNAVAILABLE' })
    }
    const bridge = getBridge()
    if (bridge && (remote || (await bridge.status()).connected)) remote = true
    signal?.throwIfAborted()
    if (remote) {
      if (!bridge) throw Object.assign(new Error(t('The remote Host connection is unavailable.')), { code: 'NETWORK' })
      try {
        const value = await bridge.call(endpoint, payload)
        signal?.throwIfAborted()
        return value
      } catch (error) {
        signal?.throwIfAborted()
        throw error
      }
    }

    let response
    try {
      response = await request('api/product', { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal })
    } catch (error) {
      signal?.throwIfAborted()
      if (error?.name === 'AbortError') throw error
      throw Object.assign(new Error(t('Could not reach Main. Check that the app is running.')), { code: 'NETWORK' })
    }
    let result
    try { result = await response.json() } catch (error) {
      signal?.throwIfAborted()
      if (error?.name === 'AbortError') throw error
      const code = response.ok ? 'PRODUCT_UNAVAILABLE' : `HTTP_${response.status}`
      throw Object.assign(new Error(t('Could not reach Main. Check that the app is running.')), { code })
    }
    signal?.throwIfAborted()
    if (response.ok && result?.ok === true && Object.hasOwn(result, 'value')) return result.value
    const fault = result?.ok === false ? result.error : null
    throw Object.assign(new Error(t(typeof fault?.message === 'string' ? fault.message : 'Main is unavailable.')),
      { code: typeof fault?.code === 'string' ? fault.code : response.ok ? 'PRODUCT_UNAVAILABLE' : `HTTP_${response.status}` })
  }

  return { productCall, call: createUpstreamAdapter(productCall, storage, appearance) }
}

export const { productCall, call } = createProductApi({ appearance: { read: getAppearance, write: setAppearance } })
