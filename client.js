/**
 * Client half of the acp-rules panel bundle.
 *
 * Renders the current `acp_rule` list into the empty left gutter of the chat
 * page: a light-grey, right-aligned, wrapping block that hugs the chat column.
 * It hides itself when that gutter is too narrow, and never captures pointer
 * events (the chat underneath stays fully usable).
 */

window.__ModuleLoader__.load({
  id: 'dsh-billion-context-ruleshow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'acp-rules'
    const ROUTE = '/dsh-billion-context-ruleshow/state'
    const POLL_MS = 2000
    const MEASURE_MS = 600
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

    /** Resolved same-origin route, probed once and reused after that. */
    let resolvedRoute

    /** Read the folded rule list for one session; undefined when unreachable. */
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

    /** Parse a CSS length in px; undefined for anything else. */
    function parsePx(value) {
      const text = String(value ?? '').trim()
      if (!text.endsWith('px')) return undefined
      const number = Number.parseFloat(text)
      return Number.isFinite(number) ? number : undefined
    }

    /** Nearest ancestor of the chat flow slot that owns a real box: the chat column. */
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

    /** Box of the centred chat column, resolved from the DOM or the width custom properties. */
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

    /** 当前是否处于「对话」标签：轨迹、上下文标签下没有 chat flow 槽。 */
    function hasChatView() {
      return document.querySelector(FLOW_SELECTOR) !== null
    }

    /** Measure where the panel may sit: the left gutter, next to the chat column. */
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

    /** Session id the chat page is showing right now, read from the conversation DOM. */
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

    /** The gutter-side rule list. */
    function AcpRulesPanel(props) {
      const t = props.t
      const [data, setData] = React.useState({ sessionId: undefined, rules: [], billionContextEnabled: false })
      const [place, setPlace] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        const load = async () => {
          const sessionId = visibleSessionId()
          if (sessionId === undefined) {
            if (!cancelled) {
              setData((previous) => (
                previous.sessionId === undefined && previous.rules.length === 0
                  ? previous
                  : { sessionId: undefined, rules: [], billionContextEnabled: previous.billionContextEnabled }
              ))
            }
            return
          }
          const payload = await readRules(sessionId, controller.signal)
          if (cancelled || payload === undefined) return
          const next = Array.isArray(payload.rules)
            ? payload.rules
              .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.text === 'string' && rule.text !== '')
              .map((rule) => ({ id: String(rule.id ?? ''), text: rule.text }))
            : []
          const billionContextOn = payload.billionContextEnabled === true
          setData((previous) => (
            previous.sessionId === sessionId
              && previous.billionContextEnabled === billionContextOn
              && sameRules(previous.rules, next)
              ? previous
              : { sessionId, rules: next, billionContextEnabled: billionContextOn }
          ))
        }
        void load()
        const timer = window.setInterval(load, POLL_MS)
        const refresh = () => { void load() }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          cancelled = true
          controller.abort()
          window.clearInterval(timer)
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [])

      React.useEffect(() => {
        const update = () => {
          const next = measure()
          setPlace((previous) => (samePlace(previous, next) ? previous : next))
        }
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
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
        const tick = () => {
          track()
          update()
        }
        tick()
        const timer = window.setInterval(tick, MEASURE_MS)
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
      }
    }
  }
})
