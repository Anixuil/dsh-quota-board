/**
 * dsh-quota-board — render the settings form to a static HTML page.
 *
 * The point is to look at the real component output without launching Harness:
 * `client.js` is materialized in a VM, the registered `plugins.bundle.config`
 * component is rendered with a fixed state, and the element tree is serialized
 * to HTML. Nothing here re-implements the markup, so what you see is what the
 * slot would draw.
 *
 * Usage:
 *   node dev/preview.mjs
 *   → writes dev/preview-config.html
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const OUT = join(ROOT, 'dev', 'preview-config.html')
const BOARD_OUT = join(ROOT, 'dev', 'preview-board.html')

/** Same tiny React stand-in the smoke suite uses. */
function makeReact() {
  const runtime = { hooks: [], index: 0 }
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
      const slots = runtime.hooks
      if (!(index in slots)) slots[index] = initial
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        },
      ]
    },
    useRef(initial) {
      const index = runtime.index++
      const slots = runtime.hooks
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    // The popover measures its anchor here; the preview seeds the measurement
    // instead, because there is no layout to measure in a Node process.
    useLayoutEffect: () => {},
  }
  return {
    React,
    runtime,
    reset: () => (runtime.index = 0),
    seed: (index, value) => {
      runtime.hooks[index] = value
    },
    resetAll: () => {
      runtime.index = 0
      runtime.hooks = []
    },
  }
}

/**
 * Primitives stand-ins.
 *
 * They render the same skeletons the real package does (label, input, hint, the
 * form container) instead of marker tags, so the preview looks like the card.
 */
const field = (tag) => (props) => ({
  type: 'div',
  props: {
    className: `pv_field${props.disabled ? ' pv_disabled' : ''}`,
    children: [
      {
        type: 'div',
        props: {
          className: 'pv_fieldHead',
          children: [{ type: 'label', props: { className: 'pv_label', children: [props.label] } }],
        },
      },
      {
        type: 'input',
        props: {
          className: 'pv_input',
          id: props.id,
          value: tag === 'number' ? props.text : props.text,
          disabled: props.disabled,
        },
      },
      { type: 'p', props: { className: 'pv_hint', children: [props.hint] } },
    ],
  },
})

const uiStub = {
  SettingsFormModel: class {
    bind(projection) {
      return { set() {}, getSnapshot: () => projection() }
    }
    field() {
      return { text: '', overridden: false }
    }
    shell() {
      return { writable: true, dirty: false }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  },
  SettingsForm: (props) => ({
    type: 'div',
    props: { className: 'pv_form', children: props.children },
  }),
  SettingsValueField: field('text'),
  SettingsSecretField: (props) => ({
    type: 'div',
    props: {
      className: 'pv_field',
      children: [
        {
          type: 'div',
          props: {
            className: 'pv_fieldHead',
            children: [
              { type: 'label', props: { className: 'pv_label', children: [props.label] } },
              { type: 'span', props: { className: 'pv_badge', children: [props.stateLabel] } },
            ],
          },
        },
        { type: 'input', props: { className: 'pv_input', id: props.id, value: props.text, disabled: props.disabled } },
        { type: 'p', props: { className: 'pv_hint', children: [props.hint] } },
      ],
    },
  }),
  settingsTextField: (name) => ({ field: name, kind: 'text' }),
  settingsNumberField: (name) => ({ field: name, kind: 'number' }),
}

const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
const cssMatch = /const CSS = `([\s\S]*?)`\n/u.exec(source)
if (cssMatch === null) throw new Error('client.js 里没找到 CSS 常量')

let factory = null
// The popover portals into <body> and subscribes on `document`; the preview only
// needs the calls to land somewhere.
const noop = () => {}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => {
        factory = definition.factory
      },
    },
    innerHeight: 900,
    addEventListener: noop,
    removeEventListener: noop,
  },
  document: {
    body: {},
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => ({}),
  },
  Node: class {},
  console,
  setInterval: () => 0,
  clearInterval: () => {},
}
vm.runInNewContext(source, sandbox)

const react = makeReact()
const materialized = factory((specifier) => {
  if (specifier === 'react') return react.React
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return uiStub
  throw new Error(`unexpected require: ${specifier}`)
})

const registrations = []
materialized.apply({
  remote: { $mount: () => Promise.resolve(() => {}) },
  get: () => undefined,
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  configForms: {
    get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ value: {} }) }),
    whileServed: (_rows, callback) => callback(),
  },
})

const card = registrations.find((entry) => entry.options.name === 'plugins.bundle.config')?.component
if (card === undefined) throw new Error('没有注册 plugins.bundle.config 槽位')

const zh = materialized.dictionaries.zh
const t = (key) => (zh[key] === undefined ? key : zh[key])

// ---------------------------------------------------------------------------
// element tree -> html
// ---------------------------------------------------------------------------

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (text) => String(text).replace(/[&<>"']/gu, (char) => ESCAPES[char])

/**
 * React spells SVG attributes in camelCase (`strokeWidth`), while the HTML parser
 * lowercases every attribute name — so an inline SVG serialized verbatim loses
 * its stroke widths and dashes and draws as a hairline. Only SVG names are
 * hyphenated; `viewBox` must keep its capital B out of the conversion.
 */
const SVG_ATTRS = new Set([
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeOpacity',
  'strokeMiterlimit',
  'fillRule',
  'fillOpacity',
  'clipRule',
  'clipPath',
  'textAnchor',
  'dominantBaseline',
  'stopColor',
  'stopOpacity',
  'vectorEffect',
  'paintOrder',
])
const svgAttribute = (key) =>
  SVG_ATTRS.has(key) ? key.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`) : key

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (node.type === react.React.Fragment) return toHtml(node.props?.children)
  if (typeof node.type === 'function') return toHtml(node.type(node.props))
  if (typeof node.type !== 'string') return ''
  const type = node.type
  const attrs = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    // `key`/`ref` are React bookkeeping; the real renderer never emits them.
    if (key === 'children' || key === 'key' || key === 'ref' || key.startsWith('on')) continue
    if (value === undefined || value === null || typeof value === 'function') continue
    if (key === 'className') {
      attrs.push(`class="${escapeHtml(value)}"`)
      continue
    }
    if (key === 'htmlFor') {
      attrs.push(`for="${escapeHtml(value)}"`)
      continue
    }
    if (typeof value === 'boolean') {
      if (value) attrs.push(key)
      continue
    }
    // React accepts a style object; the serializer has to spell it out, or every
    // computed width lands in the page as "[object Object]".
    if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value)
        .filter(([, part]) => part !== undefined && part !== null)
        .map(([prop, part]) => `${prop.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)}:${part}`)
        .join(';')
      if (css.length > 0) attrs.push(`style="${escapeHtml(css)}"`)
      continue
    }
    attrs.push(`${svgAttribute(key)}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
  if (VOID.has(type)) return open
  return `${open}${toHtml(node.props?.children)}</${type}>`
}

/** The props one card render needs; `probe` answers the test-connection call. */
function cardProps(state, peers, probe) {
  return {
    t,
    useQuotaBoardConfig: (selector) => selector(state),
    peers: () => Promise.resolve(peers),
    writeCredential: () => Promise.resolve(true),
    testProvider:
      probe ??
      (() =>
        Promise.resolve({
          ok: true,
          data: {
            status: { kind: 'usage', usage: { remaining: 12.34, unit: 'USD' }, plans: [], error: null },
            endpoint: '/v1/usage',
          },
        })),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    view: 'form',
  }
}

/**
 * Render the card with one fixed state, leaving the hook slots populated so a
 * follow-up pass (after a click) shows the state that click produced.
 */
function paint(state, peers = []) {
  react.reset()
  // Hook 0 of the card is `useState([])` for the discovered providers; the
  // effect that would fetch them is inert here, so the list is seeded directly.
  react.seed(0, peers)
  return toHtml(card(cardProps(state, peers)))
}

function collectText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node.type === 'function') return collectText(node.type(node.props))
  return collectText(node.props?.children)
}

/** Walk the tree the way the renderer does, calling function components. */
function findButton(node, label, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findButton(child, label, out)
    return out
  }
  if (typeof node.type === 'function') {
    findButton(node.type(node.props), label, out)
    return out
  }
  if (node.type === 'button' && collectText(node) === label) out.push(node)
  findButton(node.props?.children, label, out)
  return out
}

/** Render once, press "test connection", then render the result. */
async function paintAfterProbe(state, peers, probe) {
  react.resetAll()
  const tree = card(cardProps(state, peers, probe))
  const button = findButton(tree, t('formProviderTest'))[0]
  if (button === undefined) return paint(state, peers)
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Second pass over the same hook slots: this is the state after the click.
  react.reset()
  return toHtml(card(cardProps(state, peers, probe)))
}

const base = {
  writable: true,
  deepseekBaseURL: { text: '', overridden: false },
  skipHosts: { text: '', overridden: false },
  lowThreshold: { text: '5', overridden: false },
  refreshSeconds: { text: '60', overridden: false },
  usageDays: { text: '14', overridden: false },
  timeoutMs: { text: '10000', overridden: false },
}

/**
 * The Host answers `quotaBoard.load` with one card per provider. Only the
 * non-DeepSeek ones reach this list — DeepSeek is built in.
 */
const peers = [
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

const filled = {
  ...base,
  providers: {
    text: JSON.stringify([
      {
        id: 'my-gw',
        displayName: '我的网关',
        baseURL: 'https://gw.example.com/v1',
        apiKeyEnv: 'MY_GW_KEY',
        adapter: 'generic',
        fields: { endpoint: '/api/me/quota', remaining: 'data.credit' },
      },
      {
        id: 'ark',
        displayName: '火山方舟（另一个账户）',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKeyEnv: 'ARK_API_KEY_2',
        accessKeyEnv: 'VOLC_ACCESS_KEY_2',
        secretKeyEnv: 'VOLC_SECRET_KEY_2',
        adapter: 'volcengine',
      },
    ]),
    overridden: true,
  },
}

const emptyHtml = paint({ ...base, providers: { text: '[]', overridden: false } }, peers)
const filledHtml = paint(filled, peers)

/**
 * The probe result, rendered the same way the click renders it. The first row
 * has no pinned endpoint, so the endpoint the Host reports can be pinned.
 */
const probeOk = () =>
  Promise.resolve({
    ok: true,
    data: {
      status: {
        kind: 'usage',
        balance: null,
        usage: { remaining: 12.34, unit: 'USD', totalUsageUsd: null },
        plans: [],
        error: null,
        configured: true,
      },
      endpoint: '/v1/usage',
      endpointKind: 'json',
      elapsedMs: 86,
    },
  })
const probeFailed = () =>
  Promise.resolve({
    ok: true,
    data: { status: { kind: 'error', error: 'API Key 无效或无权访问（鉴权失败），请检查 Key', balance: null, usage: null, plans: [] } },
  })

const okHtml = await paintAfterProbe(filled, peers, probeOk)
const failHtml = await paintAfterProbe(filled, peers, probeFailed)

// ---------------------------------------------------------------------------
// the footer seat and its popover
// ---------------------------------------------------------------------------

const seat = registrations.find((entry) => entry.options?.name === 'sidebar.footer.action')?.component
if (seat === undefined) throw new Error('没有注册 sidebar.footer.action 槽位')

/** Every element of a tree, calling function components like a renderer would. */
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

const HOUR = 3_600_000
const DAY = 86_400_000
const now = Date.now()

/** One provider card, shaped exactly like `providerStatus` returns. */
const volc = {
  id: 'ark',
  displayName: '火山引擎',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  api: 'openai',
  adapter: 'volcengine',
  keyRef: 'VOLCENGINE_API_KEY',
  accessKeyRef: 'VOLC_ACCESS_KEY',
  secretKeyRef: 'VOLC_SECRET_KEY',
  keySource: 'credential',
  models: ['deepseek-v3.1', 'kimi-k2'],
  modelCount: 2,
  source: 'profile',
  isDefault: true,
  configured: true,
  kind: 'usage',
  balance: { isAvailable: true, currency: 'CNY', total: '0.00', granted: '0.00', toppedUp: '0' },
  usage: { remaining: null, unit: 'CNY', totalUsageUsd: null },
  plans: [
    { id: 'p5h', name: '5 小时额度', unit: '%', percent: 1, used: 1, remaining: 99, resetAt: now + 3 * HOUR },
    { id: 'p7d', name: '7 天额度', unit: '%', percent: 0, used: 0, remaining: 100, resetAt: now + 5 * DAY },
    { id: 'p30d', name: '每月额度', unit: '%', percent: 0, used: 0, remaining: 100, resetAt: now + 30 * DAY },
  ],
  note: null,
  error: null,
  low: false,
  balanceSource: 'key',
  local: { sessions: 2, tokens: { total: 3_200_000 } },
}

const deepseek = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  api: 'deepseek',
  adapter: 'deepseek',
  keyRef: '',
  accessKeyRef: '',
  secretKeyRef: '',
  keySource: 'account',
  models: [],
  modelCount: 0,
  source: 'account',
  isDefault: false,
  configured: true,
  kind: 'balance',
  // What the settings page shows for the same account: -0.07 recharge + 38.48
  // bonus. The board must print the same total (38.41), not a second opinion.
  balance: { isAvailable: true, currency: 'CNY', total: '38.41', granted: '38.48', toppedUp: '-0.07', source: 'account' },
  usage: null,
  plans: [],
  note: null,
  error: null,
  low: false,
  balanceSource: 'account',
  local: { sessions: 11, tokens: { total: 20_700_000 } },
}

const unsigned = {
  ...deepseek,
  id: 'relay',
  displayName: '备用中转',
  baseURL: 'https://relay.example.com/v1',
  adapter: 'generic',
  keyRef: 'RELAY_KEY',
  keySource: 'process',
  configured: false,
  kind: 'quota',
  balance: null,
  balanceSource: null,
  local: null,
  error: '未登录 DeepSeek 账号，也没有可用的 API Key。在「设置 → 账号与余额」登录后会自动读取余额，或给这条供应商配置一个 API Key。',
}

const boardReport = {
  generatedAt: now,
  cached: false,
  refreshSeconds: 60,
  usageDays: 14,
  providers: [volc, deepseek, unsigned],
  counts: { providers: 3, configured: 2, low: 0 },
  usage: {
    available: true,
    days: 14,
    totals: { input: 1_150_000, cacheRead: 22_500_000, cacheWrite: 0, output: 255_000, total: 23_900_000, requests: 412 },
    today: 739_000,
    byModel: [
      { model: 'deepseek-v4.1-flash-260910', tokens: { total: 23_100_000 } },
      { model: 'deepseek-v4.1-flash-261017', tokens: { total: 779_000 } },
    ],
    byDay: Array.from({ length: 14 }, (_, index) => ({
      date: new Date(now - (13 - index) * DAY).toISOString().slice(0, 10),
      total: Math.round(23_900_000 * (0.3 + 0.7 * Math.sin(index / 3) ** 2)) / 8,
    })),
    sessions: [
      { id: 's1', title: '检查电脑是否安装 Redis', model: 'deepseek-v4.1-flash-260910', turns: 6, createdAt: now - 2 * HOUR, tokens: { total: 1_200_000 } },
      { id: 's2', title: '额度看板插件开发', model: 'deepseek-v4.1-flash-260910', turns: 31, createdAt: now - DAY, tokens: { total: 9_400_000 } },
    ],
    counts: { sessions: 13, activeDays: 4 },
  },
}

/**
 * Render the seat one click after mount.
 *
 * The open flag, the report and the anchor are seeded because a Node process has
 * no layout to measure and no second render pass to settle a promise in. The
 * anchor is what the layout effect would compute for a 240px sidebar: the panel
 * sits 8px above the button, flush with the sidebar's left edge.
 */
function paintSeat(report, options = {}) {
  const { open = true, wide = true } = options
  react.resetAll()
  react.seed(0, open)
  react.seed(1, report)
  react.seed(3, false)
  react.seed(4, open ? { left: 8, bottom: 8 } : null)
  const tree = seat({ t, load: () => Promise.resolve({ ok: true, data: report }), openConfig: () => {}, wide })
  const elements = elementsOf(tree)
  const pop = elements.find((element) => element.props?.className === 'dqb_pop')
  // The sidebar sits under a transformed ancestor, so the shipped panel is
  // `position:fixed` with hand-computed coordinates. In a static page that would
  // pin it to the viewport corner, so the preview re-hosts it in normal flow.
  const inFlow = pop === undefined ? null : {
    ...pop,
    props: {
      ...pop.props,
      style: { ...pop.props.style, position: 'relative', left: 'auto', bottom: 'auto', visibility: 'visible', maxHeight: 'none' },
    },
  }
  return {
    // The button alone: the wrapper also holds the portalled panel, which is
    // rendered again below so the two can be laid out side by side.
    button: toHtml(elements.find((element) => element.props?.className === 'dqb_seatBtn') ?? ''),
    pop: inFlow === null ? '' : toHtml(inFlow),
  }
}

const board = paintSeat(boardReport)
const boardEmpty = paintSeat({ ...boardReport, providers: [], counts: { providers: 0, configured: 0, low: 0 } })
const narrowSeat = paintSeat(boardReport, { open: false, wide: false })


// Harness ships these tokens; the preview only needs a plausible light theme.
const TOKENS = `
:root{
  --dsw-alias-fill-l1:#f7f8fa;
  --dsw-alias-fill-l2:#eef0f3;
  --dsw-alias-border-l1:#e6e8ec;
  --dsw-alias-border-l2:#d6dae0;
  --dsw-alias-label-primary:#1f2328;
  --dsw-alias-label-secondary:#5b6470;
  --dsw-alias-label-tertiary:#8b939f;
  --dsw-alias-label-primary-inverted:#ffffff;
  --dsw-alias-brand-primary:#3b82f6;
  --dsw-alias-bg-layer-2:#fbfcfd;
  --dsw-alias-interactive-bg-hover:#f0f2f5;
  --dsw-alias-settings-card-fill:#fbfcfd;
  --dsw-alias-settings-card-stroke:#e6e8ec;
  --dsw-alias-button-primary-fill:#1f2328;
  --dsw-alias-button-primary-hover:#333a42;
  --dsw-alias-state-error-primary:#dc2626;
  --dsw-alias-state-warn-primary:#d97706;
  --dsw-alias-state-warn-label:#b45309;
  --dsw-alias-state-success-primary:#15803d;
  --dsw-radius-lg:12px;
  --dsw-radius-sm:8px;
}`
const PREVIEW_CSS = `
body{margin:0;background:#fff;color:#1f2328;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:28px 24px 48px}
.wrapWide{max-width:1100px}
.frame{background:#fff;border:1px solid #e6e8ec;border-radius:14px;overflow:hidden;padding:0 8px 8px}
h1{font-size:17px;margin:0 0 4px}
.note{font-size:12px;color:#8b939f;margin:0 0 22px}
.caption{font-size:11.5px;color:#8b939f;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.pv_form{display:flex;flex-direction:column;gap:18px;border:1px solid #e2e5e9;border-radius:12px;padding:18px}
.pv_field{display:flex;flex-direction:column;gap:4px}
.pv_fieldHead{display:flex;align-items:baseline;gap:8px}
.pv_label{font-size:12.5px;font-weight:500;color:#1f2328}
.pv_badge{font-size:10.5px;color:#8b939f;margin-left:auto}
.pv_input{height:30px;box-sizing:border-box;border:1px solid #e2e5e9;border-radius:7px;background:#f7f8fa;color:#1f2328;font:12.5px inherit;padding:0 9px;width:100%}
.pv_hint{margin:0;font-size:11.5px;line-height:17px;color:#8b939f}
.pv_disabled{opacity:.6}
.pv_scene{display:flex;gap:18px;align-items:flex-start;padding:18px;background:#f4f6f8;border:1px solid #e6e8ec;border-radius:14px}
.pv_sidebar{width:236px;height:520px;flex:none;display:flex;flex-direction:column;justify-content:flex-end;padding:8px 8px 10px;background:#fff;border:1px solid #e6e8ec;border-radius:12px}
.pv_slot{height:26px;border-radius:7px;background:#f1f3f6;margin-bottom:3px}
.pv_accountRow{display:flex;align-items:center;gap:8px;height:34px;margin-top:4px;padding:0 8px;border-radius:8px;font-size:12.5px;color:#5b6470;background:#f7f8fa}
.pv_avatar{width:20px;height:20px;flex:none;border-radius:50%;background:#d7dce2}
.pv_popHost{flex:1;min-width:0}
`

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>额度看板 · 配置页预览</title>
<style>${TOKENS}${cssMatch[1]}${PREVIEW_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>模型供应商额度看板 · 设置页</h1>
  <p class="note">这是 client.js 真实渲染出的 DOM，不是手绘稿。</p>
  <p class="caption">空列表</p>
  ${emptyHtml}
  <p class="caption">添加两条之后</p>
  ${filledHtml}
  <p class="caption">点「测试连接」之后 · 连通</p>
  ${okHtml}
  <p class="caption">点「测试连接」之后 · 不连通</p>
  ${failHtml}
</div>
<div class="wrap wrapWide">
  <h1>侧栏底部席位 + 浮窗</h1>
  <p class="note">同一个 client.js 的侧栏席位组件；左侧是侧栏底部的真实排布（按钮在账号行上方），右侧是被 portal 出去的浮窗本体。</p>
  <p class="caption">展开态侧栏 · 点开之后</p>
  <div class="pv_scene">
    <div class="pv_sidebar">
      <div class="pv_slot"></div>
      <div class="pv_slot"></div>
      ${board.button}
      <div class="pv_accountRow"><span class="pv_avatar"></span><span>anixuil</span></div>
    </div>
    <div class="pv_popHost">${board.pop}</div>
  </div>
  <p class="caption">收起态侧栏 · 只剩图标</p>
  <div class="pv_scene">
    <div class="pv_sidebar" style="width:64px">
      <div class="pv_slot"></div>
      <div class="pv_slot"></div>
      ${narrowSeat.button}
      <div class="pv_accountRow"><span class="pv_avatar" style="margin:0 auto"></span></div>
    </div>
    <div class="pv_popHost" style="color:#8b939f;font-size:12px">侧栏收起时按钮只留图标，宽度由侧栏决定。</div>
  </div>
  <p class="caption">没有任何供应商</p>
  <div class="pv_scene">
    <div class="pv_sidebar">
      <div class="pv_slot"></div>
      <div class="pv_slot"></div>
      ${boardEmpty.button}
      <div class="pv_accountRow"><span class="pv_avatar"></span><span>anixuil</span></div>
    </div>
    <div class="pv_popHost">${boardEmpty.pop}</div>
  </div>
</div>
</body>
</html>
`

writeFileSync(OUT, html, 'utf8')
console.log(`wrote ${OUT}`)
console.log(`size ${(html.length / 1024).toFixed(1)} KB`)

// The board on its own, so a screenshot of it is not pushed off the bottom of a
// very long settings page.
const boardHtmlDoc = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>额度看板 · 浮窗预览</title>
<style>${TOKENS}${cssMatch[1]}${PREVIEW_CSS}</style>
</head>
<body>
<div class="wrap wrapWide">
  <p class="caption">两个供应商 · DeepSeek 走账号余额 · 一条未配置</p>
  <div class="pv_scene">
    <div class="pv_sidebar">
      <div class="pv_slot"></div>
      <div class="pv_slot"></div>
      ${board.button}
      <div class="pv_accountRow"><span class="pv_avatar"></span><span>anixuil</span></div>
    </div>
    <div class="pv_popHost">${board.pop}</div>
  </div>
  <p class="caption">没有任何供应商</p>
  <div class="pv_scene">
    <div class="pv_sidebar">
      <div class="pv_slot"></div>
      <div class="pv_slot"></div>
      ${boardEmpty.button}
      <div class="pv_accountRow"><span class="pv_avatar"></span><span>anixuil</span></div>
    </div>
    <div class="pv_popHost">${boardEmpty.pop}</div>
  </div>
</div>
</body>
</html>
`
writeFileSync(BOARD_OUT, boardHtmlDoc, 'utf8')
console.log(`wrote ${BOARD_OUT}`)
