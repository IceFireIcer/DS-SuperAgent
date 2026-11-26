import type { Context } from '@deepseek-ai/cordis'
import { CoreError } from './model.js'

const PI_AI = 'llm-pi-ai'
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const MAX_MODELS = 500
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const LISTABLE_PROTOCOLS = new Set(PROTOCOLS)
const CUSTOM_COMPAT: Record<string, Record<string, unknown>> = {
  'openai-completions': {
    supportsDeveloperRole: false,
    supportsStore: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
  'openai-responses': { supportsDeveloperRole: false },
}

type JsonRecord = Record<string, unknown>

interface ProviderEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  declared?: boolean
  error?: string
}

interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: string[]
}

interface ProviderLlm {
  listConfigurableProviders?(): ProviderEntry[]
  listModels(provider: string): Promise<Array<{ id: string; name?: string }>>
  discoverModels?(namespace: string, request: JsonRecord): Promise<ModelInfo[]>
}

interface ProviderSettings {
  describe(options: { redactSecrets: boolean }): Array<{
    ns: string
    value?: JsonRecord
    user?: JsonRecord
    base?: JsonRecord
    revision?: number
    schema?: unknown
  }>
  mutate(namespace: string, operations: Array<{ op: 'set'; path: string[]; value: unknown }
    | { op: 'unset'; path: string[] }>, revision?: number): Promise<unknown>
}

interface ProviderCredentials {
  describe(reference: string): Promise<{ configured?: boolean; writable?: boolean }>
  set(reference: string, value: string): Promise<unknown>
  unset(reference: string): Promise<unknown>
}

const recordOf = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined

const profileAt = (value: unknown, path: string[]) => path.reduce<unknown>((current, key) => {
  const record = recordOf(current)
  return record ? record[key] : undefined
}, value)

const displayNameOf = (name: unknown, id: string) => typeof name === 'string' && name.trim() ? name.trim() : id
export const keyRefFor = (provider: string) => `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`

function invalid(message: string) {
  return new CoreError('INVALID_INPUT', message)
}

function checkKey(value: unknown) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') throw invalid('Enter the API key.')
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^=]/u.test(key)) throw invalid('Paste only the key, not a NAME=value line.')
  if (/^(["']).*\1$/u.test(key)) throw invalid('Paste the key without quotes.')
  if (!/^[\x21-\x7E]+$/u.test(key)) throw invalid('An API key has no spaces or special characters.')
  return key
}

function checkEndpoint(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address.')
  return text
}

export function createProductProviders(context: Context) {
  const llm = () => context.get('llm') as unknown as ProviderLlm
  const seams = () => {
    const settings = context.get('settings') as unknown as ProviderSettings | undefined
    const credentials = context.get('credentials') as unknown as ProviderCredentials | undefined
    const service = llm()
    return settings && credentials && service.listConfigurableProviders
      ? { settings, credentials, llm: service } : undefined
  }
  const usable = () => {
    const found = seams()
    if (!found) throw new CoreError('INVALID_CONFIG', 'This DSH cannot set up model providers.')
    return found
  }
  const sections = (settings: ProviderSettings) => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const profileOf = (entry: ProviderEntry, map: Map<string, ReturnType<ProviderSettings['describe']>[number]>,
    layer: 'value' | 'user' | 'base' = 'value') => profileAt(map.get(entry.settingsNs)?.[layer], entry.settingsPath)
  const entryOf = (provider: string) => llm().listConfigurableProviders?.().find(entry => entry.provider === provider)
  const refOf = (profile: unknown) => {
    const record = recordOf(profile)
    return typeof record?.apiKeyEnv === 'string' && record.apiKeyEnv !== '' ? record.apiKeyEnv : undefined
  }

  const protocolsOf = (section?: ReturnType<ProviderSettings['describe']>[number]) => {
    const schema = recordOf(section?.schema)
    const refs = recordOf(schema?.refs)
    const at = (node: unknown): unknown => typeof node === 'number' || typeof node === 'string' ? refs?.[String(node)] : node
    const root = recordOf(at(schema?.uid ?? schema))
    const providers = recordOf(root?.dict)
    const provider = recordOf(providers?.providers)
    const inner = recordOf(provider?.inner)
    const dict = recordOf(inner?.dict)
    const api = recordOf(at(dict?.api))
    const list = Array.isArray(api?.list) ? api.list : []
    const found = list.map(item => recordOf(at(item))?.value).filter((value): value is string => typeof value === 'string' && value !== '')
    return found.length ? found : PROTOCOLS
  }

  const modelEntry = (model: unknown) => {
    const value = typeof model === 'string' ? { id: model } : recordOf(model)
    const id = typeof value?.id === 'string' ? value.id.trim() : ''
    if (id === '') throw invalid('Every model needs an id.')
    const name = typeof value?.name === 'string' && value.name.trim() ? value.name.trim() : undefined
    const contextWindow = Number.isInteger(value?.contextWindow) && Number(value?.contextWindow) > 0 ? Number(value?.contextWindow) : undefined
    const maxTokens = Number.isInteger(value?.maxTokens) && Number(value?.maxTokens) > 0 ? Number(value?.maxTokens) : undefined
    const rawInput = Array.isArray(value?.inputModalities) ? value.inputModalities
      : Array.isArray(value?.input) ? value.input : []
    const input = rawInput.filter((kind): kind is string => typeof kind === 'string')
    return { id, ...(name ? { name } : {}), ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}), ...(input.length ? { input } : {}) }
  }

  const customProfile = (body: JsonRecord, protocols: string[]) => {
    const api = typeof body.api === 'string' ? body.api : protocols[0] ?? 'openai-completions'
    if (!protocols.includes(api)) throw invalid(`The protocol must be one of ${protocols.join(', ')}.`)
    const models = Array.isArray(body.models) ? body.models.slice(0, MAX_MODELS).map(modelEntry) : []
    if (models.length === 0) throw invalid('Add at least one model.')
    if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id.')
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    return {
      ...(name ? { displayName: name } : {}),
      api,
      baseURL: checkEndpoint(body.baseURL),
      ...(CUSTOM_COMPAT[api] ? { compat: { ...CUSTOM_COMPAT[api] } } : {}),
      models,
    }
  }

  async function providersView() {
    const found = seams()
    if (!found) return { available: false, providers: [], addable: [], protocols: PROTOCOLS }
    const map = sections(found.settings)
    const providers: JsonRecord[] = []
    const addable: Array<{ id: string; name: string }> = []
    for (const entry of found.llm.listConfigurableProviders?.() ?? []) {
      const profile = profileOf(entry, map)
      if (entry.settingsNs === PI_AI && profile === undefined) {
        if (entry.declared !== true) addable.push({ id: entry.provider, name: displayNameOf(entry.displayName, entry.provider) })
        continue
      }
      const ref = refOf(profile)
      let models: Array<{ id: string; ref: string; name: string }> = []
      try {
        models = (await found.llm.listModels(entry.provider)).map(model => ({
          id: model.id, ref: `${entry.provider}/${model.id}`, name: model.name ?? model.id,
        }))
      } catch { /* A provider that cannot enumerate now still keeps its declared models. */ }
      if (ref === undefined && models.length === 0 && entry.error === undefined) continue
      const info = ref === undefined ? undefined : await found.credentials.describe(ref).catch(() => undefined)
      const profileModels = recordOf(profile)?.models
      const declared = (Array.isArray(profileModels) ? profileModels as unknown[] : []).map(model => {
        const id = typeof model === 'string' ? model : recordOf(model)?.id
        if (typeof id !== 'string' || id.trim() === '') return undefined
        const name = typeof recordOf(model)?.name === 'string' && String(recordOf(model)?.name).trim()
          ? String(recordOf(model)?.name).trim() : id
        return { id, ref: `${entry.provider}/${id}`, name }
      }).filter((model): model is { id: string; ref: string; name: string } => model !== undefined)
      const byRef = new Map(models.map(model => [model.ref, model]))
      for (const model of declared) if (!byRef.has(model.ref)) byRef.set(model.ref, model)
      models = [...byRef.values()]
      const listable = entry.settingsNs === PI_AI && profile !== undefined
        && typeof recordOf(profile)?.baseURL === 'string' && recordOf(profile)?.baseURL !== ''
        && LISTABLE_PROTOCOLS.has(typeof recordOf(profile)?.api === 'string' ? String(recordOf(profile)?.api) : 'openai-completions')
      providers.push({
        id: entry.provider,
        name: displayNameOf(entry.displayName, entry.provider),
        models,
        declaredModels: declared,
        refreshable: listable && profileOf(entry, map, 'user') !== undefined,
        key: ref === undefined ? null : { configured: info?.configured === true, writable: info?.writable !== false },
        removable: entry.settingsNs === PI_AI && profileOf(entry, map, 'user') !== undefined && profileOf(entry, map, 'base') === undefined,
        custom: entry.declared === true,
        ...(entry.error ? { error: entry.error } : {}),
      })
    }
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    return { available: true, providers, addable, protocols: protocolsOf(map.get(PI_AI)), revision: map.get(PI_AI)?.revision }
  }

  async function addProvider(body: JsonRecord) {
    const { settings, credentials } = usable()
    const provider = String(body.provider ?? '').trim()
    const custom = body.custom === true
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry !== undefined && (entry.settingsNs !== PI_AI || profileOf(entry, map) !== undefined)) throw invalid(`${provider} is already set up.`)
    if (!custom && (entry === undefined || entry.declared === true)) throw invalid(`DSH offers no provider ${provider}.`)
    if (custom && !ROUTE_ID.test(provider)) throw invalid('A provider id is lowercase letters, digits and dashes, starting with a letter.')
    if (custom && entry !== undefined) throw invalid(`DSH already offers ${provider}; add it from its list.`)
    const key = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
    const ref = keyRefFor(provider)
    const info = await credentials.describe(ref)
    if (key !== undefined && info.writable === false) throw invalid(`The API key for ${provider} is set outside this product and cannot be changed here.`)
    const profile: JsonRecord = custom ? customProfile(body, protocolsOf(map.get(PI_AI))) : {}
    if (custom || key !== undefined || info.configured === true) profile.apiKeyEnv = ref
    await settings.mutate(PI_AI, [{ op: 'set', path: entry?.settingsPath ?? ['providers', provider], value: profile }], map.get(PI_AI)?.revision)
    if (key !== undefined) await credentials.set(ref, key)
    return providersView()
  }

  async function discoverModels(body: JsonRecord) {
    const { settings, llm: service } = usable()
    if (!service.discoverModels) throw new CoreError('INVALID_CONFIG', 'This DSH cannot discover models.')
    const map = sections(settings)
    const protocols = protocolsOf(map.get(PI_AI))
    const provider = typeof body.provider === 'string' && body.provider ? body.provider : undefined
    const entry = provider === undefined ? undefined : entryOf(provider)
    const profile = entry !== undefined && entry.settingsNs === PI_AI ? profileOf(entry, map) : undefined
    const stored = entry !== undefined && entry.settingsNs === PI_AI && (profile !== undefined || entry.declared === false)
    const request: JsonRecord = stored
      ? { provider, ...(typeof recordOf(profile)?.baseURL === 'string' ? { baseURL: recordOf(profile)?.baseURL } : {}),
        ...(typeof recordOf(profile)?.api === 'string' ? { api: recordOf(profile)?.api } : {}) }
      : { baseURL: checkEndpoint(body.baseURL), ...(protocols.includes(String(body.api)) ? { api: body.api } : {}),
        ...(typeof body.key === 'string' && body.key.trim() ? { apiKey: checkKey(body.key) } : {}) }
    const models = await service.discoverModels(PI_AI, request)
    return models.slice(0, MAX_MODELS).map(model => ({ id: model.id, ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}) }))
  }

  async function saveProviderModels(body: JsonRecord) {
    const { settings } = usable()
    const provider = String(body.provider ?? '').trim()
    if (provider === '') throw invalid('Choose a provider.')
    const map = sections(settings)
    const entry = entryOf(provider)
    if (!entry || entry.settingsNs !== PI_AI) throw invalid(`No editable provider ${provider}.`)
    if (profileOf(entry, map, 'user') === undefined) throw invalid(`${provider} cannot be changed here.`)
    const profile = profileOf(entry, map)
    const listable = typeof recordOf(profile)?.baseURL === 'string' && recordOf(profile)?.baseURL !== ''
      && LISTABLE_PROTOCOLS.has(typeof recordOf(profile)?.api === 'string' ? String(recordOf(profile)?.api) : 'openai-completions')
    if (!listable) throw invalid(`${provider} has no model list to refresh here.`)
    const section = map.get(PI_AI)
    if (body.revision !== undefined && section?.revision !== undefined && body.revision !== section.revision) {
      throw new CoreError('CONFIG_REVISION_CONFLICT', 'The provider settings changed in another window; refresh the models and try again.')
    }
    const list = Array.isArray(body.models) ? body.models : []
    if (list.length === 0) throw invalid('Select at least one model.')
    if (list.length > MAX_MODELS) throw invalid(`At most ${MAX_MODELS} models can be kept.`)
    const current = new Map<string, unknown>()
    const profileModels = recordOf(profile)?.models
    for (const model of Array.isArray(profileModels) ? profileModels as unknown[] : []) {
      const id = typeof model === 'string' ? model : recordOf(model)?.id
      if (typeof id === 'string' && id !== '') current.set(id, model)
    }
    const models = list.map(model => {
      const id = typeof model === 'string' ? model.trim() : String(recordOf(model)?.id ?? '').trim()
      const old = current.get(id)
      const saved = typeof old === 'string' ? { id: old } : recordOf(old) ?? {}
      const incoming = modelEntry(model)
      return { ...saved, ...incoming, id: incoming.id }
    })
    if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id.')
    await settings.mutate(PI_AI, [{ op: 'set', path: [...entry.settingsPath, 'models'], value: models }], section?.revision)
    return providersView()
  }

  async function removeProvider(provider: string) {
    const { settings, credentials } = usable()
    const map = sections(settings)
    const entry = entryOf(provider)
    if (!entry || entry.settingsNs !== PI_AI || profileOf(entry, map) === undefined) throw invalid(`${provider} is not set up.`)
    if (profileOf(entry, map, 'user') === undefined || profileOf(entry, map, 'base') !== undefined) {
      throw invalid(`${provider} comes with this setup and cannot be removed.`)
    }
    const ref = refOf(profileOf(entry, map))
    const shared = (llm().listConfigurableProviders?.() ?? []).some(other => other.provider !== provider
      && refOf(profileOf(other, map)) === ref)
    await settings.mutate(PI_AI, [{ op: 'unset', path: entry.settingsPath }], map.get(PI_AI)?.revision)
    if (ref === keyRefFor(provider) && !shared) {
      const info = await credentials.describe(ref)
      if (info.configured && info.writable !== false) await credentials.unset(ref)
    }
    return providersView()
  }

  return { providersView, addProvider, discoverModels, saveProviderModels, removeProvider }
}
