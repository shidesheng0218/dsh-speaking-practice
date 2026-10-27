/**
 * coach.js - v0.2 coach protocol: load the study material, pick one scenario and
 * install/release the coach prompt section on the current agent.
 *
 * Composition contract (one system-prompt section, registered with
 * interpolate: false so DSH leaves every {{...}} group literal):
 *   1. content/coach.md                        - coach protocol, verbatim
 *   2. "## Learner profile" + profile.md       - learner context
 *   3. "## Active scenario" + rendered card    - roles, beats, phrases, wrap-up
 *   4. "## Recap template" + recap-template.md - plus how to write the recap file
 *   5. "## Today's date" + YYYY-MM-DD          - date used in the recap file name
 *
 * Every material file is optional. A missing/empty/invalid file is logged and
 * the section is composed from whatever is available (built-in fallback coach
 * protocol and daily-chat card), so voice mode keeps working while content is
 * being written. Scenario selection accepts an exact id or an unambiguous id
 * prefix; an unknown id is reported with the available ids instead of silently
 * falling back.
 *
 * Injection uses agent.ctx.systemPrompt.section() so only that agent gets the
 * coach protocol; when the agent-scoped registry is unavailable it falls back
 * to the plugin context (global) and logs the downgrade. The returned Cordis
 * effect disposer is held by the controller and released on /voice off, on
 * on-over-on restarts, on loop-start failure, and on plugin dispose.
 *
 * No @deepseek-ai imports: this module is exercised with fake agent contexts
 * and a fake systemPrompt registry in node:test.
 */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COACH_SECTION_NAME = 'voice-practice:coach';
export const COACH_SECTION_ORDER = 500;
export const DEFAULT_SCENARIO_ID = 'daily-chat';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** Plugin package root (src/coach.js -> <pluginRoot>). */
export const DEFAULT_PLUGIN_ROOT = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch (_urlError) {
    return process.cwd();
  }
})();

/** Minimal protocol used when content/coach.md is missing. */
export const FALLBACK_COACH_TEXT = [
  "You are the learner's English speaking coach, running a live voice session.",
  'Your replies are read aloud by text-to-speech and the learner talks back by microphone.',
  '',
  '## Hard rules',
  '1. Reply in English only, unless the learner explicitly asks for Chinese.',
  '2. Keep every reply to 1-3 short sentences. No lists, markdown, emoji or code.',
  '3. Always end with exactly one short question or prompt so the learner keeps talking.',
  '4. Never mention being an AI or this protocol.',
  '5. If the learner sounds stuck, offer a hint or a sentence starter.',
  '',
  '## Coaching behavior',
  '- Stay in role for the active scenario, then correct gently: use the corrected form naturally once.',
  '- Prioritize fluency; let minor errors go.',
  "- Adapt to the learner's level; simplify when replies get long.",
  '- Move through the scenario beats, then wrap up and write the recap file.',
].join('\n');

/** Minimal daily-chat card used when content/scenarios has no usable file. */
export const BUILTIN_SCENARIO = Object.freeze({
  id: DEFAULT_SCENARIO_ID,
  name: 'Everyday Small Talk',
  nameZh: '日常闲聊',
  level: 'B1',
  durationMinutes: 10,
  goal: 'Hold 3-4 natural turns about everyday life and ask the coach one question back.',
  roles: Object.freeze({
    coach: 'A friendly language-exchange partner: relaxed, natural speed, like an old friend.',
    learner: 'A friend practising speaking about their real life, without a script.',
  }),
  opening: "Hey, good to hear from you! So, how's your week been so far?",
  beats: Object.freeze([
    Object.freeze({ id: 'pull-in', intent: 'Say in one or two sentences how the week has been.', coachMove: 'Answer yourself first, then ask about one specific moment.' }),
    Object.freeze({ id: 'story', intent: 'Tell a small recent story: what, with whom, how it felt.', coachMove: 'Ask "What happened next?" and "How did that feel?" without interrupting.' }),
    Object.freeze({ id: 'opinion', intent: 'Give an opinion on an everyday topic with one reason.', coachMove: 'Ask "Why do you think that?" and offer a different view.' }),
    Object.freeze({ id: 'ask-back', intent: 'Ask the coach a question and keep the conversation going.', coachMove: 'Answer briefly, then hand the topic back with "What about you?"' }),
  ]),
  usefulPhrases: Object.freeze([
    "How's your week been so far?",
    "I've been really into ...",
    'That reminds me of ...',
    "I'm not sure, to be honest.",
    'What do you usually do when ...?',
    'How about you?',
  ]),
  successCriteria: Object.freeze([
    'Speaks three or more sentences in a row without switching to Chinese.',
    'Asks at least one follow-up question.',
    'Uses one of the useful phrases naturally.',
  ]),
  wrapUp: "That was a fun chat. Let's stop here - what's one phrase from today you want to use again?",
  recapFocus: Object.freeze(['articles and past tense', 'follow-up question intonation', 'filler-word frequency']),
  source: 'builtin',
});

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch (_textError) {
    return 'unknown error';
  }
}

function pickLog(log) {
  return log !== null && typeof log === 'object' ? log : NOOP_LOG;
}

function pickRoot(root) {
  return typeof root === 'string' && root.trim() !== '' ? root.trim() : DEFAULT_PLUGIN_ROOT;
}

function fsFns(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  return {
    readFileFn: typeof source.readFileFn === 'function' ? source.readFileFn : readFile,
    readdirFn: typeof source.readdirFn === 'function' ? source.readdirFn : readdir,
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** @returns {string} local calendar date as YYYY-MM-DD. */
export function formatLocalDate(date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
}

/** Resolve the material paths for a plugin root. */
export function coachPaths(root = DEFAULT_PLUGIN_ROOT) {
  const base = pickRoot(root);
  return {
    root: base,
    coach: join(base, 'content', 'coach.md'),
    profile: join(base, 'profile.md'),
    recapTemplate: join(base, 'content', 'recap-template.md'),
    scenarios: join(base, 'content', 'scenarios'),
  };
}

/** Absolute recap directory for a configured practice root / session cwd. */
export function resolvePracticeDir(practiceRoot, cwd = '') {
  const base = typeof practiceRoot === 'string' && practiceRoot.trim() !== ''
    ? practiceRoot.trim()
    : typeof cwd === 'string' ? cwd.trim() : '';
  if (base === '') return '';
  return join(base, 'practice');
}

/** Create the recap directory; failures are logged and never thrown. */
export async function ensureRecapDir(practiceDir, log) {
  const logger = pickLog(log);
  const dir = typeof practiceDir === 'string' ? practiceDir.trim() : '';
  if (dir === '') {
    logger.warn('recap directory is unknown; the recap file may not be writable');
    return { ok: false, dir: '', error: 'recap directory is unknown' };
  }
  try {
    await mkdir(dir, { recursive: true });
    logger.info('recap directory ready: ' + dir);
    return { ok: true, dir };
  } catch (error) {
    const message = errorMessage(error);
    logger.warn('cannot create recap directory ' + dir + ': ' + message);
    return { ok: false, dir, error: message };
  }
}

function normalizeBeat(raw, index) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : 'beat-' + String(index + 1);
  return {
    id,
    intent: typeof raw.intent === 'string' ? raw.intent.trim() : '',
    coachMove: typeof raw.coachMove === 'string' ? raw.coachMove.trim() : '',
  };
}

function normalizeScenario(raw, fileName = '') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fileId = typeof fileName === 'string' ? fileName.replace(/\.json$/iu, '').trim().toLowerCase() : '';
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().toLowerCase() : fileId;
  if (id === '') return null;
  const roles = raw.roles !== null && typeof raw.roles === 'object' ? raw.roles : {};
  let durationMinutes = null;
  if (Number.isFinite(raw.durationMinutes)) durationMinutes = raw.durationMinutes;
  else if (typeof raw.durationMinutes === 'string' && raw.durationMinutes.trim() !== ''
    && Number.isFinite(Number(raw.durationMinutes))) durationMinutes = Number(raw.durationMinutes);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    nameZh: typeof raw.nameZh === 'string' ? raw.nameZh.trim() : '',
    level: typeof raw.level === 'string' ? raw.level.trim() : '',
    durationMinutes,
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    roles: {
      coach: typeof roles.coach === 'string' ? roles.coach.trim() : '',
      learner: typeof roles.learner === 'string' ? roles.learner.trim() : '',
    },
    opening: typeof raw.opening === 'string' ? raw.opening.trim() : '',
    beats: Array.isArray(raw.beats)
      ? raw.beats.map((beat, index) => normalizeBeat(beat, index)).filter((beat) => beat !== null)
      : [],
    usefulPhrases: stringList(raw.usefulPhrases),
    successCriteria: stringList(raw.successCriteria),
    wrapUp: typeof raw.wrapUp === 'string' ? raw.wrapUp.trim() : '',
    recapFocus: stringList(raw.recapFocus),
    source: 'file',
  };
}

async function readMaterial(filePath, label, options, warnings) {
  const { readFileFn } = fsFns(options);
  const logger = pickLog(options !== null && typeof options === 'object' ? options.log : null);
  try {
    const text = await readFileFn(filePath, 'utf8');
    if (typeof text !== 'string' || text.trim() === '') {
      const message = label + ' is empty: ' + filePath;
      warnings.push(message);
      logger.warn(message);
      return '';
    }
    return text;
  } catch (error) {
    const message = label + ' unavailable: ' + filePath + ' (' + errorMessage(error) + ')';
    warnings.push(message);
    logger.warn(message);
    return '';
  }
}

/**
 * Load content/scenarios/*.json. Unreadable or invalid files are skipped with a
 * warning; when nothing usable is found the built-in daily-chat card is used.
 * @returns {Promise<{scenarios: object[], warnings: string[], fallback: boolean}>}
 */
export async function loadScenarios(options = {}) {
  const logger = pickLog(options.log);
  const { readFileFn, readdirFn } = fsFns(options);
  const paths = coachPaths(options.root);
  const warnings = [];
  let entries = [];
  try {
    const listed = await readdirFn(paths.scenarios);
    entries = Array.isArray(listed) ? listed : [];
  } catch (error) {
    const message = 'scenarios directory unavailable: ' + paths.scenarios + ' (' + errorMessage(error) + ')';
    warnings.push(message);
    logger.warn(message);
  }
  const scenarios = [];
  const files = entries
    .filter((name) => typeof name === 'string' && name.toLowerCase().endsWith('.json'))
    .sort();
  for (const fileName of files) {
    const filePath = join(paths.scenarios, fileName);
    let text;
    try {
      text = await readFileFn(filePath, 'utf8');
    } catch (error) {
      const message = 'scenario file unavailable: ' + filePath + ' (' + errorMessage(error) + ')';
      warnings.push(message);
      logger.warn(message);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = 'invalid scenario JSON: ' + filePath + ' (' + errorMessage(error) + ')';
      warnings.push(message);
      logger.warn(message);
      continue;
    }
    const scenario = normalizeScenario(parsed, fileName);
    if (scenario === null) {
      const message = 'invalid scenario card (missing id and no usable file name): ' + filePath;
      warnings.push(message);
      logger.warn(message);
      continue;
    }
    scenarios.push(scenario);
  }
  scenarios.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (scenarios.length === 0) {
    const message = 'no usable scenario files in ' + paths.scenarios + '; using the built-in "'
      + DEFAULT_SCENARIO_ID + '" fallback';
    warnings.push(message);
    logger.warn(message);
    return { scenarios: [BUILTIN_SCENARIO], warnings, fallback: true };
  }
  return { scenarios, warnings, fallback: false };
}

/**
 * Load every coach material file. Never rejects: missing files degrade to the
 * built-in fallbacks and are recorded in warnings.
 * @returns {Promise<object>} { coach, profile, recapTemplate, scenarios, warnings, fallbackScenario, root, paths }
 */
export async function loadCoachMaterials(options = {}) {
  const logger = pickLog(options.log);
  const paths = coachPaths(options.root);
  const warnings = [];
  const [rawCoach, rawProfile, rawRecap, scenarioResult] = await Promise.all([
    readMaterial(paths.coach, 'coach protocol', options, warnings),
    readMaterial(paths.profile, 'learner profile', options, warnings),
    readMaterial(paths.recapTemplate, 'recap template', options, warnings),
    loadScenarios(options),
  ]);
  const coach = rawCoach.trim() === '' ? FALLBACK_COACH_TEXT : rawCoach;
  if (rawCoach.trim() === '') logger.warn('using the built-in coach protocol fallback');
  return {
    coach,
    profile: rawProfile,
    recapTemplate: rawRecap,
    scenarios: scenarioResult.scenarios,
    warnings: warnings.concat(scenarioResult.warnings),
    fallbackScenario: scenarioResult.fallback,
    root: paths.root,
    paths,
  };
}

/**
 * Pick a scenario by exact id or unambiguous id prefix.
 * @returns {{ok: true, scenario: object, matchedBy: string} | {ok: false, error: string, available: string[]}}
 */
export function selectScenario(scenarios, query = '') {
  const list = Array.isArray(scenarios)
    ? scenarios.filter((scenario) => scenario !== null && typeof scenario === 'object' && typeof scenario.id === 'string')
    : [];
  const available = list.map((scenario) => scenario.id);
  const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (list.length === 0) {
    return { ok: false, error: 'no scenario material is available', available };
  }
  if (wanted === '') {
    const preferred = list.find((scenario) => scenario.id === DEFAULT_SCENARIO_ID);
    return { ok: true, scenario: preferred ?? list[0], matchedBy: preferred === undefined ? 'first' : 'default' };
  }
  const exact = list.find((scenario) => scenario.id === wanted);
  if (exact !== undefined) return { ok: true, scenario: exact, matchedBy: 'id' };
  const prefixes = list.filter((scenario) => scenario.id.startsWith(wanted));
  if (prefixes.length === 1) return { ok: true, scenario: prefixes[0], matchedBy: 'prefix' };
  if (prefixes.length > 1) {
    return {
      ok: false,
      error: 'ambiguous scenario "' + wanted + '" matches ' + prefixes.map((scenario) => scenario.id).join(', '),
      available,
    };
  }
  // Convenience match: a unique id/name fragment, so "/voice on interview"
  // reaches "job-interview" and "/voice on chat" reaches "daily-chat".
  const fragments = list.filter((scenario) => {
    const name = typeof scenario.name === 'string' ? scenario.name.toLowerCase() : '';
    const nameZh = typeof scenario.nameZh === 'string' ? scenario.nameZh.toLowerCase() : '';
    return scenario.id.toLowerCase().includes(wanted) || name.includes(wanted) || nameZh.includes(wanted);
  });
  if (fragments.length === 1) return { ok: true, scenario: fragments[0], matchedBy: 'fragment' };
  if (fragments.length > 1) {
    return {
      ok: false,
      error: 'ambiguous scenario "' + wanted + '" matches ' + fragments.map((scenario) => scenario.id).join(', '),
      available,
    };
  }
  return { ok: false, error: 'unknown scenario "' + wanted + '"', available };
}

/**
 * Render one scenario card as plain prompt text. Defensive: partial cards are
 * rendered with the fields that exist.
 */
export function renderScenarioCard(scenario) {
  if (scenario === null || typeof scenario !== 'object') return '(scenario material is unavailable)';
  const lines = [];
  const title = typeof scenario.name === 'string' && scenario.name !== '' ? scenario.name : scenario.id;
  const zh = typeof scenario.nameZh === 'string' && scenario.nameZh !== '' ? '（' + scenario.nameZh + '）' : '';
  lines.push('### ' + String(scenario.id ?? 'scenario') + ' — ' + String(title) + zh);
  const facts = [];
  if (typeof scenario.level === 'string' && scenario.level !== '') facts.push('Level: ' + scenario.level);
  if (Number.isFinite(scenario.durationMinutes)) facts.push('Session length: ~' + scenario.durationMinutes + ' minutes');
  if (facts.length > 0) lines.push(facts.join(' | '));
  if (typeof scenario.goal === 'string' && scenario.goal !== '') lines.push('Goal: ' + scenario.goal);
  const roles = scenario.roles !== null && typeof scenario.roles === 'object' ? scenario.roles : {};
  if (typeof roles.coach === 'string' && roles.coach !== '') lines.push('Your role in the scene: ' + roles.coach);
  if (typeof roles.learner === 'string' && roles.learner !== '') lines.push('Learner role: ' + roles.learner);
  if (typeof scenario.opening === 'string' && scenario.opening !== '') {
    lines.push('Opening line to say first: ' + scenario.opening);
  }
  const beats = Array.isArray(scenario.beats) ? scenario.beats : [];
  if (beats.length > 0) {
    lines.push('Beats, in order (move on once the learner has answered):');
    beats.forEach((beat, index) => {
      if (beat === null || typeof beat !== 'object') return;
      const parts = [];
      if (typeof beat.intent === 'string' && beat.intent !== '') parts.push('learner says: ' + beat.intent);
      if (typeof beat.coachMove === 'string' && beat.coachMove !== '') parts.push('you do: ' + beat.coachMove);
      const beatId = typeof beat.id === 'string' && beat.id !== '' ? beat.id : 'beat-' + String(index + 1);
      lines.push('  ' + String(index + 1) + '. [' + beatId + '] ' + parts.join(' — '));
    });
  }
  if (Array.isArray(scenario.usefulPhrases) && scenario.usefulPhrases.length > 0) {
    lines.push('Useful phrases to use naturally (do not read the list aloud): ' + scenario.usefulPhrases.join(' | '));
  }
  if (Array.isArray(scenario.successCriteria) && scenario.successCriteria.length > 0) {
    lines.push('Success criteria: ' + scenario.successCriteria.join(' | '));
  }
  if (typeof scenario.wrapUp === 'string' && scenario.wrapUp !== '') lines.push('Wrap-up line: ' + scenario.wrapUp);
  if (Array.isArray(scenario.recapFocus) && scenario.recapFocus.length > 0) {
    lines.push('Recap focus: ' + scenario.recapFocus.join(' | '));
  }
  return lines.join('\n');
}

/**
 * Fill known {{placeholders}} in the recap template. Scenario facts known
 * before the session are substituted; values only known after the session
 * ({{duration}}, {{turns}}) become an ellipsis the model fills in.
 */
export function renderRecapTemplate(template, values = {}) {
  if (typeof template !== 'string' || template === '') return '';
  const source = values !== null && typeof values === 'object' ? values : {};
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_match, name) => {
    const key = String(name).toLowerCase();
    const value = source[key];
    return value === undefined || value === null || value === '' ? '…' : String(value);
  });
}

/** Replace only the placeholders whose value is already known; keep the rest. */
export function fillKnownPlaceholders(text, values = {}) {
  if (typeof text !== 'string') return '';
  const source = values !== null && typeof values === 'object' ? values : {};
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu, (match, name) => {
    const value = source[name];
    return value === undefined || value === null || value === '' ? match : String(value);
  });
}

/**
 * Compose the full coach prompt section text.
 * @param {object} parts
 * @param {string} [parts.coach] content/coach.md text.
 * @param {string} [parts.profile] profile.md text.
 * @param {object} [parts.scenario] normalized scenario card.
 * @param {string} [parts.recapTemplate] content/recap-template.md text.
 * @param {string} [parts.date] YYYY-MM-DD; defaults to today.
 * @param {string} [parts.practiceDir] absolute (or relative) recap directory.
 * @returns {string}
 */
export function composeCoachPrompt(parts = {}) {
  const source = parts !== null && typeof parts === 'object' ? parts : {};
  const coach = typeof source.coach === 'string' && source.coach.trim() !== ''
    ? source.coach.trim()
    : FALLBACK_COACH_TEXT;
  const scenario = source.scenario !== null && typeof source.scenario === 'object'
    ? source.scenario
    : BUILTIN_SCENARIO;
  const scenarioId = typeof scenario.id === 'string' && scenario.id !== '' ? scenario.id : DEFAULT_SCENARIO_ID;
  const level = typeof scenario.level === 'string' ? scenario.level : '';
  const date = typeof source.date === 'string' && source.date.trim() !== ''
    ? source.date.trim()
    : formatLocalDate();
  const practiceDir = typeof source.practiceDir === 'string' && source.practiceDir.trim() !== ''
    ? source.practiceDir.trim()
    : 'practice/';
  const practiceDirLabel = practiceDir.replace(/\/+$/u, '');

  const sections = [coach];
  const profile = typeof source.profile === 'string' ? source.profile.trim() : '';
  if (profile !== '') sections.push('## Learner profile\n\n' + profile);
  sections.push('## Active scenario\n\n' + renderScenarioCard(scenario));

  const recapTemplate = typeof source.recapTemplate === 'string' ? source.recapTemplate.trim() : '';
  if (recapTemplate !== '') {
    sections.push([
      '## Recap template',
      '',
      'When the session ends, create the recap Markdown file with the file-writing (write) tool - '
        + 'the spoken closing summary is not the recap itself.',
      'Write it to `' + practiceDirLabel + '/YYYY-MM-DD-HHmm-' + scenarioId
        + '.md` using the current local 24h time, following this template exactly. '
        + 'Replace every remaining placeholder with the real session facts, and keep it in English '
        + 'with short Chinese notes where helpful:',
      '',
      renderRecapTemplate(recapTemplate, { date, scenario: scenarioId, level }),
    ].join('\n'));
  } else {
    sections.push('## Recap template\n\nThe recap template file is missing. At the end of the session, '
      + 'write a short English recap to `' + practiceDirLabel + '/YYYY-MM-DD-HHmm-' + scenarioId
      + '.md`: what went well, at most three corrections, useful phrases, and one goal for next time.');
  }

  sections.push("## Today's date\n\n" + date + '\n\nUse this date in the recap file name.');
  return fillKnownPlaceholders(sections.join('\n\n'), { date, scenario: scenarioId, level });
}

/**
 * Register the coach section on the agent-scoped system prompt, falling back to
 * the plugin context registry. Never throws; the caller decides whether a
 * failed injection blocks voice mode.
 * @returns {{ok: true, scope: 'agent'|'global', name: string, order: number, dispose: Function}
 *   | {ok: false, scope: null, error: string}}
 */
export function installCoachSection(options = {}) {
  const logger = pickLog(options.log);
  const text = typeof options.text === 'string' ? options.text : '';
  const name = typeof options.name === 'string' && options.name !== '' ? options.name : COACH_SECTION_NAME;
  const order = Number.isFinite(options.order) ? options.order : COACH_SECTION_ORDER;
  if (text.trim() === '') return { ok: false, scope: null, error: 'coach prompt text is empty' };

  const attempts = [];
  const trySection = (prompt, scope) => {
    if (prompt === null || typeof prompt !== 'object' || typeof prompt.section !== 'function') return null;
    try {
      const dispose = prompt.section({ name, order, text, interpolate: false });
      return { ok: true, scope, dispose };
    } catch (error) {
      return { ok: false, scope, error: errorMessage(error) };
    }
  };

  let agentPrompt = null;
  try {
    const agent = options.agent;
    if (agent !== null && typeof agent === 'object') {
      const agentCtx = agent.ctx;
      if (agentCtx !== null && typeof agentCtx === 'object') agentPrompt = agentCtx.systemPrompt ?? null;
    }
  } catch (error) {
    attempts.push({ ok: false, scope: 'agent', error: errorMessage(error) });
  }
  const agentAttempt = trySection(agentPrompt, 'agent');
  if (agentAttempt !== null) {
    attempts.push(agentAttempt);
    if (agentAttempt.ok) return { ok: true, scope: 'agent', name, order, dispose: agentAttempt.dispose };
    logger.warn('coach section registration on agent.ctx.systemPrompt failed: ' + agentAttempt.error);
  }

  let globalPrompt = null;
  try {
    const ctx = options.ctx;
    if (ctx !== null && typeof ctx === 'object') {
      globalPrompt = ctx.systemPrompt ?? (typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null);
    }
  } catch (error) {
    attempts.push({ ok: false, scope: 'global', error: errorMessage(error) });
  }
  const globalAttempt = trySection(globalPrompt, 'global');
  if (globalAttempt !== null) {
    attempts.push(globalAttempt);
    if (globalAttempt.ok) {
      logger.warn('coach section registered in GLOBAL scope (agent.ctx.systemPrompt unavailable); '
        + 'it is removed when voice mode stops');
      return { ok: true, scope: 'global', name, order, dispose: globalAttempt.dispose };
    }
    logger.warn('coach section registration in the fallback scope failed: ' + globalAttempt.error);
  }

  const reason = attempts.length === 0
    ? 'ctx.systemPrompt service is unavailable'
    : attempts.map((attempt) => attempt.scope + ': ' + (attempt.error ?? 'unavailable')).join('; ');
  return { ok: false, scope: null, error: reason };
}

function fallbackMaterials(error) {
  return {
    coach: FALLBACK_COACH_TEXT,
    profile: '',
    recapTemplate: '',
    scenarios: [BUILTIN_SCENARIO],
    warnings: ['coach material loading failed: ' + errorMessage(error)],
    fallbackScenario: true,
    root: DEFAULT_PLUGIN_ROOT,
    paths: coachPaths(DEFAULT_PLUGIN_ROOT),
  };
}

/**
 * Stateful coach controller used by the /voice command:
 *   prepare(query)  - load material and validate the scenario id (does not inject)
 *   activate(...)   - compose the prompt and install the section (releases first)
 *   release()       - remove the section (safe to call repeatedly)
 *   status()        - { active, scenarioId, scope, textLength, error } for /voice status
 */
export function createCoachController(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const logger = pickLog(source.log);
  const root = pickRoot(source.root);
  const clock = typeof source.now === 'function' ? source.now : () => new Date();
  let injected = null;
  let lastError = '';

  async function loadMaterials() {
    try {
      return await loadCoachMaterials({ root, log: logger });
    } catch (error) {
      logger.error('coach material loading failed: ' + errorMessage(error));
      return fallbackMaterials(error);
    }
  }

  async function prepare(scenarioQuery = '') {
    const materials = await loadMaterials();
    const picked = selectScenario(materials.scenarios, scenarioQuery);
    if (!picked.ok) {
      return {
        ok: false,
        error: picked.error,
        available: picked.available,
        fallbackScenario: materials.fallbackScenario,
      };
    }
    return {
      ok: true,
      scenario: picked.scenario,
      matchedBy: picked.matchedBy,
      materials,
      warnings: materials.warnings,
    };
  }

  async function release() {
    const current = injected;
    injected = null;
    if (current === null) return null;
    try {
      if (typeof current.dispose === 'function') await current.dispose();
    } catch (error) {
      logger.warn('releasing the coach prompt section failed: ' + errorMessage(error));
    }
    logger.info('coach prompt released (scenario=' + current.scenario.id + ', scope=' + current.scope + ')');
    return current.scenario.id;
  }

  async function activate(activationOptions = {}) {
    const activation = activationOptions !== null && typeof activationOptions === 'object' ? activationOptions : {};
    await release();
    const materials = activation.materials !== null && typeof activation.materials === 'object'
      ? activation.materials
      : await loadMaterials();
    const picked = selectScenario(materials.scenarios, activation.scenarioQuery);
    if (!picked.ok) {
      return { ok: false, kind: 'scenario', error: picked.error, available: picked.available };
    }
    const date = formatLocalDate(clock());
    const text = composeCoachPrompt({
      coach: materials.coach,
      profile: materials.profile,
      scenario: picked.scenario,
      recapTemplate: materials.recapTemplate,
      date,
      practiceDir: activation.practiceDir,
    });
    const injection = installCoachSection({
      agent: activation.agent,
      ctx: activation.ctx,
      text,
      log: logger,
    });
    if (!injection.ok) {
      lastError = injection.error;
      logger.error('coach prompt injection failed; voice mode continues without the coach protocol: '
        + injection.error);
      return {
        ok: true,
        injected: false,
        scenario: picked.scenario,
        scope: '',
        textLength: text.length,
        error: injection.error,
        warnings: materials.warnings,
      };
    }
    injected = {
      scenario: picked.scenario,
      scope: injection.scope,
      dispose: injection.dispose,
      textLength: text.length,
      practiceDir: typeof activation.practiceDir === 'string' ? activation.practiceDir : '',
    };
    lastError = '';
    logger.info('coach prompt injected (scope=' + injection.scope + ', scenario=' + picked.scenario.id
      + ', ' + text.length + ' chars)');
    return {
      ok: true,
      injected: true,
      scenario: picked.scenario,
      scope: injection.scope,
      textLength: text.length,
      warnings: materials.warnings,
    };
  }

  function status() {
    if (injected === null) {
      return {
        active: false,
        scenarioId: '',
        scenarioName: '',
        scope: '',
        textLength: 0,
        practiceDir: '',
        error: lastError,
      };
    }
    return {
      active: true,
      scenarioId: injected.scenario.id,
      scenarioName: injected.scenario.nameZh || injected.scenario.name || '',
      scope: injected.scope,
      textLength: injected.textLength,
      practiceDir: injected.practiceDir,
      error: lastError,
    };
  }

  return { root, prepare, activate, release, status };
}
