// How runs are compared, shared by the worker (which records them) and the page (which shows what
// changed). Results are compared without `_meta`, where servers put request IDs and timings.

// Results and arguments bigger than this many characters of JSON are kept as truncated text.
export const MAX_STORED_CHARS = 256 * 1024;

// Object keys in a fixed order, every `_meta` removed.
export function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).filter(key => key !== '_meta').sort().map(key => [key, normalize(value[key])]));
    }
    return value;
}

export const canonicalJson = value => JSON.stringify(normalize(value ?? null));

export async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Runs of one saved request compare with each other; other calls compare with earlier calls of
// the same tool with the same arguments.
export async function compareKeyFor({ requestId, serverUrl, toolName, sentArgs }) {
    if (requestId) return `request:${requestId}`;
    return `call:${await sha256(`${serverUrl}\n${toolName}\n${canonicalJson(sentArgs ?? {})}`)}`;
}

// What a run is compared on: the result, or for a failed call its error. A result without a
// `resultType` is complete, and libraries differ on whether they say so.
export function comparedValue(run) {
    if (run.outcome === 'failed') return { error: run.error, errorKind: run.errorKind };
    const { result } = run;
    if (result && typeof result === 'object' && !Array.isArray(result) && result.resultType === undefined) {
        return { ...result, resultType: 'complete' };
    }
    return result;
}

// `{ [name]: value }`, or for a value too big to keep, `{ [name]: null, [name + 'Text']: the start of its JSON }`.
export function stored(name, value) {
    const text = JSON.stringify(value ?? null, null, 2);
    if (text.length <= MAX_STORED_CHARS) return { [name]: value ?? null };
    return { [name]: null, [`${name}Text`]: text.slice(0, MAX_STORED_CHARS) };
}
