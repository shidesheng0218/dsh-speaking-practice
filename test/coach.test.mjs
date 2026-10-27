/**
 * coach.test.mjs - unit tests for the v0.2 coach integration.
 *
 * The module under test is plain ESM with no DSH imports, so everything here
 * uses fake agent contexts / systemPrompt registries plus throwaway material
 * fixtures under lab/.work (git-ignored, removed afterwards).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SCENARIO,
  COACH_SECTION_NAME,
  COACH_SECTION_ORDER,
  DEFAULT_PLUGIN_ROOT,
  FALLBACK_COACH_TEXT,
  composeCoachPrompt,
  createCoachController,
  ensureRecapDir,
  formatLocalDate,
  installCoachSection,
  loadCoachMaterials,
  loadScenarios,
  renderScenarioCard,
  renderRecapTemplate,
  resolvePracticeDir,
  selectScenario,
} from '../src/coach.js';

const workRoot = fileURLToPath(new URL('../lab/.work/coach-test-' + process.pid + '/', import.meta.url));

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function fixture(name) {
  const root = join(workRoot, name);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeText(root, relativePath, text) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, JSON.stringify(value, null, 2) + '\n');
}

function scenarioCard(id, overrides = {}) {
  return {
    id,
    name: 'Card ' + id,
    nameZh: '场景 ' + id,
    level: 'B1',
    durationMinutes: 10,
    goal: 'Goal for ' + id,
    roles: { coach: 'Coach role for ' + id, learner: 'Learner role for ' + id },
    opening: 'Opening line for ' + id,
    beats: [
      { id: 'beat-1', intent: 'Intent one', coachMove: 'Coach move one' },
      { id: 'beat-2', intent: 'Intent two', coachMove: 'Coach move two' },
    ],
    usefulPhrases: ['phrase one', 'phrase two'],
    successCriteria: ['criterion one'],
    wrapUp: 'Wrap-up line for ' + id,
    recapFocus: ['focus one'],
    ...overrides,
  };
}

function recordingLog() {
  const lines = [];
  const push = (level) => (message) => {
    lines.push([level, String(message)]);
  };
  return {
    lines,
    debug() {},
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    has(level, needle) {
      return lines.some((entry) => entry[0] === level && entry[1].includes(needle));
    },
  };
}

function fakePromptRegistry() {
  const sections = new Map();
  const calls = [];
  const disposed = [];
  return {
    sections,
    calls,
    disposed,
    section(section) {
      calls.push(section);
      if (sections.has(section.name)) throw new Error('prompt section "' + section.name + '" is already registered');
      sections.set(section.name, section);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        sections.delete(section.name);
        disposed.push(section);
      };
    },
  };
}

function throwingPromptRegistry(message) {
  return {
    section() {
      throw new Error(message);
    },
  };
}

async function controllerFixture() {
  const root = await fixture('materials');
  await writeText(root, 'content/coach.md', 'COACH PROTOCOL MARKER\n');
  await writeText(root, 'profile.md', 'PROFILE MARKER\n');
  await writeText(root, 'content/recap-template.md',
    '# Speaking practice recap — {{date}} — {{scenario}}\n- Level: {{level}}\n- Duration: {{duration}} minutes (turns: {{turns}})\n');
  await writeJson(root, 'content/scenarios/daily-chat.json', scenarioCard('daily-chat'));
  await writeJson(root, 'content/scenarios/job-interview.json', scenarioCard('job-interview'));
  return root;
}

test('formatLocalDate renders a local YYYY-MM-DD date', () => {
  assert.equal(formatLocalDate(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.equal(formatLocalDate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.match(formatLocalDate(new Date('not a date')), /^\d{4}-\d{2}-\d{2}$/u);
});

test('coachPaths/DEFAULT_PLUGIN_ROOT resolve against the plugin package root', async () => {
  const manifest = JSON.parse(await readFile(join(DEFAULT_PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-speaking-practice');
  const materials = await loadCoachMaterials({});
  assert.equal(materials.root, DEFAULT_PLUGIN_ROOT);
  assert.ok(Array.isArray(materials.scenarios) && materials.scenarios.length > 0);
});

test('loadScenarios reads cards, sorts ids and skips invalid JSON with warnings', async () => {
  const root = await fixture('scenarios-happy');
  await writeJson(root, 'content/scenarios/zeta.json', scenarioCard('zeta'));
  await writeJson(root, 'content/scenarios/alpha.json', scenarioCard('alpha', { name: 'Alpha card' }));
  await writeText(root, 'content/scenarios/broken.json', '{ not json');
  await writeText(root, 'content/scenarios/notes.txt', 'ignored');
  const log = recordingLog();
  const result = await loadScenarios({ root, log });
  assert.deepEqual(result.scenarios.map((scenario) => scenario.id), ['alpha', 'zeta']);
  assert.equal(result.fallback, false);
  assert.ok(result.warnings.some((line) => line.includes('invalid scenario JSON')));
  assert.ok(log.has('warn', 'invalid scenario JSON'));
  assert.equal(result.scenarios[0].name, 'Alpha card');
});

test('loadScenarios falls back to the built-in card when nothing is usable', async () => {
  const root = await fixture('scenarios-empty');
  const result = await loadScenarios({ root });
  assert.equal(result.fallback, true);
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0].id, BUILTIN_SCENARIO.id);
  assert.ok(result.warnings.some((line) => line.includes('scenarios directory unavailable')));
});

test('loadCoachMaterials degrades when only coach.md exists', async () => {
  const root = await fixture('partial');
  await writeText(root, 'content/coach.md', 'ONLY COACH PROTOCOL\n');
  const log = recordingLog();
  const materials = await loadCoachMaterials({ root, log });
  assert.equal(materials.coach, 'ONLY COACH PROTOCOL\n');
  assert.equal(materials.profile, '');
  assert.equal(materials.recapTemplate, '');
  assert.equal(materials.scenarios[0].source, 'builtin');
  assert.equal(materials.fallbackScenario, true);
  assert.ok(materials.warnings.length >= 3);
  assert.ok(log.has('warn', 'learner profile unavailable'));
});

test('loadCoachMaterials uses built-in fallbacks for a missing root', async () => {
  const root = join(workRoot, 'does-not-exist');
  const materials = await loadCoachMaterials({ root });
  assert.equal(materials.coach, FALLBACK_COACH_TEXT);
  assert.equal(materials.profile, '');
  assert.equal(materials.recapTemplate, '');
  assert.equal(materials.scenarios[0].source, 'builtin');
  assert.ok(materials.warnings.length >= 3);
});

test('selectScenario supports default, exact id, unambiguous prefix, ambiguity and unknown ids', () => {
  const cards = [
    { id: 'daily-chat' },
    { id: 'job-interview' },
    { id: 'job-shadowing' },
  ];
  assert.equal(selectScenario(cards, '').scenario.id, 'daily-chat');
  assert.equal(selectScenario(cards, '').matchedBy, 'default');
  assert.equal(selectScenario(cards, 'job-interview').matchedBy, 'id');
  assert.equal(selectScenario(cards, 'job-i').scenario.id, 'job-interview');
  assert.equal(selectScenario(cards, 'job-i').matchedBy, 'prefix');
  assert.equal(selectScenario(cards, 'interview').scenario.id, 'job-interview');
  assert.equal(selectScenario(cards, 'interview').matchedBy, 'fragment');
  assert.equal(selectScenario(cards, 'chat').scenario.id, 'daily-chat');
  assert.equal(selectScenario(cards, '  DAILY  ').scenario.id, 'daily-chat');
  const ambiguous = selectScenario(cards, 'job');
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.available, ['daily-chat', 'job-interview', 'job-shadowing']);
  assert.ok(ambiguous.error.includes('ambiguous'));
  const unknown = selectScenario(cards, 'nope');
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error.includes('unknown scenario'));
  const empty = selectScenario([], 'daily');
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.available, []);
});

test('selectScenario falls back to the first card when daily-chat is absent', () => {
  const picked = selectScenario([{ id: 'job-interview' }, { id: 'travel' }], '');
  assert.equal(picked.scenario.id, 'job-interview');
  assert.equal(picked.matchedBy, 'first');
});

test('renderScenarioCard renders every documented field', () => {
  const card = renderScenarioCard(scenarioCard('job-interview'));
  for (const needle of [
    'job-interview',
    'Card job-interview',
    '场景 job-interview',
    'Level: B1',
    'Goal: Goal for job-interview',
    'Coach role for job-interview',
    'Learner role for job-interview',
    'Opening line for job-interview',
    '[beat-1]',
    '[beat-2]',
    'phrase one | phrase two',
    'criterion one',
    'Wrap-up line for job-interview',
    'focus one',
  ]) {
    assert.ok(card.includes(needle), 'scenario card is missing ' + needle);
  }
  assert.match(renderScenarioCard(null), /unavailable/u);
});

test('renderRecapTemplate substitutes known facts and ellipsizes runtime placeholders', () => {
  const rendered = renderRecapTemplate('date={{date}} scenario={{scenario}} level={{level}} duration={{duration}}',
    { date: '2026-03-08', scenario: 'daily-chat', level: 'B1' });
  assert.equal(rendered, 'date=2026-03-08 scenario=daily-chat level=B1 duration=…');
});

test('composeCoachPrompt keeps the documented section order and fills the date', async () => {
  const root = await controllerFixture();
  const materials = await loadCoachMaterials({ root });
  const text = composeCoachPrompt({
    coach: materials.coach,
    profile: materials.profile,
    scenario: materials.scenarios.find((scenario) => scenario.id === 'job-interview'),
    recapTemplate: materials.recapTemplate,
    date: '2026-03-08',
    practiceDir: '/fake/practice/',
  });
  let cursor = -1;
  for (const marker of ['COACH PROTOCOL MARKER', '## Learner profile', 'PROFILE MARKER',
    '## Active scenario', '## Recap template', "## Today's date"]) {
    const at = text.indexOf(marker);
    assert.ok(at > cursor, 'expected ' + marker + ' after position ' + cursor + ', got ' + at);
    cursor = at;
  }
  assert.ok(text.includes('2026-03-08'), 'composed prompt is missing the injected date');
  assert.ok(text.trimEnd().endsWith('Use this date in the recap file name.'));
  assert.ok(text.includes('/fake/practice/YYYY-MM-DD-HHmm-job-interview.md'));
  assert.ok(!text.includes('{{date}}'));
  assert.ok(!text.includes('{{duration}}'));
  assert.equal(text.startsWith('COACH PROTOCOL MARKER'), true);
  assert.match(text, /file-writing \(write\) tool/u);
});

test('composeCoachPrompt keeps a recap instruction when the template is missing', () => {
  const text = composeCoachPrompt({
    coach: 'PROTOCOL',
    scenario: scenarioCard('daily-chat'),
    recapTemplate: '',
    date: '2026-03-08',
    practiceDir: '/fake/practice',
  });
  assert.ok(text.includes('## Recap template'));
  assert.ok(text.includes('template file is missing'));
  assert.ok(!text.includes('{{'));
});

test('installCoachSection registers an agent-scoped section with interpolate: false and disposes cleanly', () => {
  const agentPrompt = fakePromptRegistry();
  const globalPrompt = fakePromptRegistry();
  const result = installCoachSection({
    agent: { ctx: { systemPrompt: agentPrompt } },
    ctx: { systemPrompt: globalPrompt },
    text: 'COACH TEXT',
  });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'agent');
  assert.equal(result.name, COACH_SECTION_NAME);
  assert.equal(result.order, COACH_SECTION_ORDER);
  assert.equal(agentPrompt.calls.length, 1);
  assert.equal(globalPrompt.calls.length, 0);
  const section = agentPrompt.calls[0];
  assert.equal(section.name, COACH_SECTION_NAME);
  assert.equal(section.order, 500);
  assert.equal(section.interpolate, false);
  assert.equal(section.text, 'COACH TEXT');
  assert.equal(agentPrompt.sections.size, 1);
  result.dispose();
  assert.equal(agentPrompt.sections.size, 0);
  assert.equal(agentPrompt.disposed.length, 1);
});

test('installCoachSection falls back to the plugin-scoped registry and logs the downgrade', () => {
  const globalPrompt = fakePromptRegistry();
  const log = recordingLog();
  const result = installCoachSection({
    agent: { ctx: {} },
    ctx: { systemPrompt: globalPrompt },
    text: 'COACH TEXT',
    log,
  });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'global');
  assert.equal(globalPrompt.sections.size, 1);
  assert.ok(log.has('warn', 'GLOBAL scope'));
});

test('installCoachSection reports every failed registry instead of throwing', () => {
  const log = recordingLog();
  const result = installCoachSection({
    agent: { ctx: { systemPrompt: throwingPromptRegistry('agent boom') } },
    ctx: { systemPrompt: throwingPromptRegistry('global boom') },
    text: 'COACH TEXT',
    log,
  });
  assert.equal(result.ok, false);
  assert.equal(result.scope, null);
  assert.ok(result.error.includes('agent boom'));
  assert.ok(result.error.includes('global boom'));
  assert.ok(log.has('warn', 'agent boom'));
  const empty = installCoachSection({ text: '   ' });
  assert.equal(empty.ok, false);
  assert.ok(empty.error.includes('empty'));
});

test('createCoachController prepare() rejects an unknown scenario without injecting', async () => {
  const root = await controllerFixture();
  const registry = fakePromptRegistry();
  const controller = createCoachController({ root, log: recordingLog() });
  const prepared = await controller.prepare('zzz');
  assert.equal(prepared.ok, false);
  assert.ok(prepared.available.includes('daily-chat'));
  const activation = await controller.activate({
    agent: { ctx: { systemPrompt: registry } },
    scenarioQuery: 'zzz',
    materials: (await controller.prepare('')).materials,
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.kind, 'scenario');
  assert.equal(registry.sections.size, 0);
  assert.equal(controller.status().active, false);
});

test('createCoachController injects, replaces on on-over-on and releases the section', async () => {
  const root = await controllerFixture();
  const agentPrompt = fakePromptRegistry();
  const globalPrompt = fakePromptRegistry();
  const log = recordingLog();
  const controller = createCoachController({
    root,
    log,
    now: () => new Date(2026, 2, 8),
  });
  const prepared = await controller.prepare('job');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.scenario.id, 'job-interview');

  const first = await controller.activate({
    agent: { ctx: { systemPrompt: agentPrompt } },
    ctx: { systemPrompt: globalPrompt },
    scenarioQuery: 'job',
    practiceDir: '/fake/practice',
    materials: prepared.materials,
  });
  assert.equal(first.ok, true);
  assert.equal(first.injected, true);
  assert.equal(first.scope, 'agent');
  assert.equal(agentPrompt.sections.size, 1);
  const section = agentPrompt.sections.get(COACH_SECTION_NAME);
  assert.ok(section.text.includes('## Active scenario'));
  assert.ok(section.text.includes('job-interview'));
  assert.ok(section.text.includes('2026-03-08'));
  assert.ok(log.has('info', 'coach prompt injected'));

  let status = controller.status();
  assert.equal(status.active, true);
  assert.equal(status.scenarioId, 'job-interview');
  assert.equal(status.scope, 'agent');
  assert.ok(status.textLength > 0);

  const second = await controller.activate({
    agent: { ctx: { systemPrompt: agentPrompt } },
    ctx: { systemPrompt: globalPrompt },
    scenarioQuery: '',
    practiceDir: '/fake/practice',
    materials: prepared.materials,
  });
  assert.equal(second.injected, true);
  assert.equal(agentPrompt.sections.size, 1);
  assert.equal(agentPrompt.disposed.length, 1);
  status = controller.status();
  assert.equal(status.scenarioId, 'daily-chat');

  const released = await controller.release();
  assert.equal(released, 'daily-chat');
  assert.equal(agentPrompt.sections.size, 0);
  assert.equal(controller.status().active, false);
  assert.equal(await controller.release(), null);
});

test('createCoachController keeps voice usable when the prompt registry rejects the section', async () => {
  const root = await controllerFixture();
  const log = recordingLog();
  const controller = createCoachController({ root, log });
  const prepared = await controller.prepare('');
  const activation = await controller.activate({
    agent: { ctx: { systemPrompt: throwingPromptRegistry('registry offline') } },
    materials: prepared.materials,
  });
  assert.equal(activation.ok, true);
  assert.equal(activation.injected, false);
  assert.ok(activation.error.includes('registry offline'));
  assert.equal(controller.status().active, false);
  assert.ok(controller.status().error.includes('registry offline'));
  assert.ok(log.has('error', 'voice mode continues without the coach protocol'));
});

test('resolvePracticeDir prefers the practice root over the session cwd', () => {
  assert.equal(resolvePracticeDir('/work/root', '/work/root/sub'), '/work/root/practice');
  assert.equal(resolvePracticeDir('', '/work/root/sub'), '/work/root/sub/practice');
  assert.equal(resolvePracticeDir('', ''), '');
});

test('ensureRecapDir creates a nested practice directory and warns on failure', async () => {
  const root = await fixture('recap');
  const log = recordingLog();
  const practiceDir = join(root, 'practice');
  const first = await ensureRecapDir(practiceDir, log);
  assert.equal(first.ok, true);
  assert.equal((await stat(practiceDir)).isDirectory(), true);
  assert.ok(log.has('info', 'recap directory ready'));

  await writeText(root, 'blocker.txt', 'x');
  const second = await ensureRecapDir(join(root, 'blocker.txt', 'practice'), log);
  assert.equal(second.ok, false);
  assert.ok(second.error.length > 0);
  assert.ok(log.has('warn', 'cannot create recap directory'));

  const missing = await ensureRecapDir('', log);
  assert.equal(missing.ok, false);
  assert.ok(log.has('warn', 'recap directory is unknown'));
});

test('index.js wires the coach controller into on/off/status/scenarios', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  for (const pattern of [
    /createCoachController/u,
    /coach\.prepare\(scenarioQuery\)/u,
    /coach\.activate\(/u,
    /await coach\.release\(\)/u,
    /ensureRecapDir\(practiceDir, log\)/u,
    /resolvePracticeDir\(options\.practiceRoot, cwd\)/u,
    /lower\.startsWith\('on '\)/u,
    /voiceScenarios\(\)/u,
    /'scenario: '/u,
    /'coach: off'/u,
    /coach: on \(scope=/u,
  ]) {
    assert.match(source, pattern, 'index.js is missing coach wiring: ' + pattern);
  }
  const offBody = source.slice(source.indexOf('async function voiceOff'), source.indexOf('function coachStatusLine'));
  assert.ok(offBody.indexOf('await coach.release()') < offBody.indexOf('await current.loop.stop(reason)'),
    'voiceOff must release the coach section before stopping the loop');
  const disposeBody = source.slice(source.indexOf('ctx.effect(() => async () => {'),
    source.indexOf("'voice: dispose'"));
  assert.ok(disposeBody.includes('await coach.release()'), 'plugin dispose must release the coach section');

  const coachSource = await readFile(new URL('../src/coach.js', import.meta.url), 'utf8');
  assert.match(coachSource, /interpolate: false/u);
  assert.match(coachSource, /voice-practice:coach/u);
  assert.doesNotMatch(coachSource, /@deepseek-ai\//u, 'src/coach.js must stay testable without DSH');
});

test('workspace content composes a full section through the controller', async () => {
  const agentPrompt = fakePromptRegistry();
  const controller = createCoachController({ root: DEFAULT_PLUGIN_ROOT, log: recordingLog() });
  const prepared = await controller.prepare('');
  assert.equal(prepared.ok, true);
  const result = await controller.activate({
    agent: { ctx: { systemPrompt: agentPrompt } },
    materials: prepared.materials,
  });
  assert.equal(result.injected, true);
  const section = agentPrompt.sections.get(COACH_SECTION_NAME);
  assert.equal(section.interpolate, false);
  for (const marker of ['## Active scenario', '## Recap template', "## Today's date"]) {
    assert.ok(section.text.includes(marker), 'composed workspace section is missing ' + marker);
  }
  if (prepared.materials.profile.trim() !== '') assert.ok(section.text.includes('## Learner profile'));
  assert.ok(section.text.includes(prepared.scenario.id));
  await controller.release();
  assert.equal(agentPrompt.sections.size, 0);
});
