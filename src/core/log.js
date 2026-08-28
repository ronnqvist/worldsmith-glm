const state = { enabled: false, buffer: [] };

export function initLogger(enabled) {
  state.enabled = !!enabled || new URLSearchParams(location.search).has('debug');
  try { localStorage.setItem('ws:debug', state.enabled ? '1' : '0'); } catch { /* private mode */ }
}

export function isEnabled() {
  return state.enabled;
}

function record(level, args) {
  const line = { t: Date.now(), level, msg: args.map(String).join(' ') };
  state.buffer.push(line);
  if (state.buffer.length > 500) state.buffer.shift();
  if (state.enabled) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[worldsmith] ${line.msg}`);
  }
}

export const log = {
  debug: (...a) => record('debug', a),
  info: (...a) => record('info', a),
  warn: (...a) => record('warn', a),
  error: (...a) => record('error', a),
  dump: () => state.buffer.slice()
};
