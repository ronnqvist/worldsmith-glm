// StorageProvider: the single swap point for a future backend (e.g. Convex).
// App logic only ever calls the async methods below; replacing this module with
// a remote implementation requires no changes elsewhere.

const PREFIX = 'ws:';
const HISTORY_LIMIT = 20;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'deepseek/deepseek-v4-flash',
  customModel: '',
  httpReferer: '',
  xTitle: '',
  muteTTS: false,
  vignette: true,
  diagnostics: false
};

function readRaw(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const storage = {
  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...(readRaw('settings') || {}) };
  },

  async saveSettings(patch) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    writeRaw('settings', next);
    return next;
  },

  async getWorldMarkup() {
    return readRaw('world') || '';
  },

  async saveWorldMarkup(markup) {
    return writeRaw('world', String(markup || ''));
  },

  async getHistory() {
    return readRaw('history') || [];
  },

  async addHistoryEntry(entry) {
    const history = await this.getHistory();
    history.unshift({ prompt: String(entry.prompt || ''), ts: entry.ts || Date.now(), narration: entry.narration || '' });
    writeRaw('history', history.slice(0, HISTORY_LIMIT));
    return history;
  },

  async clearHistory() {
    writeRaw('history', []);
  },

  async getSavedWorlds() {
    return readRaw('worlds') || [];
  },

  async saveWorld(name, markup) {
    const worlds = await this.getSavedWorlds();
    const trimmed = String(name || '').trim() || `World ${worlds.length + 1}`;
    const existing = worlds.findIndex((w) => w.name === trimmed);
    const record = { name: trimmed, ts: Date.now(), markup: String(markup || '') };
    if (existing >= 0) worlds[existing] = record;
    else worlds.unshift(record);
    writeRaw('worlds', worlds);
    return worlds;
  },

  async deleteSavedWorld(name) {
    const worlds = (await this.getSavedWorlds()).filter((w) => w.name !== name);
    writeRaw('worlds', worlds);
    return worlds;
  },

  async replaceAll({ settings, world, history, worlds }) {
    if (settings !== undefined) writeRaw('settings', { ...DEFAULT_SETTINGS, ...settings, apiKey: (await this.getSettings()).apiKey });
    if (world !== undefined) this.saveWorldMarkup(world);
    if (history !== undefined) writeRaw('history', history.slice(0, HISTORY_LIMIT));
    if (worlds !== undefined) writeRaw('worlds', worlds);
  },

  async mergeImported({ settings, world, history, worlds }) {
    if (worlds && worlds.length) {
      const existing = await this.getSavedWorlds();
      const names = new Set(existing.map((w) => w.name));
      for (const w of worlds) {
        if (!names.has(w.name)) existing.push(w);
      }
      writeRaw('worlds', existing);
    }
    if (history && history.length) {
      const existing = await this.getHistory();
      const seen = new Set(existing.map((h) => h.ts + ':' + h.prompt));
      for (const h of history) {
        const key = h.ts + ':' + h.prompt;
        if (!seen.has(key)) existing.push(h);
      }
      existing.sort((a, b) => b.ts - a.ts);
      writeRaw('history', existing.slice(0, HISTORY_LIMIT));
    }
    if (settings) {
      const current = await this.getSettings();
      const merged = { ...current };
      for (const k of ['model', 'customModel', 'httpReferer', 'xTitle', 'muteTTS', 'vignette', 'diagnostics']) {
        if (settings[k] !== undefined) merged[k] = settings[k];
      }
      writeRaw('settings', merged);
    }
    if (world) this.saveWorldMarkup(world);
  }
};
