/**
 * dsh-speaking-practice — browser half (v0.5.0).
 *
 * Direction chosen with the user:
 *   entry  = A: a tiny waveform icon in the composer toolbar
 *   active = B: an immersive centered voice sheet (breathing orb, live subtitles)
 *
 * The composer button and the sheet share a module-level store. No injected
 * <style> (CSP-safe); motion uses the Web Animations API and respects reduced
 * motion. All network calls go to the host half under /voice-practice.
 */
window.__ModuleLoader__.load({
  id: 'dsh-speaking-practice',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const C = {
      accent: '#4176e6',
      accentDeep: '#3564c9',
      accentSoft: '#eef4ff',
      accentBorder: '#d5e2ff',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      soft: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      border: 'var(--dsw-alias-border-l2, #e8eaef)',
      ink: 'var(--dsw-alias-label-primary, #1f2329)',
      muted: 'var(--dsw-alias-label-secondary, #8a8f98)',
      danger: '#d92d20',
      ok: '#12a150',
      warn: '#dc6803',
      hover: 'rgba(16,24,40,.05)',
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

    function ping(event) {
      fetch('/voice-practice/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      }).catch(() => {})
    }

    function useEntrance(duration = 200) {
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node === null || (REDUCED !== null && REDUCED.matches)) return
        try {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(10px) scale(.985)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' },
            ],
            { duration, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
          )
        } catch (_error) {}
      }, [duration])
      return ref
    }

    // ---- tiny shared store between the composer entry and the overlay ------
    function createStore() {
      let state = { open: false, sessionId: '' }
      const listeners = new Set()
      return {
        get() { return state },
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }
    const store = createStore()
    function useStore() {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => store.subscribe(() => setSnapshot(store.get())), [])
      return snapshot
    }

    // ---- icons -------------------------------------------------------------
    function WaveGlyph({ size = 16, active }) {
      const heights = [3, 7.2, 11.2, 7.2, 3]
      const opacities = [0.5, 0.72, 1, 0.72, 0.5]
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        heights.map((height, index) => h('rect', {
          key: String(index),
          x: 4.2 + index * 3.5, y: 12 - height / 2, width: 1.7, height, rx: 0.85,
          fill: 'currentColor', opacity: opacities[index],
          style: {
            transformBox: 'fill-box', transformOrigin: 'center',
            transition: 'transform .3s cubic-bezier(.22,.61,.36,1)',
            transitionDelay: (index * 25) + 'ms',
            transform: active ? (index === 2 ? 'scaleY(1.25)' : 'scaleY(1.45)') : 'scaleY(1)',
          },
        })))
    }

    function ScenarioIcon({ id, size = 18 }) {
      const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }
      if (id === 'job-interview') {
        return h('svg', common,
          h('rect', { x: 3.2, y: 7.4, width: 17.6, height: 12.2, rx: 2.4 }),
          h('path', { d: 'M8.6 7.4V6a2 2 0 0 1 2-2h2.8a2 2 0 0 1 2 2v1.4' }),
          h('path', { d: 'M3.2 12.4h17.6' }))
      }
      if (id === 'ielts-part2') {
        return h('svg', common,
          h('rect', { x: 3.4, y: 4.6, width: 17.2, height: 14.8, rx: 2.2 }),
          h('path', { d: 'M7.4 9h9.2M7.4 12.4h9.2M7.4 15.8h5.6' }))
      }
      if (id === 'workplace') {
        return h('svg', common,
          h('rect', { x: 3.4, y: 4.4, width: 17.2, height: 11.6, rx: 2 }),
          h('path', { d: 'M12 16v4M8.4 20h7.2' }))
      }
      return h('svg', common,
        h('path', { d: 'M12 4.2c-4.3 0-7.7 2.8-7.7 6.3 0 1.9 1 3.6 2.6 4.8v3.6l3.2-1.8c.6.1 1.2.2 1.9.2 4.3 0 7.7-2.8 7.7-6.3S16.3 4.2 12 4.2Z' }),
        h('path', { d: 'M9 10.4v.2M12 9.2v2.6M15 10.4v.2' }))
    }

    function CheckIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M20 6.5 9.4 17.1 4 11.7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CloseIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    function Spinner({ size = 16, color = C.accent }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { color } },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.18 }),
        h('path', { d: 'M12 3a9 9 0 0 1 9 9', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
          h('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 12 12', to: '360 12 12', dur: '0.9s', repeatCount: 'indefinite' })))
    }

    function IconButton({ onClick, title, children, disabled }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button', title, disabled,
        onClick,
        style: {
          width: 30, height: 30, borderRadius: 8, border: 'none',
          background: hover && !disabled ? C.hover : 'transparent',
          color: hover && !disabled ? C.ink : C.muted,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: disabled ? 'default' : 'pointer', padding: 0, flex: '0 0 auto',
          transition: 'background .14s ease, color .14s ease',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    // ---- motion ------------------------------------------------------------
    function Bars({ phase, size }) {
      const ref = useRef(null)
      const heights = [16, 30, 46, 30, 16]
      useEffect(() => {
        const host = ref.current
        if (host === null || (REDUCED !== null && REDUCED.matches)) return undefined
        const speed = phase === 'speaking' ? 620 : phase === 'listening' ? 1000 : 1500
        const animations = Array.from(host.children).map((element, index) => element.animate(
          [{ transform: 'scaleY(.45)' }, { transform: 'scaleY(1)' }],
          { duration: speed, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: index * 90 },
        ))
        return () => { for (const animation of animations) animation.cancel() }
      }, [phase])
      return h('div', {
        ref,
        style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', display: 'flex', alignItems: 'center', gap: 5, height: size * 0.25 },
      }, heights.map((height, index) => h('i', {
        key: String(index),
        style: {
          display: 'block', width: 5, height: Math.round(height * size / 210), borderRadius: 3,
          background: C.accent, opacity: [0.45, 0.65, 1, 0.65, 0.45][index],
          transformOrigin: 'center',
        },
      })))
    }

    function Orb({ phase, size = 210 }) {
      const hostRef = useRef(null)
      useEffect(() => {
        const host = hostRef.current
        if (host === null || (REDUCED !== null && REDUCED.matches)) return undefined
        const blobs = Array.from(host.querySelectorAll('[data-blob]'))
        const animations = blobs.map((element, index) => element.animate(
          [
            { transform: 'translate3d(0,0,0) scale(1)' },
            { transform: 'translate3d(' + (index === 1 ? -9 : 9) + 'px,' + (index === 2 ? 11 : -7) + 'px,0) scale(' + (1.06 + index * 0.02) + ')' },
          ],
          { duration: 4600 + index * 1100, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' },
        ))
        return () => { for (const animation of animations) animation.cancel() }
      }, [])
      return h('div', { style: { position: 'relative', width: size, height: size, margin: '24px auto 18px' } },
        h('div', {
          ref: hostRef,
          style: {
            position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden',
            background: 'linear-gradient(150deg,#eef3ff,#dfe9ff 60%,#e9e2ff)',
            boxShadow: 'inset 0 0 44px rgba(255,255,255,.9), 0 22px 60px rgba(65,118,230,.22)',
          },
        },
          h('div', { 'data-blob': '1', style: { position: 'absolute', inset: '-12%', background: 'radial-gradient(circle at 30% 28%, #a9c2ff 0%, rgba(169,194,255,0) 55%)' } }),
          h('div', { 'data-blob': '2', style: { position: 'absolute', inset: '-12%', background: 'radial-gradient(circle at 70% 30%, #c4b5fd 0%, rgba(196,181,253,0) 52%)' } }),
          h('div', { 'data-blob': '3', style: { position: 'absolute', inset: '-12%', background: 'radial-gradient(circle at 50% 80%, #7c9cff 0%, rgba(124,156,255,0) 60%)' } }),
          h('div', { style: { position: 'absolute', inset: 16, borderRadius: '50%', border: '1px solid rgba(255,255,255,.7)' } }),
        ),
        h(Bars, { phase, size }),
      )
    }

    // ---- composer entry (direction A) --------------------------------------
    function Entry({ ctxRef }) {
      const snapshot = useStore()
      const [hover, setHover] = useState(false)
      useEffect(() => { ping('entry-mounted') }, [])
      const resolveSessionId = () => {
        try {
          const scoped = ctxRef.current
          const current = scoped && scoped.uiSession && scoped.uiSession.current
            ? scoped.uiSession.current.getSnapshot()
            : null
          return current && (current.key || current.sessionId) ? (current.key || current.sessionId) : ''
        } catch (_error) {
          return ''
        }
      }
      return h('button', {
        type: 'button',
        title: '语音练习',
        'aria-label': '语音练习',
        style: {
          width: 30, height: 30, borderRadius: 999, border: 'none', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: snapshot.open ? C.accentSoft : (hover ? C.hover : 'transparent'),
          color: snapshot.open ? C.accent : (hover ? C.ink : C.muted),
          cursor: 'pointer', transition: 'background .14s ease, color .14s ease',
        },
        onClick: () => store.set({ open: true, sessionId: resolveSessionId() }),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, h(WaveGlyph, { size: 17, active: hover || snapshot.open }))
    }

    // ---- immersive sheet (direction B) -------------------------------------
    function Scrim({ children, onClose }) {
      const ref = useEntrance(220)
      return h('div', {
        style: {
          position: 'absolute', inset: 0, pointerEvents: 'auto',
          background: 'rgba(16,24,40,.30)',
          backdropFilter: 'blur(10px) saturate(1.05)',
          WebkitBackdropFilter: 'blur(10px) saturate(1.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40,
        },
        onClick: onClose,
      }, h('div', {
        ref,
        style: {
          width: 560, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 80px)',
          background: C.surface, color: C.ink, borderRadius: 26,
          boxShadow: '0 40px 120px rgba(16,24,40,.35), 0 2px 10px rgba(16,24,40,.10)',
          display: 'flex', flexDirection: 'column', padding: '22px 30px 26px',
          overflowY: 'auto', fontFamily: 'inherit',
        },
        onClick: (event) => event.stopPropagation(),
      }, children))
    }

    function SheetTop({ label, onClose }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        h('span', { style: { fontSize: 12, color: C.muted } }, label),
        h(IconButton, { onClick: onClose, title: '关闭' }, h(CloseIcon)))
    }

    function ActionButton({ variant, disabled, onClick, children, style }) {
      const [hover, setHover] = useState(false)
      const [pressed, setPressed] = useState(false)
      const primary = variant === 'primary'
      return h('button', {
        type: 'button', disabled, onClick,
        style: {
          flex: 1, height: 44, borderRadius: 12, border: primary ? '1px solid transparent' : '1px solid ' + C.border,
          background: primary
            ? (hover && !disabled ? 'linear-gradient(180deg,#4f83ea,#3564c9)' : 'linear-gradient(180deg,#5b8ef0,#4176e6)')
            : (hover && !disabled ? C.hover : C.surface),
          color: primary ? '#fff' : C.ink,
          fontSize: 13.5, fontWeight: 500, fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          boxShadow: primary ? '0 2px 10px rgba(65,118,230,.30)' : 'none',
          transform: pressed && !disabled ? 'scale(.985)' : 'none',
          transition: 'background .14s ease, transform .12s ease, opacity .14s ease',
          ...(style || {}),
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => { setHover(false); setPressed(false) },
        onMouseDown: () => setPressed(true),
        onMouseUp: () => setPressed(false),
      }, children)
    }

    function SetupView({ state, busy, localError, onStart, onShadow, onClose }) {
      const scenarios = state && Array.isArray(state.scenarios) ? state.scenarios : []
      const lastId = (() => { try { return window.localStorage.getItem('dsp:lastScenario') || '' } catch (_error) { return '' } })()
      const [picked, setPicked] = useState(lastId || 'daily-chat')
      const [hovered, setHovered] = useState('')
      useEffect(() => {
        if (scenarios.length > 0 && !scenarios.some((item) => item.id === picked)) setPicked(scenarios[0].id)
      }, [scenarios, picked])
      const pick = (id) => {
        setPicked(id)
        try { window.localStorage.setItem('dsp:lastScenario', id) } catch (_error) {}
      }
      return h(Scrim, { onClose },
        h(SheetTop, { label: '本地语音 · AI 教练', onClose }),
        h('div', { style: { fontSize: 22, fontWeight: 650, letterSpacing: '-.015em', margin: '10px 0 4px' } }, '语音练习'),
        h('div', { style: { fontSize: 12.5, color: C.muted, marginBottom: 18 } }, '选一个场景，直接开口说。'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          scenarios.map((item) => {
            const selected = picked === item.id
            const hover = hovered === item.id
            return h('button', {
              key: item.id,
              type: 'button',
              onClick: () => pick(item.id),
              onMouseEnter: () => setHovered(item.id),
              onMouseLeave: () => setHovered(''),
              style: {
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 10px',
                borderRadius: 12, border: '1px solid ' + (selected ? C.accentBorder : 'transparent'),
                background: selected ? C.accentSoft : (hover ? C.hover : 'transparent'),
                color: C.ink, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                transition: 'background .14s ease, border-color .14s ease',
              },
            },
              h('span', {
                style: {
                  width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: selected ? '#ffffff' : C.soft,
                  color: selected ? C.accent : C.muted,
                  boxShadow: selected ? 'inset 0 0 0 1px ' + C.accentBorder : 'none',
                },
              }, h(ScenarioIcon, { id: item.id })),
              h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                h('span', { style: { fontSize: 14, fontWeight: 500 } }, item.nameZh || item.name || item.id),
                h('span', { style: { fontSize: 11.5, color: C.muted } }, [item.level, item.name].filter(Boolean).join(' · '))),
              selected ? h('span', { style: { color: C.accent, display: 'inline-flex', flex: '0 0 auto' } }, h(CheckIcon)) : null)
          })),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 20 } },
          h(ActionButton, { variant: 'primary', disabled: busy || scenarios.length === 0, onClick: () => onStart(picked) }, busy ? '启动中…' : '开始对话练习'),
          h(ActionButton, { disabled: busy, onClick: () => onShadow(5) }, '跟读练习')),
        (localError || (state && state.lastError))
          ? h('div', { style: { marginTop: 12, fontSize: 11.5, lineHeight: 1.55, color: C.danger, whiteSpace: 'pre-wrap' } }, localError || (state && state.lastError))
          : h('div', { style: { marginTop: 12, fontSize: 11.5, color: C.muted, textAlign: 'center' } }, '开始后会打开麦克风；戴耳机效果更好。'),
      )
    }

    function statusText(phase) {
      if (phase === 'listening' || phase === 'capturing') return '正在听你说'
      if (phase === 'transcribing') return '正在识别…'
      if (phase === 'awaiting-reply') return '教练思考中…'
      if (phase === 'speaking') return '教练正在说…'
      if (phase === 'preparing') return '正在准备…'
      return '准备中…'
    }

    function PracticeView({ state, busy, onStopSpeech, onEnd }) {
      const phase = state && state.phase ? state.phase : 'idle'
      const scenario = state && (state.scenarioTitle || state.scenario) ? (state.scenarioTitle || state.scenario) : '练习'
      const level = state && state.level ? state.level : ''
      const userText = state && typeof state.userText === 'string' ? state.userText : ''
      const assistantText = state && typeof state.assistantText === 'string' ? state.assistantText : ''
      const elapsed = state && Number(state.elapsedMs) > 0 ? Math.floor(Number(state.elapsedMs) / 1000) : 0
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      return h(Scrim, {},
        h(SheetTop, { label: scenario + (level ? ' · ' + level : ''), onClose: onEnd }),
        h(Orb, { phase }),
        h('div', { style: { textAlign: 'center', fontSize: 19, fontWeight: 650, letterSpacing: '-.01em' } }, statusText(phase)),
        h('div', { style: { textAlign: 'center', fontSize: 12, color: C.muted, margin: '5px 0 18px' } }, '可以随时打断教练 · ' + mm + ':' + ss),
        h('div', {
          style: {
            background: C.soft, borderRadius: 14, padding: '14px 16px',
            display: 'flex', flexDirection: 'column', gap: 8, minHeight: 86,
          },
        },
          h('div', { style: { fontSize: 12.5, lineHeight: 1.55, color: C.ink, maxHeight: 64, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            h('span', { style: { color: C.muted, fontWeight: 500, marginRight: 6 } }, '你'),
            userText || '（还没听到你说话）'),
          h('div', { style: { fontSize: 12.5, lineHeight: 1.55, color: C.ink, maxHeight: 64, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            h('span', { style: { color: C.muted, fontWeight: 500, marginRight: 6 } }, '教练'),
            assistantText || '（等待回复）')),
        state && state.lastError ? h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.danger, whiteSpace: 'pre-wrap' } }, state.lastError) : null,
        h('div', { style: { display: 'flex', gap: 10, marginTop: 18 } },
          h(ActionButton, { disabled: busy || !(state && state.speaking), onClick: onStopSpeech }, '停止朗读'),
          h(ActionButton, { variant: 'primary', disabled: busy, onClick: onEnd }, '结束对话')),
      )
    }

    function ShadowView({ shadow, busy, onNext, onStop }) {
      const target = shadow && typeof shadow.target === 'string' ? shadow.target : ''
      const tokens = shadow && Array.isArray(shadow.tokens) ? shadow.tokens : []
      const score = shadow && Number.isFinite(Number(shadow.score)) ? Number(shadow.score) : null
      const index = shadow && Number.isFinite(Number(shadow.index)) ? Number(shadow.index) : 0
      const total = shadow && Number.isFinite(Number(shadow.total)) ? Number(shadow.total) : 0
      const phase = shadow && typeof shadow.phase === 'string' ? shadow.phase : 'idle'
      const said = shadow && typeof shadow.said === 'string' ? shadow.said : ''
      const tokenStyle = (status) => status === 'match'
        ? { background: 'rgba(18,161,80,.14)', color: '#0f7a3d' }
        : status === 'missing'
          ? { background: 'rgba(217,45,32,.12)', color: '#b42318', textDecoration: 'line-through' }
          : { background: 'rgba(16,24,40,.08)', color: C.muted, textDecoration: 'line-through' }
      return h(Scrim, {},
        h(SheetTop, { label: '跟读练习 · ' + (index + 1) + '/' + total, onClose: onStop }),
        h(Orb, { phase, size: 150 }),
        h('div', { style: { fontSize: 12, color: C.muted, textAlign: 'center', marginBottom: 6 } }, statusText(phase)),
        h('div', { style: { fontSize: 19, fontWeight: 600, lineHeight: 1.45, textAlign: 'center', letterSpacing: '-.005em' } }, target || '（准备中…）'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 4, fontSize: 13, lineHeight: 1.8, marginTop: 14, minHeight: 26 } },
          tokens.length > 0
            ? tokens.map((token, i) => h('span', { key: String(i), style: { padding: '0 3px', borderRadius: 4, ...tokenStyle(token.status) } }, token.word))
            : h('span', { style: { color: C.muted } }, said || (phase === 'listening' ? '轮到你说了…' : '请稍候'))),
        score !== null ? h('div', { style: { textAlign: 'center', fontSize: 13, fontWeight: 600, marginTop: 10, color: score >= 70 ? C.ok : C.warn } }, '本句得分 ' + String(score)) : null,
        shadow && shadow.averageScore !== null && shadow.averageScore !== undefined
          ? h('div', { style: { textAlign: 'center', fontSize: 11.5, color: C.muted, marginTop: 2 } }, '平均分 ' + String(shadow.averageScore))
          : null,
        shadow && shadow.lastError ? h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.danger, whiteSpace: 'pre-wrap', textAlign: 'center' } }, shadow.lastError) : null,
        h('div', { style: { display: 'flex', gap: 10, marginTop: 18 } },
          h(ActionButton, { disabled: busy, onClick: onNext }, '跳过这句'),
          h(ActionButton, { variant: 'primary', disabled: busy, onClick: onStop }, '结束跟读')),
      )
    }

    function StartingView({ label, hint, onCancel }) {
      return h(Scrim, {},
        h(SheetTop, { label, onClose: onCancel }),
        h(Orb, { phase: 'preparing', size: 150 }),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 16, fontWeight: 600 } }, h(Spinner), '正在打开麦克风…'),
        h('div', { style: { textAlign: 'center', fontSize: 12, color: C.muted, marginTop: 6 } }, hint || '第一次使用会请求麦克风权限。'),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 20 } }, h(ActionButton, { onClick: onCancel }, '取消')),
      )
    }

    function VoiceMode({ ctxRef }) {
      const snapshot = useStore()
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [localError, setLocalError] = useState('')
      const [starting, setStarting] = useState(false)
      const [shadowStarting, setShadowStarting] = useState(false)

      const refresh = async () => {
        try {
          const next = await fetchJson('/voice-practice/state')
          setState(next)
          setError('')
          if (next && next.active === true) setStarting(false)
          if (next && next.shadow && next.shadow.active === true) setShadowStarting(false)
          return next
        } catch (err) {
          setError(String((err && err.message) || err))
          return null
        }
      }

      useEffect(() => {
        if (!snapshot.open) return undefined
        ping('ui-open')
        let disposed = false
        let timer = null
        const tick = async () => {
          if (disposed) return
          await refresh()
          if (disposed) return
          timer = setTimeout(tick, 400)
        }
        tick()
        return () => { disposed = true; if (timer !== null) clearTimeout(timer) }
      }, [snapshot.open])

      const close = async () => {
        const shadowActive = state && state.shadow && state.shadow.active === true
        const active = state && state.active === true
        if (active || shadowActive) {
          setBusy(true)
          try { await fetchJson('/voice-practice/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) } catch (_error) {}
          setBusy(false)
        }
        store.set({ open: false })
        setStarting(false)
        setShadowStarting(false)
        setLocalError('')
      }

      useEffect(() => {
        if (!snapshot.open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [snapshot.open, state])

      if (!snapshot.open) return null

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
        const sessionId = snapshot.sessionId || ''
        if (!sessionId) { setLocalError('还没有选中会话。'); return }
        setStarting(true)
        const data = await post('/voice-practice/start', { sessionId, scenario })
        if (data && data.ok === false) setStarting(false)
      }
      const onShadowStart = async (count) => {
        setShadowStarting(true)
        const data = await post('/voice-practice/shadow/start', { count: count || 5 })
        if (data && data.ok === false) setShadowStarting(false)
      }
      const onStopSpeech = async () => { await post('/voice-practice/stop-speech', {}) }
      const onShadowNext = async () => { await post('/voice-practice/shadow/next', {}) }

      const shadow = state && state.shadow !== null && typeof state.shadow === 'object' ? state.shadow : null
      const shadowActive = Boolean(shadow && shadow.active === true)
      const active = Boolean(state && state.active === true)

      if (shadowActive) return h(ShadowView, { shadow, busy, onNext: onShadowNext, onStop: close })
      if (active) return h(PracticeView, { state, busy, onStopSpeech, onEnd: close })
      if (shadowStarting) return h(StartingView, { label: '跟读练习', hint: '正在抽取句子并打开麦克风…', onCancel: close })
      if (starting) return h(StartingView, { label: '语音练习', hint: '正在打开麦克风并准备场景，第一次会请求权限。', onCancel: close })
      return h(SetupView, {
        state,
        busy,
        localError: localError || error,
        onStart,
        onShadow: onShadowStart,
        onClose: close,
      })
    }

    return Object.defineProperty({
      name: 'dsh-speaking-practice',
      inject: ['slots'],
      apply(ctx) {
        const self = { token: {}, dispose: null }
        const ctxRef = { current: null }
        let disposeEntry = null
        let disposeOverlay = null
        self.dispose = () => {
          try { if (disposeEntry !== null) disposeEntry() } catch (_error) {}
          try { if (disposeOverlay !== null) disposeOverlay() } catch (_error) {}
          disposeEntry = null
          disposeOverlay = null
          if (window.__dshSpeakingPracticeOwner === self) window.__dshSpeakingPracticeOwner = null
        }
        const previous = window.__dshSpeakingPracticeOwner
        if (previous && previous !== self && typeof previous.dispose === 'function') {
          try { previous.dispose() } catch (_error) {}
        }
        window.__dshSpeakingPracticeOwner = self
        ctx.effect(() => () => self.dispose(), 'dsh-speaking-practice: dispose ui')
        ctx.inject(['sessions', 'uiSession'], (scoped) => {
          ctxRef.current = scoped
          scoped.effect(() => () => {
            if (ctxRef.current === scoped) ctxRef.current = null
          }, 'dsh-speaking-practice: session services')
        })
        disposeEntry = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-speaking-practice.entry',
          order: 60,
        }, () => h(Entry, { ctxRef })))
        disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-speaking-practice.overlay',
          order: 910,
        }, () => h(VoiceMode, { ctxRef })))
      },
    }, Symbol.toStringTag, { value: 'Module' })
  },
})
