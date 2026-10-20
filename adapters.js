/**
 * dsh-quota-board — provider adapters.
 *
 * Every provider on this machine exposes its money differently, and three
 * families cover almost all of them:
 *
 *   DeepSeek        GET {base}/user/balance          (prepaid balance, DeepSeek schema)
 *   OpenAI billing  GET {base}/v1/usage              (generic remaining-quota contract)
 *                   GET {base}/dashboard/billing/... (legacy usage + subscription)
 *   Volcengine      signed OpenAPI on open.volcengineapi.com — the Ark API key
 *                   spent on model calls cannot read billing, so the account
 *                   AccessKey/SecretKey signs Billing Center + Ark control-plane
 *                   calls instead (balance, resource packages, plan windows).
 *
 * Everything else is reported as unsupported rather than probed forever: a
 * platform with no key-accessible billing endpoint answers 404 on every refresh,
 * which looks like a broken plugin instead of a missing API.
 *
 * The module is pure: no Cordis, no config service, no filesystem. Callers hand
 * in the credential, the clock and the fetch implementation, so the same code
 * runs in the Host and in the offline test harness.
 */

import { createHash, createHmac } from 'node:crypto'

/** DeepSeek's public endpoint; also the schema used by DeepSeek-compatible relays. */
export const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com'

/** One sentence reused wherever a platform simply has no billing API. */
export const UNSUPPORTED_NOTE = '该平台未提供可通过 API Key 查询的余额/账单接口'

/**
 * Hosts that speak the OpenAI wire protocol but serve no key-accessible billing
 * endpoint. Probing them on every refresh only produces 404s, which reads as a
 * broken plugin instead of a missing API.
 *
 * This is a *default*, not a law: the list is exposed through the plugin config
 * (`skipHosts`) so a platform that grows a billing endpoint, or a gateway whose
 * host merely looks similar, can be moved in or out without a code change.
 */
export const DEFAULT_SKIP_HOSTS = [
  'aliyuncs',
  'anthropic',
  'googleapis',
  'gemini',
  'vertex',
  'bedrock',
  'mistral',
  'azure',
  'x.ai',
  'grok',
]

/**
 * How a provider is queried.
 *
 * Only two families are genuinely special — DeepSeek's own `/user/balance`
 * schema, and Volcengine, whose Ark API key cannot read billing at all and needs
 * account AK/SK request signing. Everything else is `generic`: a universal
 * prober that tries the common billing endpoints and recognises the shapes they
 * return. That keeps a new gateway a config entry rather than a code change.
 */
export const ADAPTER = Object.freeze({
  deepseek: 'deepseek',
  volcengine: 'volcengine',
  generic: 'generic',
  unsupported: 'unsupported',
})

/** Host part of an absolute URL, or '' when it is not one. */
export function hostOf(baseURL) {
  try {
    return new URL(String(baseURL)).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Route a provider to an adapter from its wire-API hint and base-URL host.
 *
 * `generic` is the default on purpose. Guessing the platform up front and
 * failing when the guess is wrong makes every unlisted gateway unusable; trying
 * the common endpoints in order and stopping at the first real answer makes
 * every OpenAI-compatible gateway work without being enumerated here.
 *
 * @param api - the configured `api` value (openai, openai-responses, deepseek, …).
 * @param baseURL - the configured base URL.
 * @param skipHosts - host fragments that serve no billing endpoint (defaults to
 *   DEFAULT_SKIP_HOSTS); pass `[]` to disable the check entirely.
 * @returns one of ADAPTER.
 */
export function adapterFor(api, baseURL, skipHosts = DEFAULT_SKIP_HOSTS) {
  const wire = String(api ?? '').toLowerCase()
  const host = hostOf(baseURL)
  const skipped = Array.isArray(skipHosts) ? skipHosts : DEFAULT_SKIP_HOSTS

  if (wire.includes('deepseek') || host.includes('deepseek')) return ADAPTER.deepseek

  // Volcengine's Ark endpoint speaks the openai protocol; route its hosts
  // before anything generic so they never hit absent dashboard paths.
  if (host.includes('volces') || host.includes('volcengine')) return ADAPTER.volcengine

  if (skipped.some((marker) => marker.length > 0 && host.includes(marker))) return ADAPTER.unsupported
  // An explicitly unsupported adapter still wins over the host default.
  if (wire === ADAPTER.unsupported) return ADAPTER.unsupported
  return ADAPTER.generic
}

/** Trim a trailing slash without touching a path suffix. */
function normalizeBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/u, '')
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = error instanceof Error ? error.message : String(error)
  return message
}

/** A failure that must abort the whole probe instead of trying the next URL. */
class FatalError extends Error {}

/**
 * One JSON GET with a credential and a hard timeout.
 *
 * The credential goes in `Authorization: Bearer …` unless the provider says
 * otherwise: some gateways want `x-api-key`, and a few want the raw key with no
 * scheme. Both are expressed as plain strings in the provider override, so no
 * platform-specific branch is needed here.
 *
 * Redirects are refused when a credential is attached: a 302 to another host
 * would forward the key. Keyless probes keep the default redirect behaviour.
 *
 * @returns { status, json, text } for any HTTP answer.
 * @throws only for transport failures (DNS, TLS, timeout).
 */
async function getJson(url, { key, fetchImpl, timeoutMs, authHeader, authPrefix }) {
  const headers = { accept: 'application/json' }
  if (typeof key === 'string' && key.length > 0) {
    const header = typeof authHeader === 'string' && authHeader.trim().length > 0
      ? authHeader.trim().toLowerCase()
      : 'authorization'
    const prefix = authPrefix === undefined ? 'Bearer ' : String(authPrefix)
    headers[header] = `${prefix}${key}`
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: key ? 'error' : 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** Read a number from either a number or a numeric string. */
function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Read a string from either a string or a number, trimmed. */
function stringValue(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Normalize a DeepSeek-schema balance body.
 * @param json - the decoded response.
 * @returns { isAvailable, currency, total, granted, toppedUp } or null.
 */
export function parseDeepSeekBalance(json) {
  const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
  const info = infos[0]
  if (info === undefined || info === null) return null
  return {
    isAvailable: json?.is_available !== false,
    currency: String(info.currency ?? ''),
    total: String(info.total_balance ?? '—'),
    granted: String(info.granted_balance ?? '—'),
    toppedUp: String(info.topped_up_balance ?? '—'),
  }
}

/** DeepSeek / DeepSeek-compatible relay: a prepaid balance. */
async function queryDeepSeek(provider, options) {
  const base = normalizeBase(provider.baseURL) || DEFAULT_DEEPSEEK_BASE
  const answer = await getJson(`${base}/user/balance`, options)
  if (answer.status === 401 || answer.status === 403) {
    throw new Error('API Key 无效或无权访问（鉴权失败），请检查 Key')
  }
  if (answer.status !== 200) throw new Error(`余额接口返回状态码 ${answer.status}`)
  const balance = parseDeepSeekBalance(answer.json)
  if (balance === null) throw new Error('余额响应里没有 balance_infos')
  return { kind: 'balance', adapter: ADAPTER.deepseek, balance }
}

/**
 * Read a dotted path out of a decoded body, e.g. `data.fiveHour.remaining` or
 * `items[0].left`. Used both for built-in shapes and for user-supplied field
 * hints, so a gateway with an unusual field name needs no code.
 */
export function pickPath(json, path) {
  if (typeof path !== 'string' || path.trim().length === 0) return undefined
  let cursor = json
  for (const raw of path.trim().split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    const match = /^([^[\]]*)((?:\[\d+\])*)$/u.exec(raw)
    if (match === null) return undefined
    const [, name, indexes] = match
    if (name.length > 0) {
      cursor = cursor[name]
      if (cursor === null || cursor === undefined) return undefined
    }
    for (const index of indexes.match(/\d+/gu) ?? []) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[Number(index)]
      if (cursor === undefined) return undefined
    }
  }
  return cursor
}

/** The first numeric value among several candidate paths. */
function firstNumber(json, paths) {
  for (const path of paths) {
    const value = numberValue(pickPath(json, path))
    if (value !== null) return value
  }
  return null
}

/**
 * Bodies the generic prober recognises.
 *
 * Every matcher keys off *structure*, never off a host name: the same gateway
 * software runs on thousands of domains, so a host check would cover almost
 * nothing, and a new deployment of known software is worth supporting for free.
 *
 * `read` returns the amount in the unit named, plus an optional `scale` applied
 * afterwards — one-api counts credit in 1/500000 USD, which is a unit
 * conversion rather than a different kind of number.
 */
const SHAPES = [
  {
    // DeepSeek and every relay that copies its balance schema.
    name: 'deepseek-balance',
    match: (json) => Array.isArray(json?.balance_infos) && json.balance_infos.length > 0,
    read: (json) => {
      const info = json.balance_infos[0] ?? {}
      return {
        remaining: numberValue(info.total_balance) ?? numberValue(info.balance),
        unit: stringValue(info.currency) || 'USD',
        isActive: json.is_available !== false,
      }
    },
  },
  {
    // one-api / new-api: `quota` is the granted total, `used_quota` the spent part.
    name: 'one-api',
    match: (json) => {
      const quota = firstNumber(json, ['data.quota', 'quota'])
      const used = firstNumber(json, ['data.used_quota', 'used_quota'])
      return quota !== null && used !== null
    },
    read: (json) => {
      const quota = firstNumber(json, ['data.quota', 'quota'])
      const used = firstNumber(json, ['data.used_quota', 'used_quota'])
      return { remaining: quota - used, used, unit: 'USD', scale: 1 / 500000 }
    },
  },
  {
    // OpenRouter: credits bought minus credits spent.
    name: 'credits',
    match: (json) => {
      const total = firstNumber(json, ['data.total_credits', 'total_credits'])
      return total !== null && firstNumber(json, ['data.total_usage', 'total_usage']) !== null
    },
    read: (json) => {
      const total = firstNumber(json, ['data.total_credits', 'total_credits'])
      const used = firstNumber(json, ['data.total_usage', 'total_usage'])
      return { remaining: total - used, used, unit: 'USD' }
    },
  },
  {
    // Any flat "how much is left" field. Last resort before giving up.
    name: 'remaining',
    match: (json) => firstNumber(json, REMAINING_PATHS) !== null,
    read: (json) => ({
      remaining: firstNumber(json, REMAINING_PATHS),
      unit: firstUnit(json) ?? 'USD',
      isActive: json?.is_active !== false && json?.isValid !== false,
    }),
  },
]

/** Candidate paths for a plain "remaining amount" field, most specific first. */
const REMAINING_PATHS = [
  'remaining',
  'data.remaining',
  'quota.remaining',
  'data.quota.remaining',
  'balance',
  'data.balance',
  'available',
  'data.available',
  'credit',
  'data.credit',
  'left',
  'data.left',
  'quota',
  'data.quota',
]

function firstUnit(json) {
  for (const path of ['unit', 'currency', 'data.unit', 'data.currency']) {
    const value = stringValue(pickPath(json, path))
    if (value !== null && value.length > 0) return value.toUpperCase()
  }
  return null
}

/**
 * Apply a decoded body to the generic usage contract.
 *
 * @param json - the decoded response, or null when the body was not JSON.
 * @param hints - optional overrides: `{ remaining, used, unit, scale }`, each a
 *   dotted path (or a literal number for `scale`). Checked before the built-in
 *   shapes, so a gateway whose field names collide can be pinned down in config.
 * @returns the usage object with `remaining: null` when nothing was recognised.
 */
export function parseGenericUsage(json, hints = {}) {
  if (json === null || typeof json !== 'object') {
    return { matched: null, remaining: null, unit: 'USD', isActive: true, totalUsageUsd: null, softLimitUsd: null, hardLimitUsd: null, hasPaymentMethod: null }
  }

  const hinted = numberValue(pickPath(json, hints.remaining))
  let found = null
  if (hinted !== null) {
    found = {
      name: 'configured',
      remaining: hinted,
      used: numberValue(pickPath(json, hints.used)),
      unit: stringValue(pickPath(json, hints.unit)) ?? firstUnit(json) ?? 'USD',
      isActive: true,
      scale: numberValue(hints.scale) ?? 1,
    }
  }
  if (found === null) {
    for (const shape of SHAPES) {
      if (!shape.match(json)) continue
      found = { name: shape.name, ...shape.read(json) }
      break
    }
  }

  if (found === null || found.remaining === null) {
    return { matched: null, remaining: null, unit: 'USD', isActive: true, totalUsageUsd: null, softLimitUsd: null, hardLimitUsd: null, hasPaymentMethod: null }
  }

  const scale = numberValue(found.scale) ?? 1
  return {
    matched: found.name,
    remaining: found.remaining * scale,
    unit: String(found.unit ?? 'USD').toUpperCase(),
    isActive: found.isActive !== false,
    totalUsageUsd: numberValue(found.used) === null ? null : numberValue(found.used) * scale,
    softLimitUsd: null,
    hardLimitUsd: null,
    hasPaymentMethod: null,
  }
}

/** The legacy dashboard billing pair; subscription limits are best-effort. */
async function queryOpenAIBilling(base, options) {
  const usageAnswer = await getJson(`${base}/dashboard/billing/usage`, options)
  // Same meaning as a rejected key anywhere else: stop, do not try more paths.
  if (usageAnswer.status === 401 || usageAnswer.status === 403) {
    throw new FatalError('API Key 无效或无权访问（鉴权失败），请检查 Key')
  }
  if (usageAnswer.status !== 200) throw new Error(`账单接口返回状态码 ${usageAnswer.status}`)
  // OpenAI reports `total_usage` in cents; gateways that already send dollars
  // name the field `total_usage_usd`. Convert only the former.
  const cents = numberValue(usageAnswer.json?.total_usage)
  const dollars = numberValue(usageAnswer.json?.total_usage_usd)
  const totalUsageUsd = dollars !== null ? dollars : cents !== null ? cents / 100 : null

  let subscription = null
  try {
    const subAnswer = await getJson(`${base}/dashboard/billing/subscription`, options)
    if (subAnswer.status === 200) subscription = subAnswer.json
  } catch {
    /* limits are optional */
  }
  return {
    remaining: null,
    unit: 'USD',
    isActive: true,
    totalUsageUsd,
    softLimitUsd: numberValue(subscription?.soft_limit_usd),
    hardLimitUsd: numberValue(subscription?.hard_limit_usd),
    hasPaymentMethod: typeof subscription?.has_payment_method === 'boolean' ? subscription.has_payment_method : null,
  }
}

/**
 * Endpoints the generic prober tries, in order, each relative to the API root.
 *
 * A base URL commonly already ends in `/v1`, so every path is resolved against
 * the root rather than appended to the base: `https://x/api/v1` must produce
 * `https://x/api/v1/usage`, not `https://x/api/usage`.
 */
export function genericEndpoints(base) {
  const root = normalizeBase(base).replace(/\/v1$/u, '')
  const list = [
    { kind: 'json', url: `${root}/v1/usage` },
    { kind: 'json', url: `${root}/user/balance` },
    { kind: 'json', url: `${root}/v1/credits` },
    { kind: 'billing', url: `${root}/v1/dashboard/billing/usage` },
    { kind: 'json', url: `${root}/usage` },
  ]
  // `/api/usage` only makes sense when the root does not already end in /api.
  if (!/\/api$/u.test(root)) list.push({ kind: 'json', url: `${root}/api/usage` })
  return list
}

/** Resolve a user-pinned endpoint (absolute, or relative to the API root). */
function resolveEndpoint(base, pinned) {
  if (/^https?:\/\//iu.test(pinned)) return pinned
  const root = normalizeBase(base).replace(/\/v1$/u, '')
  return `${root}${pinned.startsWith('/') ? '' : '/'}${pinned}`
}

/**
 * Path of a probed URL, for compact failure messages and for what gets written
 * down as a binding: a path survives the gateway moving to another domain, a
 * full URL does not.
 */
function pathOf(url, base) {
  const root = normalizeBase(base).replace(/\/v1$/u, '')
  return url.startsWith(root) ? url.slice(root.length) || '/' : url
}

/**
 * The universal adapter: find whichever billing endpoint a gateway exposes.
 *
 * Platforms differ in endpoint path and response shape, but the space is small
 * and stable, so the order below is tried until one answers with a number. Only
 * DeepSeek's own adapter and Volcengine's signed OpenAPI stay special-cased —
 * everything else, including gateways nobody enumerated, lands here.
 *
 * `options.binding` carries what worked last time (persisted by the Host);
 * `options.onBind` reports a new hit so the Host can remember it. Neither is
 * required, which is what keeps this module pure enough to test offline.
 */
async function queryGeneric(provider, options) {
  const base = normalizeBase(provider.baseURL)
  if (base.length === 0) throw new Error('未配置 baseURL')
  const hints = provider.fields !== null && typeof provider.fields === 'object' ? provider.fields : {}
  // An explicit endpoint in the config always wins over a remembered one.
  const pinned = typeof hints.endpoint === 'string' && hints.endpoint.trim().length > 0
    ? [{ kind: 'json', url: resolveEndpoint(base, hints.endpoint.trim()) }]
    : null

  const binding = options.binding !== null && typeof options.binding === 'object' ? options.binding : null
  let candidates = pinned
  if (candidates === null) {
    const all = genericEndpoints(base)
    if (binding !== null && typeof binding.endpoint === 'string' && binding.endpoint.trim().length > 0) {
      // Try the remembered endpoint first, then fall back to the full list: a
      // binding that stopped working costs one extra request, not a broken card.
      const remembered = {
        kind: binding.kind === 'billing' ? 'billing' : 'json',
        url: resolveEndpoint(base, binding.endpoint.trim()),
      }
      candidates = [remembered, ...all.filter((candidate) => candidate.url !== remembered.url)]
    } else {
      candidates = all
    }
  }

  /** Hand a working endpoint to the Host so the next run skips discovery. */
  const remember = (candidate) => {
    if (pinned !== null) return
    if (typeof options.onBind !== 'function') return
    options.onBind({ endpoint: pathOf(candidate.url, base), kind: candidate.kind })
  }

  const failures = []
  for (const candidate of candidates) {
    try {
      if (candidate.kind === 'billing') {
        const usage = await queryOpenAIBilling(base, options)
        if (usage.remaining === null && usage.totalUsageUsd === null) {
          failures.push(`${pathOf(candidate.url, base)} → 账单响应里没有金额`)
          continue
        }
        remember(candidate)
        return { kind: 'usage', adapter: ADAPTER.generic, usage }
      }

      const answer = await getJson(candidate.url, options)
      if (answer.status === 401 || answer.status === 403) {
        throw new FatalError('API Key 无效或无权访问（鉴权失败），请检查 Key')
      }
      if (answer.status !== 200) {
        failures.push(`${pathOf(candidate.url, base)} → ${answer.status}`)
        continue
      }
      const usage = parseGenericUsage(answer.json, hints)
      if (usage.remaining === null) {
        failures.push(`${pathOf(candidate.url, base)} → 有响应但认不出余额字段`)
        continue
      }
      remember(candidate)
      return { kind: 'usage', adapter: ADAPTER.generic, usage }
    } catch (error) {
      if (error instanceof FatalError) throw error
      // The billing helper reports "状态码 404" rather than returning it, so
      // normalize that into the same "endpoint not there" line as the others —
      // otherwise a platform with no billing API reads as six different errors.
      const missing = /状态码 (40[45])/u.exec(describeError(error))
      if (missing !== null) {
        failures.push(`${pathOf(candidate.url, base)} → ${missing[1]}`)
        continue
      }
      // One timeout should not become six timeouts in a row.
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        failures.push(`${pathOf(candidate.url, base)} → 请求超时`)
        break
      }
      failures.push(`${pathOf(candidate.url, base)} → ${describeError(error)}`)
    }
  }

  // Every candidate answering 404/405 means the platform really has no billing
  // API, which is a fact worth stating rather than a failure worth retrying.
  const allAbsent = failures.length > 0 && failures.every((line) => /→ (404|405)$/u.test(line))
  if (allAbsent) {
    return {
      kind: 'unsupported',
      adapter: ADAPTER.unsupported,
      balance: null,
      usage: null,
      plans: [],
      note: '该网关所有已知余额接口都返回 404；若它其实有，可在 providers 里用 fields.endpoint 指定路径',
    }
  }

  throw new Error(`没有找到可用的余额接口（试了 ${candidates.length} 个）：${failures.slice(0, 5).join('；')}`)
}

// ---------------------------------------------------------------------------
// Volcengine — signed OpenAPI
// ---------------------------------------------------------------------------

const VOLC_HOST = 'open.volcengineapi.com'

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, message) {
  return createHmac('sha256', key).update(message).digest()
}

/** Region of a provider base URL (`ark.cn-beijing.volces.com`), else the env, else cn-beijing. */
export function volcengineRegion(baseURL) {
  const host = hostOf(baseURL)
  const parts = host.split(/[./]/u)
  const region = parts.find((part) => part.startsWith('cn-') && part.length > 3)
  if (region !== undefined) return region
  const fromEnv = process.env?.VOLC_REGION
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return 'cn-beijing'
}

/**
 * One signed OpenAPI POST.
 *
 * Billing operations sign `content-type;host;x-content-sha256;x-date` and leave
 * Region out of the canonical query; Ark control-plane operations sign
 * `host;x-date;x-content-sha256;content-type` and include Region. Both use the
 * same V4-style key derivation.
 */
async function volcOpenApi(credentials, { action, service, version, region, includeRegion, body }, options) {
  const accessKey = credentials.accessKey
  const secretKey = credentials.secretKey
  if (!accessKey || !secretKey) {
    throw new Error(
      '需要火山引擎账户 AccessKey ID / Secret Access Key（Ark API Key 不能查询账单）。在「插件配置 → 额度看板」里填写。',
    )
  }

  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  const now = new Date()
  const dateShort = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
  const dateLong = `${dateShort}T${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`
  const payloadHash = sha256Hex(payload)

  const canonicalQuery = includeRegion
    ? `Action=${action}&Region=${region}&Version=${version}`
    : `Action=${action}&Version=${version}`
  const signedHeaders =
    service === 'ark' ? 'host;x-date;x-content-sha256;content-type' : 'content-type;host;x-content-sha256;x-date'
  const canonicalHeaders =
    service === 'ark'
      ? `host:${VOLC_HOST}\nx-date:${dateLong}\nx-content-sha256:${payloadHash}\ncontent-type:application/json\n`
      : `content-type:application/json\nhost:${VOLC_HOST}\nx-content-sha256:${payloadHash}\nx-date:${dateLong}\n`
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`

  const scope = `${dateShort}/${region}/${service}/request`
  const stringToSign = `HMAC-SHA256\n${dateLong}\n${scope}\n${sha256Hex(canonicalRequest)}`
  const kDate = hmac(Buffer.from(secretKey, 'utf8'), dateShort)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'request')
  const signature = hmac(kSigning, stringToSign).toString('hex')
  const authorization = `HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await options.fetchImpl(`https://${VOLC_HOST}/?${canonicalQuery}`, {
    method: 'POST',
    headers: {
      host: VOLC_HOST,
      'content-type': 'application/json',
      'x-date': dateLong,
      'x-content-sha256': payloadHash,
      authorization,
    },
    body: payload,
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const text = await response.text()
  let json = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (response.status !== 200) {
    const message = json?.ResponseMetadata?.Error?.Message
    throw new Error(`火山引擎 ${action} 返回状态码 ${response.status}${message ? `: ${message}` : ''}`)
  }
  const error = json?.ResponseMetadata?.Error
  if (error !== undefined && error !== null) {
    throw new Error(`火山引擎 ${action} 失败: ${String(error.Code ?? 'UnknownError')}: ${String(error.Message ?? '')}`)
  }
  const result = json?.Result ?? json?.result
  if (result === undefined || result === null) throw new Error(`火山引擎 ${action} 未返回 Result`)
  return result
}

/** Case-tolerant field reader for OpenAPI results. */
function volcField(result, names) {
  for (const name of names) {
    const value = result?.[name]
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function volcNumber(result, names) {
  return numberValue(volcField(result, names))
}

/** Normalize a `ResetTimestamp` (seconds, ms, or numeric string) to ISO. */
export function volcResetTime(value) {
  const seconds = numberValue(value)
  if (seconds === null || seconds <= 0) return null
  const ms = seconds >= 1_000_000_000_000 ? seconds : seconds * 1000
  return new Date(ms).toISOString()
}

/** One percentage-only quota window (5h / 7d / monthly). */
function quotaPlan(id, name, percent, resetAt, status, product) {
  const used = Math.min(100, Math.max(0, Number(percent) || 0))
  return {
    id,
    name,
    product,
    total: 100,
    used,
    remaining: Math.max(0, 100 - used),
    unit: '%',
    percent: used,
    status,
    expiresAt: resetAt,
    resetAt,
    periodUsage: null,
    periodStart: null,
    periodEnd: null,
  }
}

const LEVELS = { session: '5 小时额度', weekly: '7 天额度', monthly: '每月额度' }

/** Parse `GetCodingPlanUsage` into percentage plans. */
export function parseVolcCodingPlan(result) {
  const rows = Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : result?.quotaUsage
  if (!Array.isArray(rows)) throw new Error('火山方舟 Coding Plan 未返回 QuotaUsage')
  const status = volcField(result, ['Status', 'status'])
  const plans = []
  for (const row of rows) {
    const level = String(row?.Level ?? row?.level ?? '')
    if (!Object.hasOwn(LEVELS, level)) continue
    const percent = volcNumber(row, ['Percent', 'percent'])
    if (percent === null) continue
    plans.push(
      quotaPlan(
        `volc-coding-${level}`,
        LEVELS[level],
        percent,
        volcResetTime(row?.ResetTimestamp ?? row?.resetTimestamp),
        status,
        '方舟 Coding Plan',
      ),
    )
  }
  return plans
}

/** Parse `GetAFPUsage` (Agent Plan) into percentage plans. */
export function parseVolcAgentPlan(result) {
  const planType = volcField(result, ['PlanType', 'planType']) || '方舟 Agent Plan'
  const windows = [
    ['session', 'AFPFiveHour'],
    ['weekly', 'AFPWeekly'],
    ['monthly', 'AFPMonthly'],
  ]
  const plans = []
  for (const [level, field] of windows) {
    const window = result?.[field]
    if (window === undefined || window === null) continue
    const quota = volcNumber(window, ['Quota', 'quota']) ?? 0
    if (quota <= 0) continue
    const used = volcNumber(window, ['Used', 'used']) ?? 0
    plans.push(
      quotaPlan(
        `volc-agent-${level}`,
        LEVELS[level],
        (used / quota) * 100,
        volcResetTime(window?.ResetTime ?? window?.resetTime),
        'Running',
        planType,
      ),
    )
  }
  return plans
}

/** Parse `ListResourcePackages` into amount plans, sorted by expiry. */
export function parseVolcPackages(result) {
  const rows = Array.isArray(result?.List) ? result.List : result?.list
  if (!Array.isArray(rows)) throw new Error('火山引擎资源包接口未返回 List')
  const plans = rows.map((row) => {
    const total = volcNumber(row, ['TotalAmount', 'totalAmount', 'total_amount'])
    const remaining = volcNumber(row, ['AvailableAmount', 'availableAmount', 'available_amount'])
    return {
      id: volcField(row, ['InstanceNo', 'instanceNo', 'instance_no']) ?? 'unknown',
      name:
        volcField(row, ['ConfigurationName', 'configurationName', 'InstanceName', 'instanceName']) ??
        volcField(row, ['ProductName', 'productName']) ??
        '资源包',
      product: volcField(row, ['ProductName', 'productName']) ?? volcField(row, ['Product', 'product']),
      total,
      used: total !== null && remaining !== null ? Math.max(0, total - remaining) : null,
      remaining,
      unit: volcField(row, ['Unit', 'unit', 'SpecificationUnit', 'specificationUnit']),
      percent: total !== null && total > 0 && remaining !== null ? ((total - remaining) / total) * 100 : null,
      status: volcField(row, ['Status', 'status']),
      expiresAt: volcField(row, ['ExpiryTime', 'expiryTime']),
      resetAt: null,
      periodUsage: null,
      periodStart: null,
      periodEnd: null,
    }
  })
  return plans.sort((left, right) => String(left.expiresAt ?? '').localeCompare(String(right.expiresAt ?? '')))
}

/** Best-effort trailing-30-day deduction per package, keyed by instance no. */
async function attachPackageUsage(credentials, plans, options) {
  if (plans.length === 0) return
  const end = new Date()
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)
  const format = (date) => date.toISOString().replace(/\.\d{3}Z$/u, 'Z')
  let nextToken = ''
  for (let page = 0; page < 3; page += 1) {
    let result
    try {
      result = await volcOpenApi(
        credentials,
        {
          action: 'ListPackageUsageDetails',
          service: 'billing',
          version: '2022-01-01',
          region: volcengineRegion(options.baseURL),
          includeRegion: false,
          body: {
            ResourceType: 'Package',
            DeductBeginTime: format(start),
            DeductEndTime: format(end),
            MaxResults: '50',
            NextToken: nextToken,
          },
        },
        options,
      )
    } catch {
      return
    }
    const rows = Array.isArray(result?.List) ? result.List : result?.list
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      const id = volcField(row, ['InstanceNo', 'instanceNo', 'instance_no'])
      const amount = volcNumber(row, ['DeductionAmount', 'deductionAmount', 'deduction_amount'])
      if (id === null || amount === null) continue
      const plan = plans.find((candidate) => candidate.id === id)
      if (plan === undefined) continue
      plan.periodUsage = (plan.periodUsage ?? 0) + amount
      plan.periodStart = format(start)
      plan.periodEnd = format(end)
    }
    const next = volcField(result, ['NextToken', 'nextToken', 'next_token'])
    if (next === null || next.length === 0 || next === nextToken) return
    nextToken = next
  }
}

/** Volcengine account: balance, plan windows, or resource packages. */
async function queryVolcengine(provider, options) {
  const credentials = options.volc ?? {}
  const region = volcengineRegion(provider.baseURL)
  const openOptions = { ...options, baseURL: provider.baseURL }

  const balancePromise = volcOpenApi(
    credentials,
    { action: 'QueryBalanceAcct', service: 'billing', version: '2022-01-01', region, includeRegion: false, body: {} },
    openOptions,
  )
    .then((result) => ({
      isAvailable: true,
      currency: 'CNY',
      total: volcField(result, ['AvailableBalance', 'availableBalance', 'available_balance']) ?? '0.00',
      granted: '0.00',
      toppedUp:
        volcField(result, ['CashBalance', 'cashBalance', 'cash_balance']) ??
        volcField(result, ['AvailableBalance', 'availableBalance', 'available_balance']) ??
        '0.00',
    }))
    .catch((error) => ({ error: describeError(error) }))

  /** Try the Agent Plan, then the Coding Plan. */
  const planQuery = async () => {
    const failures = []
    for (const action of ['GetAFPUsage', 'GetCodingPlanUsage']) {
      try {
        const result = await volcOpenApi(
          credentials,
          { action, service: 'ark', version: '2024-01-01', region, includeRegion: true },
          openOptions,
        )
        const plans = action === 'GetAFPUsage' ? parseVolcAgentPlan(result) : parseVolcCodingPlan(result)
        if (plans.length > 0) return plans
      } catch (error) {
        failures.push(`${action}: ${describeError(error)}`)
      }
    }
    throw new Error(failures.join('；') || '火山方舟未返回可识别的套餐用量窗口')
  }

  const [balanceResult, plansResult] = await Promise.all([
    balancePromise,
    planQuery().then(
      (plans) => ({ plans }),
      (error) => ({ error: describeError(error) }),
    ),
  ])

  let plans = plansResult.plans ?? []
  let note = plansResult.error ?? null

  if (plans.length === 0) {
    // No subscription plan: fall back to prepaid resource packages.
    try {
      const listing = await volcOpenApi(
        credentials,
        {
          action: 'ListResourcePackages',
          service: 'billing',
          version: '2022-01-01',
          region,
          includeRegion: false,
          body: { ResourceType: 'Package', MaxResults: '20', NextToken: '' },
        },
        openOptions,
      )
      plans = parseVolcPackages(listing)
      if (plans.length > 0) await attachPackageUsage(credentials, plans, openOptions)
    } catch (error) {
      note = note === null ? describeError(error) : `${note}；${describeError(error)}`
    }
  }

  if (balanceResult.error !== undefined && plans.length === 0) {
    throw new Error(`火山账户余额查询失败: ${balanceResult.error}；套餐用量查询失败: ${note ?? '未知原因'}`)
  }

  return {
    kind: balanceResult.error === undefined ? 'balance' : 'quota',
    adapter: ADAPTER.volcengine,
    balance: balanceResult.error === undefined ? balanceResult : null,
    plans,
    note,
  }
}

/**
 * Query one provider through the adapter its route selects.
 *
 * A probe (unknown protocol) tries the OpenAI family, then the DeepSeek schema;
 * both failures are reported together so the user can see what was attempted.
 *
 * @param provider - `{ id, displayName, baseURL, api }`.
 * @param options - `{ key, volc, timeoutMs, fetchImpl }`.
 * @returns `{ kind, adapter, balance, usage, plans, note }`.
 */
export async function queryProvider(provider, options) {
  const adapter = provider.adapter ?? adapterFor(provider.api, provider.baseURL, options.skipHosts)
  const hasKey = typeof options.key === 'string' && options.key.length > 0
  // The credential may belong in a non-standard header; carry that choice into
  // every request instead of hardcoding Bearer at each call site.
  const call = {
    ...options,
    authHeader: provider.authHeader,
    authPrefix: provider.authPrefix,
  }

  if (adapter === ADAPTER.unsupported) {
    return { kind: 'unsupported', adapter, balance: null, usage: null, plans: [], note: UNSUPPORTED_NOTE }
  }
  // Volcengine needs account AK/SK signing, so it is handed the whole key pair
  // rather than the API key.
  if (adapter === ADAPTER.volcengine) return queryVolcengine(provider, call)
  if (!hasKey) throw new Error('未配置 API Key')
  if (adapter === ADAPTER.deepseek) return queryDeepSeek(provider, call)
  return queryGeneric(provider, call)
}
