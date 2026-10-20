/**
 * dsh-quota-board — where the prober writes down how it reached a gateway.
 *
 * The generic adapter tries a handful of endpoints and stops at the first one
 * that answers with a number. Repeating that discovery on every refresh — and
 * again after every restart — means a working gateway pays several 404s
 * forever, and an unusual one gets re-guessed even though it was figured out
 * yesterday.
 *
 * So the result is remembered here: one small JSON keyed by API root, holding
 * the endpoint that answered and how the body was read.
 *
 * It is deliberately *not* part of the plugin config. This is discovered state,
 * not a setting: writing it back into `cordis.patch.yml` would edit the user's
 * configuration behind their back, and a stale binding is worthless anyway —
 * when the recorded endpoint stops answering, the prober re-discovers and
 * overwrites it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Where bindings live. Under the Harness home rather than the plugin directory:
 * a `link:` install points at a working copy, and state belongs with the app.
 *
 * @param home - the DSH home directory.
 */
export function bindingStorePath(home) {
  return join(home, 'storages', 'quota-board', 'bindings.json')
}

/**
 * The key one API root is filed under.
 *
 * `https://gw.example.com/v1` and `https://gw.example.com` are the same account,
 * so the version suffix is normalized away — otherwise adding or removing `/v1`
 * in the config would silently lose the binding.
 *
 * @param baseURL - a provider's configured base URL.
 */
export function bindingKeyOf(baseURL) {
  return String(baseURL ?? '')
    .trim()
    .replace(/\/+$/u, '')
    .replace(/\/v1$/u, '')
}

/**
 * Read the store.
 *
 * A missing or corrupt file reads as empty: a cache that fails to parse must not
 * take the dashboard down with it, and re-probing costs a few requests.
 *
 * @param file - path from `bindingStorePath`.
 * @returns `{ [apiRoot]: { endpoint, kind, updatedAt } }`.
 */
export function readBindings(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * Write the store atomically.
 *
 * Written through a temporary file in the same directory, because the previous
 * run's file is still readable if the process dies mid-write — and a truncated
 * JSON would cost every provider its binding.
 *
 * @returns true when something was written, false when the file was unchanged.
 */
export function writeBindings(file, bindings) {
  const payload = `${JSON.stringify(bindings, null, 2)}\n`
  let previous = null
  try {
    previous = readFileSync(file, 'utf8')
  } catch {
    /* first run */
  }
  if (previous === payload) return false
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, file)
  return true
}

/**
 * Turn one probe result into a binding record.
 *
 * Only the things needed to skip discovery next time are kept. The field
 * mapping is not copied in: the body is re-read by shape every time, and a
 * recorded shape name would go stale the moment a gateway changes its response.
 *
 * @param result - what the adapter reported: `{ endpoint, kind }`.
 * @param now - clock, injected so tests are deterministic.
 */
export function makeBinding(result, now = Date.now()) {
  return {
    endpoint: String(result?.endpoint ?? ''),
    kind: result?.kind === 'billing' ? 'billing' : 'json',
    updatedAt: new Date(now).toISOString(),
  }
}
