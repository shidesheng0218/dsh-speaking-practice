import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cjkRatio,
  classifyLanguage,
  cleanForSpeech,
  extractMessageText,
  matchVoiceCommand,
  prepareSpeechText,
  segmentByLanguage,
  splitSentences,
  summarizeText,
} from '../src/core/text.js';

const TICK = String.fromCharCode(96);

test('cleanForSpeech removes code/HTML/images and keeps link text', () => {
  const input = [
    '## Heading',
    '',
    '- item **bold** and _italic_',
    '- see [the docs](https://example.com/page)',
    '',
    'Inline ' + TICK + 'code' + TICK + ' and <b>html</b>.',
    '',
    TICK + TICK + TICK + 'js',
    'console.log("no")',
    TICK + TICK + TICK,
    '> quoted line',
    '',
    '| a | b |',
    '| - | - |',
  ].join('\n');
  const cleaned = cleanForSpeech(input);
  assert.match(cleaned, /Heading/);
  assert.match(cleaned, /item bold and italic/);
  assert.match(cleaned, /the docs/);
  assert.doesNotMatch(cleaned, /console\.log/);
  assert.doesNotMatch(cleaned, /<b>/);
  assert.doesNotMatch(cleaned, /https:\/\//);
  assert.match(cleaned, /quoted line/);
  assert.doesNotMatch(cleaned, /\|/);
});

test('splitSentences splits punctuation and merges short sentences', () => {
  assert.deepEqual(splitSentences('One. Two! Three?'), ['One. Two! Three?']);
  const many = splitSentences('Hi. Ok. Go. Bye. Stop.');
  assert.equal(many.length, 1);
  const long = 'A'.repeat(300) + '.';
  const pieces = splitSentences(long, { maxChars: 120 });
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) assert.ok(piece.length <= 120);
});

test('language segmentation groups consecutive same-language sentences', () => {
  const segments = segmentByLanguage(['Hello there.', 'How are you?', '你好世界。', '我很好。', 'Good bye.']);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].lang, 'en');
  assert.equal(segments[1].lang, 'zh');
  assert.equal(segments[2].lang, 'en');
  assert.match(segments[1].text, /你好世界。我很好。/);
});

test('cjkRatio and classifyLanguage handle mixed text', () => {
  assert.equal(cjkRatio(''), 0);
  assert.ok(cjkRatio('你好世界') > 0.9);
  assert.ok(cjkRatio('Hello world') < 0.1);
  assert.equal(classifyLanguage('你好世界'), 'zh');
  assert.equal(classifyLanguage('Hello world'), 'en');
  assert.equal(classifyLanguage('Use 你好 to greet'), 'en');
});

test('prepareSpeechText truncates long replies and produces segments', () => {
  const long = 'This is a sentence. '.repeat(120);
  const prepared = prepareSpeechText(long, { maxChars: 400, maxSentenceChars: 120 });
  assert.equal(prepared.truncated, true);
  assert.ok(prepared.cleaned.length <= 401);
  assert.ok(prepared.cleaned.endsWith('…'));
  assert.ok(prepared.segments.length > 0);
});

test('matchVoiceCommand recognizes off and repeat commands', () => {
  assert.deepEqual(matchVoiceCommand('Stop listening.'), { kind: 'off', normalized: 'stop listening' });
  assert.deepEqual(matchVoiceCommand('VOICE OFF!'), { kind: 'off', normalized: 'voice off' });
  assert.equal(matchVoiceCommand('Say that again!').kind, 'repeat');
  assert.equal(matchVoiceCommand('Repeat that.').kind, 'repeat');
  assert.equal(matchVoiceCommand('Please stop listening to me'), null);
  assert.equal(matchVoiceCommand(''), null);
});

test('extractMessageText joins only text blocks', () => {
  const message = {
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', name: 'x' },
      { type: 'text', text: 'world' },
      { type: 'text', text: '   ' },
    ],
  };
  assert.equal(extractMessageText(message), 'Hello\nworld');
  assert.equal(extractMessageText({}), '');
  assert.equal(extractMessageText(null), '');
});

test('summarizeText collapses whitespace and truncates', () => {
  assert.equal(summarizeText('a  b\n c'), 'a b c');
  assert.equal(summarizeText('abcdef', 4), 'abc…');
});
