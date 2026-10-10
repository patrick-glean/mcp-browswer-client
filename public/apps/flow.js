// An app's flow: rules that say, in order, when something happens on the screen, which tool to
// call with what, and where on the screen its answer goes. Values move with {{name}}: in a call's
// arguments, {{question}} is what the screen's `question` element holds; in what a rule shows,
// {{text}} is the text the tool returned (and {{structured.…}}, {{json.…}}, {{html}}, {{result.…}},
// {{error}}). An element of a part (HTML a model or a tool made) is named part.element, as
// {{dashboard.search}}.
//
// A rule: { id, when: [trigger], call: { serverUrl, toolName, args }, then: [route], position?,
//           prompt?, instructions?, tools? }
// A trigger: { element, event }; any of a rule's triggers starts it.
// A route: { if: 'sent' | 'ok' | 'error', show, into, how: 'replace' | 'append' | 'html' }
// position: where the rule's tool sits on the canvas, { x, y }. prompt: the argument a model's
// prompt goes in, which instructions and, with tools, your servers' tools are added to (agent.js).
// Pure functions, shared by the builder, the runner and the tests.

import { resolveArguments, variablesIn } from '../workbench/template.js';
import { answerText } from './agent.js';

// What a rule can wait for. `open` belongs to the app itself, so its element is ''.
export const EVENTS = {
    click: 'is clicked',
    enter: 'gets Enter',
    change: 'changes',
    open: 'opens',
};

// Which events each kind of element has. Any element can be clicked; only fields take Enter.
export const EVENTS_BY_KIND = {
    button: ['click'],
    input: ['enter', 'change'],
    output: ['click'],
    static: ['click'],
};

export const ROUTE_HOW = {
    replace: 'replacing what it shows',
    append: 'after what it shows',
    html: 'as HTML',
};

// The names a tool's answer brings to a rule's routes, so no element may use them as its id.
export const ANSWER_NAMES = ['text', 'structured', 'json', 'html', 'result', 'error'];

const PLACEHOLDERS = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
export const ELEMENT_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class FlowError extends Error {}

export const uid = prefix => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export const trigger = (element, event) => ({ element: event === 'open' ? '' : element, event });

// What an element's wire to a tool's Run waits for, unless you choose another of its events.
export const defaultEvent = kind => (EVENTS_BY_KIND[kind] || EVENTS_BY_KIND.static)[0];

// What a route shows when nothing changes the answer on its way. A route "as it's sent" runs
// before there's an answer, with the screen's values: a chat puts the message in its
// conversation that way, and clears the field it was typed in.
export const DEFAULT_SHOW = { ok: '{{text}}', error: '{{error}}', sent: '' };

// When a route runs, as its sentence says it.
export const ROUTE_WHEN = { sent: "as it's sent", ok: 'if it works', error: 'if it fails' };
export const routeWhen = route => (Object.hasOwn(ROUTE_WHEN, route?.if) ? route.if : 'ok');

// A rule's triggers. Rules saved before a rule could have several keep their one as an object.
export function triggersOf(rule) {
    const when = rule?.when;
    const list = Array.isArray(when) ? when : when ? [when] : [];
    return list.filter(candidate => candidate && (candidate.event === 'open' || candidate.element));
}

// A rule as the builder keeps it, whatever shape it was saved in.
export const normalizeRule = rule => ({ ...rule, when: triggersOf(rule), then: rule.then || [] });

// A rule with a trigger, a call and both routes; without an element (and not on open) it waits
// for nothing yet, and `into: null` leaves the routes out. `prompt` names the call's field that
// also asks for what the boxes the rule fills need (boxes.js).
export function newRule({ element = '', event = 'click', serverUrl = '', toolName = '', args = {}, into = '', position = null, prompt = null } = {}) {
    return {
        id: uid('rule'),
        when: element || event === 'open' ? [trigger(element, event)] : [],
        call: { serverUrl, toolName, args },
        then: into === null ? [] : [
            { if: 'ok', show: DEFAULT_SHOW.ok, into, how: 'replace' },
            { if: 'error', show: DEFAULT_SHOW.error, into, how: 'replace' },
        ],
        ...(position ? { position } : {}),
        ...(prompt ? { prompt } : {}),
    };
}

// The CallToolResult inside a worker's tool_result (older workers wrapped it once more).
export function toolResult(result) {
    if (!result || typeof result !== 'object') return null;
    if (Array.isArray(result.content) || 'structuredContent' in result || 'isError' in result) return result;
    return result.result && typeof result.result === 'object' ? result.result : result;
}

export function resultText(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    return content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
}

// Models break lines inside JSON strings, which JSON doesn't allow (Glean's chat does, around its
// citations): escapes the control characters inside strings, so the JSON reads as meant.
function escapedInStrings(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const char of text) {
        if (!inString) {
            if (char === '"') inString = true;
            out += char;
        } else if (escaped) {
            escaped = false;
            out += char;
        } else if (char === '\\') {
            escaped = true;
            out += char;
        } else if (char === '"') {
            inString = false;
            out += char;
        } else if (char < ' ') {
            out += { '\n': '\\n', '\r': '\\r', '\t': '\\t' }[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
            out += char;
        }
    }
    return out;
}

function parsedJson(text) {
    const trimmed = String(text ?? '').trim();
    if (!/^[[{]/.test(trimmed)) return null;
    for (const candidate of [trimmed, escapedInStrings(trimmed)]) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Not JSON read this way.
        }
    }
    return null;
}

// The JSON in a tool's text: all of it, or the first ```json (or bare ```) block that parses, as
// a model writes it, whatever is around it (Glean's chat adds the conversation's details after).
export function jsonIn(text) {
    const whole = parsedJson(text);
    if (whole !== null) return whole;
    for (const match of String(text ?? '').matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
        const found = parsedJson(match[1]);
        if (found !== null) return found;
    }
    return null;
}

// The HTML in a tool's answer: an embedded text/html resource, structuredContent.html, or text that
// is HTML (in a ```html block or on its own, as models write it). Null when there's none.
export function htmlFromResult(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    for (const item of content) {
        const resource = item?.type === 'resource' ? item.resource : null;
        if (typeof resource?.text === 'string' && /^text\/html\b/i.test(resource.mimeType || '')) return resource.text;
    }
    if (typeof result?.structuredContent?.html === 'string') return result.structuredContent.html;
    const text = resultText(result);
    const fenced = text.match(/```(?:html)?[ \t]*\r?\n([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();
    return /<(!doctype\s+html|html|head|body|main|section|article|div|form|input|textarea|button|h[1-6]|p)\b/i.test(candidate) ? candidate : null;
}

// What a call's answer gives its routes: whether it worked, and the values {{…}} can name. A
// result the tool marked isError counts as failing, with its text as the error.
export function answerOf(message) {
    const result = toolResult(message?.result);
    const text = answerText(resultText(result));
    let error = '';
    if (message?.error) error = String(message.error);
    else if (!result) error = 'The tool sent back nothing.';
    else if (result.resultType === 'input_required') error = "The tool asked for more input, which apps can't give it yet.";
    else if (result.isError) error = text || 'The tool reported an error.';
    return {
        ok: !error,
        values: { text, structured: result?.structuredContent ?? null, json: jsonIn(text), html: htmlFromResult(result) ?? '', result, error },
    };
}

// A value at a path: `json.items.0.title` walks objects by key and arrays by index. A name that is
// a key as it is, as a part's element `dashboard.search`, is that value.
export function valueAt(values, path) {
    if (values && typeof values === 'object' && Object.hasOwn(values, path)) return values[path];
    let value = values;
    for (const key of path.split('.')) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
    }
    return value;
}

export function displayValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

// What a route shows: its template with every {{name}} filled in. Names with no value become ''
// and are listed in `missing`, so the run can say so.
export function renderTemplate(template, values) {
    const missing = [];
    const text = String(template ?? '').replace(PLACEHOLDERS, (match, name) => {
        const value = valueAt(values, name);
        if (value === undefined) missing.push(name);
        return displayValue(value);
    });
    return { text, missing };
}

// What a route gives a box: the value itself when the template is one {{name}} (a list stays a
// list), else the template's text.
export function templateValue(template, values) {
    const single = String(template ?? '').match(/^\s*\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}\s*$/);
    return single ? valueAt(values, single[1]) : renderTemplate(template, values).text;
}

// The arguments a call sends. {{name}} is the screen's value for the element with that id, else a
// variable in the active environment; a field that is exactly one {{name}} gets the value in the
// field's type, as in the Workbench. Throws a FlowError naming what's missing.
export function callArguments(call, { screen = {}, variables = {}, environmentName = 'this environment', schema = null } = {}) {
    const names = [...variablesIn(call?.args || {})];
    const missing = names.filter(name => !Object.hasOwn(screen, name) && !Object.hasOwn(variables, name));
    if (missing.length) {
        const list = missing.map(name => `{{${name}}}`).join(', ');
        throw new FlowError(`${list} ${missing.length === 1 ? "isn't an element on the screen or a variable" : "aren't elements on the screen or variables"} in ${environmentName}.`);
    }
    try {
        const sentArgs = resolveArguments(call?.args || {}, { ...variables, ...screen }, schema);
        return { sentArgs, variablesUsed: names.filter(name => !Object.hasOwn(screen, name)) };
    } catch (error) {
        throw new FlowError(error.message);
    }
}

// The elements a rule's call reads from the screen.
export function screenNamesIn(rule, elementIds) {
    const ids = new Set(elementIds);
    const names = new Set();
    for (const name of variablesIn(rule?.call?.args || {})) if (ids.has(name)) names.add(name);
    for (const route of rule?.then || []) {
        for (const match of String(route.show ?? '').matchAll(PLACEHOLDERS)) {
            const first = match[1].split('.')[0];
            if (ids.has(first) && !ANSWER_NAMES.includes(first)) names.add(first);
        }
    }
    return [...names];
}

// What the screen's runtime should report: the events rules wait for, and the elements whose
// values their calls and routes use.
export function frameConfig(flow, elementIds) {
    const watch = [];
    const read = new Set();
    for (const rule of flow || []) {
        for (const { element, event } of triggersOf(rule)) if (event !== 'open') watch.push({ element, event });
        for (const name of screenNamesIn(rule, elementIds)) read.add(name);
    }
    return { watch, read: [...read], track: [...elementIds] };
}

// Which of a rule's triggers this is, or -1.
export const triggerIndex = (rule, element, event) => triggersOf(rule)
    .findIndex(candidate => candidate.event === event && (event === 'open' || candidate.element === element));

export function rulesFor(flow, element, event) {
    return (flow || []).filter(rule => triggerIndex(rule, element, event) >= 0);
}

function replaceName(text, from, to) {
    return text.replace(PLACEHOLDERS, (match, name) => {
        const [first, ...rest] = name.split('.');
        return first === from ? `{{${[to, ...rest].join('.')}}}` : match;
    });
}

function renameInValue(value, from, to) {
    if (typeof value === 'string') return replaceName(value, from, to);
    if (Array.isArray(value)) return value.map(item => renameInValue(item, from, to));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameInValue(item, from, to)]));
    return value;
}

// The key a box's piece of an answer goes under, {{json.key}}: its id, a part's dots as underscores.
export const answerKey = id => String(id ?? '').replace(/[^\w-]/g, '_');

const JSON_KEYS = /\{\{\s*json\.([A-Za-z_][\w-]*)\s*\}\}/g;

// The flow after an element's id changed: rules that wait for it, read it or show things in it
// follow it to its new name, and so do the elements of a part (from.x becomes to.x) and the key
// of the answer a box takes ({{json.from}} becomes {{json.to}}).
export function renameInFlow(flow, from, to) {
    const renamed = id => (id === from ? to : String(id ?? '').startsWith(`${from}.`) ? `${to}${id.slice(from.length)}` : id);
    return (flow || []).map(rule => ({
        ...rule,
        when: triggersOf(rule).map(candidate => ({ ...candidate, element: renamed(candidate.element) })),
        call: { ...rule.call, args: renameInValue(rule.call?.args || {}, from, to) },
        then: (rule.then || []).map(route => {
            const into = renamed(route.into);
            let show = ANSWER_NAMES.includes(from) ? String(route.show ?? '') : replaceName(String(route.show ?? ''), from, to);
            if (into !== route.into) show = show.replace(JSON_KEYS, (match, key) => (key === answerKey(route.into) ? `{{json.${answerKey(into)}}}` : match));
            return { ...route, into, show };
        }),
    }));
}

// Why an id can't name an element, or null when it can.
export function elementIdProblem(id, takenIds = []) {
    if (!id) return 'Give it an id.';
    if (!ELEMENT_ID.test(id)) return 'An id starts with a letter or _, then letters, digits, _ or -.';
    if (ANSWER_NAMES.includes(id)) return `{{${id}}} is what a tool's answer brings to a rule, so pick another id.`;
    if (takenIds.includes(id)) return `Another element is already ${id}.`;
    return null;
}

// What's wrong with each rule, for its card: [ruleId, [problem]].
export function flowProblems(flow, { elements = [], servers = {} } = {}) {
    const ids = new Set(elements.map(element => element.id));
    return (flow || []).map(rule => {
        const problems = [];
        const triggers = triggersOf(rule);
        if (!triggers.length) problems.push('Nothing starts it yet: choose what it waits for.');
        for (const { element, event } of triggers) if (event !== 'open' && !ids.has(element)) problems.push(`${element} isn't on the screen.`);
        const { serverUrl, toolName } = rule.call || {};
        if (!serverUrl) problems.push('Choose a server.');
        else if (!servers[serverUrl]) problems.push(`${serverUrl} isn't in your servers. Add it to run this rule.`);
        if (serverUrl && !toolName) problems.push('Choose a tool.');
        else if (servers[serverUrl]?.tools?.length && !servers[serverUrl].tools.some(tool => tool.name === toolName)) {
            problems.push(`${toolName} isn't one of this server's tools.`);
        }
        const found = (servers[serverUrl]?.tools || []).find(tool => tool.name === toolName);
        const schema = found?.inputSchema || found?.input_schema;
        if (rule.prompt && schema?.properties && !Object.hasOwn(schema.properties, rule.prompt)) {
            problems.push(`${toolName} has no field ${rule.prompt} for its prompt.`);
        }
        if (!rule.prompt && (rule.tools || String(rule.instructions ?? '').trim())) {
            problems.push('Choose the field its prompt goes in: its instructions and the tools go there.');
        }
        for (const route of rule.then || []) {
            if (!route.into) problems.push('Choose where the answer goes.');
            else if (!ids.has(route.into)) problems.push(`${route.into} isn't on the screen.`);
        }
        return [rule.id, [...new Set(problems)]];
    });
}

// Words in a list: a, b and c.
export const listed = items => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Text in a sentence: a lone {{name}} as it is, anything else in quotes.
const quoted = text => (/^\{\{\s*[A-Za-z_][\w.-]*\s*\}\}$/.test(text) ? text : `“${text}”`);

// What a rule adds to its prompt field, in its sentence: its instructions, the tools its model
// may call, and the request of the boxes it fills ({{json.…}}).
function promptAdded(rule) {
    if (!rule.prompt) return '';
    const parts = [
        String(rule.instructions ?? '').trim() && 'its instructions',
        rule.tools && "your servers' tools",
        (rule.then || []).some(route => /^\s*\{\{\s*json\./.test(String(route.show ?? ''))) && 'what its boxes show',
    ].filter(Boolean);
    return parts.length ? `, adding to ${rule.prompt} ${listed(parts)}` : `, asking in ${rule.prompt}`;
}

// A rule as a sentence, for people reading the app: the zip's README and the builder.
export function describeRule(rule, { elementName = id => id, serverName = url => url } = {}) {
    const triggers = triggersOf(rule).map(({ element, event }) => (event === 'open' ? 'the app opens' : `${elementName(element)} ${EVENTS[event] || event}`));
    const when = triggers.length ? `When ${triggers.join(' or ')}` : 'Once something starts it';
    const args = Object.entries(rule.call?.args || {}).map(([key, value]) => `${key} = ${typeof value === 'string' ? quoted(value) : JSON.stringify(value)}`);
    const call = `call ${rule.call?.toolName || '(no tool)'} on ${serverName(rule.call?.serverUrl)}${args.length ? ` with ${args.join(', ')}` : ''}${promptAdded(rule)}`;
    const routes = (rule.then || []).map(route => `${ROUTE_WHEN[routeWhen(route)]}, put ${route.show === '' ? 'nothing (clearing it)' : quoted(route.show)} into ${elementName(route.into)}${route.how && route.how !== 'replace' ? ` ${ROUTE_HOW[route.how]}` : ''}`);
    return `${when}, ${call}${routes.length ? `; ${routes.join('; ')}` : ''}.`;
}

// A value's path by its last name (structured.counted is counted), keeping the name before an
// index (json.items.0 is items.0).
const shortPath = path => {
    const names = path.split('.');
    return names.length > 1 && /^\d+$/.test(names.at(-1)) ? names.slice(-2).join('.') : names.at(-1);
};

// What a route's transform shows, as the canvas labels its wire: the one value it takes, or the
// start of its template with values in braces, in at most `max` characters.
export function routeSummary(route, { max = 12 } = {}) {
    const show = String(route?.show ?? '');
    if (!show) return 'nothing';
    const single = show.match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
    if (single) return shortPath(single[1]);
    const compact = show.replace(PLACEHOLDERS, (match, path) => `{${shortPath(path)}}`).replace(/\s+/g, ' ').trim();
    return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export const isDefaultShow = route => String(route?.show ?? '') === DEFAULT_SHOW[routeWhen(route)];
