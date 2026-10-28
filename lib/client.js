/**
 * dsh-speaking-practice — browser half (v0.4.4, DSH-native surfaces).
 *
 * Design follows the harness UI: solid overlay surface, hairline borders,
 * neutral type scale, one blue accent. No injected <style> (CSP-safe);
 * entrance animations use the Web Animations API and respect reduced motion.
 *
 * Interaction: optimistic start/stop, immediate refresh after every POST,
 * 300ms polling while live, hover/press feedback on every control, click
 * outside / Esc to close, last scenario remembered.
 */
window.__ModuleLoader__.load({
  id: 'dsh-speaking-practice',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const C = {
      accent: '#4176e6',
      accentSoft: '#eef4ff',
      accentBorder: '#d5e2ff',
      accentDeep: '#3564c9',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      soft: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      border: 'var(--dsw-alias-border-l2, #e8eaef)',
      ink: 'var(--dsw-alias-label-primary, #1f2329)',
      muted: 'var(--dsw-alias-label-secondary, #8a8f98)',
      danger: '#d92d20',
      ok: '#12a150',
      warn: '#dc6803',
      hover: 'rgba(16,24,40,.045)',
    }

    const S = {
      wrap: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 30 },
      backdrop: { position: 'absolute', inset: 0, pointerEvents: 'auto', background: 'transparent' },
      launcher: {
        position: 'absolute', right: 22, bottom: 96, pointerEvents: 'auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 46, height: 46, padding: 0,
        borderRadius: 999, border: '1px solid ' + C.border,
        background: C.surface, color: C.ink, cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(16,24,40,.06), 0 8px 22px rgba(16,24,40,.12)',
        transition: 'transform .18s cubic-bezier(.22,.61,.36,1), box-shadow .18s ease, border-color .18s ease',
        fontFamily: 'inherit',
      },
      card: {
        position: 'absolute', right: 22, bottom: 96, pointerEvents: 'auto',
        width: 380, maxWidth: 'calc(100vw - 44px)', maxHeight: 'calc(100vh - 140px)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        borderRadius: 14, border: '1px solid ' + C.border,
        background: C.surface, color: C.ink,
        boxShadow: '0 12px 32px rgba(16,24,40,.12), 0 2px 6px rgba(16,24,40,.05)',
        fontFamily: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderBottom: '1px solid ' + C.border },
      mark: {
        width: 28, height: 28, borderRadius: 8, background: C.accentSoft, color: C.accent,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
      },
      headerText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
      headerTitle: { fontSize: 13, fontWeight: 600, letterSpacing: '.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      headerSub: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
      dot: { width: 6, height: 6, borderRadius: 999, background: C.muted, flex: '0 0 auto' },
      timer: { fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      iconBtn: {
        width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent',
        color: C.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', padding: 0, flex: '0 0 auto',
        transition: 'background .14s ease, color .14s ease',
      },
      body: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 10px 6px', overflowY: 'auto' },
      sectionLabel: { fontSize: 11, color: C.muted, padding: '2px 6px 6px' },
      option: {
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 8px',
        borderRadius: 10, border: '1px solid transparent', background: 'transparent',
        color: C.ink, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        transition: 'background .14s ease, border-color .14s ease',
      },
      optionOn: { background: C.accentSoft, borderColor: C.accentBorder },
      optionIcon: {
        width: 30, height: 30, borderRadius: 8, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: C.soft, color: C.muted, transition: 'background .14s ease, color .14s ease',
      },
      optionIconOn: { background: '#ffffff', color: C.accent, boxShadow: 'inset 0 0 0 1px ' + C.accentBorder },
      optionText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
      optionName: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      optionMeta: { fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      footer: { display: 'flex', gap: 8, padding: '10px 14px 12px' },
      btn: {
        flex: 1, height: 38, borderRadius: 10, border: '1px solid ' + C.border,
        background: C.surface, color: C.ink, fontSize: 13, fontWeight: 500,
        cursor: 'pointer', fontFamily: 'inherit',
        transition: 'background .14s ease, border-color .14s ease, transform .12s ease, opacity .14s ease, box-shadow .14s ease',
      },
      btnPrimary: {
        borderColor: 'transparent', color: '#ffffff',
        background: 'linear-gradient(180deg, #5b8ef0 0%, ' + C.accent + ' 100%)',
        boxShadow: '0 1px 2px rgba(16,24,40,.12), inset 0 1px 0 rgba(255,255,255,.18)',
      },
      btnDanger: { borderColor: 'rgba(217,45,32,.28)', color: C.danger, background: C.surface },
      btnDisabled: { opacity: 0.45, cursor: 'default', boxShadow: 'none', transform: 'none' },
      hint: { padding: '0 14px 12px', fontSize: 11, lineHeight: 1.55, color: C.muted },
      error: { padding: '0 14px 12px', fontSize: 11, lineHeight: 1.55, color: C.danger, whiteSpace: 'pre-wrap' },
      meter: { height: 3, borderRadius: 999, background: C.border, overflow: 'hidden' },
      meterFill: { height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,' + C.ok + ',' + '#84cc16' + ')', transition: 'width .18s linear' },
      sub: { fontSize: 12, lineHeight: 1.55, color: C.ink, maxHeight: 72, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      subLabel: { color: C.muted, marginRight: 5, fontWeight: 500 },
      target: { fontSize: 16, lineHeight: 1.5, fontWeight: 600, letterSpacing: '.005em' },
      tokens: { display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 12, lineHeight: 1.7 },
      token: { padding: '0 3px', borderRadius: 4 },
      tokenMatch: { background: 'rgba(18,161,80,.14)', color: '#0f7a3d' },
      tokenMissing: { background: 'rgba(217,45,32,.12)', color: '#b42318', textDecoration: 'line-through' },
      tokenExtra: { background: 'rgba(16,24,40,.08)', color: C.muted, textDecoration: 'line-through' },
      score: { fontSize: 12, fontWeight: 600 },
      starting: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 14px' },
      startingText: { fontSize: 13, color: C.ink, lineHeight: 1.5 },
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

    function useEntrance(duration = 180) {
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node === null || REDUCED === null || REDUCED.matches) return
        try {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(6px) scale(.99)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' },
            ],
            { duration, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
          )
        } catch (_error) {}
      }, [duration])
      return ref
    }

    const PHASE = {
      idle: ['空闲', C.muted],
      listening: ['在听', C.ok],
      capturing: ['在听', C.ok],
      transcribing: ['识别中', C.accent],
      'awaiting-reply': ['思考中', C.accent],
      speaking: ['朗读中', C.warn],
      preparing: ['准备中', C.accent],
      feedback: ['评分中', C.accent],
    }

    function PhaseLabel({ phase }) {
      const item = PHASE[phase] || PHASE.idle
      return h('span', { style: S.headerSub },
        h('i', { style: { ...S.dot, background: item[1] } }),
        item[0])
    }

    function WaveMark({ size = 15 }) {
      const heights = [3, 6, 9, 6, 3]
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
        heights.map((height, index) => h('rect', {
          key: String(index),
          x: 2.4 + index * 3.1, y: 10 - height / 2, width: 1.6, height, rx: 0.8,
          fill: 'currentColor',
        })))
    }

    function ScenarioIcon({ id, size = 17 }) {
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
        h('path', { d: 'M20 6.5 9.4 17.1 4 11.7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CloseIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    function Spinner({ size = 15, color = C.accent }) {
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
        type: 'button', title, disabled,
        style: {
          ...base,
          ...(hover && !disabled ? {
            background: variant === 'primary'
              ? 'linear-gradient(180deg, #4f83ea 0%, ' + C.accentDeep + ' 100%)'
              : C.hover,
            ...(variant !== 'primary' ? { borderColor: 'rgba(16,24,40,.16)' } : {}),
          } : {}),
          ...(pressed && !disabled ? { transform: 'scale(.98)' } : {}),
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

    function OptionRow({ id, selected, onClick, name, meta }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button',
        style: {
          ...S.option,
          ...(selected ? S.optionOn : {}),
          ...(hover && !selected ? { background: C.hover } : {}),
        },
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h('span', { style: { ...S.optionIcon, ...(selected ? S.optionIconOn : {}) } }, h(ScenarioIcon, { id })),
        h('span', { style: S.optionText },
          h('span', { style: S.optionName }, name),
          h('span', { style: S.optionMeta }, meta)),
        selected ? h('span', { style: { color: C.accent, display: 'inline-flex', flex: '0 0 auto' } }, h(CheckIcon)) : null)
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
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', style: { color: 'inherit' },
      }, bars)
    }

    function Launcher({ onOpen }) {
      const [hover, setHover] = useState(false)
      const [pressed, setPressed] = useState(false)
      const ref = useEntrance(150)
      return h('div', { style: S.wrap },
        h('button', {
          ref, type: 'button',
          style: {
            ...S.launcher,
            transform: pressed ? 'translateY(0) scale(.94)' : hover ? 'translateY(-2px) scale(1.02)' : 'none',
            borderColor: hover ? 'rgba(65,118,230,.45)' : C.border,
            boxShadow: hover
              ? '0 1px 2px rgba(16,24,40,.06), 0 10px 26px rgba(16,24,40,.16), 0 0 0 4px rgba(65,118,230,.08)'
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

    function CardHeader({ title, sub, right, onClose }) {
      return h('div', { style: S.header },
        h('span', { style: S.mark }, h(WaveMark)),
        h('span', { style: S.headerText },
          h('span', { style: S.headerTitle }, title),
          h('span', { style: S.headerSub }, sub)),
        right,
        onClose ? h('button', {
          type: 'button', style: S.iconBtn, onClick: onClose, title: '关闭', 'aria-label': '关闭',
          onMouseEnter: (event) => { event.currentTarget.style.background = C.hover; event.currentTarget.style.color = C.ink },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = C.muted },
        }, h(CloseIcon)) : null)
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
          h(CardHeader, { title: '语音练习', sub: '本地语音 · AI 教练', onClose }),
          h('div', { style: S.body },
            h('div', { style: S.sectionLabel }, '选择场景'),
            scenarios.length === 0
              ? h('div', { style: { padding: '4px 6px 8px', fontSize: 11, color: C.muted } }, '没有加载到场景卡，请检查 content/scenarios。')
              : scenarios.map((item) => h(OptionRow, {
                  key: item.id,
                  id: item.id,
                  selected: picked === item.id,
                  onClick: () => pick(item.id),
                  name: item.nameZh || item.name || item.id,
                  meta: [item.level, item.name].filter(Boolean).join(' · '),
                }))),
          h('div', { style: S.footer },
            h(ActionButton, {
              variant: 'primary',
              style: { flex: '1.35' },
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
          h(CardHeader, { title, sub: h(PhaseLabel, { phase }), right: h('span', { style: S.timer }, mm + ':' + ss) }),
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
          h(CardHeader, {
            title: '跟读练习',
            sub: h(PhaseLabel, { phase }),
            right: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('span', { style: S.timer }, (index + 1) + '/' + total),
              score !== null ? h('span', { style: { ...S.score, color: score >= 70 ? C.ok : C.warn } }, String(score)) : null),
          }),
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
          h(CardHeader, { title: label, sub: '正在准备语音…', right: h(Spinner) }),
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
