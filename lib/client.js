/**
 * dsh-speaking-practice — browser half (v0.7.0).
 *
 * Direction chosen with the user:
 *   entry  = A: a tiny waveform icon in the composer toolbar
 *   active = B: an immersive centered voice sheet
 *
 * Visual system "Practice Room": porcelain paper, ink, celadon signal,
 * editorial serif for everything spoken, hairline rules instead of boxes.
 * The pearl disc is the one loud element; everything around it stays quiet.
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

    const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif'
    const SERIF = '"New York", "Songti SC", "Noto Serif SC", Georgia, "Times New Roman", serif'

    const C = {
      // stage — porcelain, fixed so the practice room reads the same in any host theme
      paper: '#F2F3F1',
      ink: '#23261F',
      inkSoft: '#4E5247',
      muted: '#6A6F64',
      hairline: '#DCDED5',
      hairlineSoft: '#E7E9E1',
      celadon: '#3F6F5F',
      celadonDeep: '#2F5749',
      celadonSoft: '#E7EFEA',
      amber: '#A2702A',
      oxblood: '#9A4A38',
      // host-native bits for the composer entry (must blend into DSH chrome)
      hover: 'rgba(16,24,40,.05)',
      hostInk: 'var(--dsw-alias-label-primary, #1f2329)',
      hostMuted: 'var(--dsw-alias-label-secondary, #8a8f98)',
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

    function useEntrance(duration = 260) {
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node === null || (REDUCED !== null && REDUCED.matches)) return
        try {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(14px) scale(.986)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' },
            ],
            { duration, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' },
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

    function CheckIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M20 6.5 9.4 17.1 4 11.7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CloseIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    function Spinner({ size = 14, color = C.celadon }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { color } },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.2, opacity: 0.16 }),
        h('path', { d: 'M12 3a9 9 0 0 1 9 9', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
          h('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 12 12', to: '360 12 12', dur: '0.9s', repeatCount: 'indefinite' })))
    }

    function IconButton({ onClick, title, children, disabled }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button', title, disabled,
        onClick,
        style: {
          width: 30, height: 30, borderRadius: 10, border: 'none',
          background: hover && !disabled ? 'rgba(35,38,32,.06)' : 'transparent',
          color: hover && !disabled ? C.ink : C.muted,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: disabled ? 'default' : 'pointer', padding: 0, flex: '0 0 auto',
          transition: 'background .16s ease, color .16s ease',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    // ---- motion ------------------------------------------------------------
    function Bars({ phase, size }) {
      const ref = useRef(null)
      const factors = [0.34, 0.55, 0.9, 0.55, 0.34]
      useEffect(() => {
        const host = ref.current
        if (host === null || (REDUCED !== null && REDUCED.matches)) return undefined
        const speed = phase === 'speaking' ? 620 : phase === 'listening' || phase === 'capturing' ? 1000 : 1500
        const animations = Array.from(host.children).map((element, index) => element.animate(
          [{ transform: 'scaleY(.5)' }, { transform: 'scaleY(1)' }],
          { duration: speed, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: index * 90 },
        ))
        return () => { for (const animation of animations) animation.cancel() }
      }, [phase])
      const height = Math.round(size * 0.26)
      return h('div', {
        ref,
        style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', display: 'flex', alignItems: 'center', gap: 5, height },
      }, factors.map((factor, index) => h('i', {
        key: String(index),
        style: {
          display: 'block', width: index === 2 ? 4.5 : 4, height: Math.round(height * factor), borderRadius: 999,
          background: index === 2 ? C.celadonDeep : C.ink,
          opacity: index === 2 ? 0.9 : 0.55,
          transformOrigin: 'center',
        },
      })))
    }

    // The pearl: an engraved groove disc with a slow turning sheen. The one
    // loud element of the whole surface.
    function Orb({ phase, size = 200 }) {
      const hostRef = useRef(null)
      useEffect(() => {
        const host = hostRef.current
        if (host === null || (REDUCED !== null && REDUCED.matches)) return undefined
        const blobs = Array.from(host.querySelectorAll('[data-blob]'))
        const animations = blobs.map((element, index) => element.animate(
          [
            { transform: 'translate3d(0,0,0) scale(1)' },
            { transform: 'translate3d(' + (index === 1 ? -7 : 6) + 'px,' + (index === 1 ? 9 : -6) + 'px,0) scale(1.05)' },
          ],
          { duration: 5200 + index * 900, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' },
        ))
        const sheen = host.querySelector('[data-sheen]')
        if (sheen !== null) {
          animations.push(sheen.animate(
            [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
            { duration: 26000, iterations: Infinity, easing: 'linear' },
          ))
        }
        return () => { for (const animation of animations) animation.cancel() }
      }, [])
      return h('div', { style: { position: 'relative', width: size, height: size, margin: '28px auto 20px' } },
        h('div', {
          style: {
            position: 'absolute', inset: -Math.round(size * 0.09), borderRadius: '50%',
            background: 'radial-gradient(circle at 50% 44%, rgba(255,255,248,.9), rgba(255,255,248,0) 64%)',
            filter: 'blur(6px)',
          },
        }),
        h('div', {
          ref: hostRef,
          style: {
            position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden',
            background: 'radial-gradient(circle at 68% 80%, rgba(63,111,95,.14), rgba(63,111,95,0) 58%), radial-gradient(circle at 33% 27%, #FEFEFB 0%, #F1F2EB 36%, #E2E4D8 68%, #D3D6C7 100%)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.7), inset 0 -16px 34px rgba(120,126,104,.16), 0 26px 64px rgba(98,104,84,.20)',
          },
        },
          h('div', {
            style: {
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'repeating-radial-gradient(circle at 50% 50%, rgba(110,116,96,.09) 0 1px, rgba(110,116,96,0) 1px 7px)',
              opacity: 0.5,
            },
          }),
          h('div', { 'data-blob': '1', style: { position: 'absolute', inset: '-14%', background: 'radial-gradient(circle at 30% 24%, rgba(255,255,250,.85) 0%, rgba(255,255,250,0) 55%)' } }),
          h('div', { 'data-blob': '2', style: { position: 'absolute', inset: '-14%', background: 'radial-gradient(circle at 72% 34%, rgba(232,238,222,.7) 0%, rgba(232,238,222,0) 55%)' } }),
          h('div', {
            'data-sheen': '1',
            style: {
              position: 'absolute', inset: '-20%', borderRadius: '50%',
              background: 'conic-gradient(from 0deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,.55) 26deg, rgba(255,255,255,0) 70deg, rgba(255,255,255,0) 360deg)',
              mixBlendMode: 'soft-light',
            },
          }),
          h('div', { style: { position: 'absolute', inset: Math.round(size * 0.235), borderRadius: '50%', border: '1px solid rgba(110,116,96,.22)', boxShadow: 'inset 0 4px 14px rgba(110,116,96,.10)' } }),
        ),
        h(Bars, { phase, size }),
      )
    }

    function StatusDot({ phase }) {
      const ref = useRef(null)
      const live = phase === 'listening' || phase === 'capturing' || phase === 'awaiting-reply' || phase === 'speaking'
      const color = phase === 'speaking' ? C.amber : C.celadon
      useEffect(() => {
        const node = ref.current
        if (node === null || !live || (REDUCED !== null && REDUCED.matches)) return undefined
        const animation = node.animate(
          [{ opacity: 0.35, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1.12)' }],
          { duration: 1100, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' },
        )
        return () => animation.cancel()
      }, [phase, live])
      return h('i', { ref, style: { width: 6, height: 6, borderRadius: 999, background: live ? color : C.muted, flex: '0 0 auto' } })
    }

    function LevelChip({ level }) {
      if (!level) return null
      return h('span', {
        style: {
          padding: '1px 7px', borderRadius: 999, background: 'rgba(35,38,32,.06)',
          color: C.muted, fontSize: 10.5, letterSpacing: '.03em', fontWeight: 500,
        },
      }, level)
    }

    function readSessionContext(ctxRef) {
      try {
        const scoped = ctxRef && ctxRef.current ? ctxRef.current : null
        const current = scoped && scoped.uiSession && scoped.uiSession.current
          ? scoped.uiSession.current.getSnapshot()
          : null
        const sessionId = current && (current.key || current.sessionId || current.id)
          ? String(current.key || current.sessionId || current.id)
          : ''
        const cwd = current && (current.cwd || (current.header && current.header.cwd))
          ? String(current.cwd || current.header.cwd)
          : ''
        return { sessionId, cwd }
      } catch (_error) {
        return { sessionId: '', cwd: '' }
      }
    }

    // ---- composer entry (direction A) --------------------------------------
    function Entry({ ctxRef }) {
      const snapshot = useStore()
      const [hover, setHover] = useState(false)
      useEffect(() => { ping('entry-mounted') }, [])
      return h('button', {
        type: 'button',
        title: '语音练习',
        'aria-label': '语音练习',
        style: {
          position: 'relative',
          width: 30, height: 30, borderRadius: 999, border: 'none', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: hover ? C.hover : 'transparent',
          color: snapshot.open || hover ? C.hostInk : C.hostMuted,
          cursor: 'pointer', transition: 'background .14s ease, color .14s ease',
        },
        onClick: () => {
          const info = readSessionContext(ctxRef)
          store.set({ open: true, sessionId: info.sessionId, cwd: info.cwd })
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h(WaveGlyph, { size: 17, active: hover || snapshot.open }),
        snapshot.open
          ? h('i', { style: { position: 'absolute', top: 3, right: 3, width: 5, height: 5, borderRadius: 999, background: C.celadon } })
          : null,
      )
    }

    // ---- immersive sheet (direction B) -------------------------------------
    function Scrim({ children, onClose }) {
      const ref = useEntrance()
      return h('div', {
        style: {
          position: 'absolute', inset: 0, pointerEvents: 'auto',
          background: 'rgba(20,23,18,.42)',
          backdropFilter: 'blur(14px) saturate(.92)',
          WebkitBackdropFilter: 'blur(14px) saturate(.92)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40,
        },
        onClick: onClose,
      }, h('div', {
        ref,
        style: {
          width: 600, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 80px)',
          background: C.paper, color: C.ink, borderRadius: 24,
          border: '1px solid rgba(255,255,255,.55)',
          boxShadow: '0 28px 90px rgba(24,26,20,.32), 0 2px 8px rgba(24,26,20,.10)',
          display: 'flex', flexDirection: 'column', padding: '24px 34px 30px',
          overflowY: 'auto', fontFamily: SANS, colorScheme: 'light',
        },
        onClick: (event) => event.stopPropagation(),
      }, children))
    }

    function SheetTop({ label, onClose }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30 } },
        h('span', { style: { fontSize: 11.5, color: C.muted, letterSpacing: '.02em' } }, label),
        h(IconButton, { onClick: onClose, title: '关闭' }, h(CloseIcon)))
    }

    function ActionButton({ variant, disabled, onClick, children, style }) {
      const [hover, setHover] = useState(false)
      const [pressed, setPressed] = useState(false)
      const primary = variant === 'primary'
      return h('button', {
        type: 'button', disabled, onClick,
        style: {
          flex: 1, height: 46, borderRadius: 13, border: primary ? '1px solid transparent' : '1px solid ' + C.hairline,
          background: primary
            ? (hover && !disabled ? '#37332A' : C.ink)
            : (hover && !disabled ? 'rgba(35,38,32,.05)' : 'transparent'),
          color: primary ? '#F7F5EE' : C.inkSoft,
          fontSize: 13.5, fontWeight: 500, fontFamily: SANS, letterSpacing: '.01em',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          boxShadow: primary ? '0 2px 12px rgba(35,32,25,.22)' : 'none',
          transform: pressed && !disabled ? 'scale(.985)' : 'none',
          transition: 'background .16s ease, transform .12s ease, opacity .14s ease',
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
        h(SheetTop, { label: '本地语音教练', onClose }),
        h('div', { style: { fontFamily: SERIF, fontSize: 29, fontWeight: 500, letterSpacing: '-.01em', margin: '16px 0 0' } }, '语音练习'),
        h('div', { style: { fontSize: 13, color: C.muted, margin: '7px 0 6px', lineHeight: 1.6 } }, '选一个场景，直接开口说。'),
        h('div', { style: { marginTop: 14, borderTop: '1px solid ' + C.hairline } },
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
                display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '13px 8px',
                borderRadius: 10, border: 'none', borderBottom: '1px solid ' + C.hairlineSoft,
                background: hover ? 'rgba(35,38,32,.035)' : 'transparent',
                color: C.ink, textAlign: 'left', cursor: 'pointer', fontFamily: SANS,
                transition: 'background .18s ease',
              },
            },
              h('span', {
                style: {
                  width: 34, height: 34, borderRadius: 999, flex: '0 0 auto',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px solid ' + (selected ? 'rgba(63,111,95,.45)' : C.hairline),
                  background: selected ? C.celadonSoft : 'transparent',
                  color: selected ? C.celadonDeep : C.muted,
                  transition: 'border-color .18s ease, background .18s ease, color .18s ease',
                },
              }, h(ScenarioIcon, { id: item.id })),
              h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                h('span', { style: { fontSize: 14, fontWeight: 500, color: C.ink } }, item.nameZh || item.name || item.id),
                h('span', { style: { fontSize: 11.5, color: C.muted } }, [item.level, item.name].filter(Boolean).join('  /  '))),
              selected ? h('span', { style: { color: C.celadon, display: 'inline-flex', flex: '0 0 auto' } }, h(CheckIcon)) : null)
          })),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 24 } },
          h(ActionButton, { variant: 'primary', disabled: busy || scenarios.length === 0, onClick: () => onStart(picked) }, busy ? '启动中…' : '开始对话练习'),
          h(ActionButton, { disabled: busy, onClick: () => onShadow(5) }, '跟读练习')),
        (localError || (state && state.lastError))
          ? h('div', { style: { marginTop: 14, fontSize: 11.5, lineHeight: 1.55, color: C.oxblood, whiteSpace: 'pre-wrap' } }, localError || (state && state.lastError))
          : h('div', { style: { marginTop: 14, fontSize: 11.5, color: C.muted, textAlign: 'center', lineHeight: 1.6 } }, '开始后会打开麦克风；戴耳机效果更好。'),
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
        h(SheetTop, {
          label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h('span', {}, scenario),
            h(LevelChip, { level })),
          onClose: onEnd,
        }),
        h(Orb, { phase }),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 } },
          h(StatusDot, { phase }),
          h('div', { style: { fontFamily: SERIF, fontSize: 21, fontWeight: 500, letterSpacing: '-.01em', color: C.ink } }, statusText(phase))),
        h('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 11.5, color: C.muted, margin: '8px 0 20px' },
        },
          h('span', {}, '可以随时打断教练'),
          h('i', { style: { width: 3, height: 3, borderRadius: 999, background: '#C6C9BE' } }),
          h('span', { style: { fontVariantNumeric: 'tabular-nums', letterSpacing: '.06em' } }, mm + ':' + ss)),
        h('div', {
          style: {
            borderTop: '1px solid ' + C.hairline, borderBottom: '1px solid ' + C.hairline,
            padding: '13px 0 9px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 96,
          },
        },
          [
            ['你', userText, '（还没听到你说话）'],
            ['教练', assistantText, '（等待回复）'],
          ].map(([who, text, placeholder]) => h('div', { key: who, style: { display: 'flex', gap: 12, alignItems: 'baseline' } },
            h('span', { style: { flex: '0 0 34px', fontSize: 11, color: C.muted, letterSpacing: '.04em' } }, who),
            h('span', {
              style: {
                flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, lineHeight: 1.62,
                color: text ? C.ink : C.muted,
                maxHeight: 66, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              },
            }, text || placeholder)))),
        state && state.lastError ? h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.oxblood, whiteSpace: 'pre-wrap' } }, state.lastError) : null,
        h('div', { style: { display: 'flex', gap: 10, marginTop: 20 } },
          h(ActionButton, { disabled: busy || !(state && state.speaking), onClick: onStopSpeech }, '停止朗读'),
          h(ActionButton, { variant: 'primary', disabled: busy, onClick: onEnd }, '结束对话')),
      )
    }

    function ShadowView({ shadow, busy, onReplay, onNext, onStop }) {
      const target = shadow && typeof shadow.target === 'string' ? shadow.target : ''
      const focus = shadow && typeof shadow.focus === 'string' ? shadow.focus : ''
      const tipZh = shadow && typeof shadow.tipZh === 'string' ? shadow.tipZh : ''
      const tokens = shadow && Array.isArray(shadow.tokens) ? shadow.tokens : []
      const score = shadow && Number.isFinite(Number(shadow.score)) ? Number(shadow.score) : null
      const index = shadow && Number.isFinite(Number(shadow.index)) ? Number(shadow.index) : 0
      const total = shadow && Number.isFinite(Number(shadow.total)) ? Number(shadow.total) : 0
      const phase = shadow && typeof shadow.phase === 'string' ? shadow.phase : 'idle'
      const said = shadow && typeof shadow.said === 'string' ? shadow.said : ''
      // Proofreader's marks instead of highlighter chips: correct words stay
      // plain ink; only what needs attention is marked.
      const tokenStyle = (status) => status === 'match'
        ? { color: C.ink }
        : status === 'close'
          ? { color: '#855A1F', borderBottom: '1px dashed rgba(162,112,42,.6)' }
          : status === 'missing'
            ? { color: '#8A3F2E', borderBottom: '1px solid rgba(154,74,56,.5)', textDecoration: 'line-through' }
            : { color: C.muted }
      return h(Scrim, {},
        h(SheetTop, {
          label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h('span', {}, '跟读练习'),
            total > 0 ? h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, (index + 1) + ' / ' + total) : null,
            focus ? h('span', { style: { color: C.celadon, letterSpacing: '.02em' } }, focus) : null),
          onClose: onStop,
        }),
        h(Orb, { phase, size: 150 }),
        h('div', { style: { fontSize: 11.5, color: C.muted, textAlign: 'center', marginBottom: 10, letterSpacing: '.02em' } }, statusText(phase)),
        h('div', { style: { fontFamily: SERIF, fontSize: 20, fontWeight: 500, lineHeight: 1.55, textAlign: 'center', letterSpacing: '-.005em', color: C.ink } }, target || '（准备中…）'),
        tipZh ? h('div', { style: { fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 8, lineHeight: 1.6 } }, '发音要点：' + tipZh) : null,
        h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 4, fontSize: 13.5, lineHeight: 1.9, marginTop: 16, minHeight: 28 } },
          tokens.length > 0
            ? tokens.map((token, i) => h('span', {
              key: String(i),
              title: token.status === 'close' && token.heard ? '识别为 "' + token.heard + '"' : undefined,
              style: { padding: '0 2px', borderRadius: 4, ...tokenStyle(token.status) },
            }, token.word + (token.status === 'close' && token.heard ? ' ≈ ' + token.heard : '')))
            : h('span', { style: { color: C.muted } }, said || (phase === 'listening' ? '轮到你说了…' : '请稍候'))),
        score !== null ? h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 4, marginTop: 12 } },
          h('span', { style: { fontFamily: SERIF, fontSize: 34, fontWeight: 500, letterSpacing: '-.02em', color: score >= 70 ? C.celadonDeep : C.amber } }, String(score)),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, '分'))
          : null,
        shadow && shadow.averageScore !== null && shadow.averageScore !== undefined
          ? h('div', { style: { textAlign: 'center', fontSize: 11.5, color: C.muted, marginTop: 2, fontVariantNumeric: 'tabular-nums' } }, '平均分 ' + String(shadow.averageScore))
          : null,
        shadow && shadow.lastError ? h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.oxblood, whiteSpace: 'pre-wrap', textAlign: 'center' } }, shadow.lastError) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 20 } },
          h(ActionButton, { disabled: busy || phase === 'speaking' || phase === 'transcribing' || !target, onClick: onReplay }, '重读本句'),
          h(ActionButton, { disabled: busy, onClick: onNext }, '跳过这句'),
          h(ActionButton, { variant: 'primary', disabled: busy, onClick: onStop }, '结束跟读')),
      )
    }

    function StartingView({ label, hint, onCancel }) {
      return h(Scrim, {},
        h(SheetTop, { label, onClose: onCancel }),
        h(Orb, { phase: 'preparing', size: 140 }),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 } },
          h(Spinner),
          h('span', { style: { fontFamily: SERIF, fontSize: 18, fontWeight: 500, color: C.ink } }, '正在打开麦克风…')),
        h('div', { style: { textAlign: 'center', fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.6 } }, hint || '第一次使用会请求麦克风权限。'),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 22 } }, h(ActionButton, { style: { flex: '0 0 170px', margin: '0 auto' }, onClick: onCancel }, '取消')),
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

      const applySnapshot = (next) => {
        if (!next || typeof next !== 'object') return
        setState(next)
        setError('')
        if (next.active === true) setStarting(false)
        if (next.shadow && next.shadow.active === true) setShadowStarting(false)
      }

      const refresh = async () => {
        try {
          const next = await fetchJson('/voice-practice/state')
          applySnapshot(next)
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
        let sseConnected = false
        let source = null

        const schedulePoll = (delay) => {
          if (disposed) return
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(async () => {
            if (disposed) return
            await refresh()
            schedulePoll(sseConnected ? 2500 : 450)
          }, delay)
        }

        if (typeof window !== 'undefined' && typeof window.EventSource === 'function') {
          try {
            source = new window.EventSource('/voice-practice/events')
            source.addEventListener('state', (event) => {
              if (disposed) return
              sseConnected = true
              try {
                const parsed = JSON.parse(event.data)
                applySnapshot(parsed)
              } catch (_error) {}
            })
            source.onerror = () => {
              sseConnected = false
            }
          } catch (_error) {
            source = null
          }
        }

        void refresh()
        schedulePoll(sseConnected ? 2500 : 600)

        return () => {
          disposed = true
          if (timer !== null) clearTimeout(timer)
          if (source !== null) {
            try { source.close() } catch (_error) {}
          }
        }
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
        const live = readSessionContext(ctxRef)
        const sessionId = snapshot.sessionId || live.sessionId || ''
        const cwd = snapshot.cwd || live.cwd || ''
        setStarting(true)
        const data = await post('/voice-practice/start', { sessionId, scenario, cwd })
        if (data && data.ok === false) {
          setStarting(false)
        } else if (data && typeof data.sessionId === 'string' && data.sessionId !== '') {
          store.set({ sessionId: data.sessionId })
        }
      }
      const onShadowStart = async (count) => {
        setShadowStarting(true)
        const data = await post('/voice-practice/shadow/start', { count: count || 5 })
        if (data && data.ok === false) setShadowStarting(false)
      }
      const onStopSpeech = async () => { await post('/voice-practice/stop-speech', {}) }
      const onShadowReplay = async () => { await post('/voice-practice/shadow/replay', {}) }
      const onShadowNext = async () => { await post('/voice-practice/shadow/next', {}) }

      const shadow = state && state.shadow !== null && typeof state.shadow === 'object' ? state.shadow : null
      const shadowActive = Boolean(shadow && shadow.active === true)
      const active = Boolean(state && state.active === true)

      if (shadowActive) return h(ShadowView, { shadow, busy, onReplay: onShadowReplay, onNext: onShadowNext, onStop: close })
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