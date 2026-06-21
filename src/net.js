// Mock backend client. The original game talked to a server for:
//   - sharing custom maps (upload -> short URL, download by code)
//   - Kongregate stat/achievement submission
//   - high score / leaderboard
// We mock all of it. If a local mock server (server/mock-server.mjs) is
// running it will be used; otherwise everything falls back to localStorage so
// the game is fully playable offline.
const BASE = '/api';

async function tryFetch(path, opts) {
  try {
    const res = await fetch(BASE + path, opts);
    if (!res.ok) throw new Error('bad status ' + res.status);
    return await res.json();
  } catch (e) {
    return null; // signal caller to use local fallback
  }
}

export const Net = {
  online: false,

  async ping() {
    const r = await tryFetch('/ping');
    this.online = !!r;
    return this.online;
  },

  // --- map sharing -------------------------------------------------------
  async uploadMap(mapData) {
    const body = JSON.stringify({ map: mapData });
    const r = await tryFetch('/maps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r && r.code) return r;
    // local fallback: generate a code and stash it
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const store = JSON.parse(localStorage.getItem('sc_maps') || '{}');
    store[code] = mapData;
    localStorage.setItem('sc_maps', JSON.stringify(store));
    return { code, url: `${location.origin}${location.pathname}?map=${code}`, mock: true };
  },

  async downloadMap(code) {
    const r = await tryFetch('/maps/' + encodeURIComponent(code));
    if (r && r.map) return r.map;
    const store = JSON.parse(localStorage.getItem('sc_maps') || '{}');
    return store[code] || null;
  },

  // --- leaderboard -------------------------------------------------------
  async submitScore(entry) {
    const r = await tryFetch('/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
    if (r) return r;
    const list = JSON.parse(localStorage.getItem('sc_scores') || '[]');
    list.push({ ...entry, ts: Date.now() });
    list.sort((a, b) => b.waves - a.waves || b.killed - a.killed);
    localStorage.setItem('sc_scores', JSON.stringify(list.slice(0, 20)));
    return { ok: true, mock: true };
  },

  async leaderboard() {
    const r = await tryFetch('/scores');
    if (r && r.scores) return r.scores;
    return JSON.parse(localStorage.getItem('sc_scores') || '[]');
  },

  // --- Kongregate analytics stub ----------------------------------------
  kongregate: {
    submit(stat, value) { /* no-op mock */ console.debug('[kongregate mock] stat', stat, value); },
  },

  // --- local save game (SharedObject replacement) -----------------------
  saveGame(state) { localStorage.setItem('sc_savegame', JSON.stringify(state)); },
  loadGame() {
    const s = localStorage.getItem('sc_savegame');
    return s ? JSON.parse(s) : null;
  },
  hasSave() { return !!localStorage.getItem('sc_savegame'); },
};
