export const EXPORT_VERSION = 1;

export async function buildExportData(storageProvider) {
  const settings = await storageProvider.getSettings();
  const { apiKey, ...settingsSansKey } = settings;
  return {
    app: 'worldsmith',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: settingsSansKey,
    history: await storageProvider.getHistory(),
    savedWorlds: await storageProvider.getSavedWorlds(),
    world: await storageProvider.getWorldMarkup()
  };
}

export function downloadExport(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `worldsmith-${new Date().toISOString().slice(0, 10)}.worldsmith.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function readImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

export function validateImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'Not a JSON object' };
  }
  if (data.app !== 'worldsmith' || typeof data.version !== 'number') {
    return { ok: false, error: 'Missing worldsmith marker or version' };
  }
  if (data.version > EXPORT_VERSION) {
    return { ok: false, error: `File version ${data.version} is newer than supported (${EXPORT_VERSION})` };
  }
  if (data.settings && typeof data.settings !== 'object') return { ok: false, error: 'settings must be an object' };
  if (data.history && !Array.isArray(data.history)) return { ok: false, error: 'history must be an array' };
  if (data.savedWorlds && !Array.isArray(data.savedWorlds)) return { ok: false, error: 'savedWorlds must be an array' };
  if (data.world && typeof data.world !== 'string') return { ok: false, error: 'world must be a string' };
  return { ok: true };
}
