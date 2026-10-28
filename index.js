/**
 * billion-context 规则侧栏的 Host 半边。
 *
 * billion-context 插件把 `acp_rule` 工具注册进当前会话，因此每次规则变更都会
 * 以普通 `tool/call` + `tool/result` 事件写进会话日志。本插件把这段日志增量
 * 折叠成「当前规则列表」，并通过两条通道交给 Client：
 *
 * 1. session projection（主通道）：事件驱动、每个事件 O(1)，Client 直接订阅
 *    projection 的 wire view，不需要轮询；
 * 2. 同源 HTTP 路由（兜底 + 校准）：Client 拿不到会话绑定时退化为低频轮询，
 *    同时用它校准 billion-context 是否启用。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'billion-context-ruleshow'

/** 必须先就绪的服务：会话查询、路由注册、投影注册。 */
export const inject = ['agents', 'webServer', 'sessionProjections']

const RULE_TOOL_NAME = 'acp_rule'
const ROUTE_PATH = '/dsh-billion-context-ruleshow/state'

/** Client 订阅用的投影 key，两侧必须一致。 */
const RULES_PROJECTION_KEY = 'billion-context-rules'

/** 未匹配结果的 pending 调用的上限，防止异常会话把状态撑大。 */
const PENDING_LIMIT = 256

/** 本面板只服务 billion-context 插件：判断它在当前 profile 是否启用。 */
const BILLION_CONTEXT_BUNDLE = 'billion-context'
const BILLION_CONTEXT_PLUGIN_IDS = ['bili-native', 'bili-compaction-gate', 'billion-context']

/** 这些结果片段表示规则工具拒绝了本次变更。 */
const FAILURE_HINTS = [
  'rule text is empty',
  'char limit',
  'identical rule already exists',
  'rule limit reached',
  'no rule with id'
]

/** 投影 schema 只用到 parse（含 stateSchema 与 wire.viewSchema）。 */
const PASS_SCHEMA = { parse: (value) => value }

/** 从 tool-result 消息的 content 里取出纯文本。 */
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

/** 结果文本是否表示本次规则变更被拒绝。 */
function isFailureText(text, isError) {
  if (isError === true) return true
  const body = text.trim()
  if (body === '') return true
  return FAILURE_HINTS.some((hint) => body.includes(hint))
}

/** 把 `acp_rule` 的入参归类为四种操作之一。 */
function classifyArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { kind: 'list' }
  if (typeof args.rule === 'string') return { kind: 'add', text: args.rule }
  if (typeof args.delete === 'string') return { kind: 'delete', id: args.delete.trim() }
  if (args.clear === true) return { kind: 'clear' }
  return { kind: 'list' }
}

/** 解析 tool-call 的原始入参（JSON 字符串或已解析对象）。 */
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

/** 规则列表里已出现的最大 `ruleN` 编号。 */
function highestRuleNumber(rules) {
  let highest = 0
  for (const rule of rules) {
    const match = /^rule(\d+)$/.exec(rule.id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** 把工具返回的权威规则列表解析成 `[{ id, text }]`。 */
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

/** 先乐观应用一次规则调用，让面板在结果回来前就反应。 */
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

/** 用工具结果校正乐观列表，得到权威状态。 */
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
    // 成功但措辞未知：保留乐观项，只去掉标记。
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

/** 初始投影状态（可序列化，供 checkpoint/restore 使用）。 */
function initialState() {
  return { rules: [], nextId: 1, pending: {} }
}

/**
 * 把一条会话事件应用到投影状态。
 * 无变化时返回同一引用（投影注册表靠 Object.is 判断是否通知）。
 */
function stepProjectionState(state, event) {
  const data = event?.data
  if (event?.type === 'tool/call') {
    if (data?.name !== RULE_TOOL_NAME) return state
    const callId = String(data.callId)
    const next = { rules: state.rules, nextId: state.nextId, pending: { ...state.pending } }
    next.pending[callId] = beginCall(next, callId, parseToolArguments(data.arguments))
    const keys = Object.keys(next.pending)
    if (keys.length > PENDING_LIMIT) delete next.pending[keys[0]]
    return next
  }
  if (event?.type === 'tool/result') {
    const message = data?.message
    const callId = message?.source?.callId
    if (callId === undefined) return state
    const key = String(callId)
    const pending = state.pending[key]
    if (pending === undefined) return state
    const next = { rules: state.rules, nextId: state.nextId, pending: { ...state.pending } }
    delete next.pending[key]
    settleCall(next, pending, contentText(message?.content), message)
    return next
  }
  return state
}

/** 把投影状态里的规则整理成对外形状。 */
function visibleRules(rules) {
  if (!Array.isArray(rules)) return []
  return rules
    .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.text === 'string' && rule.text.trim() !== '')
    .map((rule) => ({ id: String(rule.id ?? ''), text: rule.text }))
}

/** 注册给 sessionProjections 的增量投影定义。 */
const rulesProjection = {
  key: RULES_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: PASS_SCHEMA,
  init: () => initialState(),
  apply: (state, event) => stepProjectionState(state === undefined ? initialState() : state, event),
  wire: {
    viewSchema: PASS_SCHEMA,
    view: (state) => ({ rules: visibleRules(state?.rules) })
  }
}

/** 兜底：会话没有投影（例如注册表尚未构建）时，全量折叠一次事件日志。 */
function foldRules(session) {
  const state = { rules: [], nextId: 1, pending: new Map() }
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  for (const event of events) {
    const data = event?.data
    if (event?.type === 'tool/call') {
      if (data?.name !== RULE_TOOL_NAME) continue
      const callId = String(data.callId)
      state.pending.set(callId, beginCall(state, callId, parseToolArguments(data.arguments)))
      if (state.pending.size > PENDING_LIMIT) state.pending.delete(state.pending.keys().next().value)
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
  return visibleRules(state.rules)
}

/** 优先读增量投影，退不到投影时再全量折叠；via 用于诊断数据通道。 */
function readRules(ctx, session) {
  try {
    const state = ctx.sessionProjections.stateOf(session, RULES_PROJECTION_KEY)
    if (state !== undefined && state !== null) return { rules: visibleRules(state.rules), via: 'projection' }
  } catch {}
  return { rules: foldRules(session), via: 'fold' }
}

/** 找到聊天页当前显示的会话，活跃 agent 优先。 */
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

/** billion-context 插件是否在当前 profile 里启用：看插件清单与 patch 里的禁用覆盖。 */
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

/** 读盘结果缓存几秒，路由被校准时不会反复读配置文件。 */
function billionContextEnabled() {
  const now = Date.now()
  if (billionContextEnabledCache.value !== undefined && now - billionContextEnabledCache.at < 5000) return billionContextEnabledCache.value
  const value = readBillionContextEnabled()
  billionContextEnabledCache = { value, at: now }
  return value
}

/** 把规则列表与启用状态作为 JSON 返回给 Client（兜底与校准通道）。 */
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
      if (session === undefined) {
        payload = { ok: false, billionContextEnabled: billionContextOn, rules: [], error: 'session not found' }
      } else {
        const loaded = readRules(ctx, session)
        payload = { ok: true, billionContextEnabled: billionContextOn, rules: loaded.rules, via: loaded.via }
      }
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

/** 注册增量投影与同源路由。 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.sessionProjections.register(rulesProjection),
    'billion-context-ruleshow: rules projection'
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handleState(ctx) }),
    'billion-context-ruleshow: rules route'
  )
}
