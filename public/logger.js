// Structured logging for the service worker. Every entry is printed to the worker's console
// (debug entries only show with DevTools' Verbose level) and handed to the sink, which sends it
// to each open page's Logs tab.
//
// Entry: {time, level: 'debug'|'info'|'warn'|'error', source: 'worker'|'wasm', message, server?, detail?}

let sink = () => {};

export function setLogSink(fn) {
    sink = fn;
}

export function log(level, message, { source = 'worker', server, detail } = {}) {
    const entry = { time: new Date().toISOString(), level, source, message };
    if (server) entry.server = server;
    if (detail !== undefined) entry.detail = detail;
    const print = console[level] || console.log;
    print(`[${source}] ${message}${server ? ` (${server})` : ''}`, ...(detail === undefined ? [] : [detail]));
    sink(entry);
    return entry;
}

export const logger = {
    debug: (message, options) => log('debug', message, options),
    info: (message, options) => log('info', message, options),
    warn: (message, options) => log('warn', message, options),
    error: (message, options) => log('error', message, options),
};

export function formatDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
