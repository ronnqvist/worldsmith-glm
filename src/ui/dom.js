import { storage, DEFAULT_SETTINGS } from '../storage/localProvider.js';
import { buildExportData, downloadExport, readImportFile, validateImport } from '../storage/exportImport.js';
import { MODELS, DEFAULT_MODEL } from '../llm/systemPrompt.js';
import { emit, on } from '../core/bus.js';
import { log } from '../core/log.js';

let handlers = null;
let refs = {};
let importData = null;

function $(id) {
  return document.getElementById(id);
}

export function toast(message, { error = false, ms = 4000 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = message;
  refs.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 450);
  }, ms);
}

function updateStatus() {
  const mic = handlers.micAvailable() ? 'speech' : 'keyboard';
  const model = handlers.modelLabel();
  const count = handlers.entityCount();
  refs.status.textContent = `${model} | mic: ${mic} | entities: ${count}`;
}

function renderHistory() {
  storage.getHistory().then((history) => {
    refs.historyList.innerHTML = '';
    for (const entry of history) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = 'Run';
      btn.addEventListener('click', () => handlers.submitPrompt(entry.prompt));
      const span = document.createElement('span');
      span.textContent = ' ' + (entry.prompt || '').slice(0, 90);
      li.appendChild(btn);
      li.appendChild(span);
      refs.historyList.appendChild(li);
    }
  });
}

function renderWorlds() {
  storage.getSavedWorlds().then((worlds) => {
    refs.worldList.innerHTML = '';
    for (const w of worlds) {
      const li = document.createElement('li');
      li.className = 'world-row';
      const load = document.createElement('button');
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        handlers.restoreWorld(w.markup);
        toast(`Loaded "${w.name}"`);
      });
      const del = document.createElement('button');
      del.textContent = 'X';
      del.className = 'danger';
      del.addEventListener('click', async () => {
        await storage.deleteSavedWorld(w.name);
        renderWorlds();
      });
      const span = document.createElement('span');
      span.textContent = w.name;
      li.appendChild(load);
      li.appendChild(span);
      li.appendChild(del);
      refs.worldList.appendChild(li);
    }
  });
}

async function bindSettings() {
  const s = await storage.getSettings();
  refs.apiKey.value = s.apiKey || '';
  refs.modelSelect.value = MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_MODEL;
  refs.customModel.value = s.customModel || '';
  refs.referer.value = s.httpReferer || '';
  refs.xtitle.value = s.xTitle || '';
  refs.mute.checked = !!s.muteTTS;
  refs.vignette.checked = !!s.vignette;
  refs.debug.checked = !!s.diagnostics;
}

async function persist(patch) {
  const next = await storage.saveSettings(patch);
  emit('settings:changed', next);
  updateStatus();
  return next;
}

export function initDom({ handlers: h }) {
  handlers = h;
  refs = {
    status: $('status-line'),
    toasts: $('toasts'),
    prompt: $('prompt-input'),
    send: $('btn-send'),
    mic: $('btn-mic'),
    enterVr: $('btn-enter-vr'),
    mr: $('btn-mr'),
    undo: $('btn-undo'),
    reset: $('btn-reset-world'),
    toggleUi: $('btn-toggle-ui'),
    historyList: $('history-list'),
    clearHistory: $('btn-clear-history'),
    worldName: $('world-name'),
    saveWorld: $('btn-save-world'),
    worldList: $('world-list'),
    exportBtn: $('btn-export'),
    importBtn: $('btn-import'),
    importFile: $('import-file'),
    importResult: $('import-result'),
    importChoice: $('import-choice'),
    importReplace: $('btn-import-replace'),
    importMerge: $('btn-import-merge'),
    importCancel: $('btn-import-cancel'),
    apiKey: $('set-api-key'),
    modelSelect: $('set-model'),
    customModel: $('set-model-custom'),
    referer: $('set-referer'),
    xtitle: $('set-xtitle'),
    validateKey: $('btn-validate-key'),
    validateResult: $('validate-result'),
    mute: $('set-mute'),
    vignette: $('set-vignette'),
    debug: $('set-debug')
  };

  // model dropdown
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    refs.modelSelect.appendChild(opt);
  }

  // prompt
  refs.send.addEventListener('click', () => {
    const text = refs.prompt.value.trim();
    if (!text) return;
    refs.prompt.value = '';
    handlers.submitPrompt(text);
  });
  refs.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) refs.send.click();
  });

  // mic (hold)
  if (handlers.micAvailable()) {
    refs.mic.classList.remove('hidden');
    refs.mic.addEventListener('mousedown', () => handlers.micPress());
    refs.mic.addEventListener('mouseup', () => handlers.micRelease());
    refs.mic.addEventListener('mouseleave', () => handlers.micRelease());
  }

  // top bar
  refs.enterVr.addEventListener('click', () => handlers.enterVR());
  refs.mr.addEventListener('click', () => handlers.enterMR());
  refs.undo.addEventListener('click', () => {
    if (handlers.undo()) toast('Reverted last change');
    else toast('Nothing to undo');
  });
  refs.reset.addEventListener('click', () => {
    handlers.resetWorld();
    toast('World reset');
  });
  refs.toggleUi.addEventListener('click', () => {
    const hidden = refs.promptRowHidden = !refs.promptRowHidden;
    document.querySelectorAll('#prompt-row, #side-panels').forEach((elNode) => {
      elNode.style.display = hidden ? 'none' : '';
    });
    refs.toggleUi.textContent = hidden ? 'Show UI' : 'Hide UI';
  });

  // history
  refs.clearHistory.addEventListener('click', async () => {
    await storage.clearHistory();
    renderHistory();
  });

  // saved worlds
  refs.saveWorld.addEventListener('click', async () => {
    const name = refs.worldName.value.trim();
    if (!name) {
      toast('Give the world a name first', { error: true });
      return;
    }
    await storage.saveWorld(name, handlers.getWorldMarkup());
    refs.worldName.value = '';
    renderWorlds();
    toast(`Saved "${name}"`);
  });

  // export / import
  refs.exportBtn.addEventListener('click', async () => {
    const data = await buildExportData(storage);
    downloadExport(data);
    toast('Export downloaded');
  });

  refs.importBtn.addEventListener('click', () => refs.importFile.click());
  refs.importFile.addEventListener('change', async () => {
    const file = refs.importFile.files && refs.importFile.files[0];
    if (!file) return;
    try {
      const text = await readImportFile(file);
      const data = JSON.parse(text);
      const check = validateImport(data);
      if (!check.ok) {
        refs.importResult.textContent = check.error;
        toast(`Import failed: ${check.error}`, { error: true });
        return;
      }
      importData = data;
      refs.importResult.textContent = `Valid export from ${data.exportedAt || 'unknown date'}`;
      refs.importChoice.classList.remove('hidden');
    } catch (e) {
      refs.importResult.textContent = 'Invalid JSON file';
      toast('Import failed: invalid JSON', { error: true });
    }
    refs.importFile.value = '';
  });
  const finishImport = async (mode) => {
    if (!importData) return;
    const payload = {
      settings: importData.settings,
      history: importData.history,
      world: importData.world,
      worlds: importData.savedWorlds
    };
    if (mode === 'replace') await storage.replaceAll(payload);
    else await storage.mergeImported(payload);
    if (importData.world) handlers.restoreWorld(importData.world);
    importData = null;
    refs.importChoice.classList.add('hidden');
    refs.importResult.textContent = 'Imported';
    await bindSettings();
    renderHistory();
    renderWorlds();
    toast('Import complete');
  };
  refs.importReplace.addEventListener('click', () => finishImport('replace'));
  refs.importMerge.addEventListener('click', () => finishImport('merge'));
  refs.importCancel.addEventListener('click', () => {
    importData = null;
    refs.importChoice.classList.add('hidden');
  });

  // settings bindings
  refs.apiKey.addEventListener('change', () => persist({ apiKey: refs.apiKey.value.trim() }));
  refs.modelSelect.addEventListener('change', () => persist({ model: refs.modelSelect.value }));
  refs.customModel.addEventListener('change', () => persist({ customModel: refs.customModel.value.trim() }));
  refs.referer.addEventListener('change', () => persist({ httpReferer: refs.referer.value.trim() }));
  refs.xtitle.addEventListener('change', () => persist({ xTitle: refs.xtitle.value.trim() }));
  refs.mute.addEventListener('change', () => persist({ muteTTS: refs.mute.checked }));
  refs.vignette.addEventListener('change', () => persist({ vignette: refs.vignette.checked }));
  refs.debug.addEventListener('change', () => persist({ diagnostics: refs.debug.checked }));
  refs.validateKey.addEventListener('click', async () => {
    refs.validateResult.textContent = 'Checking…';
    refs.validateResult.className = '';
    const r = await handlers.validateKey();
    refs.validateResult.textContent = r.message;
    refs.validateResult.className = r.ok ? 'ok' : 'bad';
  });

  // live updates
  on('world:changed', () => updateStatus());
  on('settings:changed', () => updateStatus());
  on('xr:ar-supported', (supported) => {
    refs.mr.classList.toggle('hidden', !supported);
  });
  on('xr:error', (msg) => toast(msg, { error: true }));

  bindSettings();
  renderHistory();
  renderWorlds();
  updateStatus();
}
