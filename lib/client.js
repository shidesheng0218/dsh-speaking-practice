/**
 * dsh-speaking-practice — browser half (v0.4 overlay).
 *
 * Renders into shell.overlay: a launcher, a scenario picker and a live call
 * card with phase, waveform, subtitles and controls. State is polled from the
 * host half at /voice-practice/state; buttons call /start, /stop,
 * /stop-speech. The host owns the microphone and the speech loop, so this
 * module never records audio itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-speaking-practice',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const STYLE_ID = 'dsh-speaking-practice-style'
    const CSS = [
      '.dsp-root{position:fixed;inset:0;pointer-events:none;z-index:60;font-family:inherit}',
      '.dsp-launcher{position:absolute;right:22px;bottom:96px;pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2937);font-size:13px;cursor:pointer;box-shadow:0 6px 24px rgba(15,23,42,.12)}',
      '.dsp-launcher:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsp-card{position:absolute;right:22px;bottom:96px;pointer-events:auto;width:340px;max-width:calc(100vw - 44px);border-radius:16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2937);box-shadow:0 18px 48px rgba(15,23,42,.18);overflow:hidden}',
      '.dsp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}',
      '.dsp-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsp-chip{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;background:rgba(77,107,254,.12);color:var(--dsw-alias-brand-primary,#4d6bfe);white-space:nowrap}',
      '.dsp-chip[data-phase="listening"]{background:rgba(34,197,94,.14);color:#16a34a}',
      '.dsp-chip[data-phase="speaking"]{background:rgba(249,115,22,.14);color:#ea580c}',
      '.dsp-chip[data-phase="transcribing"],.dsp-chip[data-phase="awaiting-reply"],.dsp-chip[data-phase="capturing"]{background:rgba(77,107,254,.12);color:#4d6bfe}',
      '.dsp-body{padding:10px 14px;display:flex;flex-direction:column;gap:8px}',
      '.dsp-scenario{display:flex;flex-direction:column;gap:6px}',
      '.dsp-option{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid transparent;cursor:pointer;font-size:12px}',
      '.dsp-option:hover{background:rgba(128,128,128,.08)}',
      '.dsp-option[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.06)}',
      '.dsp-option-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsp-option-meta{font-size:11px;opacity:.6;white-space:nowrap}',
      '.dsp-sub{font-size:12px;line-height:1.45;max-height:64px;overflow:auto;opacity:.92;white-space:pre-wrap;word-break:break-word}',
      '.dsp-sub b{font-weight:600;opacity:.55;margin-right:4px}',
      '.dsp-meter{height:4px;border-radius:999px;background:rgba(128,128,128,.15);overflow:hidden}',
      '.dsp-meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#22c55e,#84cc16);transition:width .12s linear}',
      '.dsp-row{display:flex;gap:8px;padding:0 14px 12px}',
      '.dsp-btn{flex:1;height:32px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;font-size:12px;cursor:pointer}',
      '.dsp-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsp-btn[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;color:#fff}',
      '.dsp-btn[data-kind="danger"]{color:#dc2626;border-color:rgba(220,38,38,.35)}',
      '.dsp-btn:disabled{opacity:.5;cursor:default}',
      '.dsp-hint{font-size:11px;line-height:1.5;opacity:.65;padding:0 14px 10px}',
      '.dsp-error{font-size:11px;line-height:1.5;color:#dc2626;padding:0 14px 10px;white-space:pre-wrap}',
      '.dsp-target{font-size:15px;line-height:1.5;font-weight:600;letter-spacing:.01em}',
      '.dsp-said{font-size:12px;line-height:1.6;opacity:.95}',
      '.dsp-token{margin-right:4px;border-radius:4px;padding:0 2px}',
      '.dsp-token[data-status="match"]{background:rgba(34,197,94,.16);color:#15803d}',
      '.dsp-token[data-status="missing"]{background:rgba(220,38,38,.14);color:#b91c1c;text-decoration:line-through}',
      '.dsp-token[data-status="extra"]{background:rgba(128,128,128,.16);color:#6b7280;text-decoration:line-through}',
      '.dsp-score{font-size:12px;font-weight:600}',
      '.dsp-score[data-pass="true"]{color:#16a34a}',
      '.dsp-score[data-pass="false"]{color:#ea580c}',
    ].join('')

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options)
      let data = null
      try { data = await response.json() } catch (_error) { data = null }
      if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status))
      return data
    }

    const PHASE_LABEL = {
      idle: '空闲',
      listening: '在听',
      capturing: '在听',
      transcribing: '识别中',
      'awaiting-reply': '思考中',
      speaking: '朗读中',
    }

    function useVoiceState(activeRef) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        let disposed = false
        let timer = null
        const tick = async () => {
          if (disposed) return
          try {
            const next = await fetchJson('/voice-practice/state')
            if (disposed) return
            setState(next)
            setError('')
            activeRef.current = Boolean(next && (next.active === true || (next.shadow && next.shadow.active === true)))
          } catch (err) {
            if (disposed) return
            setError(String((err && err.message) || err))
          }
          if (!disposed) timer = setTimeout(tick, activeRef.current ? 500 : 1500)
        }
        tick()
        return () => { disposed = true; if (timer !== null) clearTimeout(timer) }
      }, [activeRef])
      return { state, error }
    }

    function PhaseChip({ phase }) {
      const label = PHASE_LABEL[phase] || phase || '空闲'
      return h('span', { className: 'dsp-chip', 'data-phase': phase || 'idle' }, label)
    }

    function Meter({ levelDb }) {
      const db = Number(levelDb)
      const ratio = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 55) / 40)) : 0
      return h('div', { className: 'dsp-meter' }, h('i', { style: { width: (ratio * 100).toFixed(1) + '%' } }))
    }

    function Launcher({ onOpen, busy }) {
      return h('button', { type: 'button', className: 'dsp-launcher', disabled: busy, onClick: onOpen }, '🎙 语音练习')
    }

    function Panel({ state, onClose, onStart, onShadow, busy, localError }) {
      const scenarios = state && Array.isArray(state.scenarios) ? state.scenarios : []
      const [picked, setPicked] = useState('daily-chat')
      useEffect(() => {
        if (scenarios.length > 0 && !scenarios.some((item) => item.id === picked)) setPicked(scenarios[0].id)
      }, [scenarios, picked])
      return h('div', { className: 'dsp-card' },
        h('div', { className: 'dsp-head' },
          h('div', { className: 'dsp-title' }, '语音练习 · 选择场景'),
          h('button', { type: 'button', className: 'dsp-btn', style: { flex: '0 0 auto', width: '54px', height: '26px' }, onClick: onClose }, '关闭')),
        h('div', { className: 'dsp-body' },
          h('div', { className: 'dsp-scenario' }, scenarios.length === 0
            ? h('div', { className: 'dsp-hint' }, '没有加载到场景卡，请检查 content/scenarios。')
            : scenarios.map((item) => h('div', {
                key: item.id,
                className: 'dsp-option',
                'data-active': picked === item.id ? 'true' : 'false',
                onClick: () => setPicked(item.id),
              },
                h('span', { className: 'dsp-option-name' }, item.nameZh || item.name || item.id),
                h('span', { className: 'dsp-option-meta' }, [item.level, item.name].filter(Boolean).join(' · ')),
              )))),
        h('div', { className: 'dsp-row' },
          h('button', {
            type: 'button',
            className: 'dsp-btn',
            'data-kind': 'primary',
            disabled: busy || scenarios.length === 0,
            onClick: () => onStart(picked),
          }, busy ? '启动中…' : '开始对话练习'),
          h('button', {
            type: 'button',
            className: 'dsp-btn',
            disabled: busy,
            onClick: () => onShadow(5),
          }, '跟读练习')),
        (localError || (state && state.lastError)) ? h('div', { className: 'dsp-error' }, localError || state.lastError) : null,
        h('div', { className: 'dsp-hint' }, '开始后会打开麦克风并朗读教练回复；戴耳机效果更好。'),
      )
    }

    function CallCard({ state, onEnd, onStopSpeech, onStopListen, busy }) {
      const phase = state && state.phase ? state.phase : 'idle'
      const scenario = state && (state.scenarioTitle || state.scenario) ? (state.scenarioTitle || state.scenario) : '练习'
      const userText = state && typeof state.userText === 'string' ? state.userText : ''
      const assistantText = state && typeof state.assistantText === 'string' ? state.assistantText : ''
      const elapsed = state && Number(state.elapsedMs) > 0 ? Math.floor(Number(state.elapsedMs) / 1000) : 0
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      return h('div', { className: 'dsp-card' },
        h('div', { className: 'dsp-head' },
          h('div', { className: 'dsp-title' }, scenario),
          h(PhaseChip, { phase }),
          h('span', { className: 'dsp-option-meta' }, mm + ':' + ss)),
        h('div', { className: 'dsp-body' },
          h(Meter, { levelDb: state ? state.levelDb : 0 }),
          h('div', { className: 'dsp-sub' }, h('b', null, '你：'), userText || '（还没听到你说话）'),
          h('div', { className: 'dsp-sub' }, h('b', null, '教练：'), assistantText || '（等待回复）'),
          state && state.lastError ? h('div', { className: 'dsp-error' }, state.lastError) : null,
        ),
        h('div', { className: 'dsp-row' },
          h('button', {
            type: 'button',
            className: 'dsp-btn',
            disabled: busy || !(state && state.speaking),
            onClick: onStopSpeech,
          }, '停止朗读'),
          h('button', {
            type: 'button',
            className: 'dsp-btn',
            'data-kind': 'danger',
            disabled: busy,
            onClick: onEnd,
          }, '结束'),
        ),
        h('div', { className: 'dsp-hint' }, '说 "end session" 让教练写完整复盘；直接结束会保存轻量记录。'),
      )
    }

    function ShadowCard({ shadow, busy, onNext, onStop }) {
      const target = shadow && typeof shadow.target === 'string' ? shadow.target : ''
      const said = shadow && typeof shadow.said === 'string' ? shadow.said : ''
      const tokens = shadow && Array.isArray(shadow.tokens) ? shadow.tokens : []
      const score = shadow && Number.isFinite(Number(shadow.score)) ? Number(shadow.score) : null
      const index = shadow && Number.isFinite(Number(shadow.index)) ? Number(shadow.index) : 0
      const total = shadow && Number.isFinite(Number(shadow.total)) ? Number(shadow.total) : 0
      const phase = shadow && typeof shadow.phase === 'string' ? shadow.phase : 'idle'
      return h('div', { className: 'dsp-card' },
        h('div', { className: 'dsp-head' },
          h('div', { className: 'dsp-title' }, '跟读练习'),
          h('span', { className: 'dsp-option-meta' }, (index + 1) + ' / ' + total),
          score !== null ? h('span', { className: 'dsp-score', 'data-pass': score >= 70 ? 'true' : 'false' }, String(score)) : null),
        h('div', { className: 'dsp-body' },
          h('div', { className: 'dsp-target' }, target || '（准备中…）'),
          h('div', { className: 'dsp-said' }, tokens.length > 0
            ? tokens.map((token, i) => h('span', {
                key: String(i),
                className: 'dsp-token',
                'data-status': token.status,
              }, token.word))
            : (said ? said : (phase === 'listening' ? '轮到你说了…' : ''))),
          shadow && shadow.averageScore !== null && shadow.averageScore !== undefined
            ? h('div', { className: 'dsp-hint', style: { padding: '0' } }, '平均分：' + String(shadow.averageScore))
            : null,
          shadow && shadow.lastError ? h('div', { className: 'dsp-error', style: { padding: '0' } }, shadow.lastError) : null,
        ),
        h('div', { className: 'dsp-row' },
          h('button', { type: 'button', className: 'dsp-btn', disabled: busy, onClick: onNext }, '跳过这句'),
          h('button', { type: 'button', className: 'dsp-btn', 'data-kind': 'danger', disabled: busy, onClick: onStop }, '结束跟读'),
        ),
        h('div', { className: 'dsp-hint' }, '先听教练读一遍，再跟着说；逐词高亮显示对错。'),
      )
    }

    function Overlay({ ctxRef }) {
      injectStyle()
      const activeRef = useRef(false)
      const { state, error } = useVoiceState(activeRef)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [localError, setLocalError] = useState('')

      const shadow = state && state.shadow !== null && typeof state.shadow === 'object' ? state.shadow : null
      const shadowActive = Boolean(shadow && shadow.active === true)
      const active = Boolean(state && state.active === true)
      useEffect(() => {
        if (active || shadowActive) setOpen(false)
      }, [active, shadowActive])

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

      const call = async (url, body) => {
        setBusy(true)
        setLocalError('')
        try {
          const data = await fetchJson(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          if (data && data.ok === false) setLocalError(data.error || '操作失败')
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
        await call('/voice-practice/start', { sessionId, scenario })
      }
      const onEnd = async () => { await call('/voice-practice/stop', {}) }
      const onStopSpeech = async () => { await call('/voice-practice/stop-speech', {}) }
      const onShadow = async (count) => { await call('/voice-practice/shadow/start', { count: count || 5 }) }
      const onShadowNext = async () => { await call('/voice-practice/shadow/next', {}) }
      const onShadowStop = async () => { await call('/voice-practice/shadow/stop', {}) }

      if (shadowActive) {
        return h('div', { className: 'dsp-root' },
          h(ShadowCard, { shadow, busy, onNext: onShadowNext, onStop: onShadowStop }),
        )
      }
      if (active) {
        return h('div', { className: 'dsp-root' },
          h(CallCard, { state, busy, onEnd, onStopSpeech, onStopListen: onEnd }),
        )
      }
      if (open) {
        return h('div', { className: 'dsp-root' },
          h(Panel, { state, busy, localError: localError || error, onStart, onShadow, onClose: () => setOpen(false) }),
        )
      }
      return h('div', { className: 'dsp-root' }, h(Launcher, { busy: false, onOpen: () => { setOpen(true); setLocalError('') } }))
    }

    return Object.defineProperty({
      name: 'dsh-speaking-practice',
      inject: ['slots'],
      apply(ctx) {
        injectStyle()
        const self = { token: {}, dispose: null }
        const ctxRef = { current: null }
        self.dispose = () => {
          try { disposeSlot?.() } catch (_error) {}
          disposeSlot = null
          if (window.__dshSpeakingPracticeOwner === self) window.__dshSpeakingPracticeOwner = null
        }
        const previous = window.__dshSpeakingPracticeOwner
        if (previous && previous !== self && typeof previous.dispose === 'function') {
          try { previous.dispose() } catch (_error) {}
        }
        window.__dshSpeakingPracticeOwner = self
        let disposeSlot = null
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
