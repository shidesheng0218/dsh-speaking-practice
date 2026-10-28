/**
 * dsh-speaking-practice — browser half (v0.4.3 overlay, inline styles).
 *
 * Interaction notes:
 * - every control has hover / press feedback and the panel/cards animate in;
 * - starting, stopping and shadow-start are optimistic: the card changes on the
 *   click, not after the next poll, and a POST triggers an immediate refresh;
 * - polling runs at 300ms while a session is live and 1200ms when idle;
 * - no injected <style> (CSP-safe); animations use the Web Animations API and
 *   SVG SMIL, and respect prefers-reduced-motion.
 */
window.__ModuleLoader__.load({
  id: 'dsh-speaking-practice',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const C = {
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      brandFill: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      soft: 'var(--dsw-alias-bg-layer-2, #f7f9fc)',
      border: 'var(--dsw-alias-border-l2, #e5e9f2)',
      ink: 'var(--dsw-alias-label-primary, #1f2937)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      danger: '#dc2626',
      ok: '#16a34a',
      warn: '#ea580c',
      glass: 'color-mix(in srgb, var(--dsw-alias-bg-overlay, #ffffff) 88%, transparent)',
      hairline: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2937) 9%, transparent)',
      hairlineSoft: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2937) 6%, transparent)',
      hoverTint: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2937) 5%, transparent)',
      brandTint: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 8%, transparent)',
    }

    const S = {
      wrap: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 30 },
      backdrop: { position: 'absolute', inset: 0, pointerEvents: 'auto', background: 'transparent' },
      launcher: {
        position: 'absolute', right: 22, bottom: 96, pointerEvents: 'auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 46, height: 46, padding: 0,
        borderRadius: 999, border: '1px solid ' + C.hairline,
        background: C.glass,
        backdropFilter: 'blur(18px) saturate(1.45)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.45)',
        color: C.ink, cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(15,23,42,.05), 0 8px 24px rgba(15,23,42,.12), inset 0 1px 0 rgba(255,255,255,.6)',
        transition: 'transform .18s cubic-bezier(.22,.61,.36,1), box-shadow .18s ease, border-color .18s ease',
        fontFamily: 'inherit',
      },
      card: {
        position: 'absolute', right: 22, bottom: 96, pointerEvents: 'auto',
        width: 372, maxWidth: 'calc(100vw - 44px)', maxHeight: 'calc(100vh - 140px)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        borderRadius: 18, border: '1px solid ' + C.hairline,
        background: C.glass,
        backdropFilter: 'blur(24px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
        color: C.ink,
        boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 16px 40px rgba(15,23,42,.16), 0 40px 80px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.5)',
        fontFamily: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: '1px solid ' + C.hairlineSoft },
      title: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, letterSpacing: '.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      dot: { width: 7, height: 7, borderRadius: 999, background: C.muted, flex: '0 0 auto' },
      phase: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
      timer: { fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' },
      body: { display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', overflowY: 'auto' },
      sectionLabel: { fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: C.muted, marginBottom: 2 },
      option: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 11px',
        borderRadius: 11, border: '1px solid transparent', background: 'transparent',
        color: C.ink, fontSize: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        transition: 'background .14s ease, border-color .14s ease, transform .14s ease',
      },
      optionOn: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 42%, transparent)',
        background: C.brandTint,
      },
      optionName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      optionMeta: { fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
      footer: { display: 'flex', gap: 8, padding: '0 16px 16px' },
      btn: {
        flex: 1, height: 34, borderRadius: 10, border: '1px solid ' + C.hairline,
        background: 'transparent', color: C.ink, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
        transition: 'background .14s ease, border-color .14s ease, transform .12s ease, opacity .14s ease',
      },
      btnPrimary: {
        borderColor: 'transparent',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-button-primary-fill, #4d6bfe) 92%, #ffffff) 0%, var(--dsw-alias-button-primary-fill, #4d6bfe) 100%)',
        color: '#ffffff', fontWeight: 500,
        boxShadow: '0 1px 2px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.22)',
      },
      btnDanger: { borderColor: 'color-mix(in srgb, #dc2626 30%, transparent)', color: C.danger },
      btnDisabled: { opacity: 0.45, cursor: 'default', boxShadow: 'none', transform: 'none' },
      hint: { padding: '0 16px 13px', fontSize: 11, lineHeight: 1.55, color: C.muted },
      error: { padding: '0 16px 13px', fontSize: 11, lineHeight: 1.55, color: C.danger, whiteSpace: 'pre-wrap' },
      meter: { height: 3, borderRadius: 999, background: C.hairlineSoft, overflow: 'hidden' },
      meterFill: { height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,' + C.ok + ',' + '#84cc16' + ')', transition: 'width .18s linear' },
      sub: { fontSize: 12, lineHeight: 1.5, color: C.ink, maxHeight: 72, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      subLabel: { color: C.muted, marginRight: 4, fontWeight: 500 },
      target: { fontSize: 16, lineHeight: 1.5, fontWeight: 600, letterSpacing: '.005em' },
      tokens: { display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 12, lineHeight: 1.7 },
      token: { padding: '0 3px', borderRadius: 4 },
      tokenMatch: { background: 'rgba(34,197,94,.16)', color: '#15803d' },
      tokenMissing: { background: 'rgba(220,38,38,.14)', color: '#b91c1c', textDecoration: 'line-through' },
      tokenExtra: { background: 'rgba(128,128,128,.16)', color: C.muted, textDecoration: 'line-through' },
      score: { fontSize: 12, fontWeight: 600 },
      starting: { display: 'flex', alignItems: 'center', gap: 10, padding: '18px 16px' },
      startingText: { fontSize: 12, color: C.ink, lineHeight: 1.5 },
      startingHint: { fontSize: 11, color: C.muted, marginTop: 2 },
    }

    const REDUCED = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null

    async function fetchJson(url, options) {
      const response = await fetch(url, options)
      let data = null
      try { data = await response.json() } catch (_error) { data = null }
      if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status))
      return data
    }

    /** Animate an element in on mount unless the user prefers reduced motion. */
    function useEntrance(duration = 190) {
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node === null || REDUCED === null || REDUCED.matches) return
        try {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(8px) scale(.985)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' },
            ],
            { duration, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
          )
        } catch (_error) {
          // Older engines simply skip the animation.
        }
      }, [duration])
      return ref
    }

    const PHASE = {
      idle: ['空闲', C.muted],
      listening: ['在听', C.ok],
      capturing: ['在听', C.ok],
      transcribing: ['识别中', C.brand],
      'awaiting-reply': ['思考中', C.brand],
      speaking: ['朗读中', C.warn],
      preparing: ['准备中', C.brand],
      feedback: ['评分中', C.brand],
    }

    function PhaseLabel({ phase }) {
      const item = PHASE[phase] || PHASE.idle
      return h('span', { style: S.phase },
        h('i', { style: { ...S.dot, background: item[1] } }),
        item[0])
    }

    function Spinner({ size = 16, color = C.brand }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { color } },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.18 }),
        h('path', { d: 'M12 3a9 9 0 0 1 9 9', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
          h('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 12 12', to: '360 12 12', dur: '0.9s', repeatCount: 'indefinite' })))
    }

    function ActionButton({ variant, disabled, onClick, children, style, title }) {
      const [hover, setHover] = useState(false)
      const [pressed, setPressed] = useState(false)
      const base = variant === 'primary' ? { ...S.btn, ...S.btnPrimary } : variant === 'danger' ? { ...S.btn, ...S.btnDanger } : S.btn
      return h('button', {
        type: 'button',
        title,
        disabled,
        style: {
          ...base,
          ...(hover && !disabled ? { background: variant === 'primary' ? base.background : C.hoverTint } : {}),
          ...(hover && !disabled && variant !== 'primary' ? { borderColor: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2937) 22%, transparent)' } : {}),
          ...(pressed && !disabled ? { transform: 'scale(.97)' } : {}),
          ...(disabled ? S.btnDisabled : {}),
          ...(style || {}),
        },
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => { setHover(false); setPressed(false) },
        onMouseDown: () => setPressed(true),
        onMouseUp: () => setPressed(false),
      }, children)
    }

    function OptionRow({ selected, onClick, name, meta }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button',
        style: {
          ...S.option,
          ...(selected ? S.optionOn : {}),
          ...(hover && !selected ? { background: C.hoverTint } : {}),
          transform: hover ? 'translateY(-1px)' : 'none',
        },
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h('span', { style: S.optionName }, name),
        h('span', { style: S.optionMeta }, meta))
    }

    function VoiceGlyph({ active }) {
      const heights = [3.0, 7.2, 11.2, 7.2, 3.0]
      const opacities = [0.5, 0.72, 1, 0.72, 0.5]
      const bars = heights.map((height, index) => {
        const x = 4.2 + index * 3.5
        const scale = active ? (index === 2 ? 1.22 : 1.4) : 1
        return h('rect', {
          key: String(index),
          x, y: 12 - height / 2, width: 1.6, height, rx: 0.8,
          fill: 'currentColor',
          style: {
            opacity: opacities[index],
            transformBox: 'fill-box',
            transformOrigin: 'center',
            transition: 'transform .28s cubic-bezier(.22,.61,.36,1)',
            transitionDelay: (index * 26) + 'ms',
            transform: 'scaleY(' + scale + ')',
          },
        })
      })
      return h('svg', {
        width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
        style: { color: 'inherit' },
      }, bars)
    }

    function Launcher({ onOpen }) {
      const [hover, setHover] = useState(false)
      const [pressed, setPressed] = useState(false)
      const ref = useEntrance(160)
      const brand = C.brand
      return h('div', { style: S.wrap },
        h('button', {
          ref,
          type: 'button',
          style: {
            ...S.launcher,
            transform: pressed ? 'translateY(0) scale(.94)' : hover ? 'translateY(-2px) scale(1.02)' : 'none',
            borderColor: hover ? 'color-mix(in srgb, ' + brand + ' 34%, transparent)' : C.hairline,
            boxShadow: hover
              ? '0 1px 2px rgba(15,23,42,.05), 0 10px 28px rgba(15,23,42,.16), 0 18px 44px rgba(77,107,254,.16), inset 0 1px 0 rgba(255,255,255,.65)'
              : S.launcher.boxShadow,
          },
          title: '语音练习',
          'aria-label': '语音练习',
          onClick: onOpen,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => { setHover(false); setPressed(false) },
          onMouseDown: () => setPressed(true),
          onMouseUp: () => setPressed(false),
        }, h(VoiceGlyph, { active: hover })))
    }

    function Panel({ state, busy, localError, onClose, onStart, onShadow }) {
      const scenarios = state && Array.isArray(state.scenarios) ? state.scenarios : []
      const lastId = (() => {
        try { return window.localStorage.getItem('dsp:lastScenario') || '' } catch (_error) { return '' }
      })()
      const [picked, setPicked] = useState(lastId || 'daily-chat')
      const ref = useEntrance()
      useEffect(() => {
        if (scenarios.length > 0 && !scenarios.some((item) => item.id === picked)) setPicked(scenarios[0].id)
      }, [scenarios, picked])
      const pick = (id) => {
        setPicked(id)
        try { window.localStorage.setItem('dsp:lastScenario', id) } catch (_error) {}
      }
      return h('div', { style: S.wrap },
        h('div', { style: S.backdrop, onClick: onClose }),
        h('div', { ref, style: S.card },
          h('div', { style: S.header },
            h('div', { style: S.title }, '语音练习'),
            h(ActionButton, { style: { flex: '0 0 auto', width: 54, height: 26 }, onClick: onClose }, '关闭')),
          h('div', { style: S.body },
            h('div', { style: S.sectionLabel }, '选择场景'),
            scenarios.length === 0
              ? h('div', { style: { fontSize: 11, color: C.muted } }, '没有加载到场景卡，请检查 content/scenarios。')
              : scenarios.map((item) => h(OptionRow, {
                  key: item.id,
                  selected: picked === item.id,
                  onClick: () => pick(item.id),
                  name: item.nameZh || item.name || item.id,
                  meta: [item.level, item.name].filter(Boolean).join(' · '),
                }))),
          h('div', { style: S.footer },
            h(ActionButton, {
              variant: 'primary',
              disabled: busy || scenarios.length === 0,
              onClick: () => onStart(picked),
            }, busy ? '启动中…' : '开始对话练习'),
            h(ActionButton, { disabled: busy, onClick: () => onShadow(5) }, '跟读练习')),
          (localError || (state && state.lastError))
            ? h('div', { style: S.error }, localError || (state && state.lastError))
            : h('div', { style: S.hint }, '开始后会打开麦克风并朗读教练回复；戴耳机效果更好。'),
        ))
    }

    function Meter({ levelDb }) {
      const db = Number(levelDb)
      const ratio = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 55) / 40)) : 0
      return h('div', { style: S.meter }, h('i', { style: { ...S.meterFill, width: (ratio * 100).toFixed(1) + '%' } }))
    }

    function CallCard({ state, busy, onEnd, onStopSpeech }) {
      const ref = useEntrance()
      const phase = state && state.phase ? state.phase : 'idle'
      const title = state && (state.scenarioTitle || state.scenario) ? (state.scenarioTitle || state.scenario) : '练习'
      const userText = state && typeof state.userText === 'string' ? state.userText : ''
      const assistantText = state && typeof state.assistantText === 'string' ? state.assistantText : ''
      const elapsed = state && Number(state.elapsedMs) > 0 ? Math.floor(Number(state.elapsedMs) / 1000) : 0
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      return h('div', { style: S.wrap },
        h('div', { ref, style: S.card },
          h('div', { style: S.header },
            h('div', { style: S.title }, title),
            h(PhaseLabel, { phase }),
            h('span', { style: S.timer }, mm + ':' + ss)),
          h('div', { style: S.body },
            h(Meter, { levelDb: state ? state.levelDb : 0 }),
            h('div', { style: S.sub }, h('span', { style: S.subLabel }, '你'), userText || '（还没听到你说话）'),
            h('div', { style: S.sub }, h('span', { style: S.subLabel }, '教练'), assistantText || '（等待回复）'),
            state && state.lastError ? h('div', { style: { ...S.error, padding: 0 } }, state.lastError) : null),
          h('div', { style: S.footer },
            h(ActionButton, {
              disabled: busy || !(state && state.speaking),
              onClick: onStopSpeech,
            }, '停止朗读'),
            h(ActionButton, { variant: 'danger', disabled: busy, onClick: onEnd }, '结束')),
          h('div', { style: S.hint }, '说 "end session" 让教练写完整复盘；直接结束会保存轻量记录。'),
        ))
    }

    function ShadowCard({ shadow, busy, onNext, onStop }) {
      const ref = useEntrance()
      const target = shadow && typeof shadow.target === 'string' ? shadow.target : ''
      const tokens = shadow && Array.isArray(shadow.tokens) ? shadow.tokens : []
      const score = shadow && Number.isFinite(Number(shadow.score)) ? Number(shadow.score) : null
      const index = shadow && Number.isFinite(Number(shadow.index)) ? Number(shadow.index) : 0
      const total = shadow && Number.isFinite(Number(shadow.total)) ? Number(shadow.total) : 0
      const phase = shadow && typeof shadow.phase === 'string' ? shadow.phase : 'idle'
      return h('div', { style: S.wrap },
        h('div', { ref, style: S.card },
          h('div', { style: S.header },
            h('div', { style: S.title }, '跟读练习'),
            h(PhaseLabel, { phase }),
            h('span', { style: S.timer }, (index + 1) + '/' + total),
            score !== null ? h('span', { style: { ...S.score, color: score >= 70 ? C.ok : C.warn } }, String(score)) : null),
          h('div', { style: S.body },
            h('div', { style: S.target }, target || '（准备中…）'),
            h('div', { style: S.tokens }, tokens.length > 0
              ? tokens.map((token, i) => h('span', {
                  key: String(i),
                  style: { ...S.token, ...(token.status === 'match' ? S.tokenMatch : token.status === 'missing' ? S.tokenMissing : S.tokenExtra) },
                }, token.word))
              : (shadow && shadow.said ? h('span', null, shadow.said) : h('span', { style: { color: C.muted } }, phase === 'listening' ? '轮到你说了…' : '请稍候'))),
            shadow && shadow.averageScore !== null && shadow.averageScore !== undefined
              ? h('div', { style: { fontSize: 11, color: C.muted } }, '平均分：' + String(shadow.averageScore))
              : null,
            shadow && shadow.lastError ? h('div', { style: { ...S.error, padding: 0 } }, shadow.lastError) : null),
          h('div', { style: S.footer },
            h(ActionButton, { disabled: busy, onClick: onNext }, '跳过这句'),
            h(ActionButton, { variant: 'danger', disabled: busy, onClick: onStop }, '结束跟读')),
          h('div', { style: S.hint }, '先听教练读一遍，再跟着说；逐词高亮显示对错。'),
        ))
    }

    function StartingCard({ label, hint, onCancel }) {
      const ref = useEntrance()
      return h('div', { style: S.wrap },
        h('div', { ref, style: S.card },
          h('div', { style: S.header },
            h('div', { style: S.title }, label),
            h(Spinner)),
          h('div', { style: S.starting },
            h('div', null,
              h('div', { style: S.startingText }, '正在打开麦克风…'),
              h('div', { style: S.startingHint }, hint || '第一次使用会请求麦克风权限，允许后立刻开始。'))),
          h('div', { style: S.footer },
            h(ActionButton, { onClick: onCancel }, '取消'))))
    }

    function Overlay({ ctxRef }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [localError, setLocalError] = useState('')
      const [starting, setStarting] = useState(false)
      const [shadowStarting, setShadowStarting] = useState(false)
      const [dismissed, setDismissed] = useState(false)
      const activeRef = useRef(false)
      const stateRef = useRef(null)
      stateRef.current = state

      const refresh = async () => {
        try {
          const next = await fetchJson('/voice-practice/state')
          setState(next)
          setError('')
          activeRef.current = Boolean(next && (next.active === true || (next.shadow && next.shadow.active === true)))
          if (next && next.active === true) setStarting(false)
          if (next && next.shadow && next.shadow.active === true) setShadowStarting(false)
          if (next && next.active !== true && next.shadow && next.shadow.active !== true) setDismissed(false)
          return next
        } catch (err) {
          setError(String((err && err.message) || err))
          return null
        }
      }

      useEffect(() => {
        let disposed = false
        let timer = null
        const tick = async () => {
          if (disposed) return
          await refresh()
          if (disposed) return
          const live = activeRef.current || starting || shadowStarting
          timer = setTimeout(tick, live ? 300 : 1200)
        }
        tick()
        return () => { disposed = true; if (timer !== null) clearTimeout(timer) }
      }, [starting, shadowStarting])

      // Esc closes the panel.
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const shadow = state && state.shadow !== null && typeof state.shadow === 'object' ? state.shadow : null
      const shadowActive = Boolean(shadow && shadow.active === true)
      const active = Boolean(state && state.active === true)

      const currentSessionId = () => {
        try {
          const scoped = ctxRef.current
          const snapshot = scoped && scoped.uiSession && scoped.uiSession.current
            ? scoped.uiSession.current.getSnapshot()
            : null
          return snapshot && (snapshot.key || snapshot.sessionId) ? (snapshot.key || snapshot.sessionId) : ''
        } catch (_error) {
          return ''
        }
      }

      const post = async (url, body) => {
        setBusy(true)
        setLocalError('')
        try {
          const data = await fetchJson(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          if (data && data.ok === false) setLocalError(data.error || '操作失败')
          await refresh()
          return data
        } catch (err) {
          setLocalError(String((err && err.message) || err))
          return null
        } finally {
          setBusy(false)
        }
      }

      const onStart = async (scenario) => {
        const sessionId = currentSessionId()
        if (!sessionId) { setLocalError('还没有选中会话：先打开一个会话。'); return }
        setStarting(true)
        const data = await post('/voice-practice/start', { sessionId, scenario })
        if (data && data.ok === false) { setStarting(false); setOpen(true) }
      }
      const onShadowStart = async (count) => {
        setShadowStarting(true)
        const data = await post('/voice-practice/shadow/start', { count: count || 5 })
        if (data && data.ok === false) { setShadowStarting(false); setOpen(true) }
      }
      const onEnd = async () => {
        setDismissed(true)
        await post('/voice-practice/stop', {})
        setTimeout(() => setDismissed(false), 1500)
      }
      const onStopSpeech = async () => { await post('/voice-practice/stop-speech', {}) }
      const onShadowNext = async () => { await post('/voice-practice/shadow/next', {}) }
      const onShadowStop = async () => {
        setDismissed(true)
        await post('/voice-practice/shadow/stop', {})
        setTimeout(() => setDismissed(false), 1500)
      }

      if (dismissed) return h(Launcher, { onOpen: () => { setDismissed(false); setOpen(true) } })
      if (shadowActive) return h(ShadowCard, { shadow, busy, onNext: onShadowNext, onStop: onShadowStop })
      if (active) return h(CallCard, { state, busy, onEnd, onStopSpeech })
      if (shadowStarting) return h(StartingCard, { label: '跟读练习', hint: '正在抽取句子并打开麦克风…', onCancel: () => { setShadowStarting(false); onShadowStop() } })
      if (starting) return h(StartingCard, { label: '语音练习', hint: '正在打开麦克风并准备场景，第一次会请求权限。', onCancel: () => { setStarting(false); onEnd() } })
      if (open) {
        return h(Panel, {
          state,
          busy,
          localError: localError || error,
          onStart,
          onShadow: onShadowStart,
          onClose: () => setOpen(false),
        })
      }
      return h(Launcher, { onOpen: () => { setOpen(true); setLocalError('') } })
    }

    return Object.defineProperty({
      name: 'dsh-speaking-practice',
      inject: ['slots'],
      apply(ctx) {
        const self = { token: {}, dispose: null }
        const ctxRef = { current: null }
        let disposeSlot = null
        self.dispose = () => {
          try { if (disposeSlot !== null) disposeSlot() } catch (_error) {}
          disposeSlot = null
          if (window.__dshSpeakingPracticeOwner === self) window.__dshSpeakingPracticeOwner = null
        }
        const previous = window.__dshSpeakingPracticeOwner
        if (previous && previous !== self && typeof previous.dispose === 'function') {
          try { previous.dispose() } catch (_error) {}
        }
        window.__dshSpeakingPracticeOwner = self
        ctx.effect(() => () => self.dispose(), 'dsh-speaking-practice: dispose overlay')
        ctx.inject(['sessions', 'uiSession'], (scoped) => {
          ctxRef.current = scoped
          scoped.effect(() => () => {
            if (ctxRef.current === scoped) ctxRef.current = null
          }, 'dsh-speaking-practice: session services')
        })
        disposeSlot = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-speaking-practice.overlay',
          order: 910,
        }, () => h(Overlay, { ctxRef })))
      },
    }, Symbol.toStringTag, { value: 'Module' })
  },
})
