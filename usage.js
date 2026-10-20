/**
 * dsh-quota-board — local token usage.
 *
 * A provider can tell you what is left; it cannot tell you what you spent this
 * afternoon. That half comes from the Host's own session projection cache,
 * which already stores cumulative token totals per session — no session log
 * replay, no model call, no extra dependency.
 *
 * Two layouts are read:
 *
 *   storages/session_projcache/sessions/<id>.json   current DSH (one file per session)
 *   storages/session_projcache.json                 older single-table cache
 *
 * Attribution comes from the cached `modelSelection.lastUsed` row, so tokens are
 * grouped by the provider and model that actually served the session rather
 * than by the profile's current default.
 *
 * Pure module: takes the DSH home directory as an argument.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

/** Read a numeric field, coercing numeric strings; anything else is 0. */
function tokenValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Sum the four token classes and keep a total. */
function withTotal(tokens) {
  const input = tokenValue(tokens?.input)
  const output = tokenValue(tokens?.output)
  const cacheRead = tokenValue(tokens?.cacheRead)
  const cacheWrite = tokenValue(tokens?.cacheWrite)
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/** Token totals from a projection row, tolerating the historical field names. */
function totalsOf(row) {
  const totals = row?.val?.totals ?? row?.totals
  return withTotal({
    input: totals?.uncachedInputTokens ?? totals?.input,
    output: totals?.outputTokens ?? totals?.output,
    cacheRead: totals?.cacheReadTokens ?? totals?.cacheRead,
    cacheWrite: totals?.cacheWriteTokens ?? totals?.cacheWrite,
  })
}

/** `YYYY-MM-DD` in local time. */
function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** One session file (current layout) → a plain row, or null when unusable. */
function rowFromProjection(id, record, revision) {
  const identity = record?.identity
  const rows = record?.rows
  if (rows === null || typeof rows !== 'object') return null
  const createdAt = tokenValue(identity?.createdAt)
  if (createdAt <= 0) return null
  const tokens = totalsOf(rows.tokenUsage)
  if (tokens.total <= 0) return null
  const stats = rows.sessionStats?.val
  const selection = rows.modelSelection?.val
  const lastUsed = selection?.lastUsed ?? null
  const pressure = rows.contextPressure?.val
  const contextWindow = tokenValue(pressure?.contextWindow)
  const pressureTokens = tokenValue(pressure?.pressureTokens ?? pressure?.projectedTokens)
  const title = typeof rows.title?.val === 'string' ? rows.title.val : null
  return {
    id,
    title,
    createdAt,
    updatedAt: revision,
    tokens,
    turns: tokenValue(stats?.turns),
    steps: tokenValue(stats?.steps),
    requests: tokenValue(stats?.requests),
    model: typeof lastUsed?.model === 'string' ? lastUsed.model : null,
    provider: typeof lastUsed?.provider === 'string' ? lastUsed.provider : null,
    contextPressure:
      contextWindow > 0 && pressureTokens > 0
        ? { tokens: pressureTokens, contextWindow, ratio: Math.min(1, pressureTokens / contextWindow) }
        : null,
  }
}

/** Read the current per-session projection directory. */
function readProjectionDirectory(home) {
  const directory = join(home, 'storages', 'session_projcache', 'sessions')
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return null
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(directory, name)
    let parsed
    let revision = 0
    try {
      revision = statSync(path).mtimeMs
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const row = rowFromProjection(name.slice(0, -5), parsed?.record ?? parsed, revision)
    if (row !== null) rows.push(row)
  }
  return rows
}

/** Read the older single-file cache, if this deployment still has one. */
function readLegacyTable(home) {
  const path = join(home, 'storages', 'session_projcache.json')
  if (!existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const sessions = parsed?.tables?.sessions
  if (sessions === null || typeof sessions !== 'object') return null
  const rows = []
  for (const [id, record] of Object.entries(sessions)) {
    const row = rowFromProjection(id, record, tokenValue(record?.identity?.createdAt))
    if (row !== null) rows.push(row)
  }
  return rows
}

/** Aggregate rows into everything the page renders. */
function summarize(rows, days) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0, turns: 0, steps: 0 }
  const byModel = new Map()
  const byProvider = new Map()
  const activeDays = new Set()
  const todayKey = dayKey(Date.now())

  const series = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - offset)
    series.push({ date: dayKey(date.getTime()), total: 0, output: 0, sessions: 0 })
  }
  const seriesIndex = new Map(series.map((entry, index) => [entry.date, index]))

  let today = 0
  for (const row of rows) {
    totals.input += row.tokens.input
    totals.output += row.tokens.output
    totals.cacheRead += row.tokens.cacheRead
    totals.cacheWrite += row.tokens.cacheWrite
    totals.total += row.tokens.total
    totals.requests += row.requests
    totals.turns += row.turns
    totals.steps += row.steps

    const key = dayKey(row.createdAt)
    activeDays.add(key)
    if (key === todayKey) today += row.tokens.total
    const index = seriesIndex.get(key)
    if (index !== undefined) {
      series[index].total += row.tokens.total
      series[index].output += row.tokens.output
      series[index].sessions += 1
    }

    const modelKey = row.model ?? 'unknown'
    const modelEntry = byModel.get(modelKey) ?? {
      model: modelKey,
      provider: row.provider,
      sessions: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    modelEntry.sessions += 1
    for (const tokenKey of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      modelEntry.tokens[tokenKey] += row.tokens[tokenKey]
    }
    byModel.set(modelKey, modelEntry)

    const providerKey = row.provider ?? 'unknown'
    const providerEntry = byProvider.get(providerKey) ?? {
      provider: providerKey,
      sessions: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    providerEntry.sessions += 1
    for (const tokenKey of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      providerEntry.tokens[tokenKey] += row.tokens[tokenKey]
    }
    byProvider.set(providerKey, providerEntry)
  }

  const recent = [...rows]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      tokens: row.tokens,
      turns: row.turns,
      steps: row.steps,
      model: row.model,
      provider: row.provider,
      contextPressure: row.contextPressure,
    }))

  return {
    generatedAt: Date.now(),
    days,
    totals,
    today,
    byModel: [...byModel.values()].sort((left, right) => right.tokens.total - left.tokens.total).slice(0, 8),
    byProvider: [...byProvider.values()].sort((left, right) => right.tokens.total - left.tokens.total),
    byDay: series,
    sessions: recent,
    counts: { sessions: rows.length, activeDays: activeDays.size },
  }
}

/**
 * Build the local usage report.
 *
 * @param home - the DSH home directory (`$DSH_HOME`, usually `~/.dsh`).
 * @param options - `{ days }` for the daily series length.
 * @returns the report; never throws, and a missing cache yields zeroed totals.
 */
export function usageReport(home, options = {}) {
  const days = Math.min(60, Math.max(3, Math.round(Number(options.days) || 14)))
  const rows = readProjectionDirectory(home) ?? readLegacyTable(home) ?? []
  const report = summarize(rows, days)
  report.available = rows.length > 0
  return report
}
