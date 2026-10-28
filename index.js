/**
 * Host half of the acp-rules panel bundle.
 *
 * The billion-context plugin registers the `acp_rule` tool from the
 * billion-context proxy manifest into this session, so every rule change is written to
 * the session log as a normal `tool/call` + `tool/result` pair. This module
 * folds that log into the current rule list and serves it on a same-origin
 * route; the Client half only renders the result.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'billion-context-ruleshow'

/** Services that must be ready before this plugin mounts. */
export const inject = ['agents', 'webServer']

const RULE_TOOL_NAME = 'acp_rule'
const ROUTE_PATH = '/dsh-billion-context-ruleshow/state'

/** 本面板只服务 billion-context 插件：判断它在当前 profile 是否启用。 */
const BILLION_CONTEXT_BUNDLE = 'billion-context'
const BILLION_CONTEXT_PLUGIN_IDS = ['bili-native', 'bili-compaction-gate', 'billion-context']

/** Result fragments that mean the rule tool refused the change. */
const FAILURE_HINTS = [
  'rule text is empty',
  'char limit',
  'identical rule already exists',
  'rule limit reached',
  'no rule with id'
]

/** Read plain text out of a tool-result message content value. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (typeof part === 'string') text += part
      else if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text
    }
    return text
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** Whether a tool-result body reports a refused rule change. */
function isFailureText(text, isError) {
  if (isError === true) return true
  const body = text.trim()
  if (body === '') return true
  return FAILURE_HINTS.some((hint) => body.includes(hint))
}

/** Classify `acp_rule` tool arguments into one of the four operations. */
function classifyArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { kind: 'list' }
  if (typeof args.rule === 'string') return { kind: 'add', text: args.rule }
  if (typeof args.delete === 'string') return { kind: 'delete', id: args.delete.trim() }
  if (args.clear === true) return { kind: 'clear' }
  return { kind: 'list' }
}

/** Parse raw tool-call arguments (JSON text, or an already parsed object). */
function parseToolArguments(raw) {
  if (raw === null || raw === undefined) return { kind: 'list' }
  if (typeof raw === 'object') return classifyArguments(raw)
  const text = String(raw).trim()
  if (text === '') return { kind: 'list' }
  try {
    return classifyArguments(JSON.parse(text))
  } catch {
    return { kind: 'list' }
  }
}

/** Highest `ruleN` number already present in the list. */
function highestRuleNumber(rules) {
  let highest = 0
  for (const rule of rules) {
    const match = /^rule(\d+)$/.exec(rule.id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** Parse the tool's authoritative rule listing into `[{ id, text }]`. */
function parseRulesList(text) {
  const body = text.trim()
  if (/^no rules recorded\.?$/i.test(body)) return []
  const rules = []
  let current
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s*\[([^\]]+)\]\s?(.*)$/.exec(line)
    if (match !== null) {
      current = { id: match[1].trim(), text: match[2] }
      rules.push(current)
      continue
    }
    if (current !== undefined) current.text += `\n${line}`
  }
  if (rules.length === 0) return undefined
  return rules.map((rule) => ({ id: rule.id, text: rule.text.replace(/\s+$/, '') }))
}

/** Apply a rule call optimistically so the panel reacts before the result. */
function beginCall(state, callId, operation) {
  const key = `pending:${callId}`
  if (operation.kind === 'add') {
    const next = Math.max(state.nextId, highestRuleNumber(state.rules) + 1, 1)
    const rule = { id: `rule${next}`, text: operation.text, pending: key }
    state.rules = [...state.rules, rule]
    state.nextId = next + 1
    return { operation, ruleId: rule.id, key }
  }
  if (operation.kind === 'delete') {
    const index = state.rules.findIndex((rule) => rule.id === operation.id)
    if (index === -1) return { operation, key }
    const removed = state.rules[index]
    state.rules = state.rules.filter((_, position) => position !== index)
    return { operation, removed, index, key }
  }
  if (operation.kind === 'clear') {
    const backup = state.rules
    state.rules = []
    return { operation, backup, key }
  }
  return { operation, key }
}

/** Reconcile the optimistic rule list with the tool result that settles it. */
function settleCall(state, pending, text, message) {
  const failure = isFailureText(text, message?.isError === true)
  const body = text.trim()
  const { operation } = pending

  if (operation.kind === 'add') {
    const match = /^Recorded\s+([^\s:]+):\s*([\s\S]*)$/.exec(body)
    if (match !== null) {
      const id = match[1].trim()
      const ruleText = match[2].replace(/\s+$/, '')
      const others = state.rules.filter((rule) => rule.id !== pending.ruleId)
      state.rules = others.some((rule) => rule.id === id) ? others : [...others, { id, text: ruleText }]
      const numbered = /^rule(\d+)$/.exec(id)
      if (numbered !== null) state.nextId = Math.max(state.nextId, Number(numbered[1]) + 1)
      return
    }
    if (failure) {
      state.rules = state.rules.filter((rule) => rule.id !== pending.ruleId)
      return
    }
    // Unknown success wording: keep the optimistic entry but drop its marker.
    state.rules = state.rules.map((rule) => (rule.pending === pending.key ? { id: rule.id, text: rule.text } : rule))
    return
  }

  if (operation.kind === 'delete') {
    if (failure && pending.removed !== undefined) {
      const rest = [...state.rules]
      const index = Math.min(pending.index ?? rest.length, rest.length)
      rest.splice(index, 0, pending.removed)
      state.rules = rest
    }
    return
  }

  if (operation.kind === 'clear') {
    if (failure) state.rules = pending.backup ?? state.rules
    return
  }

  const snapshot = parseRulesList(body)
  if (snapshot !== undefined) {
    state.rules = snapshot
    state.nextId = Math.max(state.nextId, highestRuleNumber(snapshot) + 1)
  }
}

/** Fold one session's event log into the rule list it currently holds. */
function foldRules(session) {
  const state = { rules: [], nextId: 1, pending: new Map() }
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  for (const event of events) {
    const data = event?.data
    if (event?.type === 'tool/call') {
      if (data?.name !== RULE_TOOL_NAME) continue
      const callId = String(data.callId)
      state.pending.set(callId, beginCall(state, callId, parseToolArguments(data.arguments)))
      if (state.pending.size > 256) state.pending.delete(state.pending.keys().next().value)
      continue
    }
    if (event?.type === 'tool/result') {
      const message = data?.message
      const callId = message?.source?.callId
      if (callId === undefined) continue
      const key = String(callId)
      const pending = state.pending.get(key)
      if (pending === undefined) continue
      state.pending.delete(key)
      settleCall(state, pending, contentText(message?.content), message)
    }
  }
  return state.rules
    .filter((rule) => typeof rule.text === 'string' && rule.text.trim() !== '')
    .map((rule) => ({ id: rule.id, text: rule.text }))
}

/** Resolve the session a chat page is showing, live agent first. */
function findSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const agent = ctx.agents.get(sessionId)
    if (agent?.session !== undefined) return agent.session
  } catch {}
  try {
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (session !== undefined) return session
  } catch {}
  return undefined
}

/** 当前 profile 目录：DSH_PROFILE_DIR 优先，否则按 DSH_HOME/DSH_PROFILE 推导。 */
function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

/** billion-context插件是否在当前 profile 里启用：看插件清单与 patch 里的禁用覆盖。 */
function readBillionContextEnabled() {
  const dir = profileDir()
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  const bundles = manifest?.dsh?.profile?.bundles
  const dependencies = manifest?.dependencies
  const listed = Array.isArray(bundles) && bundles.includes(BILLION_CONTEXT_BUNDLE)
  const installed = dependencies !== null && typeof dependencies === 'object'
    && Object.prototype.hasOwnProperty.call(dependencies, BILLION_CONTEXT_BUNDLE)
  if (!listed && !installed) return false

  let patch = ''
  try {
    patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return true
  }
  for (const entry of patch.split(/\n(?=\s*-\s+(?:id|name):)/)) {
    if (!/\bdisabled\s*:\s*true\b/.test(entry)) continue
    if (BILLION_CONTEXT_PLUGIN_IDS.some((id) => entry.includes(`id: ${id}`) || entry.includes(`"${id}"`))) return false
  }
  return true
}

let billionContextEnabledCache = { value: undefined, at: 0 }

/** 读盘结果缓存几秒，轮询时不会反复读配置文件。 */
function billionContextEnabled() {
  const now = Date.now()
  if (billionContextEnabledCache.value !== undefined && now - billionContextEnabledCache.at < 3000) return billionContextEnabledCache.value
  const value = readBillionContextEnabled()
  billionContextEnabledCache = { value, at: now }
  return value
}

/** Serve the folded rule list as JSON for the Client half. */
function handleState(ctx) {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    let payload
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const session = findSession(ctx, sessionId)
      const billionContextOn = billionContextEnabled()
      payload = session === undefined
        ? { ok: false, billionContextEnabled: billionContextOn, rules: [], error: 'session not found' }
        : { ok: true, billionContextEnabled: billionContextOn, rules: foldRules(session) }
    } catch (error) {
      payload = { ok: false, rules: [], error: String(error?.message ?? error) }
    }
    const body = JSON.stringify(payload)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
}

/** Register the same-origin route the panel polls. */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handleState(ctx) }),
    'billion-context-ruleshow: rules route'
  )
}
