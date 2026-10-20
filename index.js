/**
 * dsh-quota-board — Host half.
 *
 * The browser cannot talk to provider billing endpoints: every one of them is
 * cross-origin, several need a signed request, and the credentials never leave
 * the Host. So this half owns all three jobs and exposes two Remote methods:
 *
 *   load(force)   the whole board — discover, resolve, query, measure
 *   test(entry)   one unsaved entry, so the settings page can say "this works"
 *
 *   discover   read the composed Loader rows to find model providers
 *   resolve    turn each provider's credential reference into a real key
 *   query      ask every provider concurrently, one failure per card
 *   measure    aggregate local token usage from the session projection cache
 *
 * Nothing here is required for the rest of the Harness to work: without the
 * Typert packages the panel reports that no board service is available and the
 * plugin simply does nothing.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SKIP_HOSTS, queryProvider, UNSUPPORTED_NOTE } from './adapters.js'
import { discoverProviders, defaultProviderOf, providerFromEntry, DEFAULT_VOLC_ACCESS_REF, DEFAULT_VOLC_SECRET_REF } from './providers.js'
import { usageReport } from './usage.js'
import { bindingKeyOf, bindingStorePath, makeBinding, readBindings, writeBindings } from './bindings.js'

/** Loader diagnostic name, matched by the row id in `cordis.patch.yml`. */
export const name = 'quota-board'

/** Cordis service key — and wire namespace — of the board. Matches `client.js`. */
export const QUOTA_NAMESPACE = 'quotaBoard'

/** Prototype key the Gateway's source-mode discovery reads markers from. */
export const PROBE_MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Marker descriptor version the Gateway's reader accepts. */
const MARKER_VERSION = 1

/**
 * Remote methods this service exposes. Exported so the offline validator can
 * hold them against the browser-side descriptor without a Typert installation.
 *
 * The Gateway derives wire parameter names from the method's own source, which
 * is why `load` spells its parameter as a bare identifier.
 */
export const REMOTE_METHODS = Object.freeze([
  Object.freeze({ method: 'load', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'test', invocation: Object.freeze({ kind: 'direct' }) }),
])

/** How long a report is reused before another poll hits the provider APIs. */
const CACHE_MS = 20_000

/** A "test connection" probe is interactive, so it gets a shorter ceiling. */
const TEST_TIMEOUT_MS = 8_000

/** Cap on the Platform wallet call, which runs inside the board's refresh. */
const ACCOUNT_TIMEOUT_MS = 8_000

/** Distinguishes "the wallet call timed out" from "the account is gone". */
const ACCOUNT_TIMEOUT = Symbol('account-timeout')

/**
 * Field/endpoint hints for one provider whose response shape is unusual.
 * Empty strings mean "let the generic prober decide".
 */
const ProviderFieldsConfig = z.object({
  endpoint: z.string().default(''),
  remaining: z.string().default(''),
  used: z.string().default(''),
  unit: z.string().default(''),
  scale: z.number().default(1),
})

/**
 * One extra or overriding provider.
 *
 * This is a real list rather than a JSON string on purpose: the settings form
 * renders one card per entry, and the profile YAML keeps a readable list.
 */
const ProviderConfig = z.object({
  id: z.string().default(''),
  displayName: z.string().default(''),
  baseURL: z.string().default(''),
  api: z.string().default(''),
  /** Credential reference for the normal (bearer) API key path. */
  apiKeyEnv: z.string().default(''),
  /**
   * Volcengine signs requests with an account key pair instead of an API key,
   * so the pair's references live on the provider too — a profile can hold more
   * than one Volcengine account. Blank falls back to the plugin-wide defaults.
   */
  accessKeyEnv: z.string().default(''),
  secretKeyEnv: z.string().default(''),
  adapter: z.string().default(''),
  authHeader: z.string().default(''),
  authPrefix: z.string().default(''),
  fields: ProviderFieldsConfig,
})

export const Config = z.object({
  /** Extra or overriding providers; discovery already reads the profile rows. */
  providers: z.array(ProviderConfig).default([]).volatile(),
  /** Warn below this amount on money balances. */
  lowThreshold: z.number().step(1).min(0).default(5).volatile(),
  /** Client polling interval; the Host still caches for 20s. */
  refreshSeconds: z.number().step(1).min(10).default(60).volatile(),
  /** Length of the local daily usage series. */
  usageDays: z.number().step(1).min(3).default(14).volatile(),
  /** Per-request timeout for every provider call. */
  timeoutMs: z.number().step(1).min(2000).default(10000).volatile(),
  /** Override the official DeepSeek base URL when no row declares one. */
  deepseekBaseURL: z.string().default('').volatile(),
  /**
   * Whose name and quota the sidebar button prints.
   *
   * Empty means "decide from the report": the profile's default provider first,
   * then the first configured one. A stale id falls back the same way instead of
   * leaving the button blank.
   */
  defaultProvider: z.string().default('').volatile(),
  /**
   * Extra host fragments to treat as "no billing API", comma separated.
   * Appended to the built-in defaults; a single provider can always override
   * with `"adapter": "generic"` in its own definition.
   */
  skipHosts: z.string().default('').volatile(),
})

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function clampTimeout(value) {
  if (!Number.isInteger(value) || value < 2000) return 10000
  return Math.min(value, 60000)
}

function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  const message = error instanceof Error ? error.message : String(error)
  return message
}

/** The DSH home the Host itself runs from. */
function dshHome() {
  const fromEnv = process.env?.DSH_HOME
  return nonEmpty(fromEnv) ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Read the composed Loader rows as plain `{ id, name, config }` objects.
 *
 * `loader` is a profile service, not a plugin service: a deployment without it
 * (or a probe run outside a profile) yields no rows, and discovery falls back to
 * the plugin's own `providers` config.
 */
function loaderEntries(ctx) {
  try {
    const loader = ctx.get('loader')
    if (loader === undefined || loader === null || typeof loader.entries !== 'function') return []
    const entries = []
    for (const entry of loader.entries()) {
      const options = entry?.options
      if (options === null || typeof options !== 'object') continue
      entries.push({ id: options.id, name: options.name, config: options.config })
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Resolve one credential reference, and report where the value came from.
 *
 * Order: the credentials service (what the settings UI and `.credentials.yaml`
 * write), then the launching environment, then `process.env`. Resolving per
 * refresh means a rotated key reaches the next poll without a restart.
 *
 * @returns `{ value, source }`; `value` is undefined when nothing resolved.
 */
async function resolveCredential(ctx, refName) {
  const reference = String(refName ?? '').trim()
  if (reference.length === 0) return { value: undefined, source: 'none' }

  try {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    const credentials = ctx.get('credentials')
    if (credentialRef !== undefined && credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef(reference))
      if (nonEmpty(resolved?.value)) return { value: resolved.value, source: 'credential' }
    }
  } catch {
    /* the composition may not mount the credentials service */
  }

  try {
    const { launchEnvironmentOf } = await import('@deepseek-ai/dsh-launch-environment')
    const ambient = launchEnvironmentOf(ctx)?.get(reference)
    if (nonEmpty(ambient?.value)) return { value: ambient.value, source: 'launch' }
  } catch {
    /* the composition may not mount the launch environment */
  }

  const fromProcess = process.env?.[reference]
  if (nonEmpty(fromProcess)) return { value: fromProcess, source: 'process' }
  return { value: undefined, source: 'none' }
}

/** Numeric money on a balance, for the low-threshold check. */
function balanceAmount(balance) {
  const parsed = Number(balance?.total)
  return Number.isFinite(parsed) ? parsed : null
}

/** Whether any plan is a percentage window that has run out. */
function planExhausted(plans) {
  if (!Array.isArray(plans)) return false
  // `Number(null)` is 0, so a plan that only reports `used` (and leaves
  // `remaining` null) used to count as exhausted — one such window flipped the
  // whole board's "low" badge. Only a real number can be exhausted.
  return plans.some((plan) => {
    const remaining = Number(plan?.remaining)
    return plan?.unit === '%' && Number.isFinite(remaining) && remaining <= 0
  })
}

/** Hosts that answer DeepSeek's own balance API. */
const DEEPSEEK_HOSTS = Object.freeze(['api.deepseek.com', 'api.deepseek.ai'])

/**
 * Whether a provider is routed at DeepSeek itself rather than a compatible relay.
 *
 * The account wallet only describes DeepSeek's own account, so a relay that
 * speaks the same protocol must keep using its own API key.
 */
function isOfficialDeepSeek(provider) {
  if (provider.adapter !== 'deepseek') return false
  if (provider.baseURL.length === 0) return true
  try {
    const host = new URL(provider.baseURL).hostname.toLowerCase()
    return DEEPSEEK_HOSTS.some((name) => host === name || host.endsWith(`.${name}`))
  } catch {
    return false
  }
}

/**
 * Identity Harness expects when asking the account service for Platform data.
 *
 * The service derives its own request headers from this; nothing here is a
 * credential. `locale` only selects the language of server-authored messages.
 */
function accountClient() {
  let locale = 'zh-CN'
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || locale
  } catch {
    // Keep the fallback: an unusable ICU data set must not break the board.
  }
  return {
    version: '1.0.0',
    locale,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Read the signed-in Harness account's DeepSeek wallet balances.
 *
 * Harness already has this data — the settings page's "账号与余额" card calls the
 * very same `deepseekAccount` service. Reading it here is what makes the board
 * and the settings page show one number instead of two: a signed-in user sees
 * the real balance without pasting an API key at all.
 *
 * Failures are returned as states, never thrown: a missing service, a signed-out
 * account or a broken grant must fall back to the API-key path instead of
 * blanking the card.
 *
 * @returns `{ status: 'ready', wallets, bonusWallets }`, or
 *   `{ status: 'absent' | 'signed-out' | 'failed' }`.
 */
export async function readAccountWallet(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  if (account === null || account === undefined) return { status: 'absent' }

  let state = null
  try {
    state = typeof account.getState === 'function' ? account.getState() : null
  } catch {
    return { status: 'absent' }
  }
  // The grant is only usable while it is stored; anything else means the user
  // has to sign in, and an API key is the only remaining route.
  if (state?.status !== 'credential-stored') return { status: 'signed-out' }
  if (typeof account.getBalance !== 'function') return { status: 'absent' }

  try {
    // The Platform round-trip is inside the board's own refresh cycle, so it
    // needs a ceiling of its own: a hung request must not hold up every other
    // card. Failing here only costs this one number.
    let timer = null
    const details = await Promise.race([
      account.getBalance(accountClient()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(ACCOUNT_TIMEOUT), ACCOUNT_TIMEOUT_MS)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
    // The board refreshes on a timer, so a leftover timer would pile up once a
    // minute for as long as the page stays open.
    if (timer !== null) clearTimeout(timer)
    if (details === ACCOUNT_TIMEOUT) return { status: 'failed' }
    if (details === null || details === undefined) return { status: 'signed-out' }
    if (details.status !== 'ready') return { status: 'failed' }
    return {
      status: 'ready',
      wallets: Array.isArray(details.value) ? details.value : [],
      bonusWallets: Array.isArray(details.bonusWallets) ? details.bonusWallets : [],
    }
  } catch {
    return { status: 'failed' }
  }
}

/** Sum the recharge and bonus wallets that share a currency. */
function walletBalance(wallets, bonusWallets) {
  const list = Array.isArray(wallets) ? wallets : []
  const bonus = Array.isArray(bonusWallets) ? bonusWallets : []
  const normal = list.find((wallet) => wallet?.currency === 'CNY') ?? list[0] ?? null
  const granted =
    bonus.find((wallet) => wallet?.currency === (normal?.currency ?? 'CNY')) ?? bonus[0] ?? null
  const currency = normal?.currency ?? granted?.currency ?? 'CNY'
  const amount = (wallet) => {
    const parsed = Number(wallet?.balance)
    return Number.isFinite(parsed) ? parsed : 0
  }
  const total = amount(normal) + amount(granted)
  const fixed = (wallet) => (wallet === null ? '—' : String(wallet.balance ?? '—'))
  return {
    isAvailable: total > 0,
    currency,
    total: total.toFixed(2),
    granted: fixed(granted),
    toppedUp: fixed(normal),
    // Tells the card where the number came from, so "no API key" never appears
    // next to a balance the account service supplied.
    source: 'account',
  }
}

/**
 * Query one provider and normalize its wire entry.
 *
 * Every failure is local to the card: one provider being down must not blank the
 * rest of the board.
 */
async function providerStatus(ctx, provider, options) {
  const needsVolcPair = provider.adapter === 'volcengine'
  // Volcengine signs with an account key pair, and the pair's references live on
  // the provider itself. The plugin-wide names are only a fallback, so a profile
  // with two Volcengine accounts shows two cards that resolve independently.
  const accessRef = needsVolcPair ? provider.accessKeyRef || DEFAULT_VOLC_ACCESS_REF : ''
  const secretRef = needsVolcPair ? provider.secretKeyRef || DEFAULT_VOLC_SECRET_REF : ''
  const accessKey = accessRef.length > 0 ? await resolveCredential(ctx, accessRef) : { value: undefined, source: 'none' }
  const secretKey = secretRef.length > 0 ? await resolveCredential(ctx, secretRef) : { value: undefined, source: 'none' }
  const key = needsVolcPair
    ? { value: accessKey.value, source: accessKey.source }
    : provider.keyRef.length > 0
      ? await resolveCredential(ctx, provider.keyRef)
      : { value: undefined, source: 'none' }
  const configured = needsVolcPair ? nonEmpty(accessKey.value) && nonEmpty(secretKey.value) : key.value !== undefined

  const status = {
    id: provider.id,
    displayName: provider.displayName,
    baseURL: provider.baseURL,
    api: provider.api,
    adapter: provider.adapter,
    keyRef: provider.keyRef,
    accessKeyRef: accessRef,
    secretKeyRef: secretRef,
    keySource: key.source,
    models: provider.models.slice(0, 8),
    modelCount: provider.models.length,
    source: provider.source,
    isDefault: provider.isDefault === true,
    configured,
    kind: 'unknown',
    balance: null,
    usage: null,
    plans: [],
    note: null,
    error: null,
    low: false,
    // Where the numbers came from: Harness's own account wallet, or a provider
    // key. The card prints it, because "no API key" next to a real balance is
    // confusing otherwise.
    balanceSource: null,
  }

  if (provider.baseURL.length === 0) {
    status.kind = 'unsupported'
    status.error = '没有 baseURL，无法查询额度'
    return status
  }

  // DeepSeek's own account wallet outranks an API-key query: it is the same
  // number the settings page shows ("账号与余额"), and it needs no key at all.
  // A relay that merely speaks the same protocol is excluded — its balance
  // belongs to someone else's account.
  if (isOfficialDeepSeek(provider)) {
    const wallet = await readAccountWallet(ctx)
    if (wallet.status === 'ready') {
      status.balance = walletBalance(wallet.wallets, wallet.bonusWallets)
      status.kind = 'balance'
      status.configured = true
      status.keySource = 'account'
      status.balanceSource = 'account'
      status.low = Number(status.balance.total) < options.lowThreshold
      return status
    }
    if (wallet.status !== 'absent' && !configured) {
      status.kind = 'quota'
      status.error =
        wallet.status === 'signed-out'
          ? '未登录 DeepSeek 账号，也没有可用的 API Key。在「设置 → 账号与余额」登录后会自动读取余额，或给这条供应商配置一个 API Key。'
          : '账号余额读取失败。可以在「设置 → 账号与余额」查看，或给这条供应商配置一个 API Key。'
      return status
    }
  }

  if (provider.adapter === 'volcengine' && !configured) {
    status.kind = 'quota'
    status.error =
      '需要火山引擎账户 AccessKey ID / Secret Access Key（Ark API Key 不能查询账单）。在「插件配置 → 额度看板」里填写。'
    return status
  }

  try {
    const result = await queryProvider(provider, {
      key: key.value,
      volc: { accessKey: accessKey.value, secretKey: secretKey.value },
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      skipHosts: options.skipHosts,
      binding: options.bindingOf(provider),
      // The prober reports the binding alone; every caller wants to know which
      // provider it belongs to, so the provider is bound here rather than at
      // each call site (getting this wrong silently drops every binding).
      onBind: typeof options.onBind === 'function' ? (binding) => options.onBind(provider, binding) : undefined,
    })
    status.kind = result.kind ?? 'unknown'
    status.balance = result.balance ?? null
    status.usage = result.usage ?? null
    status.plans = Array.isArray(result.plans) ? result.plans : []
    status.note = result.note ?? null
    if (status.balance !== null || status.usage !== null || status.plans.length > 0) status.balanceSource = 'key'
  } catch (error) {
    status.error = describe(error)
    status.kind = provider.adapter === 'unsupported' ? 'unsupported' : 'error'
  }

  if (status.kind === 'unsupported' && status.note === null && status.error === null) status.note = UNSUPPORTED_NOTE
  const amount = balanceAmount(status.balance)
  status.low = (amount !== null && amount < options.lowThreshold) || planExhausted(status.plans)
  return status
}

/**
 * Probe one provider entry that has not been saved yet.
 *
 * This backs the settings page's "test connection" button. It runs the same
 * code path as the board (`providerStatus` → `queryProvider`), so a green test
 * means the card will fill in — but it reads the entry from the form, ignores
 * nothing, and **writes no binding**: a one-off test must not pin an endpoint
 * that the user may still be editing.
 *
 * @returns `{ ok: true, status, endpoint, endpointKind, elapsedMs }`, or
 *   `{ ok: false, reason }` when the entry cannot be called at all.
 *
 * Exported for the offline suite: the Remote wrapper cannot be exercised
 * without Typert, and this is the part with behaviour worth testing.
 */
export async function probeProviderEntry(ctx, entry, snapshot, skipHosts) {
  const provider = providerFromEntry(entry, skipHosts)
  if (provider === null) return { ok: false, reason: '这个条目还没有填写接口地址（baseURL）' }

  // A stored binding is still consulted: the test should answer "will my card
  // work", not "would a fresh install work".
  const bindings = readBindings(bindingStorePath(dshHome()))
  const reached = []
  const startedAt = Date.now()
  const status = await providerStatus(ctx, provider, {
    lowThreshold: snapshot.lowThreshold,
    timeoutMs: Math.min(snapshot.timeoutMs, TEST_TIMEOUT_MS),
    fetchImpl: snapshot.fetchImpl,
    skipHosts,
    bindingOf: (candidate) => bindings[bindingKeyOf(candidate.baseURL)],
    onBind: (candidate, binding) => reached.push({ ...binding, elapsedMs: Date.now() - startedAt }),
  })

  return {
    ok: true,
    status,
    endpoint: reached.length > 0 ? reached[0].endpoint : null,
    endpointKind: reached.length > 0 ? reached[0].kind : null,
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * Build one full board report.
 *
 * Provider queries run concurrently; the local usage scan runs alongside them
 * because it touches only local files.
 */
/**
 * Hosts the generic prober must not touch: the built-in list plus the user's
 * comma-separated additions.
 */
function resolveSkipHosts(snapshot) {
  return [
    ...DEFAULT_SKIP_HOSTS,
    ...String(snapshot.skipHosts ?? '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  ]
}

async function collect(ctx, snapshot) {
  const entries = loaderEntries(ctx)
  const skipHosts = resolveSkipHosts(snapshot)
  const providers = discoverProviders(entries, {
    overrides: snapshot.providers,
    deepseekBaseURL: snapshot.deepseekBaseURL,
    defaultProvider: defaultProviderOf(entries),
    skipHosts,
  })

  // Bindings are discovered state, remembered per API root so a gateway that
  // answered once is not probed again on every refresh or restart.
  const bindingFile = bindingStorePath(dshHome())
  const bindings = readBindings(bindingFile)
  const fresh = new Map()
  const rememberBinding = (provider, binding) => {
    const at = bindingKeyOf(provider.baseURL)
    if (at.length === 0) return
    const next = makeBinding(binding)
    const previous = bindings[at]
    if (previous !== undefined && previous.endpoint === next.endpoint && previous.kind === next.kind) return
    fresh.set(at, next)
  }

  const usage = usageReport(dshHome(), { days: snapshot.usageDays })
  const localByProvider = new Map(usage.byProvider.map((entry) => [entry.provider, entry]))

  const statuses = await Promise.all(
    providers.map(async (provider) => {
      const status = await providerStatus(ctx, provider, {
        lowThreshold: snapshot.lowThreshold,
        timeoutMs: snapshot.timeoutMs,
        fetchImpl: snapshot.fetchImpl,
        skipHosts,
        bindingOf: (entry) => bindings[bindingKeyOf(entry.baseURL)],
        onBind: (entry, binding) => rememberBinding(entry, binding),
      })
      const local = localByProvider.get(provider.id)
      const at = bindingKeyOf(provider.baseURL)
      return {
        ...status,
        local: local === undefined ? null : { sessions: local.sessions, tokens: local.tokens },
        // A binding found on this very pass is already in `fresh`; reading only
        // the loaded map would report "unbound" once after discovery.
        binding: (fresh.size > 0 ? fresh.get(at) : undefined) ?? bindings[at] ?? null,
      }
    }),
  )

  if (fresh.size > 0) {
    try {
      writeBindings(bindingFile, { ...bindings, ...Object.fromEntries(fresh) })
    } catch (error) {
      console.warn(`[dsh-quota-board] 保存探测绑定失败：${describe(error)}`)
    }
  }

  return {
    ok: true,
    generatedAt: Date.now(),
    cached: false,
    lowThreshold: snapshot.lowThreshold,
    refreshSeconds: snapshot.refreshSeconds,
    usageDays: snapshot.usageDays,
    // Which provider the sidebar seat speaks for. Empty means "decide from the
    // report": the client then prefers the profile's default provider. Carried
    // on the report so the seat needs no second source of truth.
    defaultProvider: typeof snapshot.defaultProvider === 'string' ? snapshot.defaultProvider : '',
    providers: statuses,
    usage,
    counts: {
      providers: statuses.length,
      configured: statuses.filter((provider) => provider.configured).length,
      low: statuses.filter((provider) => provider.low === true).length,
    },
  }
}

/**
 * Build and register the Host-for-Client board service.
 *
 * Typert packages are imported lazily so a deployment without them keeps the
 * plugin loadable; the caller receives the reason, and the page prints it instead
 * of spinning forever.
 *
 * @returns whether the service was installed, and the reason when it was not.
 */
async function installService(ctx, snapshot) {
  let Base
  try {
    ({ TypertRemoteService: Base } = await import('@deepseek-ai/dsh-typert-protocol'))
  } catch (error) {
    return { ok: false, reason: `@deepseek-ai/dsh-typert-protocol 无法加载（${describe(error)}）` }
  }
  if (typeof Base !== 'function') {
    return { ok: false, reason: '@deepseek-ai/dsh-typert-protocol 未导出 TypertRemoteService' }
  }

  let cache = { at: 0, data: null }
  let inflight = null

  const build = async () => {
    const data = await collect(ctx, snapshot())
    cache = { at: Date.now(), data }
    return data
  }

  class QuotaBoardService extends Base {
    constructor(context) {
      super(context, QUOTA_NAMESPACE)
    }

    /**
     * The whole board: provider balances/quotas and local usage.
     *
     * A cached report is served for 20 seconds unless `force` is set, and
     * concurrent callers share one in-flight build, so two panels polling at
     * once cannot double the provider traffic.
     *
     * @param force - bypass the cache (the page's refresh button).
     * @returns a plain JSON report.
     */
    async load(force) {
      const fresh = cache.data !== null && Date.now() - cache.at < CACHE_MS
      if (force !== true && fresh) return { ...cache.data, cached: true }
      if (inflight !== null) return inflight
      inflight = build().finally(() => {
        inflight = null
      })
      return inflight
    }

    /**
     * Test one provider entry, exactly as the settings form holds it.
     *
     * Not cached and not memoized: the user pressed a button and expects a real
     * request. It also does not touch the cache, so a test can never make the
     * board show a balance the board itself never fetched.
     *
     * @param entry - one provider entry from the form (`id`, `baseURL`, refs…).
     * @returns the probe result, including which endpoint answered.
     */
    async test(entry) {
      const current = snapshot()
      try {
        return await probeProviderEntry(ctx, entry, current, resolveSkipHosts(current))
      } catch (error) {
        return { ok: false, reason: describe(error) }
      }
    }
  }

  Object.defineProperty(QuotaBoardService.prototype, PROBE_MARKER_KEY, {
    configurable: true,
    value: Object.freeze({ version: MARKER_VERSION, methods: REMOTE_METHODS }),
  })

  new QuotaBoardService(ctx)
  return { ok: true }
}

export function apply(ctx, config) {
  const snapshot = () => ({
    providers: config.providers.get(),
    lowThreshold: config.lowThreshold.get(),
    refreshSeconds: config.refreshSeconds.get(),
    usageDays: config.usageDays.get(),
    timeoutMs: clampTimeout(config.timeoutMs.get()),
    deepseekBaseURL: config.deepseekBaseURL.get(),
    skipHosts: config.skipHosts.get(),
    fetchImpl: (url, init) => fetch(url, init),
  })

  void installService(ctx, snapshot).then(
    (result) => {
      if (result.ok !== true) console.warn(`[dsh-quota-board] 额度服务未安装：${result.reason}，看板将无法读取数据。`)
    },
    (error) => console.warn(`[dsh-quota-board] 额度服务未安装：${describe(error)}`),
  )
}
