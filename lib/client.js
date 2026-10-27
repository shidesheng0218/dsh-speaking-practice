/**
 * dsh-speaking-practice — browser half (spike A: composer toggle button).
 *
 * Hand-written bundle in the lazy-CJS module-loader format:
 * executing this script only registers a factory; the React component is
 * materialized on first use. Only platform modules may be required synchronously.
 *
 * The button submits "/voice on" / "/voice off" through the composer pipeline,
 * which is the only client -> host path available without a custom Remote.
 */
window.__ModuleLoader__.load({
  id: 'dsh-speaking-practice',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-speaking-practice-style'
    const CSS = [
      '.dsp-toggle{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;',
      'border:1px solid var(--dsh-border-color,rgba(128,128,128,.35));border-radius:999px;',
      'background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;',
      'white-space:nowrap;transition:background .15s ease,border-color .15s ease;opacity:.9}',
      '.dsp-toggle:hover{background:rgba(128,128,128,.12);opacity:1}',
      '.dsp-toggle[data-on="true"]{border-color:#3b82f6;color:#3b82f6;background:rgba(59,130,246,.1)}',
      '.dsp-toggle:disabled{opacity:.5;cursor:default}',
    ].join('')

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function submitDraft(inputActions, text) {
      try {
        inputActions.setDraft(text)
      } catch (error) {
        try { console.warn('[voice-practice] setDraft failed', error) } catch {}
        return false
      }
      // Let the conversation store publish the new draft before submitting.
      setTimeout(() => {
        try {
          inputActions.submit()
        } catch (error) {
          try { console.warn('[voice-practice] submit failed', error) } catch {}
        }
      }, 60)
      return true
    }

    function VoiceToggle(props) {
      const inputActions = props !== null && props !== undefined ? props.inputActions : undefined
      const [on, setOn] = React.useState(false)
      const disabled = inputActions === undefined || typeof inputActions.setDraft !== 'function'
        || typeof inputActions.submit !== 'function'
      const onClick = () => {
        if (disabled) return
        const next = !on
        const text = next ? '/voice on' : '/voice off'
        if (submitDraft(inputActions, text)) setOn(next)
      }
      return h('button', {
        type: 'button',
        className: 'dsp-toggle',
        'data-on': on ? 'true' : 'false',
        'aria-pressed': on,
        title: on ? '关闭语音模式（/voice off）' : '开启语音模式（/voice on）',
        disabled,
        onMouseDown: (event) => event.preventDefault(),
        onClick,
      }, on ? '🎙 语音 ON' : '🎙 语音')
    }

    return Object.defineProperty({
      name: 'dsh-speaking-practice',
      inject: ['slots'],
      apply(ctx) {
        injectStyle()
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-speaking-practice.toggle',
          order: 500,
        }, VoiceToggle))
      },
    }, Symbol.toStringTag, { value: 'Module' })
  },
})
