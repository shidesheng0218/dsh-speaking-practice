/**
 * core/state.js - finite state machine for the voice loop.
 * Pure module: no DSH imports; transitions are validated and observable.
 */

export const VOICE_STATES = Object.freeze([
  'idle',
  'listening',
  'capturing',
  'transcribing',
  'awaiting-reply',
  'speaking',
]);

export const TRANSITIONS = Object.freeze({
  idle: Object.freeze(['listening']),
  listening: Object.freeze(['capturing', 'idle']),
  capturing: Object.freeze(['transcribing', 'listening', 'idle']),
  transcribing: Object.freeze(['awaiting-reply', 'listening', 'speaking', 'idle']),
  'awaiting-reply': Object.freeze(['speaking', 'listening', 'idle']),
  speaking: Object.freeze(['listening', 'capturing', 'idle']),
});

/**
 * Validate voice-loop state transitions.
 *
 * transition(to) throws on an illegal edge unless {force: true} is supplied;
 * stop paths use force to converge on idle.
 */
export class VoiceStateMachine {
  constructor(options = {}) {
    const initial = options.initial ?? 'idle';
    if (!VOICE_STATES.includes(initial)) throw new Error('unknown initial voice state: ' + String(initial));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.historyLimit = Math.max(1, options.historyLimit ?? 100);
    this._state = initial;
    this._since = this.now();
    this._history = [];
    this._listeners = new Set();
  }

  get state() {
    return this._state;
  }

  get since() {
    return this._since;
  }

  can(to) {
    if (!VOICE_STATES.includes(to)) return false;
    return TRANSITIONS[this._state].includes(to);
  }

  is(...states) {
    return states.includes(this._state);
  }

  /**
   * Apply one transition.
   * @param {string} to target state.
   * @param {object} [meta] diagnostic payload kept in history.
   * @returns {string} the new (or unchanged) state.
   */
  transition(to, meta = {}) {
    const from = this._state;
    const forced = meta !== null && typeof meta === 'object' && meta.force === true;
    if (!VOICE_STATES.includes(to)) throw new Error('unknown voice state: ' + String(to));
    if (from === to) return to;
    if (!forced && !this.can(to)) {
      throw new Error('invalid voice state transition: ' + from + ' -> ' + to);
    }
    const at = this.now();
    this._state = to;
    this._since = at;
    const entry = { from, to, at, meta };
    this._history.push(entry);
    if (this._history.length > this.historyLimit) this._history.shift();
    for (const listener of this._listeners) {
      try {
        listener(entry);
      } catch (_error) {
        // Observers must never break the loop; the loop logs its own failures.
      }
    }
    return to;
  }

  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('onChange needs a function');
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  snapshot() {
    return { state: this._state, since: this._since, history: this._history.slice(-10) };
  }

  reset(initial = 'idle') {
    if (!VOICE_STATES.includes(initial)) throw new Error('unknown voice state: ' + String(initial));
    this._state = initial;
    this._since = this.now();
    this._history = [];
  }
}
