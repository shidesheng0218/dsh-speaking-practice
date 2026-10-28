/**
 * server.js - host HTTP routes for the v0.4 client overlay.
 *
 * The browser half polls /voice-practice/state and calls /start, /stop and
 * /stop-speech. Routes are registered through ctx.webServer with the same
 * same-origin guard the official voice plugins use; no secrets cross this
 * boundary. All handlers are injected through deps so this module stays
 * testable without a real webserver.
 *
 * @module dsh-speaking-practice/server
 */

const PREFIX = '/voice-practice';
const MAX_BODY_BYTES = 256 * 1024;

export function sameOrigin(req) {
  const origin = req !== null && req !== undefined && req.headers !== undefined ? req.headers.origin : undefined;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch (_error) {
    return false;
  }
}

export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error('invalid JSON body');
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * Register the /voice-practice routes.
 * @param ctx cordis host context (needs webServer).
 * @param deps injected handlers:
 *   { log, getState, getScenarios, start, stop, stopSpeech,
 *     shadowStart, shadowNext, shadowStop }
 * @returns disposer returned by ctx.webServer.register.
 */
export function registerVoiceRoutes(ctx, deps) {
  const log = deps.log;
  const webServer = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('webServer') : null;
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    log?.warn?.('webServer unavailable: the client overlay routes are not registered');
    return () => {};
  }
  let lastStateLogAt = 0;
  return webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const sub = url.pathname.replace(new RegExp('^' + PREFIX), '') || '/';
      try {
        if (req.method === 'GET' && (sub === '/state' || sub === '/')) {
          const now = Date.now();
          if (now - lastStateLogAt > 60000) {
            lastStateLogAt = now;
            log?.info?.('overlay state poll received (client half is alive)');
          }
          sendJson(res, 200, await deps.getState());
          return;
        }
        if (req.method === 'GET' && sub === '/scenarios') {
          sendJson(res, 200, { scenarios: await deps.getScenarios() });
          return;
        }
        if (req.method === 'POST' && sub === '/start') {
          log?.info?.('overlay start requested');
          const body = await readJsonBody(req);
          const result = await deps.start({ sessionId: typeof body.sessionId === 'string' ? body.sessionId : '', scenario: typeof body.scenario === 'string' ? body.scenario : '' });
          sendJson(res, result !== null && typeof result === 'object' && result.ok === false ? 400 : 200, result);
          return;
        }
        if (req.method === 'POST' && sub === '/stop') {
          log?.info?.('overlay stop requested');
          sendJson(res, 200, await deps.stop());
          return;
        }
        if (req.method === 'POST' && sub === '/stop-speech') {
          sendJson(res, 200, await deps.stopSpeech());
          return;
        }
        if (req.method === 'POST' && sub === '/shadow/start' && typeof deps.shadowStart === 'function') {
          const body = await readJsonBody(req);
          sendJson(res, 200, await deps.shadowStart({ sessionId: typeof body.sessionId === 'string' ? body.sessionId : '', count: Number(body.count) || 5 }));
          return;
        }
        if (req.method === 'POST' && sub === '/shadow/next' && typeof deps.shadowNext === 'function') {
          sendJson(res, 200, await deps.shadowNext());
          return;
        }
        if (req.method === 'POST' && sub === '/shadow/stop' && typeof deps.shadowStop === 'function') {
          sendJson(res, 200, await deps.shadowStop());
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        log?.warn?.('voice-practice route failed: ' + errorText(error));
        sendJson(res, 500, { error: errorText(error) });
      }
    },
  });
}
