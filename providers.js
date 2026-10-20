/**
 * dsh-quota-board — provider discovery.
 *
 * A DSH profile declares its model providers as loader rows, and the composed
 * row config is the only thing that knows a provider's base URL and credential
 * reference. Reading the profile's YAML files instead would mean re-implementing
 * patch composition (bundle layers, profile layer, `!!js` expressions) and
 * guessing at a layout that changes between Harness versions.
 *
 * So discovery reads `entry.options` from the live Loader, which is already the
 * composed result:
 *
 *   row `llm-pi-ai`             config.providers.<id> = { displayName, apiKeyEnv, api, baseURL, models }
 *   row `llm-deepseek*`         config.baseURL / config.apiKeyEnv (official DeepSeek adapter)
 *   row `agent-default-model`   config.provider / config.model (which card to mark as current)
 *
 * The plugin's own `providers` config is merged last and wins: that is where a
 * user adds a gateway the profile never declared, or overrides a discovered one
 * without touching the profile.
 *
 * Pure module: no Cordis, no filesystem. `discoverProviders(entries, options)`
 * takes the rows as plain objects, which is also what the offline tests feed it.
 */

import { adapterFor, DEFAULT_DEEPSEEK_BASE } from './adapters.js'

/** The official DeepSeek credential reference when the row names none. */
export const DEFAULT_DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/** Volcengine signs with an account key pair; these are the usual reference names. */
export const DEFAULT_VOLC_ACCESS_REF = 'VOLC_ACCESS_KEY'
export const DEFAULT_VOLC_SECRET_REF = 'VOLC_SECRET_KEY'

/** A provider with no adapter hint: route by host at query time. */
function makeProvider(id, config, source, skipHosts) {
  const displayName = String(config.displayName ?? config.name ?? id)
  const baseURL = String(config.baseURL ?? config.baseUrl ?? '').trim().replace(/\/+$/u, '')
  const api = String(config.api ?? '')
  const keyRef = String(config.apiKeyEnv ?? config.keyEnv ?? '').trim()
  const models = Array.isArray(config.models)
    ? config.models
        .map((model) => (typeof model === 'string' ? model : model?.id))
        .filter((model) => typeof model === 'string' && model.length > 0)
    : []
  return {
    id,
    displayName,
    baseURL,
    api,
    keyRef,
    // Volcengine's account pair, carried per provider so one profile can hold
    // more than one account. Empty means "use the plugin-wide default".
    accessKeyRef: String(config.accessKeyEnv ?? config.accessKeyRef ?? '').trim(),
    secretKeyRef: String(config.secretKeyEnv ?? config.secretKeyRef ?? '').trim(),
    models,
    source,
    adapter: normalizeAdapter(config.adapter) ?? adapterFor(api, baseURL, skipHosts),
    // Non-Bearer gateways: which header carries the key, and what scheme
    // prefixes it. An empty header means "use the default".
    authHeader: typeof config.authHeader === 'string' ? config.authHeader.trim() : '',
    authPrefix: typeof config.authPrefix === 'string' ? config.authPrefix : undefined,
    // Field/endpoint hints for gateways whose response shape is unusual.
    fields: plainObject(config.fields),
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Adapter names users may still have in an older config.
 * `openai` used to mean "probe the OpenAI family"; that work is now `generic`.
 */
const ADAPTER_ALIASES = Object.freeze({
  openai: 'generic',
  'openai-compatible': 'generic',
  compat: 'generic',
  probe: 'generic',
})

function normalizeAdapter(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (name.length === 0) return null
  return ADAPTER_ALIASES[name] ?? name
}

/** Provider fields an override may replace. */
const MERGE_FIELDS = ['displayName', 'baseURL', 'api', 'keyRef', 'accessKeyRef', 'secretKeyRef', 'models', 'authHeader', 'authPrefix', 'fields']

/**
 * Which provider fields an override actually spoke about.
 *
 * A merge has to distinguish "left unset" from "set to empty": an override that
 * only changes a display name must not wipe the credential reference it never
 * mentioned. `makeProvider` normalizes everything to a string, which erases that
 * distinction, so it is recorded here first.
 */
function explicitFields(raw) {
  const fields = new Set()
  if (raw.displayName !== undefined || raw.name !== undefined) fields.add('displayName')
  if (raw.baseURL !== undefined || raw.baseUrl !== undefined) fields.add('baseURL')
  if (raw.api !== undefined) fields.add('api')
  if (raw.apiKeyEnv !== undefined || raw.keyEnv !== undefined) fields.add('keyRef')
  if (raw.accessKeyEnv !== undefined || raw.accessKeyRef !== undefined) fields.add('accessKeyRef')
  if (raw.secretKeyEnv !== undefined || raw.secretKeyRef !== undefined) fields.add('secretKeyRef')
  if (raw.models !== undefined) fields.add('models')
  if (raw.authHeader !== undefined) fields.add('authHeader')
  if (raw.authPrefix !== undefined) fields.add('authPrefix')
  if (raw.fields !== undefined) fields.add('fields')
  if (raw.adapter !== undefined) fields.add('adapter')
  return fields
}

/** Normalize a provider override from the plugin config. */
function fromOverride(raw, index, skipHosts) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = String(raw.id ?? `custom-${index + 1}`).trim()
  if (id.length === 0) return null
  const provider = makeProvider(id, raw, 'config', skipHosts)
  // Non-enumerable: never leaks into the config round-trip or a spread, but the
  // merge below can still tell an explicit empty value from an absent one.
  Object.defineProperty(provider, 'explicit', { value: explicitFields(raw), enumerable: false })
  return provider
}

/**
 * Build a provider from a single config entry, for the "test connection" probe.
 *
 * The entry comes straight from the settings form and has never been through
 * discovery: it may be half-filled, and its id may be blank. Nothing is merged
 * here — the point is to test exactly what the user typed, not what the profile
 * would resolve to.
 *
 * @returns the provider, or `null` when there is no base URL to call.
 */
export function providerFromEntry(entry, skipHosts) {
  const provider = fromOverride(entry, 0, skipHosts)
  if (provider === null) return null
  // Without an address there is nothing to probe; the caller says so instead of
  // firing six requests at an empty string.
  if (provider.baseURL.length === 0) return null
  if (provider.adapter === 'volcengine') {
    if (provider.accessKeyRef.length === 0) provider.accessKeyRef = DEFAULT_VOLC_ACCESS_REF
    if (provider.secretKeyRef.length === 0) provider.secretKeyRef = DEFAULT_VOLC_SECRET_REF
  }
  provider.isDefault = false
  return provider
}

/**
 * Read the plugin's `providers` config as a list.
 *
 * The config schema declares a real array, so that is the normal shape. A JSON
 * string is still accepted because an older config, or a value typed straight
 * into the YAML, can hold one; malformed input is ignored rather than fatal so
 * the dashboard still renders everything discovery found.
 *
 * @param source - the configured array, or a JSON string holding one.
 * @returns the parsed entries (possibly empty).
 */
export function parseProviderOverrides(source, skipHosts) {
  let parsed = source
  if (typeof source === 'string') {
    const text = source.trim()
    if (text.length === 0) return []
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((raw, index) => fromOverride(raw, index, skipHosts)).filter((provider) => provider !== null)
}

/** Whether a loader row is the pi-ai adapter row. */
function isPiAiRow(entry) {
  return entry.name === '@deepseek-ai/dsh-llm-pi-ai' || entry.id === 'llm-pi-ai'
}

/** Whether a loader row is one of the official DeepSeek adapter rows. */
function isDeepSeekRow(entry) {
  const name = String(entry.name ?? '')
  return name.includes('dsh-llm-deepseek') || String(entry.id ?? '').startsWith('llm-deepseek')
}

/**
 * Layer an override on top of a discovered provider.
 *
 * Field-wise on purpose: `{ ...previous, ...override }` would let an override
 * that only renames a card blank out the base URL and key reference that
 * discovery found.
 */
function mergeProvider(previous, override, skipHosts) {
  const merged = { ...previous, source: 'config' }
  const explicit = override.explicit ?? new Set(MERGE_FIELDS)
  for (const field of MERGE_FIELDS) {
    if (explicit.has(field)) merged[field] = override[field]
  }
  merged.adapter = explicit.has('adapter') ? override.adapter : adapterFor(merged.api, merged.baseURL, skipHosts)
  return merged
}

/**
 * Discover every model provider the profile declares.
 *
 * @param entries - `[{ id, name, config }]` from the Loader, already composed.
 * @param options - `{ overrides, deepseekBaseURL, defaultProvider }`.
 * @returns providers in a stable order: pi-ai rows, DeepSeek, then overrides.
 */
export function discoverProviders(entries, options = {}) {
  const providers = new Map()
  const rows = Array.isArray(entries) ? entries : []
  const deepseekBase = String(options.deepseekBaseURL ?? '').trim().replace(/\/+$/u, '')

  for (const entry of rows) {
    const config = entry?.config
    if (config === null || typeof config !== 'object') continue
    if (!isPiAiRow(entry)) continue
    const declared = config.providers
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue
    for (const [id, providerConfig] of Object.entries(declared)) {
      if (providerConfig === null || typeof providerConfig !== 'object') continue
      // A provider declared without a base URL cannot answer a balance call;
      // it stays visible as unconfigured rather than being silently dropped.
      const provider = makeProvider(id, providerConfig, 'profile', options.skipHosts)
      if (!providers.has(id)) providers.set(id, provider)
    }
  }

  for (const entry of rows) {
    if (!isDeepSeekRow(entry)) continue
    const config = entry.config !== null && typeof entry.config === 'object' ? entry.config : {}
    const baseURL = String(config.baseURL ?? '').trim().replace(/\/+$/u, '') || deepseekBase || DEFAULT_DEEPSEEK_BASE
    const keyRef = String(config.apiKeyEnv ?? config.keyEnv ?? '').trim() || DEFAULT_DEEPSEEK_KEY_REF
    const provider = makeProvider('deepseek-official', {
      displayName: 'DeepSeek',
      baseURL,
      api: 'deepseek',
      apiKeyEnv: keyRef,
      models: config.models ?? [],
    }, 'profile', options.skipHosts)
    provider.adapter = 'deepseek'
    // Several DeepSeek rows may exist (account, api-key). The first one that
    // yields a usable base URL wins; later rows only fill in a missing key ref.
    const existing = providers.get('deepseek-official')
    if (existing === undefined) {
      providers.set('deepseek-official', provider)
    } else if (existing.keyRef.length === 0) {
      existing.keyRef = provider.keyRef
    }
  }

  // Anything else the profile wires up as a model adapter, and that points at a
  // real address, is still a provider the user configured — the official set of
  // `llm-*` packages grows, and a row this plugin cannot name is better shown
  // than silently dropped. The two families above are already handled.
  for (const entry of rows) {
    const identity = `${entry?.id ?? ''} ${entry?.name ?? ''}`.toLowerCase()
    if (!identity.includes('llm-')) continue
    if (isPiAiRow(entry) || isDeepSeekRow(entry)) continue
    const config = entry?.config
    if (config === null || typeof config !== 'object') continue
    const baseURL = String(config.baseURL ?? config.baseUrl ?? '').trim()
    if (baseURL.length === 0) continue
    const id = String(entry.id ?? entry.name ?? '').trim()
    if (id.length === 0 || providers.has(id)) continue
    providers.set(id, makeProvider(id, config, 'profile', options.skipHosts))
  }

  for (const provider of parseProviderOverrides(options.overrides, options.skipHosts)) {
    const previous = providers.get(provider.id)
    providers.set(provider.id, previous === undefined ? provider : mergeProvider(previous, provider, options.skipHosts))
  }

  // The default model row already lives in the same entries list, so callers do
  // not have to pass it separately; an explicit option still wins.
  const defaultProvider = String(options.defaultProvider ?? '').trim() || defaultProviderOf(rows)
  // Volcengine needs an account key pair, not an API key. Its references default
  // to the plugin-wide names, so a discovered row works without being edited.
  const volcAccess = String(options.volcAccessKeyRef ?? '').trim() || DEFAULT_VOLC_ACCESS_REF
  const volcSecret = String(options.volcSecretKeyRef ?? '').trim() || DEFAULT_VOLC_SECRET_REF
  return [...providers.values()].map((provider) => {
    if (provider.adapter === 'volcengine') {
      if (provider.accessKeyRef.length === 0) provider.accessKeyRef = volcAccess
      if (provider.secretKeyRef.length === 0) provider.secretKeyRef = volcSecret
    }
    return {
      ...provider,
      isDefault: defaultProvider.length > 0 && provider.id === defaultProvider,
    }
  })
}

/**
 * The provider id the profile's default model row points at.
 * @param entries - composed Loader rows.
 * @returns the provider id, or '' when no row declares one.
 */
export function defaultProviderOf(entries) {
  const rows = Array.isArray(entries) ? entries : []
  for (const entry of rows) {
    const identity = `${entry?.id ?? ''} ${entry?.name ?? ''}`.toLowerCase()
    if (!identity.includes('default-model')) continue
    const config = entry?.config
    if (config === null || typeof config !== 'object') continue
    if (typeof config.provider === 'string' && config.provider.length > 0) return config.provider
  }
  return ''
}
