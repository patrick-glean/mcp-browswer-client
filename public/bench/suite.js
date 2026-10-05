// The benchmark suite: what to run, in what order, and how to sum it up. bench/index.html runs it
// from its Run button and tests/bench.mjs runs it headlessly; both print the tables from here.

import { memoryUrl } from './memory-server.js';

export const VARIANTS = {
    wasm: 'Rust/WASM',
    sdk: 'SDK, same interface',
    'sdk-objects': 'SDK, objects',
    'sdk-bare': 'SDK alone',
};

const KB = 1024;

// Each server is run with 64 B of text at several concurrencies; the first one, and the in-memory
// server, also with bigger payloads one at a time.
export function plan({ servers = [], memory = true, quick = false } = {}) {
    const targets = [
        ...servers.map((server, i) => ({ kind: 'network', label: server.label, url: server.url, sizes: i === 0 })),
        ...(memory
            ? [
                { kind: 'memory', label: 'modern, JSON', url: memoryUrl('modern', 'json'), sizes: true },
                { kind: 'memory', label: 'modern, SSE', url: memoryUrl('modern', 'sse') },
                { kind: 'memory', label: 'legacy, JSON', url: memoryUrl('legacy', 'json') },
            ]
            : []),
    ];
    const runs = [];
    for (const target of targets) {
        for (const concurrency of target.kind === 'memory' ? [1, 32] : [1, 6, 32]) runs.push(spec(target, 64, concurrency, quick));
        if (target.sizes) for (const bytes of [16 * KB, 256 * KB, 1024 * KB]) runs.push(spec(target, bytes, 1, quick));
    }
    return runs;
}

// About a second or two per run: more calls when they're small and cheap.
function spec(target, bytes, concurrency, quick) {
    const base = bytes <= 64 ? (target.kind === 'memory' ? 4000 : 1000) : bytes <= 16 * KB ? 400 : bytes <= 256 * KB ? 80 : 25;
    const calls = Math.max(10, Math.round(base * (concurrency > 1 ? 2 : 1) * (quick ? 0.2 : 1)));
    return { target, bytes, concurrency, calls, warmup: Math.max(5, Math.round(calls / 10)) };
}

let worker = null;

// Registers the benchmark's worker; resolves with what it says about its timers.
export async function ready() {
    await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { type: 'module', scope: './', updateViaCache: 'none' });
    worker = (await navigator.serviceWorker.ready).active;
    return send({ type: 'info' });
}

// Every request is a separate event for the worker, well inside the time a browser gives one.
export function send(message, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error(`The benchmark's worker didn't answer ${message.type} within ${timeoutMs / 1000} s`)), timeoutMs);
        channel.port1.onmessage = ({ data }) => {
            clearTimeout(timer);
            if (data.error === undefined) resolve(data.result);
            else reject(new Error(data.error));
        };
        worker.postMessage(message, [channel.port2]);
    });
}

export async function runSuite({ variants = Object.keys(VARIANTS), rounds = 3, ...config } = {}, onProgress = () => {}) {
    const runs = plan(config);
    const total = runs.length * rounds * variants.length;
    let done = 0;
    const results = [];
    for (const run of runs) {
        const samples = Object.fromEntries(variants.map(variant => [variant, []]));
        for (let round = 0; round < rounds; round++) {
            // A different order each round, so warming up and drift don't favor one variant.
            for (const variant of variants.map((_, i) => variants[(i + round) % variants.length])) {
                let sample;
                try {
                    sample = await send({ type: 'run', variant, url: run.target.url, bytes: run.bytes, calls: run.calls, concurrency: run.concurrency, warmup: run.warmup });
                } catch (error) {
                    sample = { variant, error: error.message };
                }
                samples[variant].push(sample);
                onProgress({ done: ++done, total, run, variant, sample });
            }
        }
        results.push({ ...run, variants: Object.fromEntries(Object.entries(samples).map(([variant, list]) => [variant, summarize(list)])) });
    }
    return results;
}

// The round with the median throughput stands for the variant; `spread` is its slowest and
// fastest rounds.
function summarize(samples) {
    const failed = samples.find(sample => sample.error);
    if (failed) return failed;
    const sorted = [...samples].sort((a, b) => a.callsPerSecond - b.callsPerSecond);
    return { ...sorted[Math.floor(sorted.length / 2)], spread: [sorted[0].callsPerSecond, sorted.at(-1).callsPerSecond] };
}

export const formatBytes = bytes => (bytes >= KB * KB ? `${bytes / KB / KB} MB` : bytes >= KB ? `${bytes / KB} KB` : `${bytes} B`);
export const formatMs = ms => (ms >= 100 ? `${Math.round(ms)} ms` : ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`);
export const formatRate = perSecond => `${Math.round(perSecond).toLocaleString('en-US')}/s`;
export const formatUs = us => (us >= 1000 ? formatMs(us / 1000) : `${Math.round(us)} µs`);

// How much faster the WASM client is than the SDK one: 1.25× means 25% more calls per second.
export function speedup(wasm, sdk) {
    if (!wasm || !sdk || wasm.error || sdk.error) return '';
    return `${(wasm.callsPerSecond / sdk.callsPerSecond).toFixed(2)}×`;
}

function cell(sample, kind) {
    if (sample.error) return `failed: ${sample.error}`;
    return kind === 'memory' ? formatUs(sample.usPerCall) : `${formatRate(sample.callsPerSecond)} · ${formatMs(sample.p50)}`;
}

// The results as tables, {title, note, headers, rows}, with every cell a string.
export function tables(results) {
    const groups = [
        { kind: 'network', title: 'Against the mock MCP server, over HTTP', note: 'Calls per second · median time per call.' },
        {
            kind: 'memory',
            title: 'Against the in-memory server: the client layer alone',
            note: 'Time per call. With one in flight that is its latency; with 32, the inverse of throughput.',
        },
    ];
    const sections = [];
    for (const { kind, title, note } of groups) {
        const rows = results.filter(result => result.target.kind === kind);
        if (!rows.length) continue;
        const variants = Object.keys(rows[0].variants);
        const compare = variants.includes('wasm') && variants.includes('sdk');
        sections.push({
            title,
            note,
            headers: ['Server', 'Payload', 'In flight', ...variants.map(variant => VARIANTS[variant] ?? variant), ...(compare ? ['WASM ÷ SDK'] : [])],
            rows: rows.map(result => [
                result.target.label,
                formatBytes(result.bytes),
                String(result.concurrency),
                ...variants.map(variant => cell(result.variants[variant], kind)),
                ...(compare ? [speedup(result.variants.wasm, result.variants.sdk)] : []),
            ]),
        });
    }
    return sections;
}

export function markdown({ title, note, headers, rows }) {
    const line = cells => `| ${cells.join(' | ')} |`;
    return [`### ${title}`, '', note, '', line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}
