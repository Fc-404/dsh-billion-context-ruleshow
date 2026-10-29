/**
 * billion-context 规则侧栏的 Client 半边。
 *
 * 渲染当前 `acp_rule` 列表到聊天页的左侧空白：浅灰、靠右、自动换行，紧贴聊天列；
 * 空白不足时隐藏，并且永远不拦截指针事件。
 *
 * 数据主通道是 session projection 的 wire view：Host 侧增量折叠会话事件，
 * Client 通过会话绑定直接订阅（变化即时到达，不轮询）。
 * 只有拿不到会话绑定时才退化为低频轮询同源路由。
 */

window.__ModuleLoader__.load({
  id: 'dsh-billion-context-ruleshow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'acp-rules'
    const ROUTE = '/dsh-billion-context-ruleshow/state'
    const RULES_KEY = 'billion-context-rules'

    /** 兜底轮询间隔：只在订阅不可用时使用。 */
    const POLL_MS = 5000
    /** 校准间隔：低频拉取 billion-context 是否启用（订阅通道不带该字段）。 */
    const META_MS = 15000
    /** 可见会话检查间隔：只读 DOM，代价极低。 */
    const SESSION_CHECK_MS = 1200
    /** 布局兜底重测间隔（正常情况下由 ResizeObserver 驱动）。 */
    const MEASURE_FALLBACK_MS = 1500

    const MAX_WIDTH = 320
    const MIN_WIDTH = 140
    const HIDE_GUTTER = 180
    const CHAT_GAP = 16
    const EDGE_INSET = 12
    const MAX_RULES = 40

    const BODY_SELECTOR = '[data-conversation-content][data-conversation-region="chat"]'
    const FLOW_SELECTOR = '[data-slot="conversation.chat.flow"]'
    const OVERLAY_SELECTOR = '[data-shell-overlay]'

    const dictionaries = {
      zh: { title: '规则' },
      en: { title: 'Rules' }
    }

    /** 由 apply 注入的 DSH Client sessions 服务；为空时走路由轮询。 */
    let sessionsApi = null

    /** 解析成功的同源路由，探测一次后复用。 */
    let resolvedRoute

    /** 读某个会话的规则快照（兜底/校准通道）；不可达时返回 undefined。 */
    async function readRules(sessionId, signal) {
      const query = `?sessionId=${encodeURIComponent(sessionId)}`
      const candidates = resolvedRoute === undefined ? [ROUTE, ROUTE.slice(1)] : [resolvedRoute]
      for (const candidate of candidates) {
        let target
        try {
          target = new URL(candidate, document.baseURI)
        } catch {
          continue
        }
        let response
        try {
          response = await fetch(`${target.href}${query}`, {
            signal,
            headers: { accept: 'application/json' },
            credentials: 'same-origin'
          })
        } catch (error) {
          if (signal?.aborted === true) return undefined
          continue
        }
        const type = response.headers.get('content-type') ?? ''
        if (!response.ok || !type.includes('application/json')) continue
        resolvedRoute = candidate
        try {
          return await response.json()
        } catch {
          return undefined
        }
      }
      return undefined
    }

    /** 把任意来源的规则数组整理成 `[{ id, text }]`。 */
    function normaliseRules(list) {
      if (!Array.isArray(list)) return []
      return list
        .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.text === 'string' && rule.text !== '')
        .map((rule) => ({ id: String(rule.id ?? ''), text: rule.text }))
    }

    /** 解析 px 长度；其他单位返回 undefined。 */
    function parsePx(value) {
      const text = String(value ?? '').trim()
      if (!text.endsWith('px')) return undefined
      const number = Number.parseFloat(text)
      return Number.isFinite(number) ? number : undefined
    }

    /** 从 chat flow 槽向上找真正有盒子的祖先：聊天列。 */
    function chatColumnElement(body, bodyRect) {
      const flow = body.querySelector(FLOW_SELECTOR)
      let node = flow
      while (node !== null && node !== body) {
        let style = null
        try {
          style = window.getComputedStyle(node)
        } catch {}
        if (style !== null && style.display !== 'contents') {
          const rect = node.getBoundingClientRect()
          if (rect.width > 0 && rect.width < bodyRect.width - 1) return node
        }
        node = node.parentElement
      }
      return null
    }

    /** 聊天列的盒子：优先真实元素，其次读宽度自定义属性。 */
    function chatColumnRect(body, bodyRect) {
      const column = chatColumnElement(body, bodyRect)
      if (column !== null) return column.getBoundingClientRect()
      let style = null
      try {
        style = window.getComputedStyle(body)
      } catch {}
      const declared = style === null
        ? undefined
        : parsePx(style.getPropertyValue('--dsh-chat-user-width'))
          ?? parsePx(style.getPropertyValue('--dsh-chat-content-width'))
      const width = declared ?? Math.max(640, Math.min(bodyRect.width * 0.64, 920))
      const left = bodyRect.left + Math.max(0, (bodyRect.width - width) / 2)
      return { left, right: left + width, width, top: bodyRect.top, bottom: bodyRect.bottom, height: bodyRect.height }
    }

    /** 当前是否在「对话」标签：轨迹、上下文标签下没有 chat flow 槽。 */
    function hasChatView() {
      return document.querySelector(FLOW_SELECTOR) !== null
    }

    /** 量出面板位置：左侧空白、紧贴聊天列。 */
    function measure() {
      if (!hasChatView()) return null
      const body = document.querySelector(BODY_SELECTOR)
      if (body === null) return null
      const bodyRect = body.getBoundingClientRect()
      if (bodyRect.width < 320 || bodyRect.height < 120) return null

      const columnRect = chatColumnRect(body, bodyRect)
      const contentLeft = columnRect === null ? bodyRect.left + bodyRect.width / 2 : columnRect.left
      const gutter = contentLeft - bodyRect.left
      if (!Number.isFinite(gutter) || gutter < HIDE_GUTTER) return null

      const available = contentLeft - CHAT_GAP - (bodyRect.left + EDGE_INSET)
      const width = Math.floor(Math.min(MAX_WIDTH, available))
      if (width < MIN_WIDTH) return null

      const overlay = document.querySelector(OVERLAY_SELECTOR)
      const base = overlay === null ? null : overlay.getBoundingClientRect()
      const top = Math.round(bodyRect.top + 18 - (base === null ? 0 : base.top))
      return {
        position: base === null ? 'fixed' : 'absolute',
        left: Math.round(contentLeft - CHAT_GAP - width - (base === null ? 0 : base.left)),
        top,
        width,
        height: Math.max(0, Math.floor(bodyRect.height - 36))
      }
    }

    /** 聊天页当前展示的会话 id（从会话 DOM 读取）。 */
    function visibleSessionId() {
      const body = document.querySelector(BODY_SELECTOR)
      const id = body === null ? null : body.getAttribute('data-conversation-session')
      return typeof id === 'string' && id !== '' ? id : undefined
    }

    function samePlace(left, right) {
      if (left === right) return true
      if (left === null || right === null) return false
      return left.position === right.position
        && left.left === right.left
        && left.top === right.top
        && left.width === right.width
        && left.height === right.height
    }

    function sameRules(left, right) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        if (left[index].id !== right[index].id || left[index].text !== right[index].text) return false
      }
      return true
    }

    /** 左侧空白里的规则列表。 */
    function AcpRulesPanel(props) {
      const t = props.t
      const [data, setData] = React.useState({ sessionId: undefined, rules: [], billionContextEnabled: false })
      const [place, setPlace] = React.useState(null)

      // 数据通道：优先订阅会话投影的 wire view，拿不到绑定时退化为低频轮询。
      React.useEffect(() => {
        let cancelled = false
        let subscription = null
        let subscribedSession
        let pollTimer = null
        let sessionTimer = null
        let metaTimer = null
        const rulesRef = { value: [] }
        const enabledRef = { value: false }

        const detach = () => {
          if (subscription !== null) {
            try { subscription() } catch {}
            subscription = null
          }
          subscribedSession = undefined
        }

        const commit = (sessionId, rules, enabled) => {
          if (cancelled) return
          rulesRef.value = rules
          enabledRef.value = enabled
          setData((previous) => (
            previous.sessionId === sessionId
              && previous.billionContextEnabled === enabled
              && sameRules(previous.rules, rules)
              ? previous
              : { sessionId, rules, billionContextEnabled: enabled }
          ))
        }

        const attach = (sessionId) => {
          detach()
          if (sessionsApi === null) return false
          let binding
          try {
            binding = sessionsApi.binding(sessionId)
          } catch {
            binding = undefined
          }
          const projections = binding?.session?.projections
          if (projections === undefined || projections === null || typeof projections.faceOf !== 'function') return false
          let face
          try {
            face = projections.faceOf(RULES_KEY)
          } catch {
            return false
          }
          if (face === null || typeof face !== 'object' || typeof face.subscribe !== 'function') return false
          const readFace = () => {
            if (cancelled) return
            let value
            try {
              value = face.getSnapshot()
            } catch {
              return
            }
            const wireRules = normaliseRules(value?.rules)
            // 投影只认会话事件里的 acp_rule 调用；bili 面板等外部入口写入的规则不在投影里。
            // 空投影不覆盖路由已拿到的规则，避免面板闪空。
            if (wireRules.length === 0 && rulesRef.value.length > 0) return
            commit(sessionId, wireRules, enabledRef.value)
          }
          try {
            subscription = face.subscribe(readFace)
            readFace()
          } catch {
            subscription = null
            return false
          }
          subscribedSession = sessionId
          return true
        }

        const ensurePoll = () => {
          if (subscription !== null) {
            if (pollTimer !== null) {
              window.clearInterval(pollTimer)
              pollTimer = null
            }
            return
          }
          if (pollTimer === null) pollTimer = window.setInterval(() => { void refresh() }, POLL_MS)
        }

        const refresh = async () => {
          const sessionId = visibleSessionId()
          if (sessionId === undefined) {
            detach()
            commit(undefined, [], enabledRef.value)
            ensurePoll()
            return
          }
          if (subscribedSession !== sessionId) attach(sessionId)
          ensurePoll()
          if (document.visibilityState === 'hidden') return
          const payload = await readRules(sessionId)
          if (cancelled || payload === undefined) return
          const enabled = payload.billionContextEnabled === true
          // 路由已把投影与 bili 持久化状态合并，优先采用；订阅只负责即时补投影内的新规则。
          const rules = normaliseRules(payload.rules)
          commit(sessionId, rules, enabled)
        }

        const checkSession = () => {
          const sessionId = visibleSessionId()
          if (sessionId === subscribedSession) {
            ensurePoll()
            return
          }
          detach()
          if (sessionId !== undefined) attach(sessionId)
          ensurePoll()
          void refresh()
        }

        const onFocus = () => { void refresh() }
        const onVisibility = () => { void refresh() }

        void refresh()
        sessionTimer = window.setInterval(checkSession, SESSION_CHECK_MS)
        metaTimer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void refresh()
        }, META_MS)
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
          cancelled = true
          detach()
          if (pollTimer !== null) window.clearInterval(pollTimer)
          if (sessionTimer !== null) window.clearInterval(sessionTimer)
          if (metaTimer !== null) window.clearInterval(metaTimer)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      // 布局通道：ResizeObserver 驱动，低频兜底重测。
      React.useEffect(() => {
        const update = () => {
          const next = measure()
          setPlace((previous) => (samePlace(previous, next) ? previous : next))
        }
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => update()) : null
        let observed = null
        const track = () => {
          if (observer === null) return
          const body = document.querySelector(BODY_SELECTOR)
          const column = body === null ? null : chatColumnElement(body, body.getBoundingClientRect())
          const target = column ?? body
          if (target === observed) return
          if (observed !== null) observer.disconnect()
          observed = target
          if (target !== null) observer.observe(target)
        }
        update()
        track()
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'hidden') return
          track()
          update()
        }, MEASURE_FALLBACK_MS)
        window.addEventListener('resize', update)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('resize', update)
          if (observer !== null) observer.disconnect()
        }
      }, [])

      const currentSession = visibleSessionId()

      if (data.billionContextEnabled !== true) return null
      if (data.sessionId === undefined || currentSession === undefined || data.sessionId !== currentSession) return null
      if (data.rules.length === 0) return null
      if (place === null) return null

      const rules = data.rules
      const visible = rules.slice(0, MAX_RULES)
      return h(
        'div',
        {
          'data-billion-context-ruleshow': '',
          style: {
            position: place.position,
            left: `${place.left}px`,
            top: `${place.top}px`,
            width: `${place.width}px`,
            maxHeight: `${place.height}px`,
            zIndex: 1,
            display: 'grid',
            gridTemplateColumns: 'auto fit-content(100%)',
            justifyContent: 'end',
            alignItems: 'start',
            columnGap: '6px',
            rowGap: '7px',
            overflow: 'hidden',
            pointerEvents: 'none',
            userSelect: 'none',
            textAlign: 'right',
            textWrap: 'pretty',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #9a9a9a))',
            fontSize: 'calc(var(--dsh-content-font-size, 14px) * 0.85)',
            lineHeight: 1.5
          }
        },
        visible.flatMap((rule, index) => {
          const ruleKey = rule.id === '' ? `rule-${rule.text}` : rule.id
          return [
            h(
              'span',
              {
                key: `${ruleKey}:index`,
                style: { minWidth: '1.9em', textAlign: 'right', opacity: 0.65 }
              },
              `${index + 1}、`
            ),
            h(
              'span',
              {
                key: `${ruleKey}:text`,
                style: {
                  minWidth: 0,
                  textAlign: 'left',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word'
                }
              },
              rule.text
            )
          ]
        })
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'billion-context-ruleshow: dictionaries')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'billion-context-ruleshow',
            order: 40,
            locale: NS
          },
          AcpRulesPanel
        ))
        // 投影订阅通道：sessions 服务可用时用会话绑定读 wire view（免轮询）。
        try {
          ctx.inject(['sessions'], (sessionCtx) => {
            sessionsApi = sessionCtx.sessions
          })
        } catch {}
      }
    }
  }
})
