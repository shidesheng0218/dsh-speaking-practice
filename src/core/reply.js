/**
 * core/reply.js - binds one submitted voice transcript to the assistant turn that
 * answers it, accumulating assistant text until that turn ends.
 *
 * Pure module: no DSH imports, unit-testable with fake session events.
 */

/**
 * Track one submission through turn/start -> assistant/message* -> turn/end.
 * A reply is bound to the first turn/start that follows begin(); assistant text
 * from other turns is ignored.
 */
export class ReplyTracker {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.maxWaitMs = Math.max(1000, options.maxWaitMs ?? 120000);
    this._active = null;
    this._sequence = 0;
  }

  get active() {
    return this._active !== null;
  }

  get turn() {
    return this._active === null ? null : this._active.turn;
  }

  /** The turn the loop currently expects (null until the reply turn starts). */
  get activeTurn() {
    return this._active === null ? null : this._active.turn;
  }

  get submittedText() {
    return this._active === null ? '' : this._active.submittedText;
  }

  get sequence() {
    return this._sequence;
  }

  /**
   * Begin tracking a submitted transcript.
   * @param {string} submittedText the exact text injected as a user message.
   * @returns {number} monotonically increasing submission sequence.
   */
  begin(submittedText) {
    this._sequence += 1;
    this._active = {
      submittedText: String(submittedText ?? ''),
      turn: null,
      parts: [],
      startedAt: this.now(),
      sequence: this._sequence,
    };
    return this._sequence;
  }

  /** Bind the submission to the first turn that starts after it. */
  onTurnStart(turn) {
    if (this._active === null || this._active.turn !== null) return false;
    if (!Number.isFinite(turn)) return false;
    this._active.turn = turn;
    return true;
  }

  /** Accumulate assistant text belonging to the bound turn. */
  onAssistantText(turn, text) {
    if (this._active === null || this._active.turn === null) return false;
    if (this._active.turn !== turn) return false;
    if (typeof text !== 'string' || text.trim() === '') return false;
    this._active.parts.push(text);
    return true;
  }

  /**
   * Finish the bound turn.
   * @returns {{turn:number, reasonKind:string|undefined, text:string, submittedText:string, sequence:number}|null}
   */
  onTurnEnd(turn, reasonKind) {
    if (this._active === null || this._active.turn === null) return null;
    if (this._active.turn !== turn) return null;
    const active = this._active;
    this._active = null;
    return {
      turn: active.turn,
      reasonKind,
      text: active.parts.join('\n').trim(),
      submittedText: active.submittedText,
      sequence: active.sequence,
    };
  }

  /** True when a submission never got a turn within maxWaitMs. */
  isExpired(now = this.now()) {
    if (this._active === null) return false;
    if (this._active.turn !== null) return false;
    return now - this._active.startedAt >= this.maxWaitMs;
  }

  reset() {
    this._active = null;
  }
}
