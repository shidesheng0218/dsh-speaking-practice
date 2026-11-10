import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Readable } from 'node:stream';

import { formatSseFrame, registerVoiceRoutes, sameOrigin } from '../src/server.js';

function makeReq(method, url, body = null, headers = {}) {
  const payload = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3131', ...headers };
  return req;
}

function makeRes() {
  const emitter = new EventEmitter();
  const chunks = [];
  let status = 200;
  let headers = {};
  let ended = false;
  const res = new EventEmitter();
  res.writeHead = (code, hdrs) => {
    status = code;
    headers = { ...hdrs };
  };
  res.write = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    }
    ended = true;
    res.emit('close');
  };
  Object.defineProperties(res, {
    status: { get: () => status },
    headers: { get: () => headers },
    body: { get: () => chunks.join('') },
    writableEnded: { get: () => ended },
  });
  return res;
}

test('sameOrigin allows matching or absent origin and blocks cross-origin', () => {
  assert.equal(sameOrigin({ headers: { host: 'localhost:3000' } }), true);
  assert.equal(sameOrigin({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }), true);
  assert.equal(sameOrigin({ headers: { host: 'localhost:3000', origin: 'http://evil.example' } }), false);
});

test('formatSseFrame formats valid SSE event blocks', () => {
  assert.equal(formatSseFrame('state', { active: true }), 'event: state\ndata: {"active":true}\n\n');
});

test('registerVoiceRoutes streams SSE updates on /events and cleans up on dispose', async () => {
  let routeHandler = null;
  let pushListener = null;
  let currentState = { ok: true, active: false, phase: 'idle' };

  const ctx = {
    get(name) {
      if (name !== 'webServer') return null;
      return {
        register(spec) {
          routeHandler = spec.handler;
          return () => { routeHandler = null; };
        },
      };
    },
  };

  const dispose = registerVoiceRoutes(ctx, {
    getState: async () => currentState,
    subscribe(fn) {
      pushListener = fn;
      return () => { pushListener = null; };
    },
    getScenarios: async () => [],
    start: async (input) => ({ ok: true, ...input }),
    stop: async () => ({ ok: true }),
    stopSpeech: async () => ({ ok: true }),
    shadowReplay: async () => ({ ok: true, replayed: true }),
  });

  assert.equal(typeof routeHandler, 'function');
  assert.equal(typeof pushListener, 'function');

  // Test SSE connection
  const sseReq = new EventEmitter();
  sseReq.method = 'GET';
  sseReq.url = '/voice-practice/events';
  sseReq.headers = { host: 'localhost:3131' };
  const sseRes = makeRes();

  await routeHandler(sseReq, sseRes);
  assert.equal(sseRes.status, 200);
  assert.match(String(sseRes.headers['content-type']), /text\/event-stream/);
  assert.match(sseRes.body, /event: state\ndata: \{"ok":true,"active":false,"phase":"idle"\}/);

  // Trigger state push
  currentState = { ok: true, active: true, phase: 'listening' };
  pushListener('loop:state');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.match(sseRes.body, /"phase":"listening"/);

  // Test POST /start forwards cwd
  const startReq = makeReq('POST', '/voice-practice/start', {
    sessionId: 's1',
    scenario: 'daily-chat',
    cwd: '/tmp/work',
  });
  const startRes = makeRes();
  await routeHandler(startReq, startRes);
  assert.equal(startRes.status, 200);
  const parsedStart = JSON.parse(startRes.body);
  assert.equal(parsedStart.cwd, '/tmp/work');

  // Test POST /shadow/replay
  const replayReq = makeReq('POST', '/voice-practice/shadow/replay', {});
  const replayRes = makeRes();
  await routeHandler(replayReq, replayRes);
  assert.equal(replayRes.status, 200);
  assert.deepEqual(JSON.parse(replayRes.body), { ok: true, replayed: true });

  dispose();
  assert.equal(sseRes.writableEnded, true);
  assert.equal(pushListener, null);
});
