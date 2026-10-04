// Shared test doubles: chrome.storage.local, chrome.runtime and a scriptable fetch.

export function installChrome() {
  const env = { store: {}, calls: [], responder: () => json(500, {}) };

  const cb = (fn, result) => (typeof fn === 'function' ? fn(result) : Promise.resolve(result));
  const pick = (keys) => {
    if (keys === null || keys === undefined) return structuredClone(env.store);
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in env.store).map(k => [k, structuredClone(env.store[k])]));
    // object form = defaults
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in env.store ? structuredClone(env.store[k]) : d]));
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: (keys, fn) => cb(fn, pick(keys)),
        set: (obj, fn) => { Object.assign(env.store, structuredClone(obj)); return cb(fn); },
        remove: (keys, fn) => { for (const k of [].concat(keys)) delete env.store[k]; return cb(fn); }
      }
    },
    runtime: { getManifest: () => ({ version: '9.9.9' }) }
  };

  globalThis.fetch = async (url, init) => {
    env.calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return env.responder(url, init);
  };

  env.reset = () => { env.store = {}; env.calls = []; env.responder = () => json(500, {}); };
  env.connect = (memberId = 'm1', token = 'ege_tok') => {
    env.store.connection = { token, member: { id: memberId, name: 'Test' }, engineUrl: 'https://engine.test' };
  };
  env.queued = () => Object.keys(env.store).filter(k => k.startsWith('ob:')).sort().map(k => env.store[k]);
  return env;
}

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Engine-like responder: accepts every event in the batch. */
export const acceptAll = (_url, init) => {
  const { events } = JSON.parse(init.body);
  return json(200, { results: events.map(e => ({ eventId: e.eventId, status: 'accepted' })) });
};
