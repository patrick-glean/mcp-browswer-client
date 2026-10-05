// Pre-fill's test data: a value for each of a tool's fields, from its input schema and the active
// environment's variables, which is where test data is staged.
//
// By default only the required fields are filled; `every` fills the optional ones too, and
// fieldTestData fills one field. A field gets the first of: its `const`; {{name}} when a variable
// is named like the field (ignoring case, dashes and underscores); its `default`; its first
// example, from `examples` or from its description ("e.g. 'react'", 'one of "asc", "desc"'). The
// rest get a generated value that fits the schema: its format, pattern, length, range, multipleOf,
// enum, items and properties, with plausible text for common field names and for what a
// description says a field holds (a date as YYYY-MM-DD, an email address). Optional pagination
// cursors stay empty, since only an earlier response has one. Nothing is random, so a schema gets
// the same values every time and their runs compare.

import { schemaType } from './template.js';

// Deeper than this is a recursive schema, which gets no generated values.
const MAX_DEPTH = 8;
const MAX_ITEMS = 50;
const DAY_MS = 86_400_000;

const normalized = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

// A range's start is a week before its end, which is today.
const START_OF_RANGE = /^(start|since|from|after|begin)|(start|since|from|after|begin)(date|day|time)?$/;
const isoDate = key => new Date(Date.now() - (START_OF_RANGE.test(normalized(key)) ? 7 * DAY_MS : 0)).toISOString().slice(0, 10);

// A default or example that says "nothing" (null, '', [] or {}) suggests no value to try.
const blank = value => value === null || value === ''
    || (Array.isArray(value) ? !value.length : typeof value === 'object' && !Object.keys(value).length);

// The variable a field takes: one with its exact name, else one named like it.
export function matchingVariable(field, variables = {}) {
    if (Object.hasOwn(variables, field)) return field;
    const wanted = normalized(field);
    return Object.keys(variables).find(name => normalized(name) === wanted) || null;
}

// {values, sources}: the values to fill in, and where each top-level field's value came from:
// 'const', 'variable', 'default', 'example', 'description' or 'generated'.
export function testData(schema, { variables = {}, every = false } = {}) {
    const context = { root: schema || {}, variables, every };
    const { value, sources } = objectValue(resolve(schema, context), context, 0, true);
    return { values: value, sources };
}

// One field's test data, as if every field were asked for: {value, source}, or null when it gets
// none. `path` names the field the way the form does: `limit`, or `filter.owner` inside an object.
export function fieldTestData(schema, path, { variables = {} } = {}) {
    const context = { root: schema || {}, variables, every: true };
    const keys = String(path).split('.');
    let parent = resolve(schema, context);
    for (const key of keys.slice(0, -1)) parent = resolve(parent.properties?.[key], context);
    const key = keys.at(-1);
    if (!parent.properties || !Object.hasOwn(parent.properties, key)) return null;
    return fieldValue(key, parent.properties[key], (parent.required || []).includes(key), context, keys.length - 1);
}

// --- What a field gets ---

function objectValue(schema, context, depth, fillRequired) {
    const value = {};
    const sources = {};
    const required = new Set(schema.required || []);
    for (const [key, prop] of Object.entries(schema.properties || {})) {
        const filled = fieldValue(key, prop, fillRequired && required.has(key), context, depth);
        if (!filled) continue;
        value[key] = filled.value;
        sources[key] = filled.source;
    }
    return { value, sources };
}

// Cursors and page tokens come from an earlier response.
const PAGINATION = /(cursor|pagetoken|nexttoken|continuationtoken)$/;

function fieldValue(key, raw, required, context, depth) {
    if (!required && !context.every) return null;
    const prop = resolve(raw, context);
    if (Object.hasOwn(prop, 'const')) return { value: prop.const, source: 'const' };
    const variable = matchingVariable(key, context.variables);
    if (variable) return { value: `{{${variable}}}`, source: 'variable' };
    const hint = suggested(key, prop, context);
    if (hint) return hint;
    if (typeOf(prop) === 'object' && prop.properties) {
        // An object's fields each get their own hints, and the object counts as generated when
        // any of them was.
        if (depth >= MAX_DEPTH) return null;
        const { value, sources } = objectValue(prop, context, depth + 1, true);
        const kinds = Object.values(sources);
        if (!kinds.length) return { value, source: 'generated' };
        const source = ['generated', 'variable', 'description', 'example', 'default', 'const'].find(kind => kinds.includes(kind));
        return { value, source };
    }
    if (!required && PAGINATION.test(normalized(key))) return null;
    const value = generated(key, prop, context, depth, 0);
    return value === undefined ? null : { value, source: 'generated' };
}

// What the schema suggests: its default, first example, or a value its description gives.
function suggested(key, prop, context) {
    if (Object.hasOwn(prop, 'default') && !blank(prop.default)) return { value: prop.default, source: 'default' };
    const examples = [...(Array.isArray(prop.examples) ? prop.examples : []), ...(Object.hasOwn(prop, 'example') ? [prop.example] : [])];
    const example = examples.find(candidate => !blank(candidate));
    if (example !== undefined) return { value: example, source: 'example' };
    const described = valueInDescription(key, prop, context);
    return described === undefined ? null : { value: described, source: 'description' };
}

// Where a description gives a value. An example comes right after its cue, in quotes or as one
// bare token that ends its phrase: "e.g. 'react'", '(e.g., "facebook/react")', "for example
// `eu-west-1`", "e.g. 25." A list of the values a field takes may have other words before its
// first quoted value: 'one of ["today", "past_week"]', 'can be a person\'s name, "me" or "myteam"',
// 'Use keywords: "today"'. Prose doesn't count: a bare word with more words after it ("e.g. last
// week"), an apostrophe taken for a quote ("what's"), a phrase for a field that doesn't take free
// text, a shortened example ("AAMkAD...") or a format (YYYY-MM-DD), and anything a clause says not
// to use. Only a value that fits the field counts.
const EXAMPLE_CUES = String.raw`e\.g\.|eg\.|for example|for instance|such as|examples?`;
const LIST_CUES = String.raw`one of|values?|keywords?|options?|either|can be|like|defaults? to`;
const CUES = new RegExp(String.raw`(?<![\w-])(?:(${EXAMPLE_CUES})|(${LIST_CUES}))(?![\w-])`, 'gi');
// Quotes that pair up. An opening quote doesn't follow a letter and a closing one isn't followed
// by one, so a quote inside a word ("what's", "Bob's") is an apostrophe.
const QUOTED = /(?<!\w)"(?!\s)([^"\n]+?)(?<!\s)"(?!\w)|“([^”\n]+)”|(?<!\w)`(?!\s)([^`\n]+?)(?<!\s)`(?!\w)|(?<!\w)'(?!\s)((?:[^'\n]|'(?=\w))+?)(?<!\s)'(?!\w)|‘((?:[^’\n]|’(?=\w))+?)’(?!\w)/g;
const QUOTED_HERE = new RegExp(QUOTED.source, 'y');
const BARE_HERE = /([^\s"'`‘’“”,;()[\]{}<>]+?)([.!?]*)(?=$|[\s,;)\]])/y;
// What may come between a cue and its value: punctuation, an opening bracket, a list's bullet.
const LEAD = String.raw`(?:[\s,:[(]|[-*•](?=\s))*`;
const LEADING = new RegExp(LEAD, 'y');
const ONLY_LEADING = new RegExp(`^${LEAD}$`);
const SENTENCE_END = /[.!?](?:\s|$)|\n/;
const CLAUSE_START = /[\s\S]*(?:[.!?,;:—–]\s|\n|\()/;
const NEGATION = /\b(?:not|never|avoid|instead|don't|doesn't|isn't|aren't)\b/i;
const PLACEHOLDER = /\b(?:Y{2,4}|M{2}|D{2}|H{2})\b|<[^<>]+>|\.\.\.|…/;
// Fields that take words people write, where a phrase or a whole sentence is a fine example.
const FREE_TEXT = /(questions?|prompts?|messages?|texts?|contents?|bod(?:y|ies)|inputs?|comments?|notes?|descriptions?|summar(?:y|ies)|instructions?|quer(?:y|ies)|search(?:es)?|keywords?|terms?|topics?|titles?|subjects?|names?|labels?|captions?|goals?|reasons?|context)$/;

function valueInDescription(key, prop, context) {
    const text = prop.description;
    if (typeof text !== 'string') return undefined;
    for (const cue of text.matchAll(CUES)) {
        if (NEGATION.test(text.slice(0, cue.index).replace(CLAUSE_START, ''))) continue;
        const end = cue.index + cue[0].length;
        const found = (cue[1] ? exampleAt(text, end) : listedAfter(text, end))?.trim();
        if (!found || PLACEHOLDER.test(found)) continue;
        if (/\s/.test(found) && !Array.isArray(prop.enum) && !FREE_TEXT.test(normalized(key))) continue;
        const value = fromText(found, prop, context);
        if (value !== undefined) return value;
    }
    return undefined;
}

const unquoted = match => match.slice(1).find(group => group !== undefined);

// The value right after an example's cue, which ends at `at`.
function exampleAt(text, at) {
    LEADING.lastIndex = at;
    LEADING.exec(text);
    const start = LEADING.lastIndex;
    QUOTED_HERE.lastIndex = start;
    const quoted = QUOTED_HERE.exec(text);
    if (quoted) return unquoted(quoted);
    BARE_HERE.lastIndex = start;
    const bare = BARE_HERE.exec(text);
    if (!bare || !/[\p{L}\p{N}]/u.test(bare[1])) return undefined;
    const moreWords = /^[^\S\n]/.test(text.slice(BARE_HERE.lastIndex)) && !bare[2];
    return moreWords ? undefined : bare[1];
}

// The first quoted value after a list's cue, in the same sentence.
function listedAfter(text, at) {
    QUOTED.lastIndex = at;
    const quoted = QUOTED.exec(text);
    if (!quoted) return undefined;
    const gap = text.slice(at, quoted.index);
    if (!ONLY_LEADING.test(gap) && (SENTENCE_END.test(gap) || NEGATION.test(gap))) return undefined;
    return unquoted(quoted);
}

function fromText(text, prop, context, nested = false) {
    const type = typeOf(prop);
    let value = text;
    if (type === 'integer' || type === 'number') {
        value = Number(text);
        if (text.trim() === '' || !Number.isFinite(value)) return undefined;
    } else if (type === 'boolean') {
        if (text !== 'true' && text !== 'false') return undefined;
        value = text === 'true';
    } else if (type === 'array') {
        // A list of one; lists of lists don't take examples from text.
        const item = !nested && prop.items && !Array.isArray(prop.items) ? fromText(text, resolve(prop.items, context), context, true) : undefined;
        return item === undefined ? undefined : [item];
    } else if (type && type !== 'string') {
        return undefined;
    }
    return fits(value, prop) ? value : undefined;
}

// --- Generated values ---

function generated(key, prop, context, depth, index) {
    if (Object.hasOwn(prop, 'const')) return prop.const;
    if (Array.isArray(prop.enum) && prop.enum.length) {
        const options = prop.enum.some(option => option !== null) ? prop.enum.filter(option => option !== null) : prop.enum;
        return options[index % options.length];
    }
    switch (typeOf(prop)) {
        case 'string': return stringValue(key, prop, index);
        case 'integer':
        case 'number': return numberValue(key, prop, index);
        case 'boolean': return false;
        // A recursive schema stops here, leaving out the optional field that would go deeper.
        case 'array': return depth >= MAX_DEPTH ? undefined : arrayValue(key, prop, context, depth);
        case 'object': return depth >= MAX_DEPTH ? undefined : objectValue(prop, context, depth + 1, true).value;
        case 'null': return null;
        default: return undefined;
    }
}

const FORMATS = {
    email: () => 'test@example.com',
    'idn-email': () => 'test@example.com',
    uri: () => 'https://example.com',
    url: () => 'https://example.com',
    iri: () => 'https://example.com',
    'uri-reference': () => '/',
    'iri-reference': () => '/',
    'uri-template': () => 'https://example.com/{id}',
    hostname: () => 'example.com',
    'idn-hostname': () => 'example.com',
    ipv4: () => '192.0.2.1',
    ipv6: () => '2001:db8::1',
    date: isoDate,
    'date-time': key => `${isoDate(key)}T00:00:00Z`,
    time: () => '12:00:00Z',
    duration: () => 'PT1H',
    uuid: () => '00000000-0000-4000-8000-000000000000',
    'json-pointer': () => '/',
    'relative-json-pointer': () => '0',
    regex: () => '.*',
    byte: () => 'dGVzdA==',
};

// Plausible text for common field names, matched on the name in lower case without separators.
// These names say what a field holds.
const STRING_HINTS = [
    [/email|^(to|cc|bcc|replyto)$|^(recipient|sender|attendee|participant|invitee)s?$/, 'test@example.com'],
    [/(url|uri|link|href|endpoint|website|homepage)$/, 'https://example.com'],
    [/^(host|hostname|domain)$/, 'example.com'],
    [/^(q|query|search|searchquery|searchterm|searchterms|keyword|keywords|term|terms)$/, 'test'],
    [/(?<!^up|vali|candi)date$|(?<!week)day$/, isoDate],
    [/colou?r$/, '#3366ff'],
    [/phone/, '+15555550100'],
    [/question$/, 'What is MCP?'],
    [/(prompt|message|text|content|body|input|comment|note|description|summary|subject)$/, 'Hello from MCP Browser Client'],
];
// What a description says a string holds, for names that don't: a date format or base64 it
// gives, or an email address or URL it starts with.
const DESCRIBED = [
    [/Y{4}-M{2}-D{2}[T ]H{2}|ISO[ -]?8601 (?:date[- ]?time|timestamp)/i, key => `${isoDate(key)}T00:00:00Z`],
    [/Y{4}-M{2}-D{2}|ISO[ -]?8601/i, isoDate],
    [/\bbase64[- ]encoded\b|\b(?:in|as) base64\b/i, 'dGVzdA=='],
    [/^\W*(?:\((?:optional|required)\)\s*)?(?:the |an? )?e-?mail address/i, 'test@example.com'],
    [/^\W*(?:\((?:optional|required)\)\s*)?(?:the |an? )?(?:\w+ )?(?:URL|URI)\b/i, 'https://example.com'],
];
// Guesses from a field's name, which a description that says what the field holds comes before.
const GUESSES = [
    [/(reponame|repofullname|nwo)$/, 'modelcontextprotocol/modelcontextprotocol'],
    [/^(owner|org|organization|organisation|namespace|repo|repository)$/, 'modelcontextprotocol'],
    [/^(user|username|login|author|handle|assignee|reviewer)s?$/, 'octocat'],
    [/^(branch|branchname|ref|basebranch|frombranch)$/, 'main'],
    [/(file|filename|filepath)$/, 'README.md'],
    [/(path|dir|directory|folder)$/, '/'],
    [/version$/, '1.0.0'],
    [/(library|package|pkg|module)(name|id)?$/, 'react'],
    [/^(lang|language|locale)$/, (key, prop) => (/\b(programming|code|snippets?|syntax)\b/i.test(prop.description || '') ? 'python' : 'en')],
    [/^(country|countrycode)$/, 'US'],
    [/^(currency|currencycode)$/, 'USD'],
    [/^(tz|timezone)$/, 'UTC'],
    [/^(order|sortorder|direction|sortdirection)$/, 'asc'],
    [/(name|title|label)$/, 'Test'],
];
// Matched on the name as written, so `paid` or `valid` aren't IDs.
const ID_NAME = /(^id$|[_-]id$|[a-z]Id$|ID$)/;

const NUMBER_HINTS = [
    [/^(max|count|size|top|topk|k|n|num|results|first|last)$|(limit|maxresults|numresults|pagesize|perpage)$/, 5],
    [/^(page|pagenumber)$/, 1],
    [/^(offset|skip|start)$/, 0],
    [/year$/, () => new Date().getUTCFullYear()],
    [/port$/, 8080],
    [/(timeout|seconds|secs)$/, 30],
];

const hinted = (hints, key, prop = {}) => {
    const found = hints.find(([pattern]) => pattern.test(normalized(key)));
    return found ? (typeof found[1] === 'function' ? found[1](key, prop) : found[1]) : undefined;
};

function described(key, prop) {
    if (typeof prop.description !== 'string') return undefined;
    const found = DESCRIBED.find(([pattern]) => pattern.test(prop.description));
    return found ? (typeof found[1] === 'function' ? found[1](key) : found[1]) : undefined;
}

function stringValue(key, prop, index) {
    const formatted = Object.hasOwn(FORMATS, prop.format) ? FORMATS[prop.format](key) : undefined;
    const named = ID_NAME.test(key) ? '1' : hinted(STRING_HINTS, key, prop);
    const fromDescription = described(key, prop);
    const guessed = hinted(GUESSES, key, prop);
    // An array that wants unique items gets "test", "test2", "test3"… Readable values come before
    // one made from the pattern, as long as they match it.
    const numbered = text => (index && text !== undefined ? `${text}${index + 1}` : text);
    const candidates = [formatted, ...[named, fromDescription, guessed, 'test'].flatMap(text => [numbered(text), text]), patternValue(prop.pattern)];
    for (const candidate of candidates) {
        if (candidate === undefined) continue;
        const value = fitLength(candidate, prop);
        if (fits(value, prop)) return value;
    }
    return undefined;
}

function fitLength(text, prop) {
    let value = text;
    if (typeof prop.minLength === 'number' && [...value].length < prop.minLength) value = value.padEnd(prop.minLength, value || 'x');
    if (typeof prop.maxLength === 'number' && [...value].length > prop.maxLength) value = [...value].slice(0, prop.maxLength).join('');
    return value;
}

function numberValue(key, prop, index) {
    const integer = typeOf(prop) === 'integer';
    const min = typeof prop.minimum === 'number' ? prop.minimum : typeof prop.exclusiveMinimum === 'number' ? prop.exclusiveMinimum : undefined;
    const max = typeof prop.maximum === 'number' ? prop.maximum : typeof prop.exclusiveMaximum === 'number' ? prop.exclusiveMaximum : undefined;
    const preferred = (hinted(NUMBER_HINTS, key) ?? 1) + index;
    const candidates = [preferred, min, min === undefined ? undefined : min + 1, min === undefined || max === undefined ? undefined : (min + max) / 2, max, max === undefined ? undefined : max - 1, 0];
    for (const candidate of candidates) {
        if (candidate === undefined) continue;
        let value = prop.multipleOf ? Math.ceil(candidate / prop.multipleOf) * prop.multipleOf : candidate;
        if (integer) value = Math.ceil(value);
        value = Number(value.toFixed(10));
        if (fits(value, prop)) return value;
    }
    return undefined;
}

function arrayValue(key, prop, context, depth) {
    const tuple = Array.isArray(prop.prefixItems) ? prop.prefixItems : Array.isArray(prop.items) ? prop.items : null;
    if (tuple) {
        const items = tuple.map((item, index) => itemValue(key, resolve(item, context), context, depth + 1, index));
        return items.includes(undefined) ? undefined : items;
    }
    if (prop.maxItems === 0) return [];
    const count = Math.max(prop.minItems ?? 0, 1);
    if (count > MAX_ITEMS) return undefined;
    const schema = resolve(prop.items || {}, context);
    const items = [];
    for (let index = 0; index < count; index++) {
        const item = itemValue(key, schema, context, depth + 1, prop.uniqueItems || count > 1 ? index : 0);
        if (item === undefined) return undefined;
        items.push(item);
    }
    return items;
}

// An item takes its schema's suggestion when it's the first, and is generated otherwise, named
// like one of the array's (`tags` → `tag`).
function itemValue(key, schema, context, depth, index) {
    const singular = key.replace(/ies$/, 'y').replace(/s$/, '');
    if (index === 0) {
        const hint = suggested(singular, schema, context);
        if (hint) return hint.value;
    }
    return generated(singular, schema, context, depth, index);
}

// The shortest string a simple pattern matches, preferring one of each optional part: classes,
// groups, alternatives (the first), quantifiers and escapes. Lookarounds and backreferences give
// up; whatever comes out is checked with the real RegExp.
function patternValue(pattern) {
    if (typeof pattern !== 'string') return undefined;
    let i = 0;
    const fail = () => { throw new Error('unsupported pattern'); };
    const escaped = char => ({ d: '1', D: 'a', w: 'a', W: '-', s: ' ', S: 'a', b: '', B: '', n: '\n', t: '\t', r: '\r' })[char];
    const classMember = () => {
        if (pattern[i] === '\\') {
            const char = pattern[i + 1];
            i += 2;
            const special = { d: ['0', '9'], w: ['a', 'z'], s: [' ', ' '] }[char];
            return special || [char, char];
        }
        const from = pattern[i++];
        if (pattern[i] === '-' && pattern[i + 1] !== ']' && i + 1 < pattern.length) {
            i++;
            const to = pattern[i] === '\\' ? pattern[(i += 2) - 1] : pattern[i++];
            return [from, to];
        }
        return [from, from];
    };
    const characterClass = () => {
        i++;
        const negated = pattern[i] === '^';
        if (negated) i++;
        const ranges = [];
        while (i < pattern.length && pattern[i] !== ']') ranges.push(classMember());
        if (pattern[i] !== ']') fail();
        i++;
        if (!negated) return ranges.length ? ranges[0][0] : fail();
        const inside = char => ranges.some(([from, to]) => char >= from && char <= to);
        return ['a', 'A', '1', 'x', '_', '-', ' '].find(char => !inside(char)) ?? fail();
    };
    const atom = () => {
        const char = pattern[i];
        if (char === '(') {
            i++;
            if (pattern[i] === '?') {
                if (pattern[i + 1] === ':') i += 2;
                else if (pattern[i + 1] === '<' && /[A-Za-z]/.test(pattern[i + 2] || '')) i = pattern.indexOf('>', i) + 1;
                else fail();
            }
            const text = alternatives();
            if (pattern[i] !== ')') fail();
            i++;
            return text;
        }
        if (char === '[') return characterClass();
        if (char === '\\') {
            const next = pattern[i + 1];
            i += 2;
            if (/[1-9]/.test(next)) fail();
            if (next === 'p' || next === 'P') {
                const end = pattern.indexOf('}', i);
                if (pattern[i] !== '{' || end === -1) fail();
                const name = pattern.slice(i + 1, end);
                i = end + 1;
                return next === 'P' ? '-' : /^(N|Nd)$/.test(name) ? '1' : /^Lu$/.test(name) ? 'A' : 'a';
            }
            return escaped(next) ?? next;
        }
        i++;
        if (char === '.') return 'a';
        if (char === '^' || char === '$') return '';
        return char;
    };
    const repeats = () => {
        const char = pattern[i];
        let count = 1;
        if (char === '*' || char === '+' || char === '?') {
            i++;
        } else if (char === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i))) {
            const [, low, comma, high] = pattern.slice(i).match(/^\{(\d+)(,)?(\d*)\}/);
            i += pattern.slice(i).indexOf('}') + 1;
            const least = Number(low);
            const most = comma ? (high === '' ? Infinity : Number(high)) : least;
            count = least > 0 ? least : Math.min(1, most);
        } else {
            return 1;
        }
        if (pattern[i] === '?') i++;
        return count;
    };
    const sequence = () => {
        let text = '';
        while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') {
            const piece = atom();
            text += piece.repeat(repeats());
        }
        return text;
    };
    const alternatives = () => {
        const first = sequence();
        while (pattern[i] === '|') {
            i++;
            sequence();
        }
        return first;
    };
    try {
        const text = alternatives();
        return i === pattern.length ? text : undefined;
    } catch {
        return undefined;
    }
}

// --- Schemas ---

// A field's schema as it's filled: $ref followed (local ones), allOf merged, and anyOf or oneOf
// merged with their first branch that isn't null.
function resolve(prop, context, hops = 0) {
    let schema = prop && typeof prop === 'object' ? prop : {};
    if (hops > MAX_DEPTH) return schema;
    if (typeof schema.$ref === 'string') {
        const { $ref, ...siblings } = schema;
        schema = { ...resolve(lookup($ref, context.root), context, hops + 1), ...siblings };
    }
    if (Array.isArray(schema.allOf)) {
        const { allOf, ...rest } = schema;
        schema = allOf.reduce((merged, part) => merge(merged, resolve(part, context, hops + 1)), rest);
    }
    const branches = schema.anyOf || schema.oneOf;
    if (Array.isArray(branches) && branches.length) {
        const { anyOf, oneOf, ...rest } = schema;
        const resolved = branches.map(branch => resolve(branch, context, hops + 1));
        schema = merge(rest, resolved.find(branch => typeOf(branch) !== 'null') || resolved[0]);
    }
    return schema;
}

function lookup(ref, root) {
    if (!ref.startsWith('#')) return {};
    let target = root;
    for (const part of ref.slice(1).split('/').filter(Boolean)) {
        target = target?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return target && typeof target === 'object' ? target : {};
}

function merge(base, part) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(part)) {
        if (key === 'properties') merged.properties = { ...merged.properties, ...value };
        else if (key === 'required') merged.required = [...new Set([...(merged.required || []), ...value])];
        else if (!Object.hasOwn(merged, key)) merged[key] = value;
    }
    return merged;
}

function typeOf(prop) {
    const type = schemaType(prop);
    if (type) return type;
    if (prop.properties) return 'object';
    if (prop.items || prop.prefixItems) return 'array';
    if (Array.isArray(prop.enum) && prop.enum.length) {
        const first = prop.enum.find(option => option !== null);
        return first === undefined ? 'null' : Array.isArray(first) ? 'array' : typeof first;
    }
    return undefined;
}

const FORMAT_CHECKS = {
    email: /^[^\s@]+@[^\s@]+$/,
    'idn-email': /^[^\s@]+@[^\s@]+$/,
    uri: /^[a-z][a-z\d+.-]*:\S*$/i,
    url: /^[a-z][a-z\d+.-]*:\S*$/i,
    date: /^\d{4}-\d{2}-\d{2}$/,
    'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i,
    uuid: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
};

// The checks a primitive value can fail on its own: enum, const, length, pattern, the common
// formats, range, multipleOf and whole numbers.
function fits(value, prop) {
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return false;
    if (Object.hasOwn(prop, 'const') && prop.const !== value) return false;
    if (typeof value === 'string') {
        const length = [...value].length;
        if (typeof prop.minLength === 'number' && length < prop.minLength) return false;
        if (typeof prop.maxLength === 'number' && length > prop.maxLength) return false;
        if (typeof prop.pattern === 'string' && !matches(value, prop.pattern)) return false;
        if (Object.hasOwn(FORMAT_CHECKS, prop.format) && !FORMAT_CHECKS[prop.format].test(value)) return false;
    }
    if (typeof value === 'number') {
        if (typeof prop.minimum === 'number' && (prop.exclusiveMinimum === true ? value <= prop.minimum : value < prop.minimum)) return false;
        if (typeof prop.exclusiveMinimum === 'number' && value <= prop.exclusiveMinimum) return false;
        if (typeof prop.maximum === 'number' && (prop.exclusiveMaximum === true ? value >= prop.maximum : value > prop.maximum)) return false;
        if (typeof prop.exclusiveMaximum === 'number' && value >= prop.exclusiveMaximum) return false;
        if (prop.multipleOf && !Number.isInteger(Number((value / prop.multipleOf).toFixed(8)))) return false;
        if (typeOf(prop) === 'integer' && !Number.isInteger(value)) return false;
    }
    return true;
}

function matches(value, pattern) {
    for (const flags of ['u', '']) {
        try {
            return new RegExp(pattern, flags).test(value);
        } catch {
            // Try again without the u flag, then give up.
        }
    }
    return false;
}
