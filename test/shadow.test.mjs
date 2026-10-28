/**
 * shadow.test.mjs - unit tests for the v0.4 shadowing diff/scoring module.
 *
 * core/shadow.js is pure logic with no DSH imports, so every case here runs in
 * plain node:test without files, microphones or the DSH host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWords, feedbackLine, normalizeWords, pickDrills } from '../src/core/shadow.js';

function drill(id) {
  return { id, focus: 'th 音', text: 'Drill sentence ' + id, tipZh: 'tip ' + id };
}

function statuses(result) {
  return result.tokens.map((token) => token.status);
}

test('normalizeWords lowercases, strips punctuation and collapses whitespace', () => {
  assert.deepEqual(normalizeWords('  Hello,   WORLD!  '), ['hello', 'world']);
  assert.deepEqual(normalizeWords("Don't stop—keep going…"), ["don't", 'stop', 'keep', 'going']);
  assert.deepEqual(normalizeWords('Ｈｅｌｌｏ，　ｗｏｒｌｄ！'), ['hello', 'world']);
  assert.deepEqual(normalizeWords('thirty-three and/or'), ['thirty', 'three', 'and', 'or']);
  assert.deepEqual(normalizeWords("I'm fine"), ["i'm", 'fine']);
  assert.deepEqual(normalizeWords(''), []);
});

test('normalizeWords tolerates non-string input', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.deepEqual(normalizeWords(value), []);
  }
});

test('normalizeWords drops hesitation fillers but keeps content words', () => {
  assert.deepEqual(normalizeWords('Um, I uh think like so, well...'), ['i', 'think', 'like', 'so', 'well']);
  assert.deepEqual(normalizeWords('Ummm erm okay hmmm'), ['okay']);
});

test('diffWords gives 100 for the exact sentence', () => {
  const target = 'I think this is the third thing I have tried today.';
  const result = diffWords(target, target);
  assert.equal(result.score, 100);
  assert.equal(result.matched, result.total);
  assert.equal(result.total, 11);
  assert.deepEqual(result.targetWords, result.saidWords);
  assert.equal(result.tokens.length, result.total);
  assert.ok(result.tokens.every((token) => token.status === 'match'));
});

test('diffWords reports missing target words and lowers the score', () => {
  const result = diffWords('I think this is the third thing', 'I think this is the thing');
  assert.equal(result.total, 7);
  assert.equal(result.matched, 6);
  assert.equal(result.score, 86);
  assert.deepEqual(statuses(result), ['match', 'match', 'match', 'match', 'match', 'missing', 'match']);
  const missing = result.tokens.filter((token) => token.status === 'missing');
  assert.deepEqual(missing.map((token) => token.word), ['third']);
});

test('diffWords reports extra words without lowering target coverage', () => {
  const result = diffWords('I think this is the thing', 'I really think this is the thing today');
  assert.equal(result.matched, 6);
  assert.equal(result.total, 6);
  assert.equal(result.score, 100);
  const extra = result.tokens.filter((token) => token.status === 'extra');
  assert.deepEqual(extra.map((token) => token.word), ['really', 'today']);
});

test('diffWords handles word order changes', () => {
  const result = diffWords('one two three', 'three two one');
  assert.equal(result.matched, 1);
  assert.equal(result.total, 3);
  assert.equal(result.score, 33);
  const counts = { match: 0, missing: 0, extra: 0 };
  for (const token of result.tokens) counts[token.status] += 1;
  assert.deepEqual(counts, { match: 1, missing: 2, extra: 2 });
});

test('diffWords aligns tokens in reading order', () => {
  const result = diffWords('a b c', 'a c d');
  assert.deepEqual(result.tokens, [
    { word: 'a', status: 'match' },
    { word: 'b', status: 'missing' },
    { word: 'c', status: 'match' },
    { word: 'd', status: 'extra' },
  ]);
});

test('diffWords is case, punctuation and apostrophe tolerant', () => {
  const target = "I think this is the third thing I've tried today.";
  const said = 'i think this is the third thing ive tried today';
  assert.equal(diffWords(target, said).score, 100);
  assert.equal(diffWords('Both of my brothers are thirty-three this month.',
    'both of my brothers are thirty three this month').score, 100);
});

test('diffWords does not expand contractions', () => {
  const result = diffWords("I'm happy today", 'I am happy today');
  assert.deepEqual(result.targetWords, ["i'm", 'happy', 'today']);
  assert.equal(result.total, 3);
  assert.equal(result.matched, 2);
  assert.equal(result.score, 67);
  assert.deepEqual(result.tokens, [
    { word: "i'm", status: 'missing' },
    { word: 'i', status: 'extra' },
    { word: 'am', status: 'extra' },
    { word: 'happy', status: 'match' },
    { word: 'today', status: 'match' },
  ]);
});

test('diffWords ignores hesitation fillers on both sides', () => {
  const result = diffWords('I think so', 'um I uh think so');
  assert.deepEqual(result.saidWords, ['i', 'think', 'so']);
  assert.equal(result.matched, 3);
  assert.equal(result.score, 100);
});

test('diffWords handles empty inputs', () => {
  const both = diffWords('', '');
  assert.equal(both.score, 0);
  assert.equal(both.total, 0);
  assert.equal(both.matched, 0);
  assert.deepEqual(both.targetWords, []);
  assert.deepEqual(both.saidWords, []);
  assert.deepEqual(both.tokens, []);

  const noTarget = diffWords('', 'hello world');
  assert.equal(noTarget.score, 0);
  assert.equal(noTarget.total, 0);
  assert.deepEqual(noTarget.saidWords, ['hello', 'world']);
  assert.equal(noTarget.tokens.filter((token) => token.status === 'extra').length, 2);

  const noSaid = diffWords('hello world', '');
  assert.equal(noSaid.score, 0);
  assert.equal(noSaid.matched, 0);
  assert.deepEqual(statuses(noSaid), ['missing', 'missing']);

  assert.equal(diffWords(null, undefined).score, 0);
  assert.equal(diffWords(42, ['x']).score, 0);
});

test('diffWords rounds the score and clamps it to 0-100', () => {
  const result = diffWords('a b c', 'a b');
  assert.equal(result.score, 67);
  assert.equal(diffWords('a b c', 'a b c').score, 100);
  assert.ok(diffWords('a b c', 'x y z').score >= 0);
});

test('feedbackLine praises a perfect match', () => {
  assert.equal(feedbackLine(diffWords('I think so', 'I think so')), 'Perfect! All 3 words matched.');
});

test('feedbackLine names the first missing word', () => {
  const result = diffWords('one two three four five six', 'one two three four five');
  assert.equal(feedbackLine(result), "Good. 5 of 6 words matched. Try 'six' again.");
  const almost = diffWords('one two three four', 'one two nine ten');
  assert.equal(feedbackLine(almost), "Almost. 2 of 4 words matched. Try 'three' again.");
});

test('feedbackLine mentions extra words when every target word matched', () => {
  const result = diffWords('one two', 'one oh two');
  assert.equal(feedbackLine(result), 'All 2 words matched. Skip the extra word next time.');
});

test('feedbackLine has fallbacks for empty or hopeless attempts', () => {
  assert.equal(feedbackLine(diffWords('', 'hello')), 'There was no target sentence to compare. Try again.');
  assert.equal(feedbackLine(diffWords('one two three', 'completely different')),
    "Let's try again. Listen once, then repeat the whole sentence.");
  assert.equal(feedbackLine(diffWords('one two three', 'other words here')),
    "Let's try again. Listen once, then repeat the whole sentence.");
  assert.equal(feedbackLine(null), 'There was no target sentence to compare. Try again.');
});

test('feedbackLine handles a single-word target', () => {
  const result = diffWords('through', 'through');
  assert.equal(feedbackLine(result), 'Perfect! All 1 word matched.');
});

test('pickDrills returns the requested number of distinct drills', () => {
  const source = [drill('s1'), drill('s2'), drill('s3'), drill('s4'), drill('s5')];
  const sourceIds = source.map((item) => item.id);
  const picked = pickDrills({ sentences: source }, 3, () => 0.5);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((item) => item.id)).size, 3);
  assert.ok(picked.every((item) => source.includes(item)));
  assert.deepEqual(source.map((item) => item.id), sourceIds);
});

test('pickDrills clamps the count and handles empty or invalid input', () => {
  const source = [drill('s1'), drill('s2'), drill('s3'), drill('s4'), drill('s5')];
  assert.equal(pickDrills({ sentences: source }, 10, () => 0).length, 5);
  assert.equal(pickDrills({ sentences: source }, 0, () => 0).length, 0);
  assert.equal(pickDrills({ sentences: source }, -3, () => 0).length, 0);
  assert.equal(pickDrills({ sentences: source }, 1.9, () => 0).length, 1);
  assert.equal(pickDrills({ sentences: source }, undefined, () => 0).length, 5);
  assert.deepEqual(pickDrills({ sentences: [] }, 3), []);
  assert.deepEqual(pickDrills(null, 2), []);
  assert.deepEqual(pickDrills([], 2), []);
  assert.deepEqual(pickDrills({}, 2), []);
});

test('pickDrills is deterministic with an injected random', () => {
  const source = [drill('s1'), drill('s2'), drill('s3'), drill('s4'), drill('s5')];
  assert.deepEqual(pickDrills({ sentences: source }, 3, () => 0).map((item) => item.id), ['s1', 's2', 's3']);
  assert.deepEqual(pickDrills({ sentences: source }, 3, () => 0.999).map((item) => item.id), ['s5', 's1', 's2']);
  assert.deepEqual(pickDrills({ sentences: source }, 3, () => 2).map((item) => item.id), ['s5', 's1', 's2']);
});

test('pickDrills dedupes duplicate ids and duplicate object references', () => {
  const first = drill('a');
  const second = drill('b');
  const copy = { id: 'a', text: 'duplicate a' };
  const picked = pickDrills({ sentences: [first, second, first, copy] }, 5, () => 0);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((item) => item.id).sort(), ['a', 'b']);
});

test('pickDrills accepts a bare array and string entries', () => {
  const picked = pickDrills(['alpha', 'beta', 'alpha'], 2, () => 0);
  assert.deepEqual(picked, ['alpha', 'beta']);
  assert.deepEqual(pickDrills(['only'], 5, () => 0), ['only']);
});

test('pickDrills never mutates the source order', () => {
  const source = [drill('s1'), drill('s2'), drill('s3'), drill('s4')];
  const before = source.slice();
  pickDrills({ sentences: source }, 4, () => 0.7);
  assert.deepEqual(source, before);
});
