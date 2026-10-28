/**
 * Offline smoke suite for dsh-quota-board.
 *
 * Runs the real modules — adapters, discovery, usage aggregation — against a
 * local mock HTTP server, then materializes `client.js` in a VM with stub React
 * and slot registry to prove the page actually renders a populated report.
 *
 *   node dev/smoke.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
// ESM's default loader rejects drive-letter specifiers on Windows, so every
// module under test has to be addressed as a file:// URL.
const load = (file) => import(pathToFileURL(join(ROOT, file)).href)

const {
  adapterFor,
  queryProvider,
  parseDeepSeekBalance,
  parseGenericUsage,
  parseVolcAgentPlan,
  parseVolcCodingPlan,
  parseVolcPackages,
  volcResetTime,
} = await load('adapters.js')
const { discoverProviders, defaultProviderOf, parseProviderOverrides, providerFromEntry } = await load('providers.js')
const { usageReport } = await load('usage.js')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) throw new Error('use await checkAsync')
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error.message}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// mock provider server
// ---------------------------------------------------------------------------

const hits = []
const server = createServer((req, res) => {
  hits.push(req.url)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url === '/deepseek/user/balance') {
    if (req.headers.authorization !== 'Bearer good-key') return send(401, { error: 'bad key' })
    return send(200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
      ],
    })
  }
  if (req.url === '/openai/v1/usage') {
    if (req.headers.authorization !== 'Bearer good-key') return send(401, { error: 'bad key' })
    return send(200, { remaining: 42.5, unit: 'USD', is_active: true })
  }
  if (req.url === '/billing/v1/usage') return send(404, { error: 'not found' })
  if (req.url === '/billing/dashboard/billing/usage') {
    return send(200, { total_usage: 1234 })
  }
  if (req.url === '/billing/dashboard/billing/subscription') {
    return send(200, { has_payment_method: true, soft_limit_usd: 100, hard_limit_usd: 120 })
  }
  // A gateway nobody has ever enumerated: non-standard path, snake-free field
  // names, and a key that belongs in `x-api-key` rather than Authorization.
  if (req.url === '/strange/api/me/quota') {
    if (req.headers['x-api-key'] !== 'strange-key') return send(401, { error: 'bad key' })
    return send(200, { data: { credit: 88.5, currency: 'cny' } })
  }
  // one-api / new-api: credit counted in 1/500000 USD.
  if (req.url === '/oneapi/v1/usage') {
    return send(200, { data: { quota: 2500000, used_quota: 500000 } })
  }
  // OpenRouter-style credits.
  if (req.url === '/credits/v1/credits') {
    return send(200, { data: { total_credits: 20, total_usage: 7.5 } })
  }
  // Only the second candidate answers, so the first-miss path is exercised.
  if (req.url === '/deeponly/user/balance') {
    return send(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5.00' }] })
  }
  // Every candidate rejects the key: the probe must stop at the first 401.
  if (req.url.startsWith('/authfail/')) return send(401, { error: 'bad key' })
  return send(404, { error: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const fetchImpl = (url, init) => fetch(url, init)

// ---------------------------------------------------------------------------
// routing + adapters
// ---------------------------------------------------------------------------

console.log('\nrouting')
check('deepseek host routes to the DeepSeek adapter', () => {
  assert.equal(adapterFor('openai', 'https://api.deepseek.com'), 'deepseek')
})
check('volcengine host wins over the openai wire hint', () => {
  assert.equal(adapterFor('openai-responses', 'https://ark.cn-beijing.volces.com/api/coding/v3'), 'volcengine')
})
check('aliyun compatible mode is reported unsupported', () => {
  assert.equal(adapterFor('openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), 'unsupported')
})
check('an unknown gateway defaults to the generic adapter, not a dead end', () => {
  assert.equal(adapterFor('', 'https://gw.example.com/v1'), 'generic')
  assert.equal(adapterFor('openai', 'https://gw.example.com/v1'), 'generic')
  assert.equal(adapterFor('', ''), 'generic')
})

check('only the two genuinely special families are special-cased', () => {
  assert.equal(adapterFor('', 'https://api.deepseek.com'), 'deepseek')
  assert.equal(adapterFor('', 'https://ark.cn-beijing.volces.com/api/v3'), 'volcengine')
  assert.equal(adapterFor('openai', 'https://ark.cn-beijing.volces.com/api/v3'), 'volcengine')
})

check('the skip list is a default that config can extend or bypass', () => {
  assert.equal(adapterFor('', 'https://api.anthropic.com/v1'), 'unsupported')
  // An explicit list replaces the built-in one, so nothing is skipped.
  assert.equal(adapterFor('', 'https://api.anthropic.com/v1', []), 'generic')
  // Extra entries are honoured.
  assert.equal(adapterFor('', 'https://newvendor.example.com/v1', ['newvendor']), 'unsupported')
})

console.log('\nadapters')
await checkAsync('DeepSeek balance is parsed and summarized', async () => {
  const result = await queryProvider(
    { id: 'ds', baseURL: `${base}/deepseek`, api: 'deepseek' },
    { key: 'good-key', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.kind, 'balance')
  assert.equal(result.balance.total, '12.34')
  assert.equal(result.balance.currency, 'CNY')
})

await checkAsync('a rejected DeepSeek key names the failure', async () => {
  await assert.rejects(
    queryProvider({ id: 'ds', baseURL: `${base}/deepseek`, api: 'deepseek' }, { key: 'bad', timeoutMs: 5000, fetchImpl }),
    /API Key 无效/,
  )
})

await checkAsync('generic /v1/usage is preferred over the billing endpoints', async () => {
  const result = await queryProvider(
    { id: 'oa', baseURL: `${base}/openai/v1`, api: 'openai' },
    { key: 'good-key', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.usage.remaining, 42.5)
  assert.ok(!hits.includes('/billing/dashboard/billing/usage'))
})

await checkAsync('a gateway without /v1/usage falls back to dashboard billing', async () => {
  const result = await queryProvider(
    { id: 'oa', baseURL: `${base}/billing`, api: 'openai' },
    { key: 'good-key', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.usage.totalUsageUsd, 12.34)
  assert.equal(result.usage.softLimitUsd, 100)
  assert.equal(result.usage.hasPaymentMethod, true)
})

await checkAsync('unsupported platforms return a note instead of a request', async () => {
  const result = await queryProvider(
    { id: 'ali', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai' },
    { key: 'k', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.kind, 'unsupported')
  assert.match(result.note, /未提供可通过 API Key 查询/)
})

await checkAsync('volcengine without an account key pair explains what is missing', async () => {
  const result = await queryProvider(
    { id: 'volc', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', api: 'openai-responses' },
    { key: 'ark-key', volc: { accessKey: '', secretKey: '' }, timeoutMs: 5000, fetchImpl },
  ).then(
    () => {
      throw new Error('expected a rejection')
    },
    (error) => error,
  )
  assert.match(result.message, /AccessKey/)
})

console.log('\ngeneric probe')
await checkAsync('an unenumerated gateway is reached through config alone', async () => {
  const result = await queryProvider(
    {
      id: 'strange',
      baseURL: `${base}/strange`,
      api: 'openai',
      // No code names this gateway: the path, the field and the header all
      // come from the provider definition.
      authHeader: 'x-api-key',
      authPrefix: '',
      fields: { endpoint: '/api/me/quota', remaining: 'data.credit', unit: 'data.currency' },
    },
    { key: 'strange-key', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.kind, 'usage')
  assert.equal(result.usage.remaining, 88.5)
  assert.equal(result.usage.unit, 'CNY')
  assert.equal(result.usage.matched, 'configured')
})

await checkAsync('a gateway with a novel field name is recognised by shape', async () => {
  const result = await queryProvider(
    // No `fields` at all: only the body shape distinguishes it.
    { id: 'one', baseURL: `${base}/oneapi`, api: 'openai' },
    { key: 'k', timeoutMs: 5000, fetchImpl },
  )
  // one-api counts credit in 1/500000 USD: 2500000 granted - 500000 spent.
  assert.equal(result.usage.matched, 'one-api')
  assert.equal(result.usage.remaining, 4)
  assert.equal(result.usage.totalUsageUsd, 1)
})

await checkAsync('OpenRouter-style credits are turned into a remaining balance', async () => {
  const result = await queryProvider(
    { id: 'or', baseURL: `${base}/credits`, api: 'openai' },
    { key: 'k', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.usage.matched, 'credits')
  assert.equal(result.usage.remaining, 12.5)
})

await checkAsync('a gateway that answers on the second candidate is found', async () => {
  const result = await queryProvider(
    { id: 'deeponly', baseURL: `${base}/deeponly`, api: 'openai' },
    { key: 'k', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.kind, 'usage')
  assert.equal(result.usage.matched, 'deepseek-balance')
  assert.equal(result.usage.remaining, 5)
})

await checkAsync('a hit is reported so it can be bound', async () => {
  const provider = { id: 'deeponly2', baseURL: `${base}/deeponly`, api: 'openai' }
  let binding = null
  const before = hits.length
  const result = await queryProvider(provider, {
    key: 'k',
    timeoutMs: 5000,
    fetchImpl,
    onBind: (value) => {
      binding = value
    },
  })
  const sent = hits.length - before
  assert.equal(result.usage.matched, 'deepseek-balance')
  assert.deepEqual(binding, { endpoint: '/user/balance', kind: 'json' })
  assert.equal(sent, 2, `discovery should miss once then hit, sent ${sent}`)
})

await checkAsync('a bound endpoint is reused, so refresh is one request', async () => {
  const provider = { id: 'deeponly3', baseURL: `${base}/deeponly`, api: 'openai' }
  const before = hits.length
  await queryProvider(provider, {
    key: 'k',
    timeoutMs: 5000,
    fetchImpl,
    binding: { endpoint: '/user/balance', kind: 'json' },
  })
  assert.equal(hits.length - before, 1, 'a bound provider answers with one request')
})

await checkAsync('a stale binding falls back to discovery and is re-bound', async () => {
  const provider = { id: 'deeponly4', baseURL: `${base}/deeponly`, api: 'openai' }
  let rebound = null
  const result = await queryProvider(provider, {
    key: 'k',
    timeoutMs: 5000,
    fetchImpl,
    // The gateway moved its endpoint; the stale path must not break the card.
    binding: { endpoint: '/v1/gone', kind: 'json' },
    onBind: (value) => {
      rebound = value
    },
  })
  assert.equal(result.kind, 'usage')
  assert.equal(rebound.endpoint, '/user/balance')
})

await checkAsync('a rejected key stops the probe instead of walking every path', async () => {
  const before = hits.length
  await assert.rejects(
    queryProvider({ id: 'af', baseURL: `${base}/authfail`, api: 'openai' }, { key: 'k', timeoutMs: 5000, fetchImpl }),
    /API Key 无效或无权访问/,
  )
  assert.equal(hits.length - before, 1, 'a 401 must abort the probe immediately')
})

await checkAsync('all-404 is reported as unsupported, not as a failure', async () => {
  const result = await queryProvider(
    { id: 'dead', baseURL: `${base}/nowhere`, api: 'openai' },
    { key: 'k', timeoutMs: 5000, fetchImpl },
  )
  assert.equal(result.kind, 'unsupported')
  assert.match(result.note, /fields\.endpoint/)
})

console.log('\nvolcengine parsers')
check('Agent Plan windows become percentage plans', () => {
  const plans = parseVolcAgentPlan({
    PlanType: '方舟 Agent Plan',
    AFPFiveHour: { Quota: 100, Used: 25, ResetTime: 1791796140 },
    AFPWeekly: { Quota: 200, Used: 50, ResetTime: 1791796140 },
    AFPMonthly: { Quota: 0, Used: 0 },
  })
  assert.equal(plans.length, 2)
  assert.equal(plans[0].name, '5 小时额度')
  assert.equal(plans[0].used, 25)
  assert.equal(plans[0].remaining, 75)
  assert.equal(plans[0].unit, '%')
  assert.ok(plans[0].resetAt.endsWith('Z'))
})

check('Coding Plan windows skip unknown levels', () => {
  const plans = parseVolcCodingPlan({
    Status: 'Running',
    QuotaUsage: [
      { Level: 'session', Percent: 42 },
      { Level: 'quarterly', Percent: 10 },
      { Level: 'weekly', Percent: 130 },
    ],
  })
  assert.equal(plans.length, 2)
  assert.equal(plans[1].used, 100)
  assert.equal(plans[1].remaining, 0)
})

check('resource packages compute used from total and remaining', () => {
  const plans = parseVolcPackages({
    List: [
      { InstanceNo: 'A', ConfigurationName: '1M tokens', TotalAmount: 1000000, AvailableAmount: 750000, Unit: 'tokens', ExpiryTime: '2026-12-01' },
    ],
  })
  assert.equal(plans[0].used, 250000)
  assert.equal(plans[0].percent, 25)
})

check('reset timestamps accept seconds and milliseconds', () => {
  assert.equal(volcResetTime(1791796140), new Date(1791796140000).toISOString())
  assert.equal(volcResetTime(1791796140000), new Date(1791796140000).toISOString())
  assert.equal(volcResetTime(0), null)
})

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

console.log('\ndiscovery')
const entriesFixture = [
  {
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        volcengine: {
          displayName: '火山引擎',
          apiKeyEnv: 'VOLCENGINE_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3/',
          models: [{ id: 'deepseek-v4-1-flash-260910' }, { id: 'other' }],
        },
        bare: { displayName: 'No base', api: 'openai', apiKeyEnv: 'BARE_KEY' },
      },
    },
  },
  { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'volcengine', model: 'x' } },
  { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: {} },
]

check('pi-ai providers, DeepSeek and the default flag are discovered', () => {
  const providers = discoverProviders(entriesFixture, {})
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  assert.deepEqual([...byId.keys()].sort(), ['bare', 'deepseek-official', 'volcengine'])
  assert.equal(byId.get('volcengine').adapter, 'volcengine')
  assert.equal(byId.get('volcengine').baseURL, 'https://ark.cn-beijing.volces.com/api/coding/v3')
  assert.equal(byId.get('volcengine').isDefault, true)
  assert.deepEqual(byId.get('volcengine').models, ['deepseek-v4-1-flash-260910', 'other'])
  assert.equal(byId.get('deepseek-official').keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(byId.get('bare').baseURL, '')
})

check('the configured base URL and key ref override the defaults', () => {
  const providers = discoverProviders(
    [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'https://relay.example.com/', apiKeyEnv: 'MY_DS' } }],
    {},
  )
  assert.equal(providers.length, 1)
  assert.equal(providers[0].baseURL, 'https://relay.example.com')
  assert.equal(providers[0].keyRef, 'MY_DS')
})

check('manual providers override discovered ones and add new ones', () => {
  const providers = discoverProviders(entriesFixture, {
    overrides: JSON.stringify([
      { id: 'volcengine', displayName: '火山（手工）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
      { id: 'my-gw', displayName: '我的网关', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY', api: 'openai' },
    ]),
  })
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  assert.equal(byId.get('volcengine').displayName, '火山（手工）')
  assert.equal(byId.get('volcengine').source, 'config')
  assert.equal(byId.get('volcengine').keyRef, 'VOLCENGINE_API_KEY')
  // `api: openai` is a shape hint, not a promise of a billing endpoint; it
  // normalises onto the universal prober.
  assert.equal(byId.get('my-gw').adapter, 'generic')
})

check('malformed override JSON is ignored, not fatal', () => {
  assert.deepEqual(parseProviderOverrides('{oops'), [])
  assert.deepEqual(parseProviderOverrides('{"not":"an array"}'), [])
  assert.deepEqual(parseProviderOverrides(''), [])
  const providers = discoverProviders(entriesFixture, { overrides: '{oops' })
  assert.equal(providers.length, 3)
})

check('an unrecognised llm-* adapter row becomes a provider, not a silent drop', () => {
  const entries = [
    ...entriesFixture,
    {
      id: 'llm-something-new',
      name: '@deepseek-ai/dsh-llm-something-new',
      config: { baseURL: 'https://new.example.com/v1', apiKeyEnv: 'NEW_KEY' },
    },
    // An adapter row with no address cannot answer a balance call.
    { id: 'llm-no-address', name: '@deepseek-ai/dsh-llm-no-address', config: {} },
  ]
  const byId = new Map(discoverProviders(entries, {}).map((provider) => [provider.id, provider]))
  assert.equal(byId.get('llm-something-new').keyRef, 'NEW_KEY')
  assert.equal(byId.get('llm-something-new').adapter, 'generic')
  assert.equal(byId.get('llm-something-new').source, 'profile')
  assert.equal(byId.has('llm-no-address'), false)
})

check('an override can pin the adapter for a misdetected gateway', () => {
  const providers = discoverProviders(
    [{ id: 'llm-custom', name: 'x-llm-custom', config: { baseURL: 'https://api.anthropic.com/v1' } }],
    { overrides: JSON.stringify([{ id: 'llm-custom', adapter: 'generic' }]) },
  )
  assert.equal(providers[0].adapter, 'generic')
})

check('the default provider is read only from a default-model row', () => {
  assert.equal(defaultProviderOf(entriesFixture), 'volcengine')
  assert.equal(defaultProviderOf([{ id: 'other', config: { provider: 'x' } }]), '')
})

// ---------------------------------------------------------------------------
// local usage
// ---------------------------------------------------------------------------

console.log('\nbindings')

const { bindingKeyOf, bindingStorePath, makeBinding, readBindings, writeBindings } = await load('bindings.js')

check('an api root is the key, with the version suffix normalized away', () => {
  assert.equal(bindingKeyOf('https://gw.example.com/v1'), 'https://gw.example.com')
  assert.equal(bindingKeyOf('https://gw.example.com/v1/'), 'https://gw.example.com')
  assert.equal(bindingKeyOf('https://gw.example.com/api/v1'), 'https://gw.example.com/api')
  assert.equal(bindingKeyOf('  '), '')
})

check('a missing or corrupt store reads as empty instead of throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'dqb-bind-'))
  const file = bindingStorePath(home)
  assert.deepEqual(readBindings(file), {})
  mkdirSync(join(home, 'storages', 'quota-board'), { recursive: true })
  writeFileSync(file, '{not json')
  assert.deepEqual(readBindings(file), {})
  writeFileSync(file, '[]')
  assert.deepEqual(readBindings(file), {})
  rmSync(home, { recursive: true, force: true })
})

check('a binding survives a write and an unchanged write is skipped', () => {
  const home = mkdtempSync(join(tmpdir(), 'dqb-bind-'))
  const file = bindingStorePath(home)
  const record = { 'https://gw.example.com': makeBinding({ endpoint: '/v1/usage', kind: 'json' }, 0) }
  assert.equal(writeBindings(file, record), true)
  assert.deepEqual(readBindings(file), record)
  // Same content must not touch the file: the dashboard refreshes every minute.
  assert.equal(writeBindings(file, record), false)
  // A billing endpoint keeps its kind, which decides whether the pair of
  // dashboard calls is repeated or a single JSON GET is used.
  const mixed = { ...record, 'https://b.example.com': makeBinding({ endpoint: '/x', kind: 'billing' }, 0) }
  writeBindings(file, mixed)
  assert.equal(readBindings(file)['https://b.example.com'].kind, 'billing')
  rmSync(home, { recursive: true, force: true })
})

check('the binding record carries no credentials or body', () => {
  const record = makeBinding({ endpoint: '/v1/usage', kind: 'json', token: 'secret', body: { x: 1 } }, 0)
  assert.deepEqual(Object.keys(record).sort(), ['endpoint', 'kind', 'updatedAt'])
})

console.log('\ntest connection')

check('an entry from the form becomes a provider with its own references', () => {
  const provider = providerFromEntry({
    id: 'ark2',
    displayName: '方舟（另一个账户）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3/',
    apiKeyEnv: 'ARK_API_KEY_2',
    accessKeyEnv: 'VOLC_ACCESS_KEY_2',
    secretKeyEnv: 'VOLC_SECRET_KEY_2',
    adapter: 'volcengine',
  })
  assert.equal(provider.baseURL, 'https://ark.cn-beijing.volces.com/api/v3', '结尾斜杠要被去掉')
  assert.equal(provider.adapter, 'volcengine')
  assert.equal(provider.keyRef, 'ARK_API_KEY_2')
  assert.equal(provider.accessKeyRef, 'VOLC_ACCESS_KEY_2')
  assert.equal(provider.secretKeyRef, 'VOLC_SECRET_KEY_2')
  // A test never marks anything as the current default.
  assert.equal(provider.isDefault, false)
})

check('a volcengine entry without reference names still gets the defaults', () => {
  const provider = providerFromEntry({ id: 'ark', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' })
  assert.equal(provider.accessKeyRef, 'VOLC_ACCESS_KEY')
  assert.equal(provider.secretKeyRef, 'VOLC_SECRET_KEY')
})

check('an entry with no address cannot be tested, and says why', () => {
  assert.equal(providerFromEntry({ id: 'blank', baseURL: '' }), null)
  assert.equal(providerFromEntry({ id: 'blank', baseURL: '   ' }), null)
  // A missing id is not fatal: the probe names it `custom-1` and still runs.
  const unnamed = providerFromEntry({ baseURL: 'https://gw.example.com/v1' })
  assert.equal(unnamed.id, 'custom-1')
})

await checkAsync('testing an entry hits the endpoint the card would use', async () => {
  const provider = providerFromEntry({
    id: 'gw',
    baseURL: `${base}/openai/v1`,
    apiKeyEnv: 'GW_KEY',
    fields: { endpoint: '/v1/usage' },
  })
  const reached = []
  const result = await queryProvider(provider, {
    key: 'good-key',
    timeoutMs: 5000,
    fetchImpl,
    skipHosts: [],
    binding: null,
    // The test path collects the endpoint instead of persisting it.
    onBind: (binding) => reached.push(binding),
  })
  assert.equal(result.kind, 'usage')
  assert.equal(result.usage.remaining, 42.5)
  // A pinned endpoint is already written down, so there is nothing to report.
  assert.deepEqual(reached, [])
})

await checkAsync('a test reports the endpoint it discovered, without binding it', async () => {
  const provider = providerFromEntry({ id: 'slow', baseURL: `${base}/deeponly/v1`, apiKeyEnv: 'SLOW_KEY' })
  const reached = []
  const result = await queryProvider(provider, {
    key: 'any-key',
    timeoutMs: 5000,
    fetchImpl,
    skipHosts: [],
    binding: null,
    onBind: (binding) => reached.push(binding),
  })
  assert.equal(result.kind, 'usage')
  // Only the second candidate answers, so this is the probed one.
  assert.deepEqual(reached, [{ endpoint: '/user/balance', kind: 'json' }])
})

// The Host wrapper itself: credential resolution, probe, and — importantly —
// no binding is written, because the entry may still be edited.
const { probeProviderEntry, readAccountWallet } = await load('index.js')

await checkAsync('the Host probe resolves the key from the environment and reports the endpoint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dqb-probe-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  process.env.DQB_TEST_KEY = 'good-key'
  try {
    const result = await probeProviderEntry(
      { get: () => undefined },
      { id: 'gw', displayName: '我的网关', baseURL: `${base}/openai/v1`, apiKeyEnv: 'DQB_TEST_KEY' },
      { lowThreshold: 5, timeoutMs: 5000, fetchImpl },
      [],
    )
    assert.equal(result.ok, true)
    assert.equal(result.status.kind, 'usage')
    assert.equal(result.status.usage.remaining, 42.5)
    assert.equal(result.status.configured, true)
    assert.equal(result.endpoint, '/v1/usage', '探测到的接口要回报给用户')
    assert.equal(result.endpointKind, 'json')
    // A test must not pin anything: the store stays absent.
    assert.equal(existsSync(bindingStorePath(home)), false, '测试连接不能写 bindings.json')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete process.env.DQB_TEST_KEY
    rmSync(home, { recursive: true, force: true })
  }
})

await checkAsync('the Host probe explains a missing credential instead of calling out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dqb-probe-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = await probeProviderEntry(
      { get: () => undefined },
      { id: 'gw', baseURL: `${base}/openai/v1`, apiKeyEnv: 'DQB_TEST_MISSING' },
      { lowThreshold: 5, timeoutMs: 5000, fetchImpl },
      [],
    )
    assert.equal(result.ok, true)
    assert.equal(result.status.configured, false)
    assert.match(result.status.error, /未配置 API Key/)
    assert.equal(result.endpoint, null)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

await checkAsync('the Host probe refuses an entry with no address', async () => {
  const result = await probeProviderEntry(
    { get: () => undefined },
    { id: 'blank', baseURL: '' },
    { lowThreshold: 5, timeoutMs: 5000, fetchImpl },
    [],
  )
  assert.equal(result.ok, false)
  assert.match(result.reason, /baseURL/)
})

console.log('\naccount wallet')
// Harness already knows the signed-in balance — the settings page reads it from
// the same service. Every failure mode must degrade to the API-key path instead
// of throwing, because the board cannot lose every card over one wallet.
await checkAsync('the wallet reader reports its four states without throwing', async () => {
  const ready = {
    getState: () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '1' }], bonusWallets: [] }),
  }
  assert.equal((await readAccountWallet({ get: () => ready })).status, 'ready')
  assert.equal((await readAccountWallet({ get: () => undefined })).status, 'absent')

  const signedOut = { getState: () => ({ status: 'signed-out' }) }
  assert.equal((await readAccountWallet({ get: () => signedOut })).status, 'signed-out')

  const broken = {
    getState: () => ({ status: 'credential-stored' }),
    getBalance: async () => {
      throw new Error('storage')
    },
  }
  assert.equal((await readAccountWallet({ get: () => broken })).status, 'failed')

  const failed = {
    getState: () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'failed' }),
  }
  assert.equal((await readAccountWallet({ get: () => failed })).status, 'failed')
})

await checkAsync('a signed-in DeepSeek account fills the card without any API key', async () => {
  let outbound = 0
  const account = {
    getState: () => ({ status: 'credential-stored' }),
    getBalance: async (client) => {
      assert.equal(typeof client?.timezoneOffsetSeconds, 'number')
      assert.equal(typeof client?.locale, 'string')
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '-0.07' }],
        bonusWallets: [{ currency: 'CNY', balance: '38.48' }],
      }
    },
  }
  const result = await probeProviderEntry(
    { get: (name) => (name === 'deepseekAccount' ? account : undefined) },
    { id: 'ds', displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com' },
    {
      lowThreshold: 5,
      timeoutMs: 5000,
      fetchImpl: () => {
        outbound += 1
        throw new Error('账号余额不需要打供应商接口')
      },
    },
    [],
  )
  assert.equal(result.ok, true)
  assert.equal(result.status.kind, 'balance')
  assert.equal(result.status.balanceSource, 'account')
  assert.equal(result.status.keySource, 'account')
  assert.equal(result.status.configured, true, '有账号余额就不该显示「未配置」')
  // Recharge and bonus add up to the number the settings page shows.
  assert.equal(result.status.balance.total, '38.41')
  assert.equal(result.status.balance.toppedUp, '-0.07')
  assert.equal(result.status.balance.granted, '38.48')
  assert.equal(outbound, 0, '走账号时不该向供应商发请求')
})

await checkAsync('a DeepSeek-compatible relay keeps using its own key', async () => {
  let walletReads = 0
  const account = {
    getState: () => ({ status: 'credential-stored' }),
    getBalance: async () => {
      walletReads += 1
      return { status: 'ready', value: [], bonusWallets: [] }
    },
  }
  process.env.DQB_RELAY_KEY = 'relay-key'
  try {
    const result = await probeProviderEntry(
      { get: (name) => (name === 'deepseekAccount' ? account : undefined) },
      { id: 'relay', baseURL: `${base}/openai/v1`, apiKeyEnv: 'DQB_RELAY_KEY' },
      { lowThreshold: 5, timeoutMs: 5000, fetchImpl },
      [],
    )
    assert.equal(walletReads, 0, '中转站的余额不属于当前账号，不能拿账号钱包顶替')
    assert.equal(result.ok, true)
    assert.notEqual(result.status.balanceSource, 'account')
  } finally {
    delete process.env.DQB_RELAY_KEY
  }
})

await checkAsync('a signed-out account with no key explains both routes', async () => {
  const account = { getState: () => ({ status: 'signed-out' }) }
  const result = await probeProviderEntry(
    { get: (name) => (name === 'deepseekAccount' ? account : undefined) },
    { id: 'ds', displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com' },
    { lowThreshold: 5, timeoutMs: 5000, fetchImpl },
    [],
  )
  assert.equal(result.ok, true)
  assert.equal(result.status.configured, false)
  assert.match(result.status.error, /账号与余额/)
  assert.match(result.status.error, /API Key/)
})

console.log('\nlocal usage')
const home = mkdtempSync(join(tmpdir(), 'dqb-'))
const sessionsDir = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const now = Date.now()
const sessionRecord = (id, createdAt, tokens, model, provider) => ({
  version: 7,
  record: {
    identity: { createdAt, cwd: 'D:\\code\\x' },
    rows: {
      title: { val: `会话 ${id}` },
      tokenUsage: {
        val: {
          totals: {
            uncachedInputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead,
            cacheWriteTokens: 0,
          },
        },
      },
      sessionStats: { val: { turns: 2, steps: 8, requests: 6 } },
      modelSelection: { val: { lastUsed: { provider, model } } },
      contextPressure: { val: { contextWindow: 100000, pressureTokens: 45000 } },
    },
  },
})
writeFileSync(
  join(sessionsDir, 'a.json'),
  JSON.stringify(sessionRecord('a', now - 60_000, { input: 1000, output: 2000, cacheRead: 120000 }, 'm1', 'volcengine')),
)
writeFileSync(
  join(sessionsDir, 'b.json'),
  JSON.stringify(sessionRecord('b', now - 3 * 86_400_000, { input: 500, output: 500, cacheRead: 0 }, 'm2', 'deepseek-official')),
)
writeFileSync(join(sessionsDir, 'broken.json'), '{not json')

const usage = usageReport(home, { days: 14 })
check('totals, model and provider attribution are aggregated', () => {
  assert.equal(usage.available, true)
  assert.equal(usage.totals.total, 124000)
  assert.equal(usage.totals.input, 1500)
  assert.equal(usage.byModel.length, 2)
  assert.equal(usage.byProvider.length, 2)
  assert.equal(usage.counts.sessions, 2)
  assert.equal(usage.counts.activeDays, 2)
})
check('today only counts sessions created today', () => {
  assert.equal(usage.today, 123000)
})
check('the daily series is padded to the requested window', () => {
  assert.equal(usage.byDay.length, 14)
  assert.equal(usage.byDay.at(-1).date, new Date().toISOString().slice(0, 10))
  assert.equal(usage.byDay.at(-1).total, 123000)
})
check('recent sessions carry model, turns and context pressure', () => {
  assert.equal(usage.sessions.length, 2)
  assert.equal(usage.sessions[0].id, 'a')
  assert.equal(usage.sessions[0].model, 'm1')
  assert.equal(usage.sessions[0].turns, 2)
  assert.equal(usage.sessions[0].contextPressure.ratio, 0.45)
})
check('a missing cache yields a zeroed but renderable report', () => {
  const empty = usageReport(join(home, 'nope'), { days: 7 })
  assert.equal(empty.available, false)
  assert.equal(empty.totals.total, 0)
  assert.equal(empty.byDay.length, 7)
  assert.deepEqual(empty.sessions, [])
})
rmSync(home, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// browser half: registrations + render
// ---------------------------------------------------------------------------

console.log('\nclient module')

/** A tiny React stand-in: elements, hook slots, seeded initial state. */
function makeReact() {
  const runtime = { hooks: [], index: 0, seeds: [], effects: [], cleanups: [] }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (child === null || child === undefined || child === false || child === true) return
        if (Array.isArray(child)) child.forEach(push)
        else flat.push(child)
      }
      push(children)
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const index = runtime.index++
      // Capture the slot array for this mount. A promise started by an earlier
      // test can resolve after the next `reset`, and writing through
      // `runtime.hooks` would then land in the *new* test's slots — the page's
      // pending load was corrupting whatever ran next.
      const slots = runtime.hooks
      if (!(index in slots)) slots[index] = runtime.seeds.length > 0 ? runtime.seeds.shift() : initial
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        },
      ]
    },
    useRef(initial) {
      const index = runtime.index++
      if (!(index in runtime.hooks)) runtime.hooks[index] = { current: initial }
      return runtime.hooks[index]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      runtime.effects.push(fn)
    },
    // The popover measures its anchor in a layout effect. This stub only queues
    // it like `useEffect`: the fake refs are `null`, so the effect has to cope
    // with an unmeasured anchor anyway.
    useLayoutEffect(fn) {
      runtime.effects.push(fn)
    },
  }
  const reset = (seeds) => {
    runtime.index = 0
    // A reset is a fresh mount, so the previous render's hook slots must go;
    // otherwise the second test silently reuses the first test's state.
    runtime.hooks = []
    runtime.seeds = [...(seeds ?? [])]
    runtime.effects = []
  }
  /**
   * Re-render against the *same* hook slots, which is what a click does in a
   * real renderer. The index has to rewind or the second pass would allocate
   * fresh slots for every hook and drop the state the event just wrote.
   */
  const rerender = () => {
    runtime.index = 0
    runtime.effects = []
    return runtime
  }
  const flush = () => {
    for (const effect of runtime.effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') runtime.cleanups.push(cleanup)
    }
    runtime.effects = []
  }
  const dispose = () => {
    for (const cleanup of runtime.cleanups) cleanup()
    runtime.cleanups = []
  }
  return { React, runtime, reset, rerender, flush, dispose }
}

/** Text content of a tree, calling function components the way a renderer would. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}

/** Collect every element object in the tree, calling function components. */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    elementsOf(node.type(node.props), out)
    return out
  }
  out.push(node)
  elementsOf(node.props?.children, out)
  return out
}

const uiStub = {
  SettingsFormModel: class {
    constructor(scope, specs, extras) {
      this.scope = scope
      this.specs = specs
      this.extras = extras
      this.projection = () => ({ writable: true, dirty: false })
      // The specs are the contract with the settings model, so the tests reach
      // them through the instance the module built.
      uiStub.SettingsFormModel.instances.push(this)
    }
    bind(projection) {
      this.projection = projection
      return { set() {}, getSnapshot: () => projection() }
    }
    field() {
      return { text: '', overridden: false, resetable: false }
    }
    shell() {
      return { writable: true, dirty: false }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  },
  SettingsForm: (props) => ({ type: 'form', props }),  SettingsValueField: (props) => ({ type: 'valueField', props }),
  SettingsSecretField: (props) => ({ type: 'secretField', props }),
  settingsTextField: (field) => ({ field, kind: 'text' }),
  settingsNumberField: (field) => ({ field, kind: 'number' }),
}
uiStub.SettingsFormModel.instances = []

const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
let factory = null

/**
 * Just enough DOM for the popover: it portals into `<body>` and listens on
 * `document` for outside clicks and Escape, so the harness has to be able to
 * register those listeners and fire them back.
 */
function makeDom() {
  const listeners = new Map()
  const key = (type, capture) => `${type}:${capture === true ? 'capture' : 'pass'}`
  const add = (type, fn, capture) => {
    const slot = key(type, capture)
    if (!listeners.has(slot)) listeners.set(slot, new Set())
    listeners.get(slot).add(fn)
  }
  const remove = (type, fn, capture) => {
    listeners.get(key(type, capture))?.delete(fn)
  }
  class DomNode {
    contains() {
      return false
    }
  }
  const dom = {
    Node: DomNode,
    body: new DomNode(),
    head: { appendChild() {} },
    innerHeight: 900,
    addEventListener: add,
    removeEventListener: remove,
    // The stylesheet injector bails out when the tag is already present; CSS
    // text is asserted by validate.mjs, not by a DOM here.
    querySelector: () => ({}),
    createElement: () => ({ setAttribute() {}, appendChild() {} }),
  }
  dom.fire = (type, event, capture) => {
    for (const fn of [...(listeners.get(key(type, capture)) ?? [])]) fn(event)
  }
  dom.listenerCount = (type, capture) => listeners.get(key(type, capture))?.size ?? 0
  return dom
}

const dom = makeDom()
/** Timer bookkeeping for the "only polls while open" assertion. */
const timers = { intervals: 0, timeouts: 0 }
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => {
        factory = definition.factory
      },
    },
    innerHeight: dom.innerHeight,
    addEventListener: dom.addEventListener,
    removeEventListener: dom.removeEventListener,
  },
  document: dom,
  Node: dom.Node,
  console,
  // The seat arms a refresh timer only while it is open, so the harness counts
  // them: "closed" has to mean "no timer at all", not "a timer that no-ops".
  setInterval: () => {
    timers.intervals += 1
    return 0
  },
  clearInterval: () => {},
  setTimeout: (fn) => {
    timers.timeouts += 1
    return { unref() {} }
  },
  clearTimeout: () => {},
}
vm.runInNewContext(source, sandbox)

const react = makeReact()
// The factory reads `require` once, so the stub must exist before it runs.
const materialized = factory((specifier) => {
  if (specifier === 'react') return react.React
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return uiStub
  throw new Error(`unexpected require: ${specifier}`)
})

check('the module registers under the package name and exports its contract', () => {
  assert.equal(typeof materialized.apply, 'function')
  assert.equal(materialized.PANEL_ID, 'quota-board')
  assert.equal(materialized.NAMESPACE, materialized.CONTRIBUTION.descriptors[0].namespace)
  assert.equal(materialized.METHOD, materialized.CONTRIBUTION.descriptors[0].method)
})

const reportFixture = (() => {
  const tokens = { input: 1000, output: 2000, cacheRead: 120000, cacheWrite: 0, total: 123000 }
  const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString()
  return {
    ok: true,
    generatedAt: Date.now(),
    cached: false,
    lowThreshold: 5,
    refreshSeconds: 60,
    usageDays: 14,
    providers: [
      {
        id: 'volcengine',
        displayName: '火山引擎',
        baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        api: 'openai-responses',
        adapter: 'volcengine',
        keyRef: 'VOLCENGINE_API_KEY',
        keySource: 'credential',
        models: ['deepseek-v4-1-flash-260910'],
        modelCount: 1,
        source: 'profile',
        isDefault: true,
        configured: true,
        kind: 'quota',
        balance: null,
        usage: null,
        plans: [
          {
            id: 'volc-coding-session',
            name: '5 小时额度',
            product: '方舟 Coding Plan',
            total: 100,
            used: 42,
            remaining: 58,
            unit: '%',
            percent: 42,
            status: 'Running',
            expiresAt: resetAt,
            resetAt,
            periodUsage: null,
          },
        ],
        note: null,
        error: null,
        low: false,
        local: { sessions: 3, tokens },
      },
      {
        id: 'my-gw',
        displayName: '我的网关',
        baseURL: 'https://gw.example.com/v1',
        api: 'openai',
        adapter: 'openai',
        keyRef: 'MY_GW_KEY',
        keySource: 'none',
        models: [],
        modelCount: 0,
        source: 'config',
        isDefault: false,
        configured: true,
        kind: 'error',
        balance: null,
        usage: null,
        plans: [],
        note: null,
        error: 'API Key 无效（鉴权失败），请检查 Key',
        low: false,
        local: null,
      },
      {
        id: 'deepseek-official',
        displayName: 'DeepSeek',
        baseURL: 'https://api.deepseek.com',
        api: 'deepseek',
        adapter: 'deepseek',
        keyRef: 'DEEPSEEK_API_KEY',
        keySource: 'credential',
        models: [],
        modelCount: 0,
        source: 'profile',
        isDefault: false,
        configured: true,
        kind: 'balance',
        balance: { isAvailable: true, currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' },
        usage: null,
        plans: [],
        note: null,
        error: null,
        low: false,
        local: null,
      },
    ],
    usage: {
      available: true,
      generatedAt: Date.now(),
      days: 14,
      totals: { ...tokens, requests: 12, turns: 4, steps: 20 },
      today: 123000,
      byModel: [{ model: 'deepseek-v4-1-flash-260910', provider: 'volcengine', sessions: 3, tokens }],
      byProvider: [{ provider: 'volcengine', sessions: 3, tokens }],
      byDay: Array.from({ length: 14 }, (_, index) => ({
        date: new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10),
        total: index === 13 ? 123000 : 0,
        output: 2000,
        sessions: index === 13 ? 3 : 0,
      })),
      sessions: [
        {
          id: 's1',
          title: '测试会话',
          createdAt: Date.now(),
          tokens,
          turns: 2,
          steps: 8,
          model: 'deepseek-v4-1-flash-260910',
          provider: 'volcengine',
          contextPressure: null,
        },
      ],
      counts: { sessions: 3, activeDays: 1 },
    },
    counts: { providers: 3, configured: 3, low: 0 },
    credentials: {
      volcAccess: { ref: 'VOLC_ACCESS_KEY', configured: false },
      volcSecret: { ref: 'VOLC_SECRET_KEY', configured: false },
    },
  }
})()

const registrations = []
/**
 * Forwarded Host events, as the real Gateway serves them: `$on` hands back a
 * disposer per listener, and a disposed listener must never fire again.
 */
const forwarded = []
const fakeCtx = {
  remote: {
    $mount: () => Promise.resolve(() => {}),
    $on: (event, listener) => {
      const entry = { event, listener, live: true }
      forwarded.push(entry)
      return () => {
        entry.live = false
      }
    },
  },
  get: () => undefined,
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    bind: () => (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    register: () => () => {},
  },
  slots: {
    inject: (slot, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  configForms: {
    get: () => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ value: {} }),
    }),
    whileServed: (_rows, callback) => callback(),
  },
}

materialized.apply(fakeCtx)

// Render with the shipping Chinese strings, so the assertions check what a user
// actually reads rather than which dictionary key was picked.
const zh = materialized.dictionaries.zh
const t = (key) => (zh[key] === undefined ? key : zh[key])

const seatComponent = registrations.find((entry) => entry.options.name === 'sidebar.footer.action').component
const seatOptions = registrations.find((entry) => entry.options.name === 'sidebar.footer.action').options

/** Deliver one forwarded Host event the way the Gateway's pump would. */
const fireRemote = (event, ...args) => {
  for (const entry of forwarded) {
    if (entry.live === true && entry.event === event) entry.listener(...args)
  }
}
/** One finished turn: the Host reports running, then not running. */
const finishTurn = (sessionId) => {
  fireRemote('api-session/status', sessionId, true)
  fireRemote('api-session/status', sessionId, false)
}
/** Let the seat's load promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Render the popover exactly as it looks one click after mount.
 *
 * The open flag and the report are seeded rather than clicked through here: the
 * stub renderer is synchronous, so a promise started by the click could never
 * settle before the assertion. The click path itself is covered separately.
 */
function renderPopover(options = {}) {
  const { report = null, failure = null, busy = false } = options
  react.reset([true, report, failure, busy, null])
  const tree = seatComponent({
    t,
    load: () => Promise.resolve({ ok: true, data: report }),
    openConfig: () => {},
    wide: true,
  })
  react.flush()
  return tree
}

/**
 * Kept under the old name and signature — `[report, failure, busy]` seeds — so
 * the content checks read the same as before the seat rewrite. The trailing
 * `loadResult` argument is now redundant and simply ignored.
 */
const renderPage = ([report = null, failure = null, busy = false] = []) =>
  renderPopover({ report, failure, busy: busy === true })

check('the board mounts as one sidebar-footer seat, not a page or a tab', () => {
  const seat = registrations.find((entry) => entry.options.name === 'sidebar.footer.action')
  assert.ok(seat, 'sidebar footer seat missing')
  assert.equal(seat.options.id, 'quota-board')
  assert.equal(seat.options.locale, 'settings.quotaBoard')
  assert.equal(seat.options.order, materialized.PANEL_ORDER)
  assert.equal(typeof seat.options.inject().load, 'function')
  // The old entry points are gone: a leftover `main` panel would show up as a
  // second, permanent copy of the board next to the popover.
  assert.equal(registrations.some((entry) => entry.options.name === 'main'), false, 'stale main panel')
  assert.equal(
    registrations.some((entry) => entry.options.name === 'sidebar.panellist'),
    false,
    'stale sidebar list entry',
  )
})
check('all three settings-form slots are registered', () => {  for (const slot of ['plugins.bundle.config', 'plugins.item', 'plugins.row.config']) {
    assert.ok(registrations.some((entry) => entry.options.name === slot), `${slot} missing`)
  }
  const row = registrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.equal(row.options.key, 'dsh-quota-board#quota-board')
})

check('clicking the seat opens the popover, clicking again closes it', () => {
  const props = { t, load: () => Promise.resolve({ ok: true, data: reportFixture }), openConfig: () => {}, wide: true }
  // One render pass per call: a real renderer rewinds the hook index and hands
  // back the state the previous event wrote.
  const render = () => {
    react.rerender()
    return seatComponent(props)
  }
  const button = (tree) => elementsOf(tree).find((element) => element.type === 'button')
  const isOpen = () => elementsOf(render()).some((element) => element.props?.className === 'dqb_pop')

  react.reset([])
  assert.equal(isOpen(), false, 'it starts closed')
  const armed = timers.intervals
  react.flush()
  assert.equal(timers.intervals, armed, 'a closed seat must not arm a refresh timer')

  button(render()).props.onClick()
  const pop = elementsOf(render()).find((element) => element.props?.className === 'dqb_pop')
  assert.ok(pop, 'the click must mount the popover')
  assert.equal(pop.props.role, 'dialog')
  assert.equal(pop.props['aria-label'], t('title'))
  // Placement is manual because the sidebar sits under a transformed ancestor
  // that would clip a fixed panel; until the anchor is measured it stays hidden
  // rather than flashing at the wrong corner.
  assert.equal(pop.props.style.visibility, 'hidden', 'unmeasured anchor must stay hidden')

  button(render()).props.onClick()
  assert.equal(isOpen(), false, 'a second click must close it')
  assert.doesNotMatch(textOf(render()), /火山引擎/)
  react.dispose()
})

check('Escape and an outside click both dismiss the popover', () => {
  const props = { t, load: () => Promise.resolve({ ok: true, data: reportFixture }), openConfig: () => {}, wide: true }
  const mount = () => {
    react.reset([true, reportFixture, null, false, null])
    const tree = seatComponent(props)
    react.flush()
    assert.ok(elementsOf(tree).some((element) => element.props?.className === 'dqb_pop'), 'precondition: it is open')
  }
  const isOpen = () => {
    react.rerender()
    return elementsOf(seatComponent(props)).some((element) => element.props?.className === 'dqb_pop')
  }

  mount()
  dom.fire('keydown', { key: 'Escape' })
  assert.equal(isOpen(), false, 'Escape must close the popover')

  mount()
  dom.fire('keydown', { key: 'a' })
  assert.equal(isOpen(), true, 'other keys must not close it')

  mount()
  dom.fire('mousedown', { target: new dom.Node() }, true)
  assert.equal(isOpen(), false, 'an outside click must close the popover')

  react.dispose()
})

check('the seat names the default provider and prints its remaining quota', () => {
  const props = { t, load: () => Promise.resolve({ ok: true, data: reportFixture }), openConfig: () => {}, wide: true }
  // Closed, with the report already in hand — the state one click-through of the
  // button leaves behind.
  react.reset([false, reportFixture])
  const text = textOf(seatComponent(props))
  assert.match(text, /火山引擎/, 'the button must name the provider, not say "额度看板"')
  assert.match(text, /58%/, 'the button must carry the remaining quota')
  assert.equal(text.includes('额度看板'), false, 'the generic label must be gone once there is a report')
  react.dispose()
})

check('a configured provider wins, a stale id falls back, no data keeps the title', () => {
  const report = (extra) => ({ ...reportFixture, ...extra })
  // Hook order in the seat: open, report, failure, busy, anchor.
  const mount = (value) => {
    react.reset([false, value, null, false, null])
    return textOf(seatComponent({ t, load: () => Promise.resolve({ ok: true, data: value }), openConfig: () => {}, wide: true }))
  }

  const chosen = mount(report({ defaultProvider: 'deepseek-official' }))
  assert.match(chosen, /DeepSeek/)
  assert.match(chosen, /12\.34 CNY/, 'the balance headline is what the seat prints for a wallet')

  // Renaming a provider leaves an id behind: fall back rather than go blank.
  assert.match(mount(report({ defaultProvider: 'gone' })), /火山引擎/)

  assert.match(mount(null), /额度看板/, 'with nothing loaded the button falls back to the plugin name')
  react.dispose()
})

/**
 * A closed seat has to keep up on its own. The trigger is the Host's forwarded
 * `api-session/status` event — the same edge the session list paints as a busy
 * dot — so these tests drive that stream instead of waiting for a timer.
 */
async function mountSeatForTurnEnd(load) {
  const props = { t, load, onTurnEnd: seatOptions.inject().onTurnEnd, openConfig: () => {}, wide: true }
  react.reset([])
  seatComponent(props)
  react.flush()
  await settle()
}

await checkAsync('a finished turn re-reads the board while the panel stays closed', async () => {
  const calls = []
  await mountSeatForTurnEnd((force) => {
    calls.push(force === true)
    return Promise.resolve({ ok: true, data: reportFixture })
  })
  assert.deepEqual(calls, [false], 'the mount read is not forced: the Host cache is fine there')

  finishTurn('session-1')
  await settle()
  assert.deepEqual(calls, [false, true], 'a finished turn must bypass the 20s cache, or it reads the pre-turn number')

  // Unmounting must release the feed, or every removed seat keeps fetching.
  react.dispose()
  finishTurn('session-1')
  await settle()
  assert.equal(calls.length, 2, 'a disposed seat must stop listening')
})

await checkAsync('a status baseline is not a finished turn', async () => {
  const calls = []
  await mountSeatForTurnEnd((force) => {
    calls.push(force === true)
    return Promise.resolve({ ok: true, data: reportFixture })
  })

  // `false` for a session this page never saw running: a list baseline, not a
  // turn. Refreshing on those would re-query every provider on each page load.
  fireRemote('api-session/status', 'idle-session', false)
  await settle()
  assert.deepEqual(calls, [false])
  react.dispose()
})

await checkAsync('turns finishing during one fetch collapse into a single follow-up', async () => {
  const calls = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  await mountSeatForTurnEnd((force) => {
    calls.push(force === true)
    // The first read stays open so both turns land mid-flight.
    if (calls.length === 1) return gate.then(() => ({ ok: true, data: reportFixture }))
    return Promise.resolve({ ok: true, data: reportFixture })
  })

  finishTurn('a')
  finishTurn('b')
  release()
  await settle()
  await settle()
  assert.deepEqual(calls, [false, true], 'two notifications, one follow-up read')
  react.dispose()
})

await checkAsync('the finished turn lands in the button, not just in the panel', async () => {
  // The headline prints what is left, derived from `used`: 88 consumed is 12%.
  const after = { ...reportFixture, providers: reportFixture.providers.map((provider) => ({
    ...provider,
    plans: provider.plans.map((plan) => ({ ...plan, used: 88, remaining: 12 })),
  })) }
  const props = {
    t,
    load: () => Promise.resolve({ ok: true, data: after }),
    onTurnEnd: seatOptions.inject().onTurnEnd,
    openConfig: () => {},
    wide: true,
  }
  react.reset([false, null, null, false, null])
  seatComponent(props)
  react.flush()
  await settle()

  finishTurn('session-2')
  await settle()
  react.rerender()
  assert.match(textOf(seatComponent(props)), /12%/, 'the closed button must print the post-turn quota')
  react.dispose()
})


check('a healthy quota bar is DeepSeek blue, not the theme green', () => {
  const fills = elementsOf(renderPage([reportFixture, null, false])).filter(
    (element) => element.props?.className === 'dqb_barFill',
  )
  assert.ok(fills.length > 0, 'no bars rendered')
  assert.equal(fills[0].props.style.background, '#4d6bfe', 'the available share must be whale blue')
})

check('the loading state renders', () => {
  const text = textOf(renderPage([null, null, false]))
  assert.match(text, /正在读取额度/)
})

check('a populated report renders every provider card and the usage section', () => {
  const text = textOf(renderPage([reportFixture, null, false], { ok: true, data: reportFixture }))
  for (const expected of [
    '火山引擎',
    '我的网关',
    'DeepSeek',
    '5 小时额度',
    '剩余 58%',
    // The headline prints what is left, matching the row beneath it.
    '58',
    '12.34',
    'CNY',
    '查询失败',
    '当前默认',
    '本机用量',
    '123K',
    '测试会话',
  ]) {
    assert.ok(text.includes(expected), `missing ${expected} in rendered page`)
  }
})

check('a service failure names the cause instead of rendering an empty board', () => {
  const text = textOf(
    renderPage([null, { ok: false, absence: { cause: 'refused', message: 'mount refused' } }, false], { ok: true, data: null }),
  )
  assert.match(text, /读不到额度数据/)
  assert.match(text, /挂载被 Gateway 拒绝/)
  assert.match(text, /mount refused/)
  assert.match(text, /重试/)
})

check('an empty provider list explains how to add one', () => {
  const empty = { ...reportFixture, providers: [], counts: { providers: 0, configured: 0, low: 0 }, usage: { ...reportFixture.usage, available: false, totals: { total: 0 } } }
  const text = textOf(renderPage([empty, null, false], { ok: true, data: empty }))
  assert.match(text, /还没有发现任何模型供应商/)
  assert.match(text, /providers 字段手工添加/)
})

check('low balances, unsupported platforms and per-card errors are all flagged', () => {
  const [volc, gateway, deepseek] = reportFixture.providers
  const report = {
    ...reportFixture,
    providers: [
      { ...volc, low: true },
      { ...deepseek, low: true },
      { ...gateway, kind: 'unsupported', error: null, note: '该平台未提供可通过 API Key 查询的余额/账单接口' },
    ],
  }
  const text = textOf(renderPage([report, null, false], { ok: true, data: report }))
  assert.match(text, /额度偏低/)
  assert.match(text, /不支持查询/)
  assert.match(text, /没有可通过 API Key 查询/)
  // Per-card failures never blank the page: the other two cards still render.
  assert.match(text, /火山引擎/)
  assert.match(text, /DeepSeek/)
})

check('a provider with no credential says so instead of showing a zero balance', () => {
  const [, gateway] = reportFixture.providers
  const report = { ...reportFixture, providers: [{ ...gateway, configured: false, kind: 'unknown', error: null }] }
  const text = textOf(renderPage([report, null, false], { ok: true, data: report }))
  assert.match(text, /未配置/)
  assert.doesNotMatch(text, /CNY/)
})

check('an account-funded card credits the account instead of a missing key', () => {
  const deepseek = reportFixture.providers.find((provider) => provider.adapter === 'deepseek')
  const report = {
    ...reportFixture,
    providers: [
      {
        ...deepseek,
        configured: true,
        kind: 'balance',
        balanceSource: 'account',
        keySource: 'account',
        keyRef: '',
        balance: { isAvailable: true, currency: 'CNY', total: '38.41', granted: '38.48', toppedUp: '-0.07' },
        plans: [],
        usage: null,
        error: null,
        note: null,
      },
    ],
  }
  const text = textOf(renderPage([report, null, false], { ok: true, data: report }))
  assert.match(text, /余额来源/)
  assert.match(text, /账号与余额/)
  assert.doesNotMatch(text, /密钥来源/, '余额来自账号时不能再说密钥没找到')
  assert.match(text, /38\.41/)
  assert.match(text, /38\.48/)
})

check('a card that was never configured is neutral, a broken one is not', () => {
  const gateway = reportFixture.providers.find((provider) => provider.adapter === 'generic')
  const paint = (provider) => {
    const report = { ...reportFixture, providers: [provider] }
    return elementsOf(renderPage([report, null, false], { ok: true, data: report }))
      .map((element) => element.props?.className ?? '')
      .join(' ')
  }
  const neutral = paint({
    ...gateway,
    configured: false,
    kind: 'quota',
    balance: null,
    usage: null,
    plans: [],
    error: '未配置 API Key',
  })
  assert.match(neutral, /dqb_state\b/)
  assert.doesNotMatch(neutral, /dqb_stateErr/)

  const broken = paint({
    ...gateway,
    configured: true,
    kind: 'error',
    balance: null,
    usage: null,
    plans: [],
    error: '接口返回状态码 500',
  })
  assert.match(broken, /dqb_stateErr/)
})

const configComponent = registrations.find((entry) => entry.options.name === 'plugins.bundle.config').component
check('the settings form renders every field with its own id', () => {
  react.reset([])
  const state = {
    writable: true,
    providers: { text: '[]', overridden: false, resetable: false },
    deepseekBaseURL: { text: '', overridden: false, resetable: false },
    skipHosts: { text: '', overridden: false, resetable: false },
    lowThreshold: { text: '5', overridden: false, resetable: false },
    refreshSeconds: { text: '60', overridden: false, resetable: false },
    usageDays: { text: '14', overridden: false, resetable: false },
    timeoutMs: { text: '10000', overridden: false, resetable: false },
  }
  const props = {
    t,
    useQuotaBoardConfig: (selector) => selector(state),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    peers: () => Promise.resolve([]),
    writeCredential: () => Promise.resolve(true),
    view: 'form',
  }
  const tree = configComponent(props)
  const elements = elementsOf(tree)
  const ids = elements.filter((element) => element.type === 'valueField' || element.type === 'secretField').map((element) => element.props.id)
  for (const field of ['deepseekBaseURL', 'skipHosts', 'lowThreshold', 'refreshSeconds', 'usageDays', 'timeoutMs']) {
    assert.ok(ids.includes(`plugin-config-quota-board-${field}`), `missing field ${field}`)
  }
  // Volcengine credentials live inside a provider entry now, not at the top.
  assert.equal(elements.filter((element) => element.type === 'secretField').length, 0)
})

check('the providers list renders as a list, not a JSON box', () => {
  const state = {
    writable: true,
    providers: {
      text: JSON.stringify([
        { id: 'my-gw', displayName: '我的网关', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY' },
        { id: 'second' },
      ]),
      overridden: true,
      resetable: false,
    },
  }
  const props = {
    t,
    useQuotaBoardConfig: (selector) => selector(state),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    view: 'form',
  }
  const tree = configComponent(props)
  const elements = elementsOf(tree)
  const inputs = elements.filter((element) => element.type === 'input')
  // One card per entry, each with its own ids, plus an add button.
  assert.ok(inputs.some((el) => el.props.id === 'plugin-config-quota-board-providers-0-id'), 'row 0 id input missing')
  assert.ok(inputs.some((el) => el.props.id === 'plugin-config-quota-board-providers-0-baseURL'), 'row 0 baseURL input missing')
  assert.ok(inputs.some((el) => el.props.id === 'plugin-config-quota-board-providers-1-id'), 'row 1 id input missing')
  assert.equal(inputs.filter((el) => el.props.id === 'plugin-config-quota-board-providers-0-id')[0].props.value, 'my-gw')
  assert.ok(elements.some((el) => el.type === 'select'), 'adapter dropdown missing')
  assert.ok(elements.filter((el) => el.type === 'button').length >= 3, 'remove buttons and add button missing')
  const text = textOf(tree)
  assert.match(text, /我的网关/)
  assert.match(text, /添加供应商/)
  assert.match(text, /删除/)
})

check('an empty providers list invites the first entry instead of showing a box', () => {
  const state = { writable: true, providers: { text: '[]', overridden: false, resetable: false } }
  const props = {
    t,
    useQuotaBoardConfig: (selector) => selector(state),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    view: 'form',
  }
  const text = textOf(configComponent(props))
  assert.match(text, /还没有额外供应商/)
  assert.match(text, /添加供应商/)
  assert.equal(text.includes('JSON'), false, 'the JSON wording must be gone')
})

/** One host answer, as the board would return it: DeepSeek excluded by the card. */
const peerFixture = [
  {
    id: 'ark',
    displayName: '火山方舟',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    adapter: 'volcengine',
    keyRef: 'ARK_API_KEY',
    accessKeyRef: 'VOLC_ACCESS_KEY',
    secretKeyRef: 'VOLC_SECRET_KEY',
    configured: true,
    binding: { endpoint: 'billing', kind: 'billing' },
  },
  {
    id: 'relay',
    displayName: '中转站',
    baseURL: 'https://relay.example.com/v1',
    adapter: 'generic',
    keyRef: 'RELAY_KEY',
    configured: true,
    binding: { endpoint: '/api/me/quota', kind: 'json' },
  },
  {
    id: 'silicon',
    displayName: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    adapter: 'generic',
    keyRef: 'SILICON_KEY',
    configured: false,
    binding: null,
  },
]

/** Card props over one state, with peers already resolved. */
function cardProps(state, peers, overrides = {}) {
  return {
    t,
    useQuotaBoardConfig: (selector) => selector(state),
    peers: () => Promise.resolve(peers ?? []),
    writeCredential: () => Promise.resolve(true),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    view: 'form',
    ...overrides,
  }
}

check('the default-provider dropdown offers every provider the board can see', () => {
  // The unfiltered list is what feeds the dropdown, so DeepSeek has to be in it
  // even though the "extra providers" list above deliberately hides it.
  const all = [
    ...peerFixture,
    { id: 'deepseek-official', displayName: 'DeepSeek', adapter: 'deepseek', configured: true },
  ]
  const edits = []
  const state = {
    writable: true,
    providers: { text: '[]', overridden: false },
    defaultProvider: { text: 'ark', overridden: true },
  }
  react.reset([all])
  const props = cardProps(state, peerFixture, {
    providers: () => Promise.resolve(all),
    edit: (field, text) => edits.push([field, text]),
  })
  const tree = configComponent(props)
  const select = elementsOf(tree).find(
    (element) => element.type === 'select' && element.props.id === 'plugin-config-quota-board-defaultProvider-input',
  )
  assert.ok(select, 'the default-provider dropdown is missing')
  assert.equal(select.props.value, 'ark', 'the saved id must be selected')
  const options = elementsOf(select).filter((element) => element.type === 'option')
  assert.equal(options[0].props.value, '', 'the first option is "auto"')
  const values = options.map((option) => option.props.value)
  for (const id of ['ark', 'relay', 'deepseek-official']) {
    assert.ok(values.includes(id), `${id} must be selectable`)
  }
  // A hand-added gateway with no discovery entry is still choosable by id.
  const words = textOf(tree)
  assert.match(words, /火山方舟/)
  select.props.onChange({ target: { value: 'deepseek-official' } })
  assert.deepEqual(edits, [['defaultProvider', 'deepseek-official']])
})

check('providers found in the model configuration are listed above the editable list', () => {
  react.reset([peerFixture])
  const text = textOf(configComponent(cardProps({ writable: true, providers: { text: '[]', overridden: false } }, peerFixture)))
  assert.match(text, /来自模型配置（3）/)
  assert.match(text, /火山方舟/)
  assert.match(text, /billing/, 'volcengine should show its billing binding')
  assert.match(text, /\/api\/me\/quota/, 'generic should show the bound endpoint')
  assert.match(text, /未绑定接口/, 'an unbound generic provider must say so')
  assert.match(text, /未配置密钥/, 'a provider without a credential must say so')
  // With peers present, the empty state must not claim there are no providers.
  assert.match(text, /还没有手动添加的条目/)
  assert.equal(text.includes('还没有额外供应商'), false)
})

check('overriding a discovered provider copies its references into an entry', () => {
  react.reset([peerFixture])
  const edits = []
  const props = cardProps({ writable: true, providers: { text: '[]', overridden: false } }, peerFixture, {
    edit: (field, text) => edits.push([field, text]),
  })
  const tree = configComponent(props)
  const override = elementsOf(tree).find((element) => element.type === 'button' && textOf(element) === '覆盖')
  assert.ok(override !== undefined, 'the override button is missing')
  assert.equal(override.props.disabled, false)
  override.props.onClick()
  assert.equal(edits.length, 1)
  assert.equal(edits[0][0], 'providers')
  const rows = JSON.parse(edits[0][1])
  assert.equal(rows.length, 1)
  // The pair travels with the entry, so the copied row is queryable as-is.
  assert.deepEqual(Object.keys(rows[0]).sort(), ['accessKeyEnv', 'api', 'apiKeyEnv', 'baseURL', 'displayName', 'id', 'secretKeyEnv', 'adapter'].sort())
  assert.equal(rows[0].id, 'ark')
  assert.equal(rows[0].accessKeyEnv, 'VOLC_ACCESS_KEY')
  assert.equal(rows[0].secretKeyEnv, 'VOLC_SECRET_KEY')
  assert.equal(rows[0].apiKeyEnv, 'ARK_API_KEY')
})

check('a volcengine entry carries its own AK/SK block, and other entries do not', () => {
  react.reset()
  const state = {
    writable: true,
    providers: {
      text: JSON.stringify([
        { id: 'ark', adapter: 'volcengine', baseURL: 'https://ark.example.com/api/v3', accessKeyEnv: 'VOLC_AK', secretKeyEnv: 'VOLC_SK' },
        { id: 'gw', adapter: 'generic', baseURL: 'https://gw.example.com/v1' },
      ]),
      overridden: true,
    },
  }
  const elements = elementsOf(configComponent(cardProps(state, [])))
  const inputs = elements.filter((element) => element.type === 'input')
  assert.equal(inputs.find((el) => el.props.id === 'plugin-config-quota-board-providers-0-accessKeyEnv').props.value, 'VOLC_AK')
  assert.equal(inputs.find((el) => el.props.id === 'plugin-config-quota-board-providers-0-secretKeyEnv').props.value, 'VOLC_SK')
  const secrets = inputs.filter((element) => element.props.type === 'password')
  assert.equal(secrets.length, 2, 'the AK pair needs two secret inputs')
  for (const secret of secrets) {
    assert.equal(secret.props.value, '', 'secrets must never be echoed back')
    assert.equal(secret.props.disabled, false)
  }
  // Row 1 is generic: no password box, no AK/SK labels.
  assert.equal(inputs.filter((el) => String(el.props.id).startsWith('plugin-config-quota-board-providers-1-') && el.props.type === 'password').length, 0)
})

check('the providers spec round-trips AK/SK reference names', () => {
  const model = uiStub.SettingsFormModel.instances.at(-1)
  assert.ok(model !== undefined, 'the module did not build a settings model')
  const spec = model.specs.find((entry) => entry.field === 'providers')
  assert.ok(spec !== undefined, 'the providers spec is missing')
  const rows = [
    { id: 'ark', baseURL: 'https://ark.example.com/api/v3', adapter: 'volcengine', accessKeyEnv: 'VOLC_AK', secretKeyEnv: 'VOLC_SK' },
  ]
  const text = spec.format(rows)
  assert.match(text, /"accessKeyEnv":"VOLC_AK"/)
  assert.match(text, /"secretKeyEnv":"VOLC_SK"/)
  // The spec runs inside the VM realm, so its objects have a different
  // prototype; field-by-field comparison avoids both that and key order.
  const parsed = spec.parse(text)
  assert.equal(parsed.kind, 'set')
  assert.equal(parsed.value.length, rows.length)
  for (const key of Object.keys(rows[0])) assert.equal(parsed.value[0][key], rows[0][key], `lost ${key}`)
  // Blank names are dropped rather than written as empty strings.
  assert.equal(spec.format([{ id: 'x', baseURL: 'y', accessKeyEnv: '  ' }]).includes('accessKeyEnv'), false)
  // Anything that is not a list is rejected, not written.
  assert.equal(spec.parse('{}'), undefined)
  assert.equal(spec.parse('nope'), undefined)
})

/** The stub's hook cursor has to be rewound before every pass over a tree. */
function rerender(state, peers, props) {
  react.runtime.index = 0
  return configComponent(props ?? cardProps(state, peers))
}

await checkAsync('the test button probes the values on screen, then reports what answered', async () => {
  react.reset([])
  const calls = []
  const patches = []
  const state = {
    writable: true,
    providers: {
      text: JSON.stringify([
        { id: 'gw', displayName: '我的网关', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY' },
      ]),
      overridden: true,
    },
  }
  const props = cardProps(state, [], {
    edit: (field, text) => patches.push([field, text]),
    testProvider: (entry) => {
      calls.push(entry)
      return Promise.resolve({
        ok: true,
        data: {
          status: { kind: 'usage', balance: null, usage: { remaining: 12.5, unit: 'USD' }, plans: [], error: null },
          endpoint: '/v1/usage',
          endpointKind: 'json',
        },
      })
    },
  })

  let tree = rerender(state, [], props)
  const button = elementsOf(tree).find((element) => element.type === 'button' && textOf(element) === '测试连接')
  assert.ok(button !== undefined, '每个条目都要有「测试连接」按钮')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // One probe, built from the row itself — no save, no discovery.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'gw')
  assert.equal(calls[0].baseURL, 'https://gw.example.com/v1')
  assert.equal(calls[0].apiKeyEnv, 'GW_KEY')
  assert.equal('authHeader' in calls[0], false, '空字段不该发给宿主')

  // Re-render with the state the click left behind.
  tree = rerender(state, [], props)
  const text = textOf(tree)
  assert.match(text, /连通 · 12\.5 USD/)
  assert.match(text, /接口 \/v1\/usage/)

  const pin = elementsOf(rerender(state, [], props)).find(
    (element) => element.type === 'button' && textOf(element) === '钉死这个接口',
  )
  assert.ok(pin !== undefined, '探到的接口应当可以钉死')
  pin.props.onClick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0][0], 'providers')
  // Pinning writes a hint, nothing else — the endpoint becomes explicit config.
  assert.equal(JSON.parse(patches[0][1])[0].fields.endpoint, '/v1/usage')
})

await checkAsync('a failed probe says why, and read-only forms cannot test', async () => {
  react.reset([])
  const state = {
    writable: true,
    providers: {
      text: JSON.stringify([{ id: 'gw', baseURL: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY' }]),
      overridden: true,
    },
  }
  const props = cardProps(state, [], {
    testProvider: () => Promise.resolve({ ok: true, data: { status: { error: 'API Key 无效或无权访问（鉴权失败），请检查 Key' } } }),
  })
  let tree = rerender(state, [], props)
  elementsOf(tree)
    .find((element) => element.type === 'button' && textOf(element) === '测试连接')
    .props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = textOf(rerender(state, [], props))
  assert.match(text, /不连通/)
  assert.match(text, /API Key 无效/)

  // A read-only deployment must not fire requests from the form.
  react.reset([])
  const readOnly = { ...state, writable: false }
  const readOnlyProps = cardProps(readOnly, [], { testProvider: props.testProvider })
  const button = elementsOf(rerender(readOnly, [], readOnlyProps)).find(
    (element) => element.type === 'button' && textOf(element) === '测试连接',
  )
  assert.equal(button.props.disabled, true)
})

await checkAsync('a Host refusal is surfaced instead of a silent nothing', async () => {
  react.reset([])
  const state = {
    writable: true,
    providers: { text: JSON.stringify([{ id: 'gw', baseURL: 'https://gw.example.com/v1' }]), overridden: true },
  }
  const props = cardProps(state, [], {
    testProvider: () => Promise.resolve({ ok: false, reason: '宿主没有提供额度服务' }),
  })
  const tree = rerender(state, [], props)
  elementsOf(tree)
    .find((element) => element.type === 'button' && textOf(element) === '测试连接')
    .props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(textOf(rerender(state, [], props)), /宿主没有提供额度服务/)
})

react.dispose()
server.close()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
