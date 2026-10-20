/**
 * dsh-quota-board — browser half.
 *
 * Three surfaces, all registered from this one module:
 *
 *   main            a full page in the centre column, opened from the sidebar
 *   sidebar.panellist  the sidebar entry that opens that page
 *   plugins.*       the settings form (bundle page, plugin card, row detail)
 *
 * The page renders provider balances and local token usage. Everything it shows
 * comes from the Host through one Remote method (`quotaBoard.load`), because
 * provider billing endpoints are cross-origin, several are signed, and the
 * credentials never reach the browser.
 *
 * Styles use only `--dsw-alias-*` theme tokens so light and dark both work, and
 * the dashboard markup is plain HTML rather than Harness primitives: a component
 * that throws blanks its slot without a message. The settings form is the one
 * exception — it uses the shared form primitives, which own save/discard
 * revisioning that is not worth reimplementing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-board',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const UI = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * Portal renderer for the sidebar popover.
     *
     * The sidebar lives under a transformed ancestor, so a `position: fixed`
     * child would be placed against that ancestor rather than the viewport — and
     * clipped by its overflow. Harness ships `react-dom` to plugin clients; if a
     * future build withholds it, the panel falls back to rendering inline (still
     * fixed, possibly clipped) instead of throwing and blanking the seat.
     */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      createPortal = typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
    } catch {
      createPortal = null
    }

    /** Package name: the bundle slot key and the client module id. */
    const PKG_NAME = 'dsh-quota-board'

    /** Loader row / settings namespace this page configures. */
    const ROW_ID = 'quota-board'

    /** `plugins.row.config` key: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-quota-board#quota-board'

    /** Centre-column panel key and sidebar entry id. */
    const PANEL_ID = 'quota-board'

    /** Sidebar ordering: plugins is 0, schedules is 10. */
    const PANEL_ORDER = 20

    /** The `plugins.item` card id; must not collide with official artwork ids. */
    const ITEM_ID = 'quota-board'

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.quotaBoard'

    /** Remote namespace and methods; must equal `index.js`. */
    const NAMESPACE = 'quotaBoard'
    const METHOD = 'load'
    /** One unsaved entry, tested from the settings page. */
    const METHOD_TEST = 'test'

    const BUNDLE_SLOT = 'plugins.bundle.config'
    const ITEM_SLOT = 'plugins.item'
    const ROW_SLOT = 'plugins.row.config'

    /** Host method parameters, in wire order. */
    const LOAD_PARAM = 'force'
    const TEST_PARAM = 'entry'

    /**
     * The boundary schema: this endpoint is JSON and nothing more. The Host
     * synthesizes an SRC parameter as `{ mode: 'src-json' }`, and its decoder
     * only consults a codec for strict modes, so a JSON passthrough is honest.
     */
    const SRC_SCHEMA = { parse: (value) => value }

    /**
     * A strict codec complete enough for the three validators on the way in
     * (Gateway `requireStrictInputs`, registry `validateCodec`, loader
     * `requireStrictCodec`): `mode`, a non-empty `typeSymbol`, and `create`.
     */
    const strictCodec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      create: () => SRC_SCHEMA,
    })

    const CONTRIBUTION = {
      package: PKG_NAME,
      descriptors: [
        {
          id: `${PKG_NAME}#${NAMESPACE}/${METHOD}`,
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: METHOD,
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: LOAD_PARAM,
              wire: LOAD_PARAM,
              source: 'json',
              codec: strictCodec(`${PKG_NAME}#${NAMESPACE}/${METHOD}:parameter:${LOAD_PARAM}`),
            },
          ],
          result: strictCodec(`${PKG_NAME}#${NAMESPACE}/${METHOD}:result`),
        },
        {
          id: `${PKG_NAME}#${NAMESPACE}/${METHOD_TEST}`,
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: METHOD_TEST,
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: TEST_PARAM,
              wire: TEST_PARAM,
              source: 'json',
              codec: strictCodec(`${PKG_NAME}#${NAMESPACE}/${METHOD_TEST}:parameter:${TEST_PARAM}`),
            },
          ],
          result: strictCodec(`${PKG_NAME}#${NAMESPACE}/${METHOD_TEST}:result`),
        },
      ],
    }

    // -----------------------------------------------------------------------
    // dictionaries
    // -----------------------------------------------------------------------

    const zh = {
      title: '模型供应商额度看板',
      summary: '余额、套餐额度与 token 用量，一个面板看完。',
      panel: '额度看板',
      panelHint: '所有已配置的模型供应商',
      loading: '正在读取额度…',
      empty: '还没有发现任何模型供应商。',
      emptyHint:
        '在「设置 → 模型」或 profile 的 llm-pi-ai 里添加提供方后，这里会自动出现；也可以用下方配置里的 providers 字段手工添加。',
      actionRefresh: '刷新',
      actionRefreshing: '刷新中…',
      actionConfig: '配置',
      actionRetry: '重试',
      statProviders: '供应商',
      statLow: '低额度',
      statTotal: '本机累计',
      statToday: '今日消耗',
      statTokensUnit: 'tokens',
      updatedAt: '更新于 {time}',
      cachedAt: '缓存于 {time}',
      badgeOk: '正常',
      badgeLow: '额度偏低',
      badgeError: '查询失败',
      badgeUnconfigured: '未配置',
      badgeUnsupported: '不支持查询',
      badgeDefault: '当前默认',
      badgeFree: '免密钥',
      labelBalance: '账户余额',
      labelGranted: '赠送',
      labelTopped: '充值',
      labelRemaining: '剩余',
      labelUsed: '已用',
      labelTotalUsed: '累计消费',
      labelSoft: '软限额',
      labelHard: '硬限额',
      labelPayment: '支付方式',
      labelPaymentYes: '已绑定',
      labelPaymentNo: '未绑定',
      labelPlanExpires: '到期 {time}',
      labelPlanRecent: '近 30 天扣减',
      labelLocal: '本机用量',
      labelSessionsUnit: '{n} 个会话',
      labelKeyFrom: '密钥来源：{v}',
      labelWalletFrom: '余额来源：{v}',
      walletAccount: 'DeepSeek 账号（设置 → 账号与余额）',
      walletKey: '供应商接口',
      keyCredential: '凭证服务',
      keyLaunch: '启动环境',
      keyProcess: '进程环境变量',
      keyAccount: 'DeepSeek 账号',
      keyNone: '未找到',
      labelModelCount: '{n} 个模型',
      labelBase: '接口',
      stateTitle: '还没有可显示的额度',
      stateHint: '登录 DeepSeek 账号或在插件配置里补一个 API Key 就能看到数字。',
      unsupportedNote: '该平台没有可通过 API Key 查询的余额/账单接口，本卡片只统计本机用量。',
      usageTitle: '本机用量',
      usageNote: '来自会话投影缓存，覆盖全部已记录的会话；与供应商账单的口径可能不同。',
      usageComposition: 'token 组成',
      usageInput: '输入',
      usageCacheRead: '缓存读',
      usageCacheWrite: '缓存写',
      usageOutput: '输出',
      usageTotal: '合计',
      usageSessions: '会话',
      usageActiveDays: '活跃天数',
      usageRequests: '请求数',
      usageAvgSession: '平均每会话',
      usageModels: '按模型',
      usageDays: '近 {n} 天',
      usageRecent: '最近会话',
      usageEmpty: '还没有可统计的本地用量。',
      usageUntitled: '未命名会话',
      usageTurns: '{n} 轮',
      usagePressure: '上下文 {n}%',
      resetExpired: '已到重置时间',
      resetMinutes: '{n} 分钟后重置',
      resetHours: '{n} 小时后重置',
      resetDays: '{n} 天后重置',
      errTitle: '读不到额度数据',
      errNoService: '宿主没有提供额度服务（{v}）。',
      errServiceHint:
        '插件已加载但额度服务没有挂载，通常是 Harness 版本不带 Typert 的 remote 能力。重启 Harness 后如果仍然这样，请把这条信息反馈给插件作者。',
      errFailed: '查询失败：{v}',
      errUnavailable: '还没有挂载完成，稍后自动重试。',
      errNoMount: '这个 Harness 构建的 remote 上没有 $mount。',
      errRefused: '挂载被 Gateway 拒绝：{v}',
      errUnreadable: '额度服务已挂载，但读不到命名空间 {v}。',
      errMissingMethod: '额度服务已挂载，但没有 {v} 方法。',
      formLabelProviders: '额外供应商',
      formHintProviders: '补充或覆盖自动发现的供应商。留空时看板直接用 profile 里已配置的那些；要看新网关的余额，就在这里加一条。',
      formLabelDefaultProvider: '默认展示供应商',
      formHintDefaultProvider: '侧栏底部按钮显示这一家的名字与额度。选「自动」时优先用模型配置里的默认供应商。',
      formDefaultProviderAuto: '自动（跟随默认供应商）',
      formProviderAdd: '添加供应商',
      formProviderRemove: '删除',
      formProviderUntitled: '未命名供应商',
      formProviderEmpty: '还没有额外供应商。上面从模型配置里发现的会自动出现在看板里，这里只用来补充或覆盖。',
      formProviderEmptyManual: '还没有手动添加的条目。上面这些已经够用；想改某个的查询方式，点它的「覆盖」。',
      formProviderAdvanced: '高级：协议、鉴权头与字段映射',
      formProviderAdvancedCount: '高级：协议、鉴权头与字段映射（已配置 {n} 项）',
      formProviderAuto: '自动识别',
      formProviderBroken: '这个列表读不出来，请检查配置。',
      formProviderId: '标识',
      formProviderName: '显示名称',
      formProviderBaseURL: '接口地址',
      formProviderKeyRef: '密钥引用名',
      formProviderAdapter: '适配器',
      formProviderApi: '协议提示（api）',
      formProviderAuthHeader: '鉴权头',
      formProviderAuthPrefix: '鉴权前缀',
      formProviderEndpoint: '接口路径',
      formProviderRemaining: '余额字段',
      formProviderUsed: '已用字段',
      formProviderUnit: '单位字段',
      formProviderScale: '数值倍率',
      formProviderDiscovered: '来自模型配置（{n}）',
      formProviderOverride: '覆盖',
      formProviderUnbound: '未绑定接口',
      formProviderNoKey: '未配置密钥',
      formProviderCredentials: '火山账户密钥（AK/SK）',
      formProviderAccessKeyRef: 'AccessKey 引用名',
      formProviderSecretKeyRef: 'SecretKey 引用名',
      formProviderAccessKey: 'AccessKey ID · {ref}',
      formProviderSecretKey: 'Secret Access Key · {ref}',
      formHintProviderAccessKey: '只在查火山账单时使用，Ark API Key 不能代替；写入凭证服务，不进设置文件。',
      formHintProviderSecretKey: '与 AccessKey 配对使用；写入凭证服务，不进设置文件。',
      formProviderSecretPlaceholder: '粘贴密钥后点保存',
      formProviderWrite: '保存',
      formProviderWritten: '已写入凭证服务',
      formProviderWriteFailed: '写入失败，检查凭证服务是否可用',
      formProviderTest: '测试连接',
      formProviderTesting: '测试中…',
      formProviderTestOk: '连通 · {value}',
      formProviderTestNoValue: '连通，但没读到余额',
      formProviderTestUnsupported: '连通，但该平台没有额度接口',
      formProviderTestFailed: '不连通 · {reason}',
      formProviderTestVia: '接口 {endpoint}',
      formProviderTestPin: '钉死这个接口',
      formProviderTestPinned: '已钉死接口 {endpoint}',
      formProviderTestHint: '用上面填的值直接试一次，不用先保存；不会改动已发现的供应商。',
      formProviderTestNoService: '宿主没有提供额度服务，无法测试。',
      formLabelLowThreshold: '低额度阈值',
      formHintLowThreshold: '余额低于这个数字时，卡片和概览会标红。',
      formLabelRefreshSeconds: '自动刷新间隔（秒）',
      formHintRefreshSeconds: '页面停留时的轮询间隔，最小 10 秒；宿主另有 20 秒缓存。',
      formLabelUsageDays: '用量图表天数',
      formHintUsageDays: '本机用量每天一根柱子的天数，3–60。',
      formLabelTimeoutMs: '查询超时（毫秒）',
      formHintTimeoutMs: '单个供应商接口的超时，最小 2000。',
      formLabelDeepseekBaseURL: 'DeepSeek 接口地址',
      formHintDeepseekBaseURL: '没有 llm-deepseek 行时用于查询官方余额，留空用 https://api.deepseek.com。',
      formLabelSkipHosts: '不探测的域名片段',
      formHintSkipHosts: '逗号分隔，追加在内置名单（anthropic、azure、gemini 等）之后；某个供应商想强制走通用探测，在它的定义里写 "adapter": "generic"。',
      formSave: '保存',
      formSaving: '保存中…',
      formReadOnly: '本部署的设置为只读。',
      formUnavailable: '该插件当前未加载，暂时无法配置。',
      formSaveFailed: '本部署没有接受这些值，已保留供你修改。',
      formOverridden: '已覆盖',
      formReset: '恢复默认',
      formInvalidNumber: '请填数字；留空表示使用默认值。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    }

    const en = {
      title: 'Provider quota board',
      summary: 'Balances, plan windows and token usage in one panel.',
      panel: 'Quota board',
      panelHint: 'Every configured model provider',
      loading: 'Reading quotas…',
      empty: 'No model provider was discovered.',
      emptyHint:
        'Add a provider under Settings → Models or in the profile’s llm-pi-ai row and it appears here automatically. The providers field in the config below also accepts manual entries.',
      actionRefresh: 'Refresh',
      actionRefreshing: 'Refreshing…',
      actionConfig: 'Configure',
      actionRetry: 'Retry',
      statProviders: 'Providers',
      statLow: 'Low balance',
      statTotal: 'Local total',
      statToday: 'Today',
      statTokensUnit: 'tokens',
      updatedAt: 'Updated {time}',
      cachedAt: 'Cached {time}',
      badgeOk: 'Healthy',
      badgeLow: 'Low',
      badgeError: 'Failed',
      badgeUnconfigured: 'Not configured',
      badgeUnsupported: 'No billing API',
      badgeDefault: 'Default',
      badgeFree: 'Keyless',
      labelBalance: 'Account balance',
      labelGranted: 'Granted',
      labelTopped: 'Topped up',
      labelRemaining: 'remaining',
      labelUsed: 'used',
      labelTotalUsed: 'Total spend',
      labelSoft: 'Soft limit',
      labelHard: 'Hard limit',
      labelPayment: 'Payment method',
      labelPaymentYes: 'Linked',
      labelPaymentNo: 'None',
      labelPlanExpires: 'expires {time}',
      labelPlanRecent: 'last 30 days',
      labelLocal: 'Local usage',
      labelSessionsUnit: '{n} sessions',
      labelKeyFrom: 'Credential from {v}',
      labelWalletFrom: 'Balance from {v}',
      walletAccount: 'your DeepSeek account (Settings → Account)',
      walletKey: 'the provider endpoint',
      keyCredential: 'the credentials service',
      keyLaunch: 'the launching environment',
      keyProcess: 'the process environment',
      keyAccount: 'your DeepSeek account',
      keyNone: 'nowhere',
      labelModelCount: '{n} models',
      labelBase: 'Endpoint',
      stateTitle: 'No balance to show yet',
      stateHint: 'Sign in to DeepSeek, or add an API key for this provider in the plugin settings.',
      unsupportedNote:
        'This platform offers no key-accessible balance or billing endpoint, so the card only reports local usage.',
      usageTitle: 'Local usage',
      usageNote:
        'Read from the session projection cache across all recorded sessions; the accounting may differ from the provider’s bill.',
      usageComposition: 'Token composition',
      usageInput: 'Input',
      usageCacheRead: 'Cache read',
      usageCacheWrite: 'Cache write',
      usageOutput: 'Output',
      usageTotal: 'Total',
      usageSessions: 'Sessions',
      usageActiveDays: 'Active days',
      usageRequests: 'Requests',
      usageAvgSession: 'Per session',
      usageModels: 'By model',
      usageDays: 'Last {n} days',
      usageRecent: 'Recent sessions',
      usageEmpty: 'No local usage recorded yet.',
      usageUntitled: 'Untitled session',
      usageTurns: '{n} turns',
      usagePressure: 'context {n}%',
      resetExpired: 'reset time reached',
      resetMinutes: 'resets in {n} min',
      resetHours: 'resets in {n} h',
      resetDays: 'resets in {n} d',
      errTitle: 'No quota data',
      errNoService: 'The Host exposes no quota service ({v}).',
      errServiceHint:
        'The plugin loaded but its service did not mount — usually a Harness build without the Typert remote capability. Restart the Harness, and if this persists report the message above to the plugin author.',
      errFailed: 'Request failed: {v}',
      errUnavailable: 'Not mounted yet; retrying shortly.',
      errNoMount: 'this Harness build has no $mount on remote.',
      errRefused: 'the Gateway refused the mount: {v}',
      errUnreadable: 'the service mounted, but namespace {v} is not readable.',
      errMissingMethod: 'the service mounted, but it has no {v} method.',
      formLabelProviders: 'Extra providers',
      formHintProviders: 'Adds to or overrides discovered providers. Leave it empty to just use whatever the profile already declares; add a row here to see a gateway the profile never mentions.',
      formLabelDefaultProvider: 'Default provider',
      formHintDefaultProvider: 'The sidebar button prints this provider\'s name and remaining quota. On "Auto", the profile\'s default provider is used.',
      formDefaultProviderAuto: 'Auto (follow the default provider)',
      formProviderAdd: 'Add provider',
      formProviderRemove: 'Remove',
      formProviderUntitled: 'Untitled provider',
      formProviderEmpty: 'No extra providers. Everything discovered from the model configuration already shows on the board; this list only adds or overrides.',
      formProviderEmptyManual: 'No entries added by hand. The ones above are enough — press "Override" on one to change how it is queried.',
      formProviderAdvanced: 'Advanced: protocol, auth header and field mapping',
      formProviderAdvancedCount: 'Advanced: protocol, auth header and field mapping ({n} set)',
      formProviderAuto: 'Auto-detect',
      formProviderBroken: 'This list could not be read; check the configuration.',
      formProviderId: 'ID',
      formProviderName: 'Display name',
      formProviderBaseURL: 'Base URL',
      formProviderKeyRef: 'Credential reference',
      formProviderAdapter: 'Adapter',
      formProviderApi: 'Protocol hint (api)',
      formProviderAuthHeader: 'Auth header',
      formProviderAuthPrefix: 'Auth prefix',
      formProviderEndpoint: 'Endpoint path',
      formProviderRemaining: 'Remaining field',
      formProviderUsed: 'Used field',
      formProviderUnit: 'Unit field',
      formProviderScale: 'Scale',
      formProviderDiscovered: 'From the model configuration ({n})',
      formProviderOverride: 'Override',
      formProviderUnbound: 'no endpoint bound',
      formProviderNoKey: 'no credential',
      formProviderCredentials: 'Volcengine account key pair (AK/SK)',
      formProviderAccessKeyRef: 'AccessKey reference',
      formProviderSecretKeyRef: 'SecretKey reference',
      formProviderAccessKey: 'AccessKey ID · {ref}',
      formProviderSecretKey: 'Secret Access Key · {ref}',
      formHintProviderAccessKey: 'Only for billing queries — an Ark API key cannot replace it. Stored in the credentials service, never in the settings file.',
      formHintProviderSecretKey: 'Pairs with the AccessKey. Stored in the credentials service, never in the settings file.',
      formProviderSecretPlaceholder: 'Paste the secret, then save',
      formProviderWrite: 'Save',
      formProviderWritten: 'Written to the credentials service',
      formProviderWriteFailed: 'Write failed — check the credentials service',
      formProviderTest: 'Test connection',
      formProviderTesting: 'Testing…',
      formProviderTestOk: 'Reachable · {value}',
      formProviderTestNoValue: 'Reachable, but no balance was found',
      formProviderTestUnsupported: 'Reachable, but this platform has no balance API',
      formProviderTestFailed: 'Unreachable · {reason}',
      formProviderTestVia: 'endpoint {endpoint}',
      formProviderTestPin: 'Pin this endpoint',
      formProviderTestPinned: 'Endpoint pinned to {endpoint}',
      formProviderTestHint: 'Probes the values above without saving first; discovered providers are left alone.',
      formProviderTestNoService: 'No board service in this Host, so it cannot be tested.',
      formLabelLowThreshold: 'Low-balance threshold',
      formHintLowThreshold: 'Balances below this number mark the card and the summary as low.',
      formLabelRefreshSeconds: 'Auto refresh (s)',
      formHintRefreshSeconds: 'Polling interval while the page is open, at least 10s; the Host also caches for 20s.',
      formLabelUsageDays: 'Usage chart days',
      formHintUsageDays: 'How many daily bars the local usage chart draws, 3–60.',
      formLabelTimeoutMs: 'Query timeout (ms)',
      formHintTimeoutMs: 'Per-provider request timeout, at least 2000.',
      formLabelDeepseekBaseURL: 'DeepSeek endpoint',
      formHintDeepseekBaseURL: 'Used for the official balance when no llm-deepseek row exists; blank means https://api.deepseek.com.',
      formLabelSkipHosts: 'Hosts not to probe',
      formHintSkipHosts: 'Comma separated, appended to the built-in list (anthropic, azure, gemini, …); to force the generic probe for one provider, add "adapter": "generic" to its definition.',
      formSave: 'Save',
      formSaving: 'Saving…',
      formReadOnly: 'This deployment stores settings read-only.',
      formUnavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      formSaveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      formOverridden: 'Overridden',
      formReset: 'Reset to default',
      formInvalidNumber: 'Enter a number, or leave blank to use the default.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    // -----------------------------------------------------------------------
    // formatting helpers
    // -----------------------------------------------------------------------

    /** Fill `{name}` placeholders. */
    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/gu, (match, name) =>
        vars !== null && vars !== undefined && name in vars ? String(vars[name]) : match,
      )
    }

    /** Compact token counts: 12.3K / 4.5M / 1.2B. */
    function compact(value) {
      const number = Number(value) || 0
      const abs = Math.abs(number)
      if (abs < 1000) return String(Math.round(number))
      const units = [
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
      ]
      for (const [size, suffix] of units) {
        if (abs >= size) {
          const scaled = number / size
          const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
          return `${scaled.toFixed(digits).replace(/\.0+$/u, '')}${suffix}`
        }
      }
      return String(Math.round(number))
    }

    /** Two-decimal money, without inventing digits for text amounts. */
    function money(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return String(value ?? '—')
      return number.toFixed(2)
    }

    /** `MM-DD HH:mm` in local time. */
    function dateTime(ms) {
      const date = new Date(Number(ms))
      if (!Number.isFinite(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** `HH:mm` in local time. */
    function clockTime(ms) {
      const date = new Date(Number(ms))
      if (!Number.isFinite(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Relative time until an ISO instant, in the reader's words. */
    function resetText(iso, t) {
      const at = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(at)) return null
      const diff = at - Date.now()
      if (diff <= 0) return t('resetExpired')
      const minutes = Math.max(1, Math.round(diff / 60_000))
      if (minutes < 60) return format(t('resetMinutes'), { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 48) return format(t('resetHours'), { n: hours })
      return format(t('resetDays'), { n: Math.round(hours / 24) })
    }

    /**
     * DeepSeek's own blue — the whale blue from the brand mark.
     *
     * The theme's `success` token is green, which reads as somebody else's brand
     * on a DeepSeek surface: a healthy, available window is DeepSeek blue here,
     * and only the warning states keep their amber/red.
     */
    const DS_BLUE = '#4d6bfe'

    /** The state colour of a bar, from what is left. */
    function levelColor(remainingPercent) {
      const value = Number(remainingPercent)
      if (!Number.isFinite(value)) return DS_BLUE
      if (value <= 10) return 'var(--dsw-alias-state-error-primary)'
      if (value <= 30) return 'var(--dsw-alias-state-warn-primary)'
      return DS_BLUE
    }

    // -----------------------------------------------------------------------
    // styles
    // -----------------------------------------------------------------------

    const CSS = `
.dqb_page{height:100%;overflow:auto;color:var(--dsw-alias-label-primary);box-sizing:border-box}
/* --- sidebar seat ------------------------------------------------------- */
.dqb_seat{display:flex;align-items:center;min-width:0;width:100%}
.dqb_seatBtn{display:flex;align-items:center;gap:7px;width:100%;min-width:0;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;text-align:left}
.dqb_seatBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dqb_seatBtn[aria-expanded="true"]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.dqb_seatLabel{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden}
.dqb_seatName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The number is the reason the seat exists, so it never gets ellipsized: the
   name gives way first. */
.dqb_seatQuota{flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dqb_seatCaret{flex:none;font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary)}
/* The popover is portaled to <body>: fixed would otherwise resolve against the
   sidebar's transformed ancestor and be clipped by its overflow. */
.dqb_pop{position:fixed;z-index:2147483000;width:min(460px,calc(100vw - 16px));max-height:min(78vh,720px);overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:14px 16px 16px;box-sizing:border-box;color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08)}
.dqb_popHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dqb_popTitles{display:flex;flex-direction:column;gap:2px;min-width:0}
.dqb_popTitle{font-size:14px;font-weight:600;line-height:20px}
.dqb_popSub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dqb_board{display:flex;flex-direction:column;gap:12px}
.dqb_iconBtn{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dqb_iconBtn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.dqb_iconBtn:disabled{opacity:.55;cursor:default}
.dqb_spin{animation:dqb-spin 1s linear infinite}
@keyframes dqb-spin{to{transform:rotate(360deg)}}
.dqb_inner{display:flex;flex-direction:column;gap:22px;padding:0 clamp(20px,4vw,40px) 56px;max-width:1120px;margin:0 auto}
.dqb_head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px}
[data-platform="darwin"] .dqb_head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dqb_title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dqb_sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dqb_actions{display:flex;gap:8px;align-items:center;flex:none}
.dqb_btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dqb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dqb_btn:disabled{opacity:.55;cursor:default}
.dqb_btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.dqb_btnPrimary:hover{background:var(--dsw-alias-button-primary-hover)}
.dqb_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dqb_stat{background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);padding:12px 14px;display:flex;flex-direction:column;gap:4px;min-width:0}
.dqb_statLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dqb_statValue{font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:4px}
.dqb_statUnit{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dqb_statWarn .dqb_statValue{color:var(--dsw-alias-state-error-primary)}
.dqb_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(318px,1fr));gap:12px;align-items:stretch}
.dqb_card{background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-width:0;height:100%;box-sizing:border-box;transition:border-color .15s ease}
.dqb_card:hover{border-color:var(--dsw-alias-border-l2)}
.dqb_cardHead{display:flex;align-items:center;gap:8px;min-width:0}
.dqb_name{font-size:14px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dqb_badges{display:flex;gap:5px;margin-left:auto;flex:none}
.dqb_badge{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;white-space:nowrap;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary)}
.dqb_badgeOk{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dqb_badgeWarn{color:var(--dsw-alias-state-warn-label);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.dqb_badgeErr{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dqb_bigRow{display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap;min-height:34px}
.dqb_big{font-size:30px;line-height:34px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.dqb_bigUnit{font-size:12.5px;color:var(--dsw-alias-label-secondary);padding-bottom:5px}
/* Kept next to the number: floating it to the far edge made "99%" look like it
   had no unit at all. */
.dqb_bigCap{font-size:11px;color:var(--dsw-alias-label-tertiary);padding-bottom:6px;text-align:left}
.dqb_state{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-fill-l1);border:1px dashed var(--dsw-alias-border-l2);min-height:62px;justify-content:center;box-sizing:border-box}
.dqb_stateTitle{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dqb_stateText{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dqb_stateErr{border-style:solid;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.dqb_stateErr .dqb_stateTitle{color:var(--dsw-alias-state-error-primary)}
.dqb_stateErr .dqb_stateText{color:var(--dsw-alias-label-secondary)}
.dqb_plans{display:flex;flex-direction:column;gap:9px;margin-top:2px}
.dqb_plan{display:flex;flex-direction:column;gap:4px}
.dqb_planHead{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:17px}
.dqb_planName{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dqb_planValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none}
.dqb_bar{height:6px;border-radius:999px;background:var(--dsw-alias-fill-l2);overflow:hidden;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.dqb_barFill{height:100%;border-radius:999px;transition:width .2s ease}
.dqb_planMeta{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dqb_planMeta>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dqb_meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;margin-top:auto}
/* One fact per line, and a line is never broken mid-word: Chinese has no spaces,
   so a shrinking span used to stack one character per line ("本机用/量"). */
.dqb_meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dqb_meta b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dqb_note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dqb_err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dqb_warnNote{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);word-break:break-word}
.dqb_empty{display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.dqb_emptyTitle{font-size:14px;font-weight:500}
.dqb_emptyText{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}
.dqb_sectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:4px}
/* The hint gives way, not the title: a flex item may shrink to one character,
   which turned "本机用量" into a vertical stack instead of a heading. */
.dqb_sectionTitle{font-size:14px;font-weight:600;flex:none;white-space:nowrap}
.dqb_sectionHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.dqb_usageGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:stretch}
.dqb_stack{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-fill-l2)}
.dqb_legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.dqb_legendItem{display:inline-flex;align-items:center;gap:5px}
.dqb_swatch{width:8px;height:8px;border-radius:2px;flex:none}
.dqb_swatchInput{background:#3b82f6}
.dqb_swatchCacheRead{background:#22c55e}
.dqb_swatchCacheWrite{background:#eab308}
.dqb_swatchOutput{background:#a855f7}
.dqb_legendItem b{font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dqb_row{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:18px}
/* Wallet figures sit side by side and fill the card's width, so a provider
   with only a balance does not look half empty next to one with four windows. */
.dqb_rowGrid{display:grid;grid-template-columns:1fr;gap:6px}
.dqb_rowGridTwo{grid-template-columns:1fr 1fr}
.dqb_rowGrid .dqb_row{flex-direction:column;align-items:flex-start;gap:1px;background:var(--dsw-alias-fill-l1);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 10px;box-sizing:border-box}
.dqb_rowGrid .dqb_rowLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:100%}
.dqb_rowGrid .dqb_rowValue{font-size:13.5px;font-weight:500;line-height:19px}
.dqb_rowLabel{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dqb_rowValue{font-variant-numeric:tabular-nums;flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dqb_rowValueNeg{color:var(--dsw-alias-state-error-primary)}
.dqb_modelRow{display:flex;flex-direction:column;gap:4px;margin-bottom:7px}
.dqb_chart{display:flex;align-items:flex-end;gap:4px;height:96px;padding-top:4px}
.dqb_dayCol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;min-width:0;height:100%}
.dqb_dayBar{width:100%;max-width:26px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);min-height:2px}
.dqb_dayBarToday{background:var(--dsw-alias-brand-primary)}
.dqb_dayLabel{font-size:9.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dqb_sessionList{display:flex;flex-direction:column;gap:1px}
.dqb_session{display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;min-width:0}
.dqb_session:last-child{border-bottom:0}
.dqb_sessionTitle{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dqb_sessionMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dqb_sessionTokens{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:52px;text-align:right}
.dqb_form{display:flex;flex-direction:column;gap:2px}
.dqb_footer{margin:14px 0 8px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dqb_plist{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.dqb_pfieldHead{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.dqb_pfieldHead .dqb_plabel{font-size:12px;line-height:17px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dqb_pover{font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dqb_pcard{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-fill-l1);display:flex;flex-direction:column;gap:8px}
.dqb_phead{display:flex;align-items:center;gap:8px;min-width:0}
.dqb_pindex{flex:none;font-size:10.5px;line-height:16px;min-width:16px;text-align:center;border-radius:4px;padding:0 4px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dqb_ptitle{flex:1;min-width:0;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dqb_ptitleEmpty{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dqb_pdel{flex:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11.5px;font-family:inherit;padding:3px 7px;border-radius:5px;line-height:1}
.dqb_pdel:hover{background:var(--dsw-alias-fill-l2);color:#dc2626}
.dqb_pgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dqb_pcell{display:flex;flex-direction:column;gap:3px;min-width:0}
.dqb_pcellWide{grid-column:1/-1}
.dqb_plabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dqb_pinput,.dqb_pselect{height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;padding:0 8px;min-width:0;width:100%}
.dqb_pinput:focus,.dqb_pselect:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dqb_pinput:disabled,.dqb_pselect:disabled{opacity:.55;cursor:not-allowed}
.dqb_padd{align-self:flex-start;height:28px;padding:0 12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:7px;background:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer}
.dqb_padd:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dqb_padd:disabled{opacity:.55;cursor:not-allowed}
.dqb_pempty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dqb_pdiscovered{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border:1px dashed var(--dsw-alias-border-l1);border-radius:9px;margin-bottom:2px}
.dqb_peer{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dqb_peerName{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dqb_peerMeta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dqb_peeredit{flex:none;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:none;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer}
.dqb_peeredit:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dqb_peeredit:disabled{opacity:.5;cursor:not-allowed}
.dqb_pcreds{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-fill-l2)}
.dqb_psecret{display:flex;gap:6px;align-items:center}
.dqb_psecret .dqb_pinput{flex:1;min-width:0}
.dqb_psave{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:inherit;cursor:pointer}
.dqb_psave:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dqb_psave:disabled{opacity:.5;cursor:not-allowed}
.dqb_ptest{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.dqb_ptestRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dqb_ptestOut{font-size:11.5px;line-height:17px;min-width:0;overflow-wrap:anywhere}
.dqb_ptest .dqb_phint{margin:0}
.dqb_pok{color:#16a34a}
.dqb_perr{color:#dc2626}
.dqb_plink{border:0;background:none;padding:0;margin-left:4px;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer;text-decoration:underline}
.dqb_pmore{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dqb_pmore>summary{cursor:pointer;padding:1px 0;list-style-position:inside;color:var(--dsw-alias-label-secondary)}
.dqb_pmore[open]>summary{margin-bottom:7px}
.dqb_phint{margin:6px 0 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dqb_perror{margin:4px 0 0;font-size:11.5px;line-height:17px;color:#dc2626}
@media (max-width:600px){.dqb_pgrid{grid-template-columns:1fr}}
`

    /** Register the stylesheet once; the returned disposer removes it. */
    function installStyles() {
      const tagId = `${PKG_NAME}/board.css`
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG_NAME
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // -----------------------------------------------------------------------
    // remote wiring
    // -----------------------------------------------------------------------

    /** Mount outcome, so a missing service is reported by cause. */
    const mountState = { status: 'pending', reason: null }

    /**
     * The mounted namespace, or undefined. A Remote namespace is a child service
     * of `remote`, reachable by property or dotted key; reading an unmounted one
     * can throw, so both paths are guarded.
     */
    function boardOf(ctx) {
      try {
        const direct = ctx.remote?.[NAMESPACE]
        if (direct !== undefined && direct !== null) return direct
      } catch {
        /* not mounted as a reachable property */
      }
      try {
        return ctx.get(`remote.${NAMESPACE}`)
      } catch {
        return undefined
      }
    }

    function describeFailure(error) {
      if (error instanceof Error) return String(error.message)
      if (error !== null && typeof error === 'object') {
        const code = error.code
        const message = error.message
        if (typeof message === 'string' && message.length > 0) {
          return typeof code === 'string' ? `${code}: ${message}` : message
        }
        try {
          return JSON.stringify(error).slice(0, 300)
        } catch {
          return Object.prototype.toString.call(error)
        }
      }
      return String(error)
    }

    /** Mount the Host-for-Client service, keeping the page alive when refused. */
    function mountService(ctx) {
      if (typeof ctx.remote?.$mount !== 'function') {
        mountState.status = 'unsupported'
        return
      }
      let dispose
      let disposed = false
      Promise.resolve()
        .then(() => ctx.remote.$mount(CONTRIBUTION))
        .then((unmount) => {
          if (disposed) {
            try {
              unmount?.()
            } catch {
              /* already gone */
            }
            return
          }
          dispose = unmount
          mountState.status = 'mounted'
          mountState.reason = null
        })
        .catch((error) => {
          mountState.status = 'refused'
          mountState.reason = describeFailure(error)
        })
      ctx.effect(
        () => () => {
          disposed = true
          try {
            dispose?.()
          } catch {
            /* unmounted with its fiber */
          }
        },
        'dsh-quota-board: service unmount',
      )
    }

    /** Why the service is not callable, from the four outcomes the page can see. */
    function serviceAbsence(ctx) {
      if (mountState.status === 'unsupported') return { cause: 'unsupported' }
      if (mountState.status === 'refused') return { cause: 'refused', message: mountState.reason }
      if (mountState.status === 'mounted') {
        const board = boardOf(ctx)
        if (board === undefined || board === null) return { cause: 'unreadable', message: NAMESPACE }
        return { cause: 'missing-method', message: METHOD }
      }
      return { cause: 'pending' }
    }

    /**
     * Run one board load.
     * @returns `{ ok: true, data }` or `{ ok: false, reason, absence }`; never rejects.
     */
    async function loadBoard(ctx, force) {
      const board = boardOf(ctx)
      if (board === undefined || board === null || typeof board[METHOD] !== 'function') {
        return { ok: false, absence: serviceAbsence(ctx) }
      }
      let answer
      try {
        answer = await board[METHOD](force === true)
      } catch (error) {
        return { ok: false, reason: describeFailure(error) }
      }
      if (answer?.ok !== true) {
        return { ok: false, reason: String(answer?.error?.message ?? 'unreachable') }
      }
      return { ok: true, data: answer.value ?? null }
    }

    /**
     * Probe one unsaved provider entry.
     *
     * Same envelope as `loadBoard`, but a refusal has one more layer: the Host
     * answers `{ ok: true, value: { ok: false, reason } }` when the entry itself
     * cannot be called (no base URL), and that reason is more useful than
     * "unreachable".
     *
     * @returns `{ ok: true, data }` or `{ ok: false, reason, absence }`; never rejects.
     */
    async function testConnection(ctx, entry) {
      const board = boardOf(ctx)
      if (board === undefined || board === null || typeof board[METHOD_TEST] !== 'function') {
        return { ok: false, absence: serviceAbsence(ctx) }
      }
      let answer
      try {
        answer = await board[METHOD_TEST](entry)
      } catch (error) {
        return { ok: false, reason: describeFailure(error) }
      }
      if (answer?.ok !== true) {
        return { ok: false, reason: String(answer?.error?.message ?? 'unreachable') }
      }
      const data = answer.value ?? null
      if (data === null || data.ok !== true) {
        return { ok: false, reason: String(data?.reason ?? 'unreachable') }
      }
      return { ok: true, data }
    }

    // -----------------------------------------------------------------------
    // page pieces
    // -----------------------------------------------------------------------

    /** Small state pill. */
    function badge(text, kind) {
      const cls = kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : kind === 'err' ? ' err' : ''
      return h('span', { className: `dqb_badge${cls}`, key: `badge-${text}` }, text)
    }

    /** Status badge for one provider, in the same order the Host flags them. */
    function providerBadge(provider, t) {
      if (provider.kind === 'unsupported') return badge(t('badgeUnsupported'), 'muted')
      if (!provider.configured) return badge(t('badgeUnconfigured'), 'warn')
      if (provider.error !== null && provider.error !== undefined) return badge(t('badgeError'), 'err')
      if (provider.low === true) return badge(t('badgeLow'), 'warn')
      return badge(t('badgeOk'), 'ok')
    }

    /** The big number and its caption for one provider. */
    function headline(provider, t) {
      const plans = Array.isArray(provider.plans) ? provider.plans : []
      const plan = plans[0] ?? null
      // A quota window is answered as "how much is left" everywhere else on the
      // card, so the headline follows the same reading. Printing the consumed
      // share here made the big number mean the opposite of the rows below it.
      if (plan !== null && plan.unit === '%' && Number.isFinite(Number(plan.used))) {
        const left = Math.max(0, Math.min(100, 100 - Math.round(Number(plan.used))))
        return { value: `${left}`, unit: '%', caption: t('labelRemaining'), plan }
      }
      if (plan !== null && Number.isFinite(Number(plan.remaining))) {
        return { value: money(plan.remaining), unit: plan.unit ?? '', caption: plan.name, plan }
      }
      if (provider.balance !== null && provider.balance !== undefined) {
        return {
          value: String(provider.balance.total),
          unit: provider.balance.currency ?? '',
          caption: '',
          plan: null,
        }
      }
      if (provider.usage !== null && provider.usage !== undefined) {
        if (Number.isFinite(Number(provider.usage.remaining))) {
          return {
            value: String(provider.usage.remaining),
            unit: provider.usage.unit ?? 'USD',
            caption: t('labelRemaining'),
            plan: null,
          }
        }
        if (Number.isFinite(Number(provider.usage.totalUsageUsd))) {
          return { value: `$${money(provider.usage.totalUsageUsd)}`, unit: '', caption: t('labelTotalUsed'), plan: null }
        }
      }
      return { value: '—', unit: '', caption: '', plan: null }
    }

    /** One plan row: name, used bar, remaining and reset. */
    function planRow(plan, t) {
      const percent = Number(plan.percent)
      const used = Number.isFinite(percent)
        ? Math.min(100, Math.max(0, percent))
        : plan.total !== null && plan.total !== undefined && Number(plan.total) > 0 && Number.isFinite(Number(plan.used))
          ? Math.min(100, Math.max(0, (Number(plan.used) / Number(plan.total)) * 100))
          : null
      const isQuota = plan.unit === '%'
      const usedPercent = used === null ? null : Math.round(used)
      // A quota window is read as "how much is left", so the remaining share
      // takes both the headline slot and the bar. Drawing the consumed 1% made
      // a healthy window look empty — the bar could not even be seen.
      const leftPercent = usedPercent === null ? null : 100 - usedPercent
      // A quota window is read as "how much is left", so the remaining share
      // takes the headline slot and the consumed share moves to the meta line.
      const valueText =
        usedPercent !== null && isQuota
          ? `${t('labelRemaining')} ${100 - usedPercent}%`
          : isQuota
            ? `${Math.round(Number(plan.used) || 0)}% ${t('labelUsed')}`
            : `${t('labelRemaining')} ${money(plan.remaining)}${plan.unit ? ` ${plan.unit}` : ''}`
      const reset = resetText(plan.resetAt ?? plan.expiresAt, t)
      const recent =
        Number.isFinite(Number(plan.periodUsage)) && Number(plan.periodUsage) > 0
          ? `${t('labelPlanRecent')} ${money(plan.periodUsage)}${plan.unit && plan.unit !== '%' ? ` ${plan.unit}` : ''}`
          : null
      // For a quota window the headline and the bar already say how much is
      // left, so the meta line keeps only the reset time. A spend-based plan has
      // no bar of its own and keeps the used figure.
      const metaLeft = [
        !isQuota && usedPercent !== null ? `${t('labelUsed')} ${usedPercent}%` : null,
        reset,
      ]
        .filter((part) => part !== null)
        .join(' · ')
      return h('div', { className: 'dqb_plan', key: `plan-${plan.id}` }, [
        h('div', { className: 'dqb_planHead', key: 'head' }, [
          h('span', { className: 'dqb_planName', key: 'name', title: plan.product ?? plan.name }, plan.name),
          h('span', { className: 'dqb_planValue', key: 'value' }, valueText),
        ]),
        used === null
          ? null
          : h('div', { className: 'dqb_bar', key: 'bar', title: `${t('labelRemaining')} ${leftPercent}%` }, [
              h('div', {
                className: 'dqb_barFill',
                key: 'fill',
                style: { width: `${leftPercent}%`, background: levelColor(leftPercent) },
              }),
            ]),
        h('div', { className: 'dqb_planMeta', key: 'meta' }, [
          h('span', { key: 'left' }, metaLeft),
          h('span', { key: 'right' }, recent ?? ''),
        ]),
      ])
    }

    /**
     * The card body when the provider has nothing to report.
     *
     * A bare em dash over a raw error line read like a crash; this says what is
     * missing and what would fix it, in the card's own voice.
     */
    function stateBlock(provider, t) {
      // Only a provider that has what it needs can "fail". A card that was never
      // configured is not an error, and painting it red says otherwise.
      const failed = provider.configured === true && provider.error !== null && provider.error !== undefined
      const text = provider.error ?? provider.note ?? t('stateHint')
      return h('div', { className: `dqb_state${failed ? ' dqb_stateErr' : ''}`, key: 'state' }, [
        h('span', { className: 'dqb_stateTitle', key: 't' }, t('stateTitle')),
        h('p', { className: 'dqb_stateText', key: 'x' }, text),
      ])
    }

    /**
     * The provider the sidebar seat speaks for.
     *
     * `preferred` is the id chosen in settings. When it is empty — or names a
     * provider the report no longer has, which happens after renaming one — the
     * profile's own default wins, then the first configured provider. An empty
     * report simply yields null and the button falls back to its own name.
     */
    function seatProvider(providers, preferred) {
      const list = Array.isArray(providers) ? providers : []
      const id = String(preferred ?? '').trim()
      if (id.length > 0) {
        const named = list.find((provider) => String(provider?.id ?? '') === id)
        if (named !== undefined) return named
      }
      return (
        list.find((provider) => provider?.isDefault === true && provider?.configured !== false) ??
        list.find((provider) => provider?.configured === true && provider?.error == null) ??
        list.find((provider) => provider?.configured === true) ??
        list[0] ??
        null
      )
    }

    /**
     * The two things the seat prints: who, and how much is left.
     *
     * The number is the same one the card's headline shows, so the button can
     * never disagree with the popover it opens.
     */
    function seatSummary(provider, t) {
      if (provider === null || provider === undefined) return null
      const head = headline(provider, t)
      const unit = String(head.unit ?? '')
      const quota =
        head.value === '—' ? '' : `${head.value}${unit === '%' ? '%' : unit.length > 0 ? ` ${unit}` : ''}`
      // Only a quota window has a "how full" colour; money keeps the muted tone.
      const color = head.plan !== null && head.plan.unit === '%' ? levelColor(Number(head.value)) : null
      return { name: String(provider.displayName ?? provider.id ?? ''), quota, color }
    }

    /** One provider card. */
    function providerCard(provider, t) {
      const planSource = Array.isArray(provider.plans) ? provider.plans : []
      const plans = planSource.slice(0, 3)
      const head = headline(provider, t)
      const meta = []
      if (provider.baseURL) meta.push(h('span', { key: 'base' }, [h('b', { key: 'b' }, t('labelBase')), ` ${provider.baseURL}`]))
      if (provider.balanceSource === 'account') {
        // The account wallet needs no key, so printing "no key found" here would
        // contradict the balance shown right above it.
        meta.push(h('span', { key: 'wallet' }, format(t('labelWalletFrom'), { v: t('walletAccount') })))
      } else if (provider.keyRef) {
        const sourceKey =
          provider.keySource === 'credential'
            ? 'keyCredential'
            : provider.keySource === 'launch'
              ? 'keyLaunch'
              : provider.keySource === 'process'
                ? 'keyProcess'
                : 'keyNone'
        meta.push(
          h('span', { key: 'key' }, format(t('labelKeyFrom'), { v: `${t(sourceKey)}${provider.keyRef ? ` (${provider.keyRef})` : ''}` })),
        )
      }
      if (provider.local !== null && provider.local !== undefined) {
        meta.push(
          h('span', { key: 'local' }, [
            h('b', { key: 'b' }, t('labelLocal')),
            ` ${compact(provider.local.tokens.total)} tokens · `,
            format(t('labelSessionsUnit'), { n: provider.local.sessions }),
          ]),
        )
      }

      const subRows = []
      if (provider.balance !== null && provider.balance !== undefined) {
        const currency = provider.balance.currency ?? ''
        const walletRow = (key, label, amount) => {
          const text = String(amount ?? '').trim()
          // A zero or missing wallet is noise: the headline already carries the
          // total. Only a real number earns a row.
          if (text.length === 0 || text === '—') return null
          const value = Number(text)
          if (Number.isFinite(value) && value === 0) return null
          return h('div', { className: 'dqb_row', key }, [
            h('span', { className: 'dqb_rowLabel', key: 'l' }, label),
            h(
              'span',
              { className: `dqb_rowValue${Number.isFinite(value) && value < 0 ? ' dqb_rowValueNeg' : ''}`, key: 'v' },
              `${text} ${currency}`.trim(),
            ),
          ])
        }
        subRows.push(
          walletRow('topped', t('labelTopped'), provider.balance.toppedUp),
          walletRow('granted', t('labelGranted'), provider.balance.granted),
        )
      }
      if (provider.usage !== null && provider.usage !== undefined) {
        if (Number.isFinite(Number(provider.usage.softLimitUsd)) || Number.isFinite(Number(provider.usage.hardLimitUsd))) {
          subRows.push(
            h('div', { className: 'dqb_row', key: 'limits' }, [
              h('span', { className: 'dqb_rowLabel', key: 'l' }, `${t('labelSoft')} / ${t('labelHard')}`),
              h(
                'span',
                { className: 'dqb_rowValue', key: 'v' },
                `${Number.isFinite(Number(provider.usage.softLimitUsd)) ? money(provider.usage.softLimitUsd) : '—'} / ${Number.isFinite(Number(provider.usage.hardLimitUsd)) ? money(provider.usage.hardLimitUsd) : '—'}`,
              ),
            ]),
          )
        }
        if (provider.usage.hasPaymentMethod !== null && provider.usage.hasPaymentMethod !== undefined) {
          subRows.push(
            h('div', { className: 'dqb_row', key: 'payment' }, [
              h('span', { className: 'dqb_rowLabel', key: 'l' }, t('labelPayment')),
              h('span', { className: 'dqb_rowValue', key: 'v' }, provider.usage.hasPaymentMethod ? t('labelPaymentYes') : t('labelPaymentNo')),
            ]),
          )
        }
      }

      // Nothing measured yet: print a short explanation instead of a lone dash.
      const hasData =
        (provider.balance !== null && provider.balance !== undefined) ||
        (provider.usage !== null && provider.usage !== undefined) ||
        planSource.length > 0
      const rows = subRows.filter((row) => row !== null && row !== undefined)

      return h('div', { className: 'dqb_card', key: provider.id }, [
        h('div', { className: 'dqb_cardHead', key: 'head' }, [
          h('span', { className: 'dqb_name', key: 'name', title: provider.displayName }, provider.displayName),
          h('div', { className: 'dqb_badges', key: 'badges' }, [
            provider.isDefault === true ? badge(t('badgeDefault'), 'muted') : null,
            providerBadge(provider, t),
          ]),
        ]),
        hasData
          ? h('div', { className: 'dqb_bigRow', key: 'big' }, [
              h('span', { className: 'dqb_big', key: 'v' }, head.value),
              head.unit ? h('span', { className: 'dqb_bigUnit', key: 'u' }, head.unit) : null,
              head.caption ? h('span', { className: 'dqb_bigCap', key: 'c' }, head.caption) : null,
            ])
          : stateBlock(provider, t),
        rows.length > 0 ? h('div', { className: `dqb_rowGrid${rows.length > 1 ? ' dqb_rowGridTwo' : ''}`, key: 'sub' }, rows) : null,
        plans.length > 0 ? h('div', { className: 'dqb_plans', key: 'plans' }, plans.map((plan) => planRow(plan, t))) : null,
        planSource.length > plans.length
          ? h('div', { className: 'dqb_note', key: 'more' }, `+${planSource.length - plans.length}`)
          : null,
        provider.kind === 'unsupported' && provider.note ? h('div', { className: 'dqb_note', key: 'note' }, t('unsupportedNote')) : null,
        hasData && provider.note !== null && provider.note !== undefined && provider.kind !== 'unsupported'
          ? h('div', { className: 'dqb_note', key: 'note2' }, provider.note)
          : null,
        hasData && provider.error !== null && provider.error !== undefined
          ? h('div', { className: 'dqb_err', key: 'err' }, provider.error)
          : null,
        meta.length > 0 ? h('div', { className: 'dqb_meta', key: 'meta' }, meta) : null,
      ])
    }

    /** One stat block. */
    function statBlock(label, value, unit, warn) {
      return h('div', { className: `dqb_stat${warn === true ? ' dqb_statWarn' : ''}`, key: `stat-${label}` }, [
        h('span', { className: 'dqb_statLabel', key: 'l' }, label),
        h('span', { className: 'dqb_statValue', key: 'v' }, [
          String(value),
          unit ? h('span', { className: 'dqb_statUnit', key: 'u' }, unit) : null,
        ]),
      ])
    }

    /** Token composition bar and legend. */
    function composition(tokens, t) {
      const parts = [
        { key: 'input', label: t('usageInput'), value: Number(tokens?.input) || 0, cls: 'dqb_swatchInput' },
        { key: 'cacheRead', label: t('usageCacheRead'), value: Number(tokens?.cacheRead) || 0, cls: 'dqb_swatchCacheRead' },
        { key: 'cacheWrite', label: t('usageCacheWrite'), value: Number(tokens?.cacheWrite) || 0, cls: 'dqb_swatchCacheWrite' },
        { key: 'output', label: t('usageOutput'), value: Number(tokens?.output) || 0, cls: 'dqb_swatchOutput' },
      ]
      const total = Number(tokens?.total) || parts.reduce((sum, part) => sum + part.value, 0)
      return h('div', { key: 'composition' }, [
        h(
          'div',
          { className: 'dqb_stack', key: 'stack' },
          parts
            .filter((part) => part.value > 0)
            .map((part) =>
              h('span', {
                key: part.key,
                className: part.cls,
                style: { width: `${total > 0 ? (100 * part.value) / total : 0}%`, background: swatchColor(part.key) },
                title: `${part.label}: ${compact(part.value)}`,
              }),
            ),
        ),
        h(
          'div',
          { className: 'dqb_legend', key: 'legend' },
          parts.map((part) =>
            h('span', { className: 'dqb_legendItem', key: part.key }, [
              h('i', { className: `dqb_swatch ${part.cls}`, key: 'i', 'aria-hidden': 'true' }),
              h('span', { key: 'l' }, part.label),
              h('b', { key: 'v' }, compact(part.value)),
            ]),
          ),
        ),
      ])
    }

    function swatchColor(key) {
      if (key === 'input') return '#3b82f6'
      if (key === 'cacheRead') return '#22c55e'
      if (key === 'cacheWrite') return '#eab308'
      return '#a855f7'
    }

    /** Daily bars; the tallest day defines the scale. */
    function dayChart(usage, t) {
      const days = Array.isArray(usage.byDay) ? usage.byDay : []
      const max = days.reduce((value, day) => Math.max(value, Number(day.total) || 0), 0)
      const todayKey = (() => {
        const date = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      })()
      return h(
        'div',
        { className: 'dqb_chart', key: 'chart' },
        days.map((day) => {
          const total = Number(day.total) || 0
          const height = max > 0 ? Math.max(total > 0 ? 3 : 1.5, (100 * total) / max) : 1.5
          return h('div', { className: 'dqb_dayCol', key: day.date, title: `${day.date} · ${compact(total)} tokens` }, [
            h('div', {
              className: `dqb_dayBar${day.date === todayKey ? ' dqb_dayBarToday' : ''}`,
              key: 'bar',
              style: { height: `${height}%` },
            }),
            h('span', { className: 'dqb_dayLabel', key: 'label' }, day.date.slice(5)),
          ])
        }),
      )
    }

    /** The whole local-usage section. */
    function usageSection(usage, t) {
      if (usage === null || usage === undefined) return null
      if (usage.available !== true || Number(usage.totals?.total) <= 0) {
        return h('div', { className: 'dqb_card', key: 'usage' }, h('div', { className: 'dqb_note' }, t('usageEmpty')))
      }
      const totals = usage.totals
      const average = usage.counts?.sessions > 0 ? totals.total / usage.counts.sessions : null
      const models = Array.isArray(usage.byModel) ? usage.byModel.slice(0, 6) : []
      const maxModel = models.reduce((value, row) => Math.max(value, Number(row.tokens?.total) || 0), 0)

      return h('div', { key: 'usage' }, [
        h('div', { className: 'dqb_sectionHead', key: 'head' }, [
          h('span', { className: 'dqb_sectionTitle', key: 'title' }, t('usageTitle')),
          h('span', { className: 'dqb_sectionHint', key: 'hint' }, t('usageNote')),
        ]),
        h('div', { className: 'dqb_usageGrid', key: 'grid', style: { marginTop: '10px' } }, [
          h('div', { className: 'dqb_card', key: 'comp' }, [
            h('div', { className: 'dqb_row', key: 'head' }, [
              h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageComposition')),
              h('span', { className: 'dqb_rowValue', key: 'v' }, `${compact(totals.total)} tokens`),
            ]),
            composition(totals, t),
            h('div', { className: 'dqb_plans', key: 'stats', style: { marginTop: '10px' } }, [
              h('div', { className: 'dqb_row', key: 'sessions' }, [
                h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageSessions')),
                h('span', { className: 'dqb_rowValue', key: 'v' }, String(usage.counts?.sessions ?? 0)),
              ]),
              h('div', { className: 'dqb_row', key: 'days' }, [
                h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageActiveDays')),
                h('span', { className: 'dqb_rowValue', key: 'v' }, String(usage.counts?.activeDays ?? 0)),
              ]),
              h('div', { className: 'dqb_row', key: 'requests' }, [
                h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageRequests')),
                h('span', { className: 'dqb_rowValue', key: 'v' }, compact(totals.requests)),
              ]),
              h('div', { className: 'dqb_row', key: 'avg' }, [
                h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageAvgSession')),
                h('span', { className: 'dqb_rowValue', key: 'v' }, average === null ? '—' : `${compact(average)} tokens`),
              ]),
            ]),
          ]),
          h('div', { className: 'dqb_card', key: 'models' }, [
            h('div', { className: 'dqb_row', key: 'head' }, [
              h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageModels')),
              h('span', { className: 'dqb_rowValue', key: 'v' }, compact(totals.total)),
            ]),
            h(
              'div',
              { key: 'rows' },
              models.map((row) =>
                h('div', { className: 'dqb_modelRow', key: row.model }, [
                  h('div', { className: 'dqb_row', key: 'row' }, [
                    h('span', { className: 'dqb_rowLabel', key: 'l', title: row.model }, row.model),
                    h('span', { className: 'dqb_rowValue', key: 'v' }, compact(row.tokens.total)),
                  ]),
                  h('div', { className: 'dqb_bar', key: 'bar' }, [
                    h('div', {
                      className: 'dqb_barFill',
                      key: 'fill',
                      style: {
                        width: maxModel > 0 ? `${Math.max(2, (100 * row.tokens.total) / maxModel)}%` : '0%',
                        background: 'var(--dsw-alias-brand-primary)',
                      },
                    }),
                  ]),
                ]),
              ),
            ),
          ]),
        ]),
        h('div', { className: 'dqb_card', key: 'days', style: { marginTop: '12px' } }, [
          h('div', { className: 'dqb_row', key: 'head' }, [
            h('span', { className: 'dqb_rowLabel', key: 'l' }, format(t('usageDays'), { n: usage.days ?? 14 })),
            h('span', { className: 'dqb_rowValue', key: 'v' }, `↑ ${compact(usage.today ?? 0)} tokens`),
          ]),
          dayChart(usage, t),
        ]),
        Array.isArray(usage.sessions) && usage.sessions.length > 0
          ? h('div', { className: 'dqb_card', key: 'sessions', style: { marginTop: '12px' } }, [
              h('div', { className: 'dqb_row', key: 'head' }, [
                h('span', { className: 'dqb_rowLabel', key: 'l' }, t('usageRecent')),
                h('span', { className: 'dqb_rowValue', key: 'v' }, ''),
              ]),
              h(
                'div',
                { className: 'dqb_sessionList', key: 'list' },
                usage.sessions.map((session) =>
                  h('div', { className: 'dqb_session', key: session.id }, [
                    h('span', { className: 'dqb_sessionTitle', key: 'title', title: session.title ?? '' },
                      session.title ?? t('usageUntitled')),
                    h('span', { className: 'dqb_sessionMeta', key: 'meta' }, [
                      session.model ?? '',
                      session.turns ? ` · ${format(t('usageTurns'), { n: session.turns })}` : '',
                      ` · ${dateTime(session.createdAt)}`,
                    ].join('')),
                    h('span', { className: 'dqb_sessionTokens', key: 'tokens' }, compact(session.tokens?.total)),
                  ]),
                ),
              ),
            ])
          : null,
      ])
    }

    /** The failure card: names the cause instead of blaming the Host. */
    function failureCard(failure, t, retry) {
      const absence = failure?.absence ?? null
      let message
      if (failure?.reason !== undefined) message = format(t('errFailed'), { v: failure.reason })
      else if (absence === null) message = t('errUnavailable')
      else if (absence.cause === 'unsupported') message = format(t('errNoService'), { v: t('errNoMount') })
      else if (absence.cause === 'refused') message = format(t('errRefused'), { v: absence.message })
      else if (absence.cause === 'unreadable') message = format(t('errUnreadable'), { v: absence.message })
      else if (absence.cause === 'missing-method') message = format(t('errMissingMethod'), { v: absence.message })
      else message = t('errUnavailable')
      return h('div', { className: 'dqb_card' }, [
        h('div', { className: 'dqb_emptyTitle', key: 'title' }, t('errTitle')),
        h('p', { className: 'dqb_emptyText', key: 'message' }, message),
        h('p', { className: 'dqb_emptyText', key: 'hint' }, t('errServiceHint')),
        h('button', { type: 'button', className: 'dqb_btn', key: 'retry', onClick: retry }, t('actionRetry')),
      ])
    }

    // -----------------------------------------------------------------------
    // the page
    // -----------------------------------------------------------------------

    /**
     * The board body: header, stats, provider cards and local usage.
     *
     * Pure rendering — the seat owns loading, polling and placement, so the same
     * markup can sit in the sidebar popover without a second fetch path.
     */
    function BoardContent(props) {
      const t = props.t
      const report = props.report ?? null
      const failure = props.failure ?? null
      const busy = props.busy === true
      const refresh = props.refresh
      const openConfig = props.openConfig

      const providers = Array.isArray(report?.providers) ? report.providers : []
      const counts = report?.counts ?? { providers: 0, configured: 0, low: 0 }
      const usage = report?.usage ?? null
      const time = report?.generatedAt ? clockTime(report.generatedAt) : null
      const subtitle =
        time === null
          ? t('summary')
          : `${t('summary')} · ${format(t(report?.cached === true ? 'cachedAt' : 'updatedAt'), { time })}`

      const header = h('div', { className: 'dqb_popHead', key: 'head' }, [
        h('div', { className: 'dqb_popTitles', key: 'titles' }, [
          h('span', { className: 'dqb_popTitle', key: 'title' }, t('title')),
          h('span', { className: 'dqb_popSub', key: 'sub' }, subtitle),
        ]),
        h('div', { className: 'dqb_actions', key: 'actions' }, [
          h(
            'button',
            {
              type: 'button',
              className: 'dqb_iconBtn',
              key: 'refresh',
              disabled: busy,
              title: busy ? t('actionRefreshing') : t('actionRefresh'),
              'aria-label': busy ? t('actionRefreshing') : t('actionRefresh'),
              onClick: () => refresh(true),
            },
            h(RefreshGlyph, { key: 'g', size: 15, spinning: busy }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dqb_iconBtn',
              key: 'config',
              title: t('actionConfig'),
              'aria-label': t('actionConfig'),
              onClick: () => openConfig(),
            },
            h(GearGlyph, { key: 'g', size: 15 }),
          ),
        ]),
      ])

      if (report === null && failure === null) {
        return h('div', { className: 'dqb_board' }, [
          header,
          h('div', { className: 'dqb_note', key: 'loading' }, t('loading')),
        ])
      }

      if (report === null) {
        return h('div', { className: 'dqb_board' }, [header, failureCard(failure, t, () => refresh(true))])
      }

      const body = [header]
      if (failure !== null) {
        body.push(
          h('div', { className: 'dqb_warnNote', key: 'stale' }, format(t('errFailed'), { v: failure.reason ?? 'unreachable' })),
        )
      }

      body.push(
        h('div', { className: 'dqb_stats', key: 'stats' }, [
          statBlock(t('statProviders'), `${counts.configured ?? 0}/${counts.providers ?? 0}`, '', false),
          statBlock(t('statLow'), counts.low ?? 0, '', (counts.low ?? 0) > 0),
          statBlock(t('statTotal'), compact(usage?.totals?.total ?? 0), t('statTokensUnit'), false),
          statBlock(t('statToday'), compact(usage?.today ?? 0), t('statTokensUnit'), false),
        ]),
      )

      if (providers.length === 0) {
        body.push(
          h('div', { className: 'dqb_card dqb_empty', key: 'empty' }, [
            h('div', { className: 'dqb_emptyTitle', key: 'title' }, t('empty')),
            h('p', { className: 'dqb_emptyText', key: 'hint' }, t('emptyHint')),
            h('button', { type: 'button', className: 'dqb_btn', key: 'config', onClick: () => openConfig() }, t('actionConfig')),
          ]),
        )
      } else {
        body.push(h('div', { className: 'dqb_grid', key: 'grid' }, providers.map((provider) => providerCard(provider, t))))
      }

      body.push(usageSection(usage, t))

      return h('div', { className: 'dqb_board' }, body)
    }

    /** Refresh glyph: an arc with an arrow head. */
    function RefreshGlyph(props) {
      const size = Number(props?.size) || 15
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          className: props?.spinning === true ? 'dqb_spin' : undefined,
          style: { display: 'block' },
        },
        h('path', {
          key: 'arc',
          d: 'M20 12a8 8 0 1 1-2.34-5.66',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head',
          d: 'M20 4v4h-4',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Settings glyph: a gear, drawn as a ring plus teeth. */
    function GearGlyph(props) {
      const size = Number(props?.size) || 15
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('circle', { key: 'ring', cx: 12, cy: 12, r: 3.1, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', {
          key: 'teeth',
          d: 'M12 3.2v2.1M12 18.7v2.1M3.2 12h2.1M18.7 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * The sidebar-footer seat: one button above the account row, and a
     * trigger-anchored popover holding the board.
     *
     * This is a seat rather than a page on purpose — the board should be one
     * click away without leaving the conversation, so the panel floats above the
     * button and closes on outside click or Escape. The board only polls while
     * it is open.
     */
    function QuotaBoardSeat(props) {
      const t = props.t
      const wide = props.wide === true
      const [open, setOpen] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const alive = React.useRef(true)
      const seenReport = React.useRef(false)
      // `props` is a fresh object every render, so a callback that closed over it
      // would change identity each time — and the polling effect below would
      // restart on every render, refetching in a loop. The loader is read through
      // a ref instead, keeping `refresh` stable for the life of the seat.
      const loadRef = React.useRef(props.load)
      loadRef.current = props.load

      const refresh = React.useCallback((force) => {
        setBusy(true)
        return Promise.resolve()
          .then(() => loadRef.current(force === true))
          .then((result) => {
            if (!alive.current) return
            if (result.ok === true) {
              seenReport.current = true
              setReport(result.data)
              setFailure(null)
            } else {
              setFailure(result)
            }
          })
          .catch((error) => {
            if (alive.current) setFailure({ reason: String(error?.message ?? error) })
          })
          .then(() => {
            if (alive.current) setBusy(false)
          })
      }, [])

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      // One quiet read on mount: the button has to say a name and a number
      // before it is ever opened. The Host caches for 20s, so this is close to
      // free, and it is the only fetch that happens while the panel is closed.
      React.useEffect(() => {
        refresh(false)
      }, [refresh])

      // Fetch on open, then keep it fresh only while it is visible.
      React.useEffect(() => {
        if (!open) return undefined
        refresh(!seenReport.current)
        const seconds = Math.max(10, Number(report?.refreshSeconds) || 60)
        const timer = setInterval(() => refresh(false), seconds * 1000)
        return () => clearInterval(timer)
        // `report.refreshSeconds` is the only field the interval depends on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, refresh, report?.refreshSeconds])

      // Place the panel above the button, clamped to the viewport by the CSS
      // max-height. Recomputed on resize and on any scroll, because the sidebar
      // scrolls inside its own container.
      React.useLayoutEffect(() => {
        if (!open) return undefined
        const place = () => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 8) })
        }
        place()
        window.addEventListener('resize', place)
        document.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          document.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (target instanceof Node !== true) return
          if (rootRef.current?.contains(target) === true) return
          if (panelRef.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const summary = seatSummary(seatProvider(report?.providers, report?.defaultProvider), t)
      const label = summary === null ? t('panel') : summary.name
      const titleText = summary === null || summary.quota.length === 0 ? label : `${label} · ${summary.quota}`

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dqb_seatBtn',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': titleText,
          title: titleText,
          onClick: () => setOpen((value) => !value),
        },
        [
          h(BoardIcon, { key: 'icon', size: wide ? 16 : 18, active: open }),
          wide
            ? h('span', { className: 'dqb_seatLabel', key: 'label' }, [
                h('span', { className: 'dqb_seatName', key: 'n' }, label),
                summary !== null && summary.quota.length > 0
                  ? h(
                      'span',
                      {
                        className: 'dqb_seatQuota',
                        key: 'q',
                        style: summary.color === null ? undefined : { color: summary.color },
                      },
                      summary.quota,
                    )
                  : null,
              ])
            : null,
          wide ? h('span', { className: 'dqb_seatCaret', key: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▸') : null,
        ],
      )

      const panel =
        open === false
          ? null
          : h(
              'div',
              {
                className: 'dqb_pop',
                ref: panelRef,
                role: 'dialog',
                'aria-label': t('title'),
                style:
                  anchor === null
                    ? { left: 8, bottom: 8, visibility: 'hidden' }
                    : { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
              },
              h(BoardContent, {
                t,
                report,
                failure,
                busy,
                refresh,
                openConfig: props.openConfig,
              }),
            )

      return h('div', { className: 'dqb_seat', ref: rootRef }, [
        button,
        panel === null ? null : createPortal === null ? panel : createPortal(panel, document.body),
      ])
    }

    /** Sidebar glyph: a gauge, drawn inline so no icon package is imported. */
    function BoardIcon(props) {
      const size = Number(props?.size) || 18
      const active = props?.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          key: 'arc',
          d: 'M4 16a8 8 0 1 1 16 0',
          stroke: 'currentColor',
          strokeWidth: active ? 2.1 : 1.7,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'needle',
          d: 'M12 16l4-5',
          stroke: 'currentColor',
          strokeWidth: active ? 2.1 : 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'hub', cx: 12, cy: 16, r: 1.5, fill: 'currentColor' }),
      )
    }

    // -----------------------------------------------------------------------
    // settings form
    // -----------------------------------------------------------------------

    /** The one structured list; every other control is a scalar text field. */
    const LIST_FIELDS = ['providers']
    const TEXT_FIELDS = ['defaultProvider', 'deepseekBaseURL', 'skipHosts']
    const NUMBER_FIELDS = ['lowThreshold', 'refreshSeconds', 'usageDays', 'timeoutMs']
    const VALUE_FIELDS = [...LIST_FIELDS, ...TEXT_FIELDS, ...NUMBER_FIELDS]

    /** Keys of one provider entry, in the order the list editor shows them. */
    const PROVIDER_KEYS = [
      'id',
      'displayName',
      'baseURL',
      'apiKeyEnv',
      'accessKeyEnv',
      'secretKeyEnv',
      'api',
      'adapter',
      'authHeader',
      'authPrefix',
      'fields',
    ]
    /** Keys of the optional `fields` hint block. */
    const FIELD_HINT_KEYS = ['endpoint', 'remaining', 'used', 'unit', 'scale']
    /** Adapter values the dropdown offers; '' means "let discovery decide". */
    const ADAPTER_CHOICES = ['', 'generic', 'deepseek', 'volcengine', 'unsupported']

    /** Blank `fields` hints are dropped, so a half-filled row writes nothing. */
    function tidyFields(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const out = {}
      for (const key of FIELD_HINT_KEYS) {
        const raw = value[key]
        if (key === 'scale') {
          const scale = Number(raw)
          if (Number.isFinite(scale) && scale !== 1) out.scale = scale
          continue
        }
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text.length > 0) out[key] = text
      }
      return Object.keys(out).length > 0 ? out : null
    }

    /**
     * Normalize the list before it is compared or written.
     *
     * Keys are emitted in a fixed order and blanks are dropped: `format` has to
     * return the same string for the same logical list, otherwise every render
     * would look like an unsaved edit.
     */
    function tidyProviders(value) {
      if (!Array.isArray(value)) return []
      return value.map((entry) => {
        const out = {}
        if (entry === null || typeof entry !== 'object') return out
        for (const key of PROVIDER_KEYS) {
          if (key === 'fields') {
            const hints = tidyFields(entry.fields)
            if (hints !== null) out.fields = hints
            continue
          }
          const raw = entry[key]
          const text = typeof raw === 'string' ? raw.trim() : ''
          if (text.length > 0) out[key] = text
        }
        return out
      })
    }

    /**
     * The list field's bridge to `SettingsFormModel`.
     *
     * The model stages every control as text, so the array is serialized here
     * and parsed back on save. `parse` rejects anything that is not a list,
     * which marks the field invalid instead of writing a corrupt value.
     */
    const PROVIDER_SPEC = {
      field: 'providers',
      format: (value) => JSON.stringify(tidyProviders(value)),
      parse: (text) => {
        try {
          const parsed = JSON.parse(text)
          return Array.isArray(parsed) ? { kind: 'set', value: parsed } : undefined
        } catch {
          return undefined
        }
      },
    }

    const SPECS = [
      PROVIDER_SPEC,
      ...TEXT_FIELDS.map((field) => UI.settingsTextField(field)),
      ...NUMBER_FIELDS.map((field) => UI.settingsNumberField(field)),
    ]

    const LABEL_OF = {
      providers: 'formLabelProviders',
      defaultProvider: 'formLabelDefaultProvider',
      deepseekBaseURL: 'formLabelDeepseekBaseURL',
      skipHosts: 'formLabelSkipHosts',
      lowThreshold: 'formLabelLowThreshold',
      refreshSeconds: 'formLabelRefreshSeconds',
      usageDays: 'formLabelUsageDays',
      timeoutMs: 'formLabelTimeoutMs',
    }

    const HINT_OF = {
      providers: 'formHintProviders',
      defaultProvider: 'formHintDefaultProvider',
      deepseekBaseURL: 'formHintDeepseekBaseURL',
      skipHosts: 'formHintSkipHosts',
      lowThreshold: 'formHintLowThreshold',
      refreshSeconds: 'formHintRefreshSeconds',
      usageDays: 'formHintUsageDays',
      timeoutMs: 'formHintTimeoutMs',
    }

    /**
     * Stages value fields over the `quota-board` settings scope and writes the
     * two Volcengine secrets through the credentials domain (never the settings
     * file).
     */
    /**
     * Stages value fields over the `quota-board` settings scope.
     *
     * Credentials are no longer form fields: every provider entry carries its own
     * reference names and writes its own secret through the credentials domain,
     * so a profile with two Volcengine accounts needs no second plugin-wide
     * setting — and no field sits outside the entry it belongs to.
     */
    class CardController {
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.form = new UI.SettingsFormModel(scope, SPECS, [])
        this.peers = null
        this.allProviders = null
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        const state = this.form.shell()
        for (const field of VALUE_FIELDS) state[field] = this.form.field(field)
        return state
      }

      /**
       * Every provider the board can see, DeepSeek included.
       *
       * The dashboard response is cached for 20s in the Host, so opening the
       * settings page right after looking at the popover costs no requests.
       */
      async loadAllProviders() {
        if (this.allProviders !== null) return this.allProviders
        const answer = await loadBoard(this.ctx, false)
        const list = answer?.ok === true && Array.isArray(answer.data?.providers) ? answer.data.providers : []
        this.allProviders = list
        return this.allProviders
      }

      /**
       * Providers the profile already declares, minus DeepSeek.
       *
       * DeepSeek is the one built-in: it is the Harness' own provider and its
       * balance comes from `/user/balance` with `DEEPSEEK_API_KEY`. Everything
       * else — including Volcengine — is "extra", so it is listed here and can
       * be overridden entry by entry.
       */
      async loadPeers() {
        if (this.peers !== null) return this.peers
        const list = await this.loadAllProviders()
        this.peers = list.filter((provider) => provider.adapter !== 'deepseek')
        return this.peers
      }

      /** Write one credential a provider entry points at. */
      async writeCredential(ref, value) {
        const name = String(ref ?? '').trim()
        if (name.length === 0) return false
        try {
          await this.ctx.remote.credentials.set(name, value)
          return true
        } catch {
          return false
        }
      }

      /**
       * Probe one entry before it is saved.
       *
       * The whole point is that the values on screen are what gets tested: the
       * key is resolved by the Host, so a wrong base URL or a missing credential
       * shows up here rather than on the dashboard after a save and a refresh.
       */
      async testProvider(entry) {
        return testConnection(this.ctx, entry)
      }

      inject() {
        return {
          hooks: { quotaBoardConfig: this.store },
          peers: () => this.loadPeers(),
          providers: () => this.loadAllProviders(),
          writeCredential: (ref, value) => this.writeCredential(ref, value),
          testProvider: (entry) => this.testProvider(entry),
          ...this.form.actions(),
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    function formLabels(t) {
      return {
        unavailable: t('formUnavailable'),
        readOnly: t('formReadOnly'),
        saveFailed: t('formSaveFailed'),
        save: t('formSave'),
        saving: t('formSaving'),
      }
    }

    /** One staged value row. */
    function valueField(props, state, field, numeric) {
      return h(UI.SettingsValueField, {
        key: field,
        id: `plugin-config-quota-board-${field}`,
        label: props.t(LABEL_OF[field] ?? field),
        hint: props.t(HINT_OF[field] ?? field),
        overriddenLabel: props.t('formOverridden'),
        resetLabel: props.t('formReset'),
        invalidLabel: props.t('formInvalidNumber'),
        numeric: numeric === true,
        disabled: !state.writable,
        ...(state[field] ?? { text: '' }),
        onEdit: (text) => props.edit(field, text),
        onReset: () => props.resetField(field),
      })
    }

    /**
     * One labelled input inside a provider card.
     *
     * Controlled on purpose: every keystroke is staged into the form model, so
     * "save" would write exactly what is on screen even if the field never
     * blurs.
     */
    function providerCell(props, spec) {
      return h('div', { className: spec.wide === true ? 'dqb_pcell dqb_pcellWide' : 'dqb_pcell', key: spec.key }, [
        h('label', { className: 'dqb_plabel', key: 'label', htmlFor: spec.id }, props.t(spec.labelKey)),
        h('input', {
          key: 'input',
          id: spec.id,
          className: 'dqb_pinput',
          type: spec.numeric === true ? 'number' : 'text',
          value: spec.value,
          disabled: spec.disabled,
          spellCheck: false,
          autoComplete: 'off',
          ...(spec.numeric === true ? { step: 'any' } : {}),
          onChange: (event) => spec.onChange(event.target.value),
        }),
      ])
    }

    /**
     * A write-only credential input for one provider entry.
     *
     * Deliberately not a form field: secrets never travel through the settings
     * value — they are written straight to the credentials domain and read back
     * only as "configured", which is why the box clears itself on success.
     */
    function CredentialInput(props) {
      const [text, setText] = React.useState('')
      const [status, setStatus] = React.useState('idle')

      const submit = () => {
        const value = text.trim()
        if (value.length === 0 || props.disabled === true) return
        setStatus('saving')
        Promise.resolve(props.onWrite?.(props.refName, value)).then(
          (ok) => {
            const landed = ok === true
            setStatus(landed ? 'saved' : 'failed')
            if (landed) setText('')
          },
          () => setStatus('failed'),
        )
      }

      const note =
        status === 'saved'
          ? h('p', { className: 'dqb_phint', key: 'note' }, props.savedLabel)
          : status === 'failed'
            ? h('p', { className: 'dqb_perror', key: 'note' }, props.failedLabel)
            : h('p', { className: 'dqb_phint', key: 'note' }, props.hint)

      return h('div', { className: 'dqb_pcell', key: props.id }, [
        h('label', { className: 'dqb_plabel', key: 'label', htmlFor: props.id }, props.label),
        h('div', { className: 'dqb_psecret', key: 'row' }, [
          h('input', {
            key: 'input',
            id: props.id,
            className: 'dqb_pinput',
            type: 'password',
            value: text,
            disabled: props.disabled === true || status === 'saving',
            placeholder: props.placeholder,
            autoComplete: 'new-password',
            spellCheck: false,
            onChange: (event) => {
              setText(event.target.value)
              setStatus('idle')
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              submit()
            },
          }),
          h(
            'button',
            {
              key: 'write',
              type: 'button',
              className: 'dqb_psave',
              disabled: props.disabled === true || status === 'saving' || text.trim().length === 0,
              onClick: submit,
            },
            props.actionLabel,
          ),
        ]),
        note,
      ])
    }

    /**
     * What one probe found, in one line.
     *
     * `headline` is reused so the number is read exactly as it will be on the
     * card: a plan window shows its percentage, a balance shows its currency.
     */
    function testText(data, t) {
      const status = data?.status ?? {}
      const error = typeof status.error === 'string' ? status.error.trim() : ''
      if (error.length > 0) return { ok: false, text: format(t('formProviderTestFailed'), { reason: error }) }
      if (status.kind === 'unsupported') return { ok: false, text: t('formProviderTestUnsupported') }
      const head = headline(status, t)
      const value =
        head.value === '—'
          ? ''
          : [head.value, head.unit].filter((part) => typeof part === 'string' && part.length > 0).join(' ')
      return {
        ok: true,
        text: value.length === 0 ? t('formProviderTestNoValue') : format(t('formProviderTestOk'), { value }),
      }
    }

    /**
     * "Test connection" for one entry that has not been saved yet.
     *
     * The probe runs in the Host against the values currently on screen, so a
     * typo in the base URL or a missing credential is caught here instead of on
     * the dashboard after a save and a refresh. When the probe finds an endpoint
     * that was not pinned yet, it can be pinned from here — that is the one
     * write this component offers, and it only writes a form field.
     */
    function TestConnection(props) {
      const t = props.t
      const [status, setStatus] = React.useState('idle')
      const [data, setData] = React.useState(null)
      const [reason, setReason] = React.useState('')
      // Set when this session pinned the endpoint, so the button disappears even
      // if the parent has not re-rendered with the new field yet.
      const [pinned, setPinned] = React.useState('')

      const run = () => {
        if (props.disabled === true || status === 'running') return
        setStatus('running')
        setData(null)
        setReason('')
        Promise.resolve(props.onTest?.(props.entry)).then(
          (answer) => {
            if (answer?.ok === true) {
              setData(answer.data ?? null)
            } else {
              setReason(answer?.absence !== undefined ? t('formProviderTestNoService') : String(answer?.reason ?? ''))
            }
            setStatus('done')
          },
          (error) => {
            setReason(describeFailure(error))
            setStatus('done')
          },
        )
      }

      const summary = data === null ? null : testText(data, t)
      const endpoint = typeof data?.endpoint === 'string' ? data.endpoint.trim() : ''
      const pinnedNow = pinned.length > 0 ? pinned : String(props.pinnedEndpoint ?? '')
      const canPin = summary?.ok === true && endpoint.length > 0 && pinnedNow !== endpoint

      return h('div', { className: 'dqb_ptest', key: props.id }, [
        h('div', { className: 'dqb_ptestRow', key: 'row' }, [
          h(
            'button',
            {
              key: 'run',
              type: 'button',
              className: 'dqb_psave',
              disabled: props.disabled === true || status === 'running',
              onClick: run,
            },
            status === 'running' ? t('formProviderTesting') : t('formProviderTest'),
          ),
          summary === null
            ? null
            : h(
                'span',
                { key: 'summary', className: `dqb_ptestOut ${summary.ok ? 'dqb_pok' : 'dqb_perr'}` },
                summary.text,
              ),
          reason.length === 0
            ? null
            : h('span', { key: 'reason', className: 'dqb_ptestOut dqb_perr' }, reason),
        ]),
        summary === null
          ? h('p', { className: 'dqb_phint', key: 'hint' }, t('formProviderTestHint'))
          : null,
        endpoint.length === 0
          ? null
          : h('p', { className: 'dqb_phint', key: 'via' }, [
              format(t('formProviderTestVia'), { endpoint }),
              canPin
                ? h(
                    'button',
                    {
                      key: 'pin',
                      type: 'button',
                      className: 'dqb_plink',
                      onClick: () => {
                        props.onPin?.(endpoint)
                        setPinned(endpoint)
                      },
                    },
                    t('formProviderTestPin'),
                  )
                : null,
            ]),
        pinned.length === 0
          ? null
          : h('p', { className: 'dqb_phint', key: 'pinned' }, format(t('formProviderTestPinned'), { endpoint: pinned })),
      ])
    }

    /**
     * The Volcengine account pair, carried by the entry itself.
     *
     * Volcengine is signed with an account AK/SK rather than an API key, and the
     * pair belongs next to the account it unlocks: two entries can then hold two
     * different accounts. A plugin-wide pair would silently apply to both.
     */
    function providerCredentials(props, row, patch, base, disabled) {
      const accessRef = String(row.accessKeyEnv ?? '').trim() || 'VOLC_ACCESS_KEY'
      const secretRef = String(row.secretKeyEnv ?? '').trim() || 'VOLC_SECRET_KEY'
      return h('div', { className: 'dqb_pcreds', key: 'credentials' }, [
        h('p', { className: 'dqb_plabel', key: 'title' }, props.t('formProviderCredentials')),
        h('div', { className: 'dqb_pgrid', key: 'grid' }, [
          providerCell(props, {
            key: 'accessKeyEnv',
            id: `${base}-accessKeyEnv`,
            labelKey: 'formProviderAccessKeyRef',
            value: row.accessKeyEnv ?? '',
            disabled,
            onChange: (value) => patch('accessKeyEnv', value),
          }),
          providerCell(props, {
            key: 'secretKeyEnv',
            id: `${base}-secretKeyEnv`,
            labelKey: 'formProviderSecretKeyRef',
            value: row.secretKeyEnv ?? '',
            disabled,
            onChange: (value) => patch('secretKeyEnv', value),
          }),
          h(CredentialInput, {
            key: 'accessKey',
            id: `${base}-accessKey`,
            label: format(props.t('formProviderAccessKey'), { ref: accessRef }),
            hint: props.t('formHintProviderAccessKey'),
            placeholder: props.t('formProviderSecretPlaceholder'),
            refName: accessRef,
            disabled,
            onWrite: props.writeCredential,
            actionLabel: props.t('formProviderWrite'),
            savedLabel: props.t('formProviderWritten'),
            failedLabel: props.t('formProviderWriteFailed'),
          }),
          h(CredentialInput, {
            key: 'secretKey',
            id: `${base}-secretKey`,
            label: format(props.t('formProviderSecretKey'), { ref: secretRef }),
            hint: props.t('formHintProviderSecretKey'),
            placeholder: props.t('formProviderSecretPlaceholder'),
            refName: secretRef,
            disabled,
            onWrite: props.writeCredential,
            actionLabel: props.t('formProviderWrite'),
            savedLabel: props.t('formProviderWritten'),
            failedLabel: props.t('formProviderWriteFailed'),
          }),
        ]),
      ])
    }

    /** One provider entry: the fields worth seeing, then the rest on demand. */
    function providerRowEditor(props, rows, row, index, commit, disabled) {
      const patch = (key, value) => {
        commit(rows.map((item, i) => (i === index ? { ...item, [key]: value } : item)))
      }
      const patchHint = (key, value) => {
        const current = row.fields !== null && typeof row.fields === 'object' && !Array.isArray(row.fields) ? row.fields : {}
        patch('fields', { ...current, [key]: value })
      }
      const hints = row.fields !== null && typeof row.fields === 'object' && !Array.isArray(row.fields) ? row.fields : {}
      const hintCount = FIELD_HINT_KEYS.filter((key) => {
        if (key === 'scale') {
          const scale = Number(hints[key])
          return Number.isFinite(scale) && scale !== 1
        }
        return typeof hints[key] === 'string' && hints[key].trim().length > 0
      }).length
      const base = `plugin-config-${ROW_ID}-providers-${index}`
      const named = String(row.displayName ?? '').trim() || String(row.id ?? '').trim()
      const where = [row.id, row.baseURL].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')

      return h('div', { className: 'dqb_pcard', key: `provider-${index}` }, [
        h('div', { className: 'dqb_phead', key: 'head' }, [
          h('span', { className: 'dqb_pindex', key: 'index' }, String(index + 1)),
          h(
            'span',
            {
              className: named.length > 0 ? 'dqb_ptitle' : 'dqb_ptitle dqb_ptitleEmpty',
              key: 'title',
              ...(where.length > 0 ? { title: where } : {}),
            },
            named.length > 0 ? named : props.t('formProviderUntitled'),
          ),
          h(
            'button',
            { key: 'remove', type: 'button', className: 'dqb_pdel', disabled, onClick: () => commit(rows.filter((_, i) => i !== index)) },
            props.t('formProviderRemove'),
          ),
        ]),
        h('div', { className: 'dqb_pgrid', key: 'main' }, [
          providerCell(props, {
            key: 'id',
            id: `${base}-id`,
            labelKey: 'formProviderId',
            value: row.id ?? '',
            disabled,
            onChange: (value) => patch('id', value),
          }),
          providerCell(props, {
            key: 'displayName',
            id: `${base}-displayName`,
            labelKey: 'formProviderName',
            value: row.displayName ?? '',
            disabled,
            onChange: (value) => patch('displayName', value),
          }),
          providerCell(props, {
            key: 'baseURL',
            id: `${base}-baseURL`,
            labelKey: 'formProviderBaseURL',
            value: row.baseURL ?? '',
            disabled,
            wide: true,
            onChange: (value) => patch('baseURL', value),
          }),
          providerCell(props, {
            key: 'apiKeyEnv',
            id: `${base}-apiKeyEnv`,
            labelKey: 'formProviderKeyRef',
            value: row.apiKeyEnv ?? '',
            disabled,
            onChange: (value) => patch('apiKeyEnv', value),
          }),
          h('div', { className: 'dqb_pcell', key: 'adapter' }, [
            h('label', { className: 'dqb_plabel', key: 'label', htmlFor: `${base}-adapter` }, props.t('formProviderAdapter')),
            h(
              'select',
              {
                key: 'select',
                id: `${base}-adapter`,
                className: 'dqb_pselect',
                value: row.adapter ?? '',
                disabled,
                onChange: (event) => patch('adapter', event.target.value),
              },
              ADAPTER_CHOICES.map((choice) =>
                h('option', { key: choice.length > 0 ? choice : 'auto', value: choice }, choice.length > 0 ? choice : props.t('formProviderAuto')),
              ),
            ),
          ]),
        ]),
        row.adapter === 'volcengine' ? providerCredentials(props, row, patch, base, disabled) : null,
        // Testing sits before the advanced block on purpose: it is the control
        // most people open this form for after typing a new gateway in.
        h(TestConnection, {
          key: 'test',
          id: `${base}-test`,
          t: props.t,
          entry: tidyProviders([row])[0] ?? {},
          disabled,
          pinnedEndpoint: typeof hints.endpoint === 'string' ? hints.endpoint : '',
          onTest: props.testProvider,
          onPin: (endpoint) => patchHint('endpoint', endpoint),
        }),
        h('details', { className: 'dqb_pmore', key: 'more' }, [
          h('summary', { key: 'summary' }, hintCount > 0 ? format(props.t('formProviderAdvancedCount'), { n: hintCount }) : props.t('formProviderAdvanced')),
          h('div', { className: 'dqb_pgrid', key: 'advanced' }, [
            providerCell(props, {
              key: 'api',
              id: `${base}-api`,
              labelKey: 'formProviderApi',
              value: row.api ?? '',
              disabled,
              onChange: (value) => patch('api', value),
            }),
            providerCell(props, {
              key: 'authHeader',
              id: `${base}-authHeader`,
              labelKey: 'formProviderAuthHeader',
              value: row.authHeader ?? '',
              disabled,
              onChange: (value) => patch('authHeader', value),
            }),
            providerCell(props, {
              key: 'authPrefix',
              id: `${base}-authPrefix`,
              labelKey: 'formProviderAuthPrefix',
              value: row.authPrefix ?? '',
              disabled,
              onChange: (value) => patch('authPrefix', value),
            }),
            providerCell(props, {
              key: 'endpoint',
              id: `${base}-endpoint`,
              labelKey: 'formProviderEndpoint',
              value: typeof hints.endpoint === 'string' ? hints.endpoint : '',
              disabled,
              wide: true,
              onChange: (value) => patchHint('endpoint', value),
            }),
            providerCell(props, {
              key: 'remaining',
              id: `${base}-remaining`,
              labelKey: 'formProviderRemaining',
              value: typeof hints.remaining === 'string' ? hints.remaining : '',
              disabled,
              onChange: (value) => patchHint('remaining', value),
            }),
            providerCell(props, {
              key: 'used',
              id: `${base}-used`,
              labelKey: 'formProviderUsed',
              value: typeof hints.used === 'string' ? hints.used : '',
              disabled,
              onChange: (value) => patchHint('used', value),
            }),
            providerCell(props, {
              key: 'unit',
              id: `${base}-unit`,
              labelKey: 'formProviderUnit',
              value: typeof hints.unit === 'string' ? hints.unit : '',
              disabled,
              onChange: (value) => patchHint('unit', value),
            }),
            providerCell(props, {
              key: 'scale',
              id: `${base}-scale`,
              labelKey: 'formProviderScale',
              value: Number.isFinite(Number(hints.scale)) && Number(hints.scale) !== 1 ? String(hints.scale) : '',
              disabled,
              numeric: true,
              onChange: (value) => patchHint('scale', value),
            }),
          ]),
        ]),
      ])
    }

    /** Map a discovered provider onto the fields an entry carries. */
    function peerToEntry(peer) {
      return {
        id: String(peer.id ?? ''),
        displayName: String(peer.displayName ?? ''),
        baseURL: String(peer.baseURL ?? ''),
        api: String(peer.api ?? ''),
        apiKeyEnv: String(peer.keyRef ?? ''),
        accessKeyEnv: String(peer.accessKeyRef ?? ''),
        secretKeyEnv: String(peer.secretKeyRef ?? ''),
        adapter: String(peer.adapter ?? ''),
      }
    }

    /** One line saying how a discovered provider is queried right now. */
    function peerSummary(peer, t) {
      const bits = []
      if (typeof peer.adapter === 'string' && peer.adapter.length > 0) bits.push(peer.adapter)
      if (typeof peer.binding?.endpoint === 'string' && peer.binding.endpoint.length > 0) bits.push(peer.binding.endpoint)
      else if (peer.adapter === 'generic') bits.push(t('formProviderUnbound'))
      if (peer.configured !== true) bits.push(t('formProviderNoKey'))
      return bits.join(' · ')
    }

    /**
     * Providers the profile already declares, shown above the editable list.
     *
     * They are not copied into the config: an entry is only created when the
     * user actually overrides one, so the settings file stays a list of
     * decisions rather than a snapshot of the profile.
     */
    function discoveredGroup(props, peers, rows, commit, disabled) {
      return h('div', { className: 'dqb_pdiscovered', key: 'discovered' }, [
        h('p', { className: 'dqb_plabel', key: 'title' }, format(props.t('formProviderDiscovered'), { n: String(peers.length) })),
        ...peers.map((peer) =>
          h('div', { className: 'dqb_peer', key: `peer-${String(peer.id ?? '')}` }, [
            h('span', { className: 'dqb_peerName', key: 'name' }, String(peer.displayName ?? peer.id ?? '')),
            h('span', { className: 'dqb_peerMeta', key: 'meta' }, peerSummary(peer, props.t)),
            h(
              'button',
              {
                key: 'override',
                type: 'button',
                className: 'dqb_peeredit',
                disabled,
                onClick: () => commit([...rows, peerToEntry(peer)]),
              },
              props.t('formProviderOverride'),
            ),
          ]),
        ),
      ])
    }

    /** The `providers` control: discovered peers, then a card per entry. */
    function providerListField(props, state, peers) {
      const entry = state.providers ?? { text: '[]', invalid: false, overridden: false }
      const disabled = state.writable !== true
      let rows = []
      let broken = false
      try {
        const parsed = JSON.parse(typeof entry.text === 'string' ? entry.text : '[]')
        if (Array.isArray(parsed)) rows = parsed
        else broken = true
      } catch {
        broken = true
      }
      const commit = (next) => props.edit('providers', JSON.stringify(next))
      // A discovered peer the config already overrides is listed as an entry, so
      // showing it twice would only invite editing the same thing in two places.
      const overridden = new Set(rows.map((row) => String(row.id ?? '').trim()).filter((id) => id.length > 0))
      const discovered = (Array.isArray(peers) ? peers : []).filter((peer) => !overridden.has(String(peer.id ?? '').trim()))

      const body = broken
        ? h('p', { className: 'dqb_perror', key: 'error' }, props.t('formProviderBroken'))
        : h('div', { className: 'dqb_plist', key: 'list' }, [
            discovered.length > 0 ? discoveredGroup(props, discovered, rows, commit, disabled) : null,
            ...rows.map((row, index) => providerRowEditor(props, rows, row, index, commit, disabled)),
            rows.length === 0
              ? h(
                  'p',
                  { className: 'dqb_pempty', key: 'empty' },
                  props.t(discovered.length > 0 ? 'formProviderEmptyManual' : 'formProviderEmpty'),
                )
              : null,
            h(
              'button',
              {
                key: 'add',
                type: 'button',
                className: 'dqb_padd',
                disabled,
                onClick: () =>
                  commit([...rows, { id: '', displayName: '', baseURL: '', apiKeyEnv: '', api: '', adapter: '', authHeader: '', authPrefix: '' }]),
              },
              props.t('formProviderAdd'),
            ),
          ])

      return h('div', { className: 'dqb_pfield', key: 'providers', id: `plugin-config-${ROW_ID}-providers` }, [
        h('div', { className: 'dqb_pfieldHead', key: 'head' }, [
          h('span', { className: 'dqb_plabel', key: 'label' }, props.t('formLabelProviders')),
          entry.overridden === true ? h('span', { className: 'dqb_pover', key: 'over' }, props.t('formOverridden')) : null,
        ]),
        body,
        h('p', { className: 'dqb_phint', key: 'hint' }, props.t('formHintProviders')),
      ])
    }

    /**
     * The `defaultProvider` control: a dropdown of everything the board knows
     * about, so the choice is a name rather than an id someone has to spell.
     *
     * Discovered providers come from the report; configured-but-undiscovered
     * extra rows are merged in, since a gateway added by hand is exactly the one
     * that has no discovery entry.
     */
    function defaultProviderField(props, state, providers) {
      const entry = state.defaultProvider ?? { text: '', overridden: false, resetable: false }
      const current = typeof entry.text === 'string' ? entry.text.trim() : ''
      const disabled = state.writable !== true
      const choices = []
      const seen = new Set()
      const add = (id, label) => {
        const clean = String(id ?? '').trim()
        if (clean.length === 0 || seen.has(clean)) return
        seen.add(clean)
        choices.push({ id: clean, label: String(label ?? clean) })
      }
      for (const provider of Array.isArray(providers) ? providers : []) add(provider.id, provider.displayName ?? provider.id)
      let rows = []
      try {
        const parsed = JSON.parse(typeof state.providers?.text === 'string' ? state.providers.text : '[]')
        if (Array.isArray(parsed)) rows = parsed
      } catch {
        rows = []
      }
      for (const row of rows) add(row?.id, row?.displayName ?? row?.id)

      return h('div', { className: 'dqb_pfield', key: 'defaultProvider', id: `plugin-config-${ROW_ID}-defaultProvider` }, [
        h('div', { className: 'dqb_pfieldHead', key: 'head' }, [
          h('label', { className: 'dqb_plabel', key: 'label', htmlFor: `plugin-config-${ROW_ID}-defaultProvider-input` }, props.t('formLabelDefaultProvider')),
          entry.overridden === true ? h('span', { className: 'dqb_pover', key: 'over' }, props.t('formOverridden')) : null,
        ]),
        h(
          'select',
          {
            id: `plugin-config-${ROW_ID}-defaultProvider-input`,
            className: 'dqb_pselect',
            value: current,
            disabled,
            onChange: (event) => props.edit('defaultProvider', String(event?.target?.value ?? '')),
          },
          [
            h('option', { value: '', key: '__auto' }, props.t('formDefaultProviderAuto')),
            ...choices.map((choice) => h('option', { value: choice.id, key: choice.id }, choice.label)),
          ],
        ),
        h('p', { className: 'dqb_phint', key: 'hint' }, props.t('formHintDefaultProvider')),
      ])
    }

    function QuotaBoardConfigCard(props) {
      const state = props.useQuotaBoardConfig((snapshot) => snapshot)
      // The profile's own providers are read once per mount: they tell the list
      // what already exists, so "extra" includes what the profile declared — not
      // just what the user typed here. The unfiltered list also feeds the
      // "default provider" dropdown, which has to offer DeepSeek too.
      const [all, setAll] = React.useState([])
      React.useEffect(() => {
        let alive = true
        const read = typeof props.providers === 'function' ? props.providers : props.peers
        if (typeof read !== 'function') return undefined
        void read().then(
          (list) => {
            if (alive) setAll(Array.isArray(list) ? list : [])
          },
          () => {},
        )
        return () => {
          alive = false
        }
      }, [])
      const peers = all.filter((peer) => peer.adapter !== 'deepseek')

      if (props.view === 'summary') return props.t('summary')
      return h(
        UI.SettingsForm,
        {
          labels: formLabels(props.t),
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        [
          valueField(props, state, 'lowThreshold', true),
          valueField(props, state, 'refreshSeconds', true),
          valueField(props, state, 'usageDays', true),
          valueField(props, state, 'timeoutMs', true),
          valueField(props, state, 'deepseekBaseURL', false),
          valueField(props, state, 'skipHosts', false),
          defaultProviderField(props, state, all),
          providerListField(props, state, peers),
        ],
      )
    }

    /** Services required by the browser half. */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

    /** Mount a settings form on one slot, only while the Host serves the row. */
    function mountForm(ctx, card, slot, options, effect) {
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ROW_ID], () =>
            ctx.slots.inject(slot, () =>
              ctx.slots.register({ name: slot, locale: NS, inject: () => card.inject(), ...options }, QuotaBoardConfigCard),
            ),
          ),
        effect,
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quota-board: dictionaries')
      ctx.effect(() => installStyles(), 'dsh-quota-board: styles')

      // Jumping to this plugin's own settings row: `pluginNavigation` is optional,
      // so a Harness without it still leaves the sidebar Plugins page reachable.
      const openConfig = () => {
        try {
          ctx.get('pluginNavigation')?.openBundle?.(PKG_NAME)
        } catch {
          /* navigation is optional; the sidebar Plugins page still works */
        }
      }

      mountService(ctx)

      // One seat in the sidebar footer, directly above the account row: the
      // board opens as a popover from there, so reading a balance never costs
      // the conversation you were in.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: PANEL_ID,
            order: PANEL_ORDER,
            locale: NS,
            inject: () => ({
              load: (force) => loadBoard(ctx, force),
              openConfig,
            }),
          },
          QuotaBoardSeat,
        ),
      )

      const card = new CardController(ctx.configForms.get(ROW_ID), ctx)
      ctx.effect(
        () => () => {
          card.dispose()
        },
        'dsh-quota-board: form subscription',
      )

      mountForm(ctx, card, BUNDLE_SLOT, { key: PKG_NAME }, 'dsh-quota-board: bundle config')
      mountForm(ctx, card, ITEM_SLOT, { id: ITEM_ID, order: 46, label: () => t('title') }, 'dsh-quota-board: card')
      mountForm(ctx, card, ROW_SLOT, { key: ROW_KEY }, 'dsh-quota-board: row config')
    }

    exports.NS = NS
    exports.ROW_ID = ROW_ID
    exports.ROW_KEY = ROW_KEY
    exports.PKG_NAME = PKG_NAME
    exports.PANEL_ID = PANEL_ID
    exports.PANEL_ORDER = PANEL_ORDER
    exports.ITEM_ID = ITEM_ID
    exports.NAMESPACE = NAMESPACE
    exports.METHOD = METHOD
    exports.CONTRIBUTION = CONTRIBUTION
    // Exported so the offline suite can render with the real strings instead of
    // an identity reader that would assert on dictionary keys.
    exports.dictionaries = { zh, en }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
