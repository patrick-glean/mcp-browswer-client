// Log entries for the service worker's logger: {level, server, message, detail?}. Until the
// worker sets a logger, entries go to the console.

let sink = null;

export function setLogger(fn) {
    sink = typeof fn === 'function' ? fn : null;
}

export function emit(level, server, message, detail) {
    const entry = { level, server, message };
    if (detail !== undefined) entry.detail = detail;
    if (sink) sink(entry);
    else console.log('[sdk]', entry);
}

export const debug = (server, message, detail) => emit('debug', server, message, detail);
export const info = (server, message, detail) => emit('info', server, message, detail);
export const warn = (server, message, detail) => emit('warn', server, message, detail);
