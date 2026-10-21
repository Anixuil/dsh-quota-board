# dsh-quota-board

> A DeepSeek Harness plugin that puts every model provider's balance, plan
> windows and local token usage in one popover, anchored to a button above the
> account row in the sidebar footer. DeepSeek reads the signed-in account wallet
> Harness already has; every other provider is an "extra" that a universal prober
> figures out on its own — and the endpoint it finds is remembered.

一个给 DeepSeek Harness 桌面端的「模型供应商额度看板」：侧栏底部、账号行上方多一个按钮，
点开就是一整块看板，把当前 profile 里**所有已配置的模型供应商**的余额、套餐额度、
以及本机的 token 用量摆在一起。看过期就点掉，不用离开正在进行的对话。

只有 **DeepSeek 是内置的**：登录后直接读 Harness 的账号钱包，和「设置 → 账号与余额」是同一个数字，
不用再填 API Key；其余一律算「额外供应商」——火山引擎、中转站、自建网关都一样：
插件自己去试接口，试通了就把这个获取方式**记下来**。
配置页的每条供应商都能「测试连接」，拿没保存的值先打一次，不用等看板刷新才知道填错没有。

> **第三方社区插件。** 本项目与 DeepSeek 官方无隶属关系，也不属于官方插件市场。

---

## 它是怎么知道「有哪些供应商」的

不读配置文件、也不猜目录结构。Harness 的 Loader 已经把整个 profile 的层（bundle 层 + profile 层
+ `!!js` 表达式）合成好了，插件直接读**已合成的行**：

| 行 | 读到的东西 |
|---|---|
| `llm-pi-ai` | `config.providers.<id>`：`displayName` / `api` / `baseURL` / `apiKeyEnv` / `models[]` |
| `llm-deepseek*` | 官方 DeepSeek 适配器的 `baseURL` / `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`） |
| `agent-default-model` | `config.provider`，用来把某张卡标成「当前默认」 |

这意味着「加一个 provider」在 Harness 里的原有做法（改 profile 里的 `llm-pi-ai` 行）**立刻**会反映到看板上，
不需要在这里再登记一遍。插件自己的 `providers` 字段只用来补「profile 里根本没声明的网关」。

## 内置 vs 额外

| | 谁 | 怎么查额度 |
|---|---|---|
| **内置** | DeepSeek（`llm-deepseek` 行） | 登录后直接读 Harness 账号钱包（与「设置 → 账号与余额」同源）；未登录才退回 `GET {base}/user/balance` |
| **额外** | 其余全部，含火山引擎 | 通用探测器按需试探；探到就绑定 |

设置页的「额外供应商」列表上方会列出**已经发现的额外供应商**（只读，带它当前的
查询方式与是否配了密钥）；想改哪一条就点它的「覆盖」，这时才会在配置里生成一条条目。
所以配置文件里记的是**你的决定**，而不是 profile 的一份快照。

密钥同样不落盘：每个供应商的 `apiKeyEnv` 只是一个**引用名**，宿主按
`凭证服务 → 启动环境 → 进程环境变量` 的顺序解析，浏览器半侧永远拿不到明文。

### DeepSeek 不需要 API Key

登录 Harness 之后，「设置 → 账号与余额」里的**充值余额 / 赠金余额**就是看板上的那个数字：
插件调用宿主已有的 `deepseekAccount` 服务（`getState()` 判断是否登录、`getBalance()` 取钱包），
不自己猜、也不重复登录。所以两边永远一致，且不会出现「设置里有余额、看板说未配置」。
钱包是充值 + 赠金相加（例：`-0.07` + `38.48` = `38.41`），两笔明细并排显示，负数标红。

只有三种情况会退回 API Key：

- 没有登录（`getState()` 不是 `credential-stored`）——卡片会直接说明去「账号与余额」登录；
- 账号服务不存在（老版本 Harness）——静默走原来的 `/user/balance`；
- 钱包读取失败（授权损坏、Platform 超时 8 秒）——同样退回 Key，且不会影响其他卡片。

**中转站不受影响**：只有 `api.deepseek.com` / `api.deepseek.ai` 会被当作官方 DeepSeek。
一个协议相同、账户不同的中转（比如 `relay.example.com`）始终用自己的 Key，绝不会拿你的
账户余额去顶替。

## 额度接口：默认通用，探到就记住

只有 DeepSeek 和火山引擎是真的特殊，其余全部走同一个通用探测器。

| 适配器 | 触发条件 | 行为 |
|---|---|---|
| `generic`（默认） | 除下面两种以外的一切 | 顺序试常见余额接口，命中即停，并**把命中的路径写进 `bindings.json`** |
| `deepseek` | `api` 或域名含 `deepseek` | 官方主机优先读账号钱包；否则 `GET {base}/user/balance` |
| `volcengine` | 域名含 `volces` / `volcengine` | 签名的 `open.volcengineapi.com`：`billing.QueryBalanceAcct`、`billing.ListResourcePackages`、`ark.GetCodingPlanUsage`、`ark.GetAFPUsage` |
| `unsupported` | 命中跳过名单 | 不发请求，卡片写明「没有可通过 API Key 查询的账单接口」 |

通用探测器按以下顺序试（路径相对于 API 根，`/v1` 结尾会被归一化，不会拼出 `/api/usage` 这种）：

```
/v1/usage  →  /user/balance  →  /v1/credits  →  /v1/dashboard/billing/usage  →  /usage  →  /api/usage
```

任何一个返回 401/403 就**立即中止**（Key 有问题，继续试没有意义）；404/405 继续下一个；
超时则不再往下试（避免变成连续六次超时）；全部 404 说明这个平台确实没有账单接口，
卡片改成「不支持」并说明怎么手工指定路径——而不是显示一个红色报错让你反复重试。

### 探到之后绑定，下次直接问

第一次探通就把「哪条路径、返回的是账单还是普通 JSON」记下来：

```
~/.dsh/storages/quota-board/bindings.json
```

```json
{
  "https://relay.example.com": { "endpoint": "/api/me/quota", "kind": "json", "updatedAt": 1750000000000 }
}
```

- 键是 API 根（结尾的 `/v1` 归一化掉），所以 `…/v1` 换不换写法都是同一个供应商。
- 有绑定就**先问绑定的那个**；它失败再退回完整列表重探，不会一上来就六连发。
- 写进绑定表的是**探测结果**，不是用户配置：`providers` 里没写的供应商也会被记住，
  升级或换 profile 不受影响（`bindings.json` 在 `~/.dsh` 下，不在 profile 里）。
- 写入是原子的（临时文件 + rename），内容没变就不写；写失败只 warn，不影响这次查询。

要重新探一遍，把对应那一项从 `bindings.json` 里删掉即可（或在条目里写死 `fields.endpoint`）。

### 认得的响应形状

按**结构**识别，不按域名识别——同一套网关软件跑在几千个域名上，域名匹配等于不匹配：

| 形状 | 例子 | 取值 |
|---|---|---|
| `deepseek-balance` | `{ balance_infos: [{ total_balance, currency }] }` | 总余额 |
| `one-api` | `{ data: { quota, used_quota } }` | `quota - used_quota`，按 1 USD = 500000 额度换算 |
| `credits` | `{ data: { total_credits, total_usage } }` | 两者相减 |
| `remaining` | `{ remaining }` / `{ balance }` / `{ data: { available } }` 等 | 最近的金额字段 |

### 接一个上面没覆盖的网关

在插件配置的「额外供应商」列表里加一条，不用改代码。设置页是**卡片列表**：
一条一个卡片，有「添加供应商」和「删除」，不用手写 JSON。

存进 profile 的 `cordis.patch.yml` 是普通的 YAML 列表：

```yaml
providers:
  - id: my-gw
    displayName: 我的网关
    baseURL: https://gw.example.com/v1
    apiKeyEnv: MY_GW_KEY
    # 路径不认识就用 endpoint 钉死；字段不认识就用 fields 映射
    fields:
      endpoint: /api/me/quota
      remaining: data.credit
      unit: data.currency
    # 不是 Bearer 的网关：header 名与前缀都可改（前缀留空表示裸 Key）
    authHeader: x-api-key
    authPrefix: ''
```

可用字段：

| 字段 | 作用 |
|---|---|
| `adapter` | 强制用哪个适配器：`generic` / `deepseek` / `volcengine` / `unsupported` |
| `fields.endpoint` | 钉死请求路径，可写绝对 URL；不写就自动探测 |
| `fields.remaining` / `used` / `unit` | 点路径（`data.credit`、`items[0].left`），优先于内置形状 |
| `fields.scale` | 数值倍率，用于单位不同的网关 |
| `authHeader` / `authPrefix` | 换成 `x-api-key` 之类的自定义鉴权头 |
| `accessKeyEnv` / `secretKeyEnv` | 火山引擎专用：账户 AK/SK 的**凭证名**，默认 `VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY` |

`providers` 是**逐字段合并**的：只改显示名不会清掉探测到的 baseURL 和密钥引用。

三个容易踩的点：

- **火山引擎的 Ark API Key 查不了账单。** 那个 key 只能跑模型，账单在 Billing Center。
  所以火山走的是**账户 AK/SK 签名**的 OpenAPI。`adapter` 选 `volcengine` 的条目会多出一块
  「火山账户密钥（AK/SK）」：先填两个引用名，再把值**粘进去点保存**——值走凭证服务，不落 YAML，
  也不回显。没配就整张卡提示「需要 AccessKey」，而不是显示 0。
- **OpenAI 官方没有公开的 `/v1/usage`。** 通用网关的约定是 `/v1/usage` 返回「剩余额度」；
  对不上就回退到 dashboard billing 的两个老接口（`total_usage` 单位是**美分**，已换算）。
- **用账号登录的 DeepSeek 不再需要单独配 Key。** 桌面端的官方 DeepSeek 通道走的是账号授权，
  余额在 Platform 内部——插件通过宿主的 `deepseekAccount` 服务拿到它（见上文）。
  如果那个服务不可用，才需要 `DEEPSEEK_API_KEY` 走 `/user/balance`。

## 本机用量从哪来

不重放会话日志（那是 zstd 压缩的），直接读会话投影缓存：

```
~/.dsh/storages/session_projcache/sessions/<sessionId>.json
```

取 `rows.tokenUsage.totals`（未命中缓存的输入 / 输出 / 缓存读 / 缓存写）与 `rows.sessionStats`，
再用 `rows.modelSelection.lastUsed.provider` 做供应商归因。所以「用量」这一栏
**不需要任何网络请求**，断网也能看，只是口径和供应商账单不完全一致（缓存计价、赠送额度、按次计费等）。

## 装

**桌面端面板**：侧栏「插件」→「+ 添加插件」→ 输入框填下面任意一种 → 安装 → 立即启用 → 重启 Harness。

| 输入 | 效果 |
|---|---|
| `github:Anixuil/dsh-quota-board` | 装 GitHub main 的当前代码；插件升级要卸载重装 |
| `git+https://github.com/Anixuil/dsh-quota-board.git#v0.1.0` | 钉在某个 tag，不跟 main 变 |
| `dsh-quota-board`（发布到 npm 后） | 走 npm 版本管理，`@0.1.0` 可固定版本 |

装完**重启 Harness**（bundle 类插件不热加载）。
安装时出现 `[WARN] Issues with peer dependencies found` 可忽略：peerDependencies 指向
Harness 自身的 `@deepseek-ai/*`，它们不发布到 npm，dsh 官方插件也一样。

**本地开发**：同一栏填本目录的绝对路径（例如 `D:\code\self\all\dsh-quota-board`）。
pnpm 记成 `link:`，此后改 `index.js` / `client.js` 只要重启 Harness 就生效。
注意 link 和实体安装互斥：换回对话框安装前，先删掉 profile `node_modules` 里的链接，
否则 pnpm 的「解压 → rename 覆盖」在 Windows 上会报 `ERR_PNPM_EPERM`。

## 看板在哪

侧栏**左下角、账号行上方**多出一个「额度看板」按钮，点一下浮窗就贴在这个按钮上展开：

- 浮窗是 **portal 到 `<body>`** 的，不挂在侧栏里 —— 侧栏处在 transform 祖先之下，
  `position: fixed` 会被那一层的 overflow 裁掉，所以定位按按钮的 `getBoundingClientRect()`
  算好后手动贴边，窗口缩放或侧栏滚动时重算。
- 关闭方式三选一：再点一次按钮、点浮窗外面、按 `Esc`。
- **按钮上写的是谁**：默认显示「默认展示供应商」那一家的名字和它的剩余额度
  （配额窗口给百分比，钱包给币种金额）。没配置就跟随模型配置里的默认供应商，
  选中的供应商改了名或没了，也会自动退回默认那个 —— 不会空着。
- **只有浮窗开着才轮询**：打开时取一次，之后按 `refreshSeconds` 轮询；
  关掉即停表，不会在后台一直打接口。挂载时另有一次安静的首读，
  好让按钮在没人点开时也有数字可写（宿主有 20 秒缓存，几乎不花钱）。
- 侧栏收起（只剩图标列）时按钮也只留图标，宽度吃满侧栏，不撑破布局。

想改配置：浮窗右上角的齿轮 → 设置 → 插件 → 额度看板。

## 配色

「可用」用的是 DeepSeek 的品牌蓝 `#4d6bfe` —— 主题里的 success 是绿色，
摆在 DeepSeek 的界面上像是别人家的颜色。只有真的告急时才换色：
剩余 ≤30% 转琥珀，≤10% 转红。

## 配置

设置 → 插件 → 额度看板。八个字段，全部有默认值，多数情况下一个都不用动：

| 字段 | 默认 | 说明 |
|---|---|---|
| `providers` | `[]` | 额外供应商列表，补充或覆盖自动发现的那些（设置页是可增删的卡片列表） |
| `defaultProvider` | `''` | 侧栏按钮显示哪一家（下拉选，空 = 跟随模型配置的默认供应商） |
| `lowThreshold` | `5` | 金额余额低于此值时标红 |
| `refreshSeconds` | `60` | 浮窗打开时的轮询间隔（最小 10 秒；宿主管 20 秒缓存） |
| `usageDays` | `14` | 本机用量柱状图天数（3–60） |
| `timeoutMs` | `10000` | 单个供应商接口超时（最小 2000） |
| `deepseekBaseURL` | `''` | 所有 DeepSeek 行都没写 baseURL 时的兜底 |
| `skipHosts` | `''` | 额外不探测的域名片段（逗号分隔），追加在内置名单之后 |

火山账户的 AK/SK **不在上面**：它是条目自己的字段（见下），这样同一个 profile 里挂两个火山账户
也不会互相串。

列表里每条只需要填**想改或想加**的部分：`id` 必填（新网关随便起一个，要覆盖已发现的
就用它原来的 id），其余留空即用默认。合并是逐字段的 —— 只改显示名时，探测到的
`baseURL` / `apiKeyEnv` 不会被清空。

一个最小条目：

```yaml
providers:
  - id: my-gw
    displayName: 我的网关
    baseURL: https://gw.example.com/v1
    apiKeyEnv: MY_GW_KEY
```

火山账户要带上自己的一对引用名（值本身在凭证服务里，不写在这里）：

```yaml
providers:
  - id: ark-second
    displayName: 方舟（另一个账户）
    baseURL: https://ark.cn-beijing.volces.com/api/v3
    apiKeyEnv: ARK_API_KEY_2
    adapter: volcengine
    accessKeyEnv: VOLC_ACCESS_KEY_2
    secretKeyEnv: VOLC_SECRET_KEY_2
```

设置页里每条还有「高级」折叠区（协议提示、鉴权头与前缀、字段映射），
平时不用展开；「测试连接」就在高级上面，填完值先点一下比保存后再看省事。

## 降级

| 情况 | 表现 |
|---|---|
| Harness 不带 Typert remote | 浮窗直说「宿主没有提供额度服务」，并给出原因（无 `$mount` / 被 Gateway 拒绝 / 读不到命名空间 / 没有 `load` 方法） |
| 没配密钥 | 卡片标「未配置」，其余卡片照常 |
| 某个供应商接口挂了 | 只有那张卡显示错误，整块不塌 |
| 平台没有账单接口 | 卡片标明，本机用量照常统计 |
| 没有投影缓存 | 用量区显示 0 并说明还没记录 |

## 结构

```
index.js            宿主半侧：发现供应商、解析密钥、并发查询、聚合用量；暴露 load(force) 与 test(entry)
client.js           浏览器半侧：侧栏底部席位 + portal 浮窗 + 三处配置表单
adapters.js         纯函数适配器：路由、HTTP、通用探测器、两个特殊平台
providers.js        纯函数：从已合成的 Loader 行里发现供应商
bindings.js         纯函数：探测结果的持久绑定（读、写、归一化 API 根）
usage.js            纯函数：会话投影缓存 → token 用量报告
cordis.patch.yml    只 insert 本包自己的一行（不覆盖别人的行，卸载才干净）
locale/{zh,en}.json 插件页的标题与描述
dev/smoke.mjs       离线冒烟：mock HTTP + 真实模块 + 物化 client.js 渲染
dev/validate.mjs    清单契约：exports / patch 方言 / 两端 Remote 契约 / 槽位 / 词典
dev/preview.mjs     把设置页与浮窗渲染成静态 HTML（含侧栏底部排布、三种测试连接状态）
```

宿主与浏览器之间只有两条通路，都在 Host 侧发起请求：

| Remote 方法 | 谁调 | 作用 |
|---|---|---|
| `quotaBoard.load(force)` | 浮窗、配置页的发现列表 | 整块看板；20 秒缓存 + in-flight 去重 |
| `quotaBoard.test(entry)` | 配置页的「测试连接」 | 单条**未保存**条目的试打；不缓存、不写绑定 |

看板不直连供应商接口 —— 跨域、签名、密钥都不该发生在渲染进程里。

## 测试连接

配置页每个条目都有「测试连接」：拿**屏幕上当前的值**（还没保存的那些）去打一次真实的额度接口。

```
[测试连接]  连通 · 12.34 USD
            接口 /v1/usage  [钉死这个接口]
```

- 走的是和看板完全相同的代码路径（`providerStatus` → `queryProvider`），所以这里绿了，卡片就会亮。
- 密钥由宿主解析，浏览器不碰；条目里的 `apiKeyEnv` / `accessKeyEnv` 只是引用名。
- **不写 `bindings.json`**：一次试探不该把接口钉死，你可能还在改 baseURL。
  但探到的路径会回显，想固定下来点「钉死这个接口」，它就写进条目的 `fields.endpoint`。
- 主机不给额度服务、条目没填地址、Key 解析不到，都各有各的说法，不会只给一个「失败」。
- 超时上限压到 8 秒——按钮是要等结果的，不能跟看板一样等 10 秒。

## 开发

```bash
npm install          # 只为 dev/ 里的两个脚本：js-yaml、@deepseek-ai/schemastery
node dev/smoke.mjs   # 80 项：路由、通用探测、绑定、账号钱包、测试连接、形状识别、发现、用量聚合、席位文案、浮窗开合与表单渲染
node dev/validate.mjs # 44 项：清单、patch、Remote 契约、槽位、词典、账号钱包
node dev/preview.mjs  # 生成 dev/preview-config.html 与 dev/preview-board.html：设置页与浮窗的真实渲染结果
```

`smoke.mjs` 会起一个本地 mock HTTP 服务，把真实模块跑一遍，再把 `client.js` 物化到 VM 里、
用桩 React 真渲染 —— 因为「组件抛错」在 Harness 里的表现是**整块槽位静默空白**，
不跑一遍根本发现不了。桩 React 会按点击重放一次渲染，所以「点开浮窗 / `Esc` 关掉」
这类状态切换也在断言范围里。

## 许可

MIT
