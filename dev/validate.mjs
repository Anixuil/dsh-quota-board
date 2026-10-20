/**
 * Manifest-contract validation for dsh-quota-board.
 *
 * `smoke.mjs` proves the code does what it says; this proves the PACKAGE is
 * wired correctly, which is a different failure mode — every check below fails
 * silently in the Harness, with no message anywhere:
 *
 *   1. `package.json` — a missing `exports` entry, a file outside `files`, or an
 *      undeclared `@deepseek-ai/*` peer means a piece of the plugin is simply
 *      absent after installation.
 *   2. `cordis.patch.yml` — the loader drops a row config key the Config schema
 *      does not declare, and a row whose `name` is not this package makes the
 *      bundle permanently uninstallable (`bundle-in-use`).
 *   3. Host/client contract — the two halves only meet if the namespace, method
 *      name and parameter name agree; a mismatch mounts a service nobody calls,
 *      or calls a method that does not exist.
 *   4. Slot registrations — a page or sidebar entry that is not registered is
 *      drawn as nothing, not as an error.
 *   5. Dictionaries — a missing key renders its own key to the user, and a
 *      placeholder that a call site never fills ships a literal `{v}`.
 *
 *   node dev/validate.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
// js-yaml 5 exposes named exports only.
import { load as loadYaml } from 'js-yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/** Strip an optional `./` so both manifest styles resolve against the package root. */
const at = (rel) => rel.replace(/^\.\//u, '')
const exists = (rel) => fs.existsSync(path.join(ROOT, at(rel)))

let checked = 0
const ok = (line) => {
  checked += 1
  console.log('  ✓', line)
}

// ---------------------------------------------------------------------------
// 1. package.json
// ---------------------------------------------------------------------------

console.log('\nmanifest')
const pkg = JSON.parse(read('package.json'))
const clientSrc = read('client.js')
const hostSrc = read('index.js')

assert.equal(pkg.name, 'dsh-quota-board', '包名是工厂 id / 槽 key / configForms 命名空间的共同来源，不能改')
assert.equal(pkg.type, 'module', 'ESM 插件必须声明 type: module')
ok(`包名 ${pkg.name}，ESM 入口`)

for (const [key, rel] of [
  ['main', pkg.main],
  ['exports["."]', pkg.exports?.['.']],
  ['exports["./client"]', pkg.exports?.['./client']],
  ['exports["./package.json"]', pkg.exports?.['./package.json']],
]) {
  assert.ok(typeof rel === 'string', `缺 ${key}`)
  assert.ok(exists(rel), `${key} 指向的 ${rel} 不存在`)
}
assert.ok(pkg.exports?.['./locale/*.json'], 'locale 通配导出缺失时面板读不到标题')
ok('exports 覆盖入口、浏览器半侧与 locale/*.json')

assert.ok(/^\.\//u.test(pkg.icon ?? ''), 'icon 必须是相对清单目录的路径')
assert.ok(exists(pkg.icon), `icon ${pkg.icon} 不存在`)
assert.ok(fs.statSync(path.join(ROOT, pkg.icon.slice(2))).size < 256 * 1024, 'icon 须小于 256 KiB')
ok(`icon 存在且体积合规（${fs.statSync(path.join(ROOT, 'icon.svg')).size} 字节）`)

// Every module the Host imports has to be in the whitelist, or the published
// package resolves locally but not after installation.
const hostImports = [...hostSrc.matchAll(/(?:import\s*\(\s*|from\s+)['"](\.\/[^'"]+)['"]/gu)].map((match) => match[1])
const hostModules = hostImports.map((specifier) => specifier.slice(2))
assert.ok(hostModules.length >= 3, `宿主半侧应导入至少 3 个本地模块，实际 ${hostModules.length} 个`)
for (const module of hostModules) {
  assert.ok(pkg.files.includes(module), `宿主半侧导入了 ${module}，但它不在 files 白名单里 —— 发布包里会缺这个文件`)
}
ok(`files 覆盖宿主半侧导入的本地模块（${hostModules.join(', ')}）`)

for (const file of pkg.files) {
  if (file.includes('*')) {
    const [dir, suffix] = file.split('/*')
    const found = fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith(suffix.replace('*', '')))
    assert.ok(found.length > 0, `files 通配 ${file} 匹配不到任何文件`)
    continue
  }
  assert.ok(exists(file), `files 里的 ${file} 不存在`)
}
ok(`files 白名单的 ${pkg.files.length} 个条目都存在`)

for (const file of ['client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
  assert.ok(pkg.files.includes(file), `files 必须包含 ${file}，否则安装后缺这一块`)
}
ok('files 包含浏览器半侧、patch、图标与文档')

for (const lang of ['zh', 'en']) {
  const locale = JSON.parse(read(`locale/${lang}.json`))
  assert.ok(locale.meta?.title, `${lang}.json 缺 meta.title`)
  assert.ok(locale.meta?.description, `${lang}.json 缺 meta.description`)
}
ok('locale/zh.json 与 locale/en.json 元数据完整')

// ---------------------------------------------------------------------------
// 2. cordis.patch.yml
// ---------------------------------------------------------------------------

console.log('\npatch')
const patches = loadYaml(read('cordis.patch.yml'))
assert.ok(Array.isArray(patches), 'patch 顶层必须是 YAML 数组')
ok(`cordis.patch.yml 是合法 YAML 数组（${patches.length} 个条目）`)

const inserts = patches.flatMap((entry) => entry?.insert ?? [])
const overrides = patches.filter((entry) => entry?.insert === undefined)
for (const row of [...inserts, ...overrides]) {
  assert.ok(row.id, '每个 patch 行都需要 id')
  assert.ok(row.name ?? row.disabled !== undefined, `行 ${row.id} 既没有 name 也没有 disabled`)
  assert.ok(!('insert' in row), `行 ${row.id} 不应再嵌套 insert`)
}
ok('每个 patch 行都有 id，且形式合法')

assert.equal(overrides.length, 0, '这个组合包不覆盖别人的行：额度看板是读者，不是接缝。多出的覆盖行会让卸载变复杂')
// The plugin manager attributes only a bundle's `insert:` rows to that bundle
// and refuses to uninstall while any of them is mounted, so an `insert:` row
// naming another package pins a foreign copy forever.
for (const row of inserts) {
  assert.equal(row.name, pkg.name, `insert 行 "${row.id}" 的 name 是 ${row.name}，不是本包 —— 会让本组合包永远无法卸载`)
}
ok(`insert 只声明本包自己的行（${inserts.map((row) => row.id).join(', ')}）`)

// Reproduce the loader's composition against an empty base: a bundle's
// `insert:` list is exactly what it contributes to the tree.
function applyEntryPatches(data, patchList) {
  data = structuredClone(data)
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)
    }
  }
  buildMap(data)
  for (const patch of patchList) {
    const { id, insert, name, ...rest } = patch
    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target || !target.group) continue
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else data.push(...insert)
      buildMap(insert)
      continue
    }
    if (!id) continue
    const target = entryMap.get(id)
    if (!target || (name && name !== target.name)) continue
    for (const [key, value] of Object.entries(rest)) {
      if (key !== 'id') target[key] = value
    }
  }
  return data
}

const contributed = applyEntryPatches([], patches)
assert.deepEqual(
  contributed.map((row) => row.id),
  inserts.map((row) => row.id),
  '本组合包贡献的行必须恰好等于它的 insert 行 —— 这是卸载检查的依据',
)
ok(`本组合包只贡献 ${contributed.length} 行`)

const pluginRow = contributed[0]
const { Config, name: hostName, QUOTA_NAMESPACE, REMOTE_METHODS } = await import('../index.js')
assert.equal(pluginRow.id, hostName, 'patch 行 id 必须等于 index.js 的 name 导出，否则 loader 会警告并跳过')
ok(`行 id 与宿主 name 一致（${hostName}）`)

// --- patch config vs. the Config schema -----------------------------------
const declared = new Map()
for (const [key, schema] of Object.entries(Config.dict ?? {})) declared.set(key, schema.meta ?? {})
// A hard count would fail every time a field is legitimately retired; what
// matters is that the controls the dashboard needs are all declared.
for (const required of ['providers', 'lowThreshold', 'refreshSeconds', 'usageDays', 'timeoutMs']) {
  assert.ok(declared.has(required), `Config 缺字段 ${required}`)
}

const written = Object.keys(pluginRow.config ?? {})
for (const key of written) {
  assert.ok(declared.has(key), `patch 写了 Config 里不存在的字段 "${key}" —— loader 会静默丢弃`)
}
ok(`patch 的 ${written.length} 个配置项全部存在于 Config schema`)

for (const [key, meta] of declared) {
  assert.ok(written.includes(key), `Config 字段 "${key}" 未在 patch 中给出默认值`)
  assert.deepEqual(pluginRow.config[key], meta.default, `patch 里 "${key}" 的默认值与 Config 不一致（Config: ${JSON.stringify(meta.default)}）`)
}
ok('Config 的每个字段都在 patch 中给出默认值，且与 schema 一致')

// The loader must accept the patch's literals as-is.
Config({ ...pluginRow.config })
ok('patch 的配置能通过 Config 校验')

// ---------------------------------------------------------------------------
// 3. Host ↔ client contract
// ---------------------------------------------------------------------------

console.log('\nremote contract')

/**
 * Every method the Host exposes, with the wire parameter the client must send.
 *
 * The Gateway derives wire parameter names from the method's own source, so a
 * renamed parameter silently changes the wire shape. Spelling the contract out
 * here keeps both halves — and the descriptor — held to the same list.
 */
const EXPECTED_METHODS = [
  { method: 'load', param: 'force' },
  { method: 'test', param: 'entry' },
]

assert.deepEqual(
  REMOTE_METHODS.map((method) => method.method),
  EXPECTED_METHODS.map((method) => method.method),
  '宿主侧 REMOTE_METHODS 与契约不一致',
)
for (const entry of REMOTE_METHODS) {
  assert.equal(entry.invocation?.kind, 'direct', `Gateway 只接受 direct 调用（${entry.method}）`)
}
ok(`宿主侧声明 ${REMOTE_METHODS.length} 个 Remote 方法，全部是 direct 调用`)

const hostSignatures = new Map()
for (const { method } of EXPECTED_METHODS) {
  const match = new RegExp(`async\\s+${method}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`, 'u').exec(hostSrc)
  assert.ok(match, `宿主侧必须声明 ${method}(...)，参数以裸标识符书写`)
  hostSignatures.set(method, match[1])
}
ok(`宿主侧形参：${[...hostSignatures].map(([method, param]) => `${method}(${param})`).join('、')}`)

const clientNs = /const\s+NAMESPACE\s*=\s*'([^']+)'/u.exec(clientSrc)?.[1]
assert.equal(clientNs, QUOTA_NAMESPACE, '浏览器侧的 NAMESPACE 必须等于宿主的 QUOTA_NAMESPACE')

// `METHOD` / `METHOD_TEST` name the methods; `<METHOD>_PARAM` names the wire
// parameter of each, so the pairing is by the upper-cased method name.
const clientMethods = [...clientSrc.matchAll(/const\s+METHOD(?:_([A-Z_]+))?\s*=\s*'([^']+)'/gu)].map((match) => match[2])
assert.deepEqual(clientMethods, EXPECTED_METHODS.map((entry) => entry.method), '浏览器侧的 METHOD 常量必须覆盖宿主的方法')
const clientParams = new Map(
  [...clientSrc.matchAll(/const\s+([A-Z_]+)_PARAM\s*=\s*'([^']+)'/gu)].map((match) => [match[1], match[2]]),
)
for (const { method, param } of EXPECTED_METHODS) {
  assert.equal(
    clientParams.get(method.toUpperCase()),
    hostSignatures.get(method),
    `${method} 的参数名必须等于宿主形参（应写在 ${method.toUpperCase()}_PARAM）`,
  )
  assert.equal(hostSignatures.get(method), param, `${method} 的接线参数名变了，请同步 EXPECTED_METHODS`)
}
ok(`两端命名空间/方法/参数一致（${clientNs}.{${clientMethods.join(', ')}}）`)

// Materialize the browser half to inspect the descriptor it really registers,
// rather than trusting a regex over the source.
let factory = null
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { factory = definition.factory } } },
  document: undefined,
  console,
  setInterval: () => 0,
  clearInterval: () => {},
}
vm.runInNewContext(clientSrc, sandbox)
assert.equal(typeof factory, 'function', 'client.js 必须注册一个工厂函数')

const requested = []
const reactStub = { createElement: () => null, Fragment: 'Fragment' }
// The module body builds its form specs at load time, so the primitives it
// reads eagerly have to exist; nothing here renders.
const primitivesStub = {
  settingsTextField: (name) => ({ kind: 'text', name }),
  settingsNumberField: (name) => ({ kind: 'number', name }),
  SettingsFormModel: class {},
  SettingsForm: () => null,
  SettingsValueField: () => null,
  SettingsSecretField: () => null,
}
const moduleExports = factory((specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return reactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`浏览器半侧 import 了 loader 不会提供的模块：${specifier}`)
})
ok(`浏览器半侧只依赖 loader 会提供的模块（${[...new Set(requested)].join(', ')}）`)

const descriptors = moduleExports.CONTRIBUTION?.descriptors ?? []
assert.ok(descriptors.length > 0, 'CONTRIBUTION 必须携带 descriptor，否则 $mount 没有东西可挂')
assert.equal(
  descriptors.length,
  EXPECTED_METHODS.length,
  `CONTRIBUTION 应声明 ${EXPECTED_METHODS.length} 个 descriptor，实际 ${descriptors.length} 个`,
)
for (const { method } of EXPECTED_METHODS) {
  const descriptor = descriptors.find((entry) => entry.method === method)
  assert.ok(descriptor, `CONTRIBUTION 缺 ${method} 的 descriptor —— 浏览器侧会拿到 undefined`)
  assert.equal(descriptor.namespace, moduleExports.NAMESPACE)
  assert.equal(
    descriptor.id,
    `${pkg.name}#${moduleExports.NAMESPACE}/${method}`,
    'descriptor id 必须是 <包名>#<命名空间>/<方法>',
  )
  assert.equal(descriptor.invocation?.kind, 'direct', 'descriptor 的调用方式必须与宿主一致')
  assert.equal(descriptor.parameters?.length, 1, `${method} 只接受一个参数`)
  assert.equal(descriptor.parameters[0].name, hostSignatures.get(method), `${method} 的参数名必须与宿主形参一致`)
  assert.equal(
    descriptor.parameters[0].wire,
    descriptor.parameters[0].name,
    'wire 名与参数名一致时 Gateway 才能按名取值',
  )
  for (const [label, codec] of [
    ['parameter', descriptor.parameters[0].codec],
    ['result', descriptor.result],
  ]) {
    // Three validators sit on this path and each checks something different:
    // `mode`, a non-empty `typeSymbol`, and `create`/`decode`/`encode` shapes.
    assert.equal(codec?.mode, 'strict', `${method} 的 ${label} codec 必须是 strict 模式，否则 Gateway 会拒收`)
    assert.ok(
      typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0,
      `${method} 的 ${label} codec 需要非空 typeSymbol`,
    )
    assert.equal(typeof codec.create, 'function', `${method} 的 ${label} codec 需要 create()`)
    for (const hook of ['decode', 'encode']) {
      if (hook in codec) assert.equal(typeof codec[hook], 'function', `${method} 的 ${label} codec 的 ${hook} 必须是函数`)
    }
  }
}
ok(`每个 descriptor 的两个 codec 都满足三道校验器的要求（${descriptors.length} 个方法）`)

// `require('@deepseek-ai/dsh-client-ui-primitives')` is the one allowed import:
// the shared form primitives own save/discard revisioning. Anything else — a
// peer package, a node builtin — would resolve in dev and fail in the browser.
const hostRequires = [...hostSrc.matchAll(/require\(/gu)]
assert.equal(hostRequires.length, 0, '宿主半侧用 ESM import，不用 require')
ok('宿主半侧没有 require 调用')

// The account wallet is the only reason DeepSeek needs no API key; losing it
// would silently bring back the "未配置 API Key" card for a signed-in user.
assert.ok(/function\s+readAccountWallet\s*\(/u.test(hostSrc), 'DeepSeek 余额必须能读到 Harness 账号钱包')
assert.ok(/get\('deepseekAccount'\)/u.test(hostSrc), '账号钱包只能通过 deepseekAccount 服务读取')
assert.ok(/function\s+isOfficialDeepSeek\s*\(/u.test(hostSrc), '必须区分官方 DeepSeek 与同协议的第三方中转')
ok('DeepSeek 走账号钱包，且只对官方主机生效')

// ---------------------------------------------------------------------------
// 4. Host imports vs. peerDependencies
// ---------------------------------------------------------------------------

console.log('\npeers')
const importedPeers = new Set()
for (const source of [hostSrc, read('client.js')]) {
  for (const match of source.matchAll(/(?:import\s*\(\s*|from\s+|require\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/gu)) {
    importedPeers.add(match[1])
  }
}
const peers = pkg.peerDependencies ?? {}
const undeclared = [...importedPeers].filter((name) => peers[name] === undefined).sort()
assert.deepEqual(
  undeclared.filter((name) => name !== '@deepseek-ai/dsh-client-ui-primitives'),
  [],
  `代码导入了却没声明 peerDependencies 的包（运行时解析不到，功能会静默缺失）：${undeclared.join(', ')}`,
)
assert.equal(
  peers['@deepseek-ai/dsh-client-ui-primitives'],
  undefined,
  '浏览器半侧的 primitives 由 loader 提供，不应声明为 peer —— 声明了反而会被兼容性检查拦下',
)
ok(`代码导入的 ${importedPeers.size} 个 @deepseek-ai 包都已声明为 peer（primitives 除外）`)

const stale = Object.keys(peers).filter((name) => !importedPeers.has(name)).sort()
assert.deepEqual(stale, [], `peerDependencies 里有代码不再导入的条目：${stale.join(', ')}`)
ok('peerDependencies 没有过期条目')

for (const [name, range] of Object.entries(peers)) {
  assert.equal(range, '*', `${name} 的 peer 范围应为 *，否则升级 dsh 后会被兼容性检查拦下`)
}
ok('peer 范围全为 *：升级 dsh 后不会被兼容性检查拦下')

// A bundle must not carry runtime dependencies: the profile's node_modules is
// shared, and a nested copy of a Harness package breaks identity checks.
assert.equal(pkg.dependencies, undefined, '组合包不应带 dependencies')
ok('没有运行时 dependencies')

// ---------------------------------------------------------------------------
// 5. Slot registrations
// ---------------------------------------------------------------------------

console.log('\nslots')
const clientDecl = pkg.dsh?.client
assert.ok(clientDecl, 'package.json 缺 dsh.client —— 插件页不会挂载任何页面')
assert.equal(clientDecl.platform, 'web', 'dsh.client.platform 必须是 "web"')
assert.equal(clientDecl.immediately, true, '面板要在首帧就可用，必须是 immediately')
ok('dsh.client 声明 web + immediately')

// Two different `inject` lists, often confused:
//   package.json `dsh.client.inject` — CLIENT PACKAGES this module must load
//     after, because they own the slots it registers into;
//   client.js `inject` — CORDIS SERVICES its `apply(ctx)` needs.
const declaredInject = clientDecl.inject
assert.ok(Array.isArray(declaredInject) && declaredInject.length > 0, 'dsh.client.inject 不能为空')
assert.equal(new Set(declaredInject).size, declaredInject.length, 'dsh.client.inject 有重复项')
for (const name of declaredInject) {
  assert.ok(name.startsWith('@deepseek-ai/dsh-'), `dsh.client.inject 里的 "${name}" 不像一个 client 包名`)
}
// Each entry is load-bearing: without the owner package, the slot this module
// registers into does not exist yet and the registration goes nowhere.
assert.deepEqual(
  [...declaredInject].sort(),
  [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ],
  'dsh.client.inject 必须覆盖本插件注册用到的槽位主人（main / sidebar.panellist / plugins.*）',
)
ok(`dsh.client.inject 覆盖 ${declaredInject.length} 个槽位主人`)

for (const service of ['slots', 'locale', 'configForms', 'remote']) {
  assert.ok(moduleExports.inject.includes(service), `client.js 的 inject 必须包含 ${service}，否则 apply 里取到 undefined`)
}
ok(`client.js 的 inject 覆盖它真正读的服务（${moduleExports.inject.join(', ')}）`)

const clientConst = (name) => {
  const match = clientSrc.match(new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`, 'u'))
  assert.ok(match, `client.js 必须声明 ${name}`)
  return match[1]
}
assert.equal(clientConst('PKG_NAME'), pkg.name, 'PKG_NAME 必须等于包名：包页的槽按包名寻址')
assert.equal(clientConst('ROW_ID'), pluginRow.id, 'configForms 用的命名空间是行 id')
assert.equal(clientConst('ROW_KEY'), `${pkg.name}#${pluginRow.id}`, 'row 槽的 key 必须是 <包名>#<行 id>')
assert.equal(clientConst('BUNDLE_SLOT'), 'plugins.bundle.config')
assert.equal(clientConst('ITEM_SLOT'), 'plugins.item')
assert.equal(clientConst('ROW_SLOT'), 'plugins.row.config')
ok('三个配置入口的槽位与 key 都正确')

assert.ok(
  /whileServed\(\s*\[\s*ROW_ID\s*\]/u.test(clientSrc),
  '配置表单应经 configForms.whileServed 跟随 Host 提供的命名空间',
)
const mounts = [...clientSrc.matchAll(/^[ \t]+mountForm\(\s*ctx,\s*card,\s*(\w+)/gmu)].map((match) => match[1])
assert.deepEqual(mounts, ['BUNDLE_SLOT', 'ITEM_SLOT', 'ROW_SLOT'], '三个入口都必须挂载，缺一个就少一个配置入口')
ok(`三个入口都经 configForms.whileServed 挂载（${mounts.join(' + ')}）`)

// Runner-level slots: the page and the sidebar entry share PANEL_ID, which is
// how selecting the sidebar entry reaches this page instead of a blank centre.
assert.ok(
  new RegExp(`name:\\s*'main'[^}]*key:\\s*PANEL_ID`, 'u').test(clientSrc),
  '页面必须注册到 main 槽，并用 PANEL_ID 作为 key',
)
assert.ok(
  new RegExp(`name:\\s*'sidebar\\.panellist'[^}]*id:\\s*PANEL_ID`, 'u').test(clientSrc),
  '侧栏入口必须注册到 sidebar.panellist，id 必须是 PANEL_ID',
)
assert.ok(/layout\.selectPanel|selectPanel\(/u.test(clientSrc) || /PANEL_ID/u.test(clientSrc), '侧栏入口与页面必须共用 PANEL_ID')
ok('页面与侧栏入口共用 PANEL_ID，切面板能落到这一页')

// Two registrations of the same (slot, key) silently replace each other.
const registrations = [...clientSrc.matchAll(/ctx\.slots\.register\(\s*\{([^}]*)\}/gu)].map((match) => match[1])
assert.ok(registrations.length >= 3, `页面、侧栏入口、配置表单三类注册缺一不可，实际 ${registrations.length} 处`)
ok(`共 ${registrations.length} 处槽位注册`)

// ---------------------------------------------------------------------------
// 6. Dictionaries
// ---------------------------------------------------------------------------

console.log('\ndictionaries')
const { zh, en } = moduleExports.dictionaries
assert.ok(zh && en, 'client.js 必须导出 zh / en 词典，供离线校验与渲染测试使用')

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
const missingEn = zhKeys.filter((key) => en[key] === undefined)
const missingZh = enKeys.filter((key) => zh[key] === undefined)
assert.deepEqual(missingEn, [], `英文词典缺 ${missingEn.join(', ')}`)
assert.deepEqual(missingZh, [], `中文词典缺 ${missingZh.join(', ')}`)
ok(`中英词典 key 完全对应（${zhKeys.length} 个）`)

const placeholders = (template) => new Set([...String(template).matchAll(/\{(\w+)\}/gu)].map((match) => match[1]))
for (const key of zhKeys) {
  const a = [...placeholders(zh[key])].sort()
  const b = [...placeholders(en[key])].sort()
  assert.deepEqual(a, b, `"${key}" 的中英文占位符不一致（zh: ${a.join(',')} / en: ${b.join(',')}）`)
}
ok('每个 key 的中英文占位符一致')

// Every literal key a call site asks for must exist. A missing one renders the
// key itself, which looks like a bug report rather than a sentence.
const used = new Set()
for (const match of clientSrc.matchAll(/(?:\bt|props\.t)\(\s*'([A-Za-z][\w.]*)'/gu)) used.add(match[1])
const unknown = [...used].filter((key) => zh[key] === undefined).sort()
assert.deepEqual(unknown, [], `页面用了词典里没有的 key：${unknown.join(', ')}`)
ok(`页面用到的 ${used.size} 个 key 都在词典里`)

// The other direction: a call site that passes variables to a template with no
// placeholder, or one that fills a template nobody passes variables to, ships a
// literal `{v}` to the user — or silently drops the value.
const filled = new Map()
for (const match of clientSrc.matchAll(/format\(\s*(?:props\.)?t\(\s*'([A-Za-z][\w.]*)'\s*\)\s*,\s*\{([^}]*)\}/gu)) {
  filled.set(match[1], new Set(match[2].split(',').map((pair) => pair.split(':')[0].trim()).filter(Boolean)))
}
for (const [key, vars] of filled) {
  const slots = placeholders(zh[key])
  for (const name of vars) {
    assert.ok(slots.has(name), `"${key}" 的调用方传了 {${name}}，但模板里没有这个占位符：${JSON.stringify(zh[key])}`)
  }
  for (const name of slots) {
    assert.ok(vars.has(name), `"${key}" 的模板需要 {${name}}，但调用方没有传`)
  }
}
ok(`format() 的 ${filled.size} 处插值与模板占位符一一对应`)

// A template with placeholders that is rendered bare would print them raw.
const bare = [...clientSrc.matchAll(/(?<!format\()\s(?:props\.)?t\(\s*'([A-Za-z][\w.]*)'\s*\)/gu)].map((match) => match[1])
const rawSlots = [...new Set(bare)].filter((key) => zh[key] !== undefined && placeholders(zh[key]).size > 0)
assert.deepEqual(rawSlots, [], `这些 key 的模板带占位符，但被直接渲染（会输出成 {v}）：${rawSlots.join(', ')}`)
ok('没有把带占位符的模板直接渲染出来')

// The settings form is the only place the patch config can be edited, so a
// reference-based drift is a field the user cannot reach without hand-editing
// YAML. Both directions are checked: every Config key has a field, and every
// field names a Config key.
const fieldsOf = (name) => {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u').exec(clientSrc)
  assert.ok(match, `client.js 必须声明 ${name}`)
  return [...match[1].matchAll(/'(\w+)'/gu)].map((item) => item[1])
}
const valueFields = [...fieldsOf('LIST_FIELDS'), ...fieldsOf('TEXT_FIELDS'), ...fieldsOf('NUMBER_FIELDS')]
// Secrets are no longer top-level fields: each provider entry carries its own
// references and writes its own value, so the list may legitimately be empty.
const secretFields = /const\s+SECRET_FIELDS\s*=/u.test(clientSrc) ? fieldsOf('SECRET_FIELDS') : []
assert.ok(valueFields.length >= 6, `表单应有至少 6 个值字段，实际 ${valueFields.length} 个`)
// The Volcengine pair has to be reachable somewhere; it moved into the entry.
assert.ok(/function\s+providerCredentials\s*\(/u.test(clientSrc), '火山 AK/SK 必须能在供应商条目里填写')
assert.ok(/function\s+CredentialInput\s*\(/u.test(clientSrc), '条目内的凭证必须有写入控件')

// `tidyProviders` rebuilds every entry from PROVIDER_KEYS, so a key that is
// missing here is silently dropped on save — the input would look empty again.
const providerKeys = fieldsOf('PROVIDER_KEYS')
for (const key of ['accessKeyEnv', 'secretKeyEnv']) {
  assert.ok(providerKeys.includes(key), `PROVIDER_KEYS 缺 ${key}，保存时这个引用名会被丢掉`)
}
assert.ok(providerKeys.includes('apiKeyEnv') && providerKeys.includes('adapter'), 'PROVIDER_KEYS 缺基本字段')
ok(`供应商条目的 ${providerKeys.length} 个键都会写进配置文件`)

// The pair used to be two plugin-wide fields; if their labels survive, the
// dictionary carries copy for controls that no longer exist.
const staleVolcKeys = Object.keys(zh).filter((key) => /^form(?:Label|Hint)Volc(?:Access|Secret)KeyEnv$/u.test(key))
assert.deepEqual(staleVolcKeys, [], `这些文案对应的全局火山字段已删除，应当一并移除：${staleVolcKeys.join(', ')}`)
ok('词典里没有已删除字段的残留文案')

const pairOf = (name) => {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n    \\}`, 'u').exec(clientSrc)
  assert.ok(match, `client.js 必须声明 ${name}`)
  return new Map([...match[1].matchAll(/(\w+):\s*'([\w.]+)'/gu)].map((item) => [item[1], item[2]]))
}

const mapPairs = [
  ['LABEL_OF', valueFields, '标签'],
  ['HINT_OF', valueFields, '提示'],
]
if (secretFields.length > 0) {
  mapPairs.push(['SECRET_LABEL_OF', secretFields, '标签'], ['SECRET_HINT_OF', secretFields, '提示'])
}
for (const [pairs, fields, label] of mapPairs) {
  const map = pairOf(pairs)
  for (const field of fields) {
    const key = map.get(field)
    assert.ok(key !== undefined, `${pairs} 缺字段 ${field} 的${label}`)
    assert.ok(zh[key] !== undefined, `${field} 的${label}键 ${key} 不在中文词典里`)
    assert.ok(en[key] !== undefined, `${field} 的${label}键 ${key} 不在英文词典里`)
  }
}
ok(`表单 ${valueFields.length} 个值字段 + ${secretFields.length} 个密钥字段都有中英标签与提示`)

const formFields = new Set([...valueFields, ...secretFields])
for (const key of declared.keys()) {
  assert.ok(formFields.has(key), `Config 字段 "${key}" 在设置表单里没有入口 —— 用户只能手改 YAML`)
}
ok(`Config 的 ${declared.size} 个字段都能在设置表单里编辑`)

const orphanFields = [...formFields].filter((field) => !declared.has(field) && !secretFields.includes(field))
assert.deepEqual(orphanFields, [], `表单里的这些字段 Config 不认识（存不下来）：${orphanFields.join(', ')}`)
ok('表单没有 Config 不认识的字段')

console.log(`\n${checked} checks passed`)
