// An app's flow: rules that say, in order, when something happens on the screen, which tool to
// call with what, and where on the screen its answer goes. Values move with {{name}}: in a call's
// arguments, {{question}} is what the screen's `question` element holds; in what a rule shows,
// {{text}} is the text the tool returned (and {{structured.…}}, {{json.…}}, {{html}}, {{result.…}},
// {{error}}). An element of a part (HTML a model or a tool made) is named part.element, as
// {{dashboard.search}}.
//
// A rule: { id, when: [trigger], call: { serverUrl, toolName, args }, then: [route], position? }
// A trigger: { element, event }; any of a rule's triggers starts it.
// A route: { if: 'ok' | 'error', show, into, how: 'replace' | 'append' | 'html' }
// position: where the rule's tool sits on the canvas, { x, y }.
// Pure functions, shared by the builder, the runner and the tests.

import { resolveArguments, variablesIn } from '../workbench/template.js';

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

// What a route shows when nothing changes the answer on its way.
export const DEFAULT_SHOW = { ok: '{{text}}', error: '{{error}}' };

// A rule's triggers. Rules saved before a rule could have several keep their one as an object.
export function triggersOf(rule) {
    const when = rule?.when;
    const list = Array.isArray(when) ? when : when ? [when] : [];
    return list.filter(candidate => candidate && (candidate.event === 'open' || candidate.element));
}

// A rule as the builder keeps it, whatever shape it was saved in.
export const normalizeRule = rule => ({ ...rule, when: triggersOf(rule), then: rule.then || [] });

// A rule with a trigger, a call and both routes; without an element (and not on open) it waits
// for nothing yet, and `into: null` leaves the routes out.
export function newRule({ element = '', event = 'click', serverUrl = '', toolName = '', args = {}, into = '', position = null } = {}) {
    return {
        id: uid('rule'),
        when: element || event === 'open' ? [trigger(element, event)] : [],
        call: { serverUrl, toolName, args },
        then: into === null ? [] : [
            { if: 'ok', show: DEFAULT_SHOW.ok, into, how: 'replace' },
            { if: 'error', show: DEFAULT_SHOW.error, into, how: 'replace' },
        ],
        ...(position ? { position } : {}),
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

function parsedJson(text) {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
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
    const text = resultText(result);
    let error = '';
    if (message?.error) error = String(message.error);
    else if (!result) error = 'The tool sent back nothing.';
    else if (result.resultType === 'input_required') error = "The tool asked for more input, which apps can't give it yet.";
    else if (result.isError) error = text || 'The tool reported an error.';
    return {
        ok: !error,
        values: { text, structured: result?.structuredContent ?? null, json: parsedJson(text), html: htmlFromResult(result) ?? '', result, error },
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

// The flow after an element's id changed: rules that wait for it, read it or show things in it
// follow it to its new name, and so do the elements of a part (from.x becomes to.x).
export function renameInFlow(flow, from, to) {
    const renamed = id => (id === from ? to : String(id ?? '').startsWith(`${from}.`) ? `${to}${id.slice(from.length)}` : id);
    return (flow || []).map(rule => ({
        ...rule,
        when: triggersOf(rule).map(candidate => ({ ...candidate, element: renamed(candidate.element) })),
        call: { ...rule.call, args: renameInValue(rule.call?.args || {}, from, to) },
        then: (rule.then || []).map(route => ({
            ...route,
            into: renamed(route.into),
            show: ANSWER_NAMES.includes(from) ? route.show : replaceName(String(route.show ?? ''), from, to),
        })),
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
        for (const route of rule.then || []) {
            if (!route.into) problems.push('Choose where the answer goes.');
            else if (!ids.has(route.into)) problems.push(`${route.into} isn't on the screen.`);
        }
        return [rule.id, [...new Set(problems)]];
    });
}

// Text in a sentence: a lone {{name}} as it is, anything else in quotes.
const quoted = text => (/^\{\{\s*[A-Za-z_][\w.-]*\s*\}\}$/.test(text) ? text : `“${text}”`);

// A rule as a sentence, for people reading the app: the zip's README and the builder.
export function describeRule(rule, { elementName = id => id, serverName = url => url } = {}) {
    const triggers = triggersOf(rule).map(({ element, event }) => (event === 'open' ? 'the app opens' : `${elementName(element)} ${EVENTS[event] || event}`));
    const when = triggers.length ? `When ${triggers.join(' or ')}` : 'Once something starts it';
    const args = Object.entries(rule.call?.args || {}).map(([key, value]) => `${key} = ${typeof value === 'string' ? quoted(value) : JSON.stringify(value)}`);
    const call = `call ${rule.call?.toolName || '(no tool)'} on ${serverName(rule.call?.serverUrl)}${args.length ? ` with ${args.join(', ')}` : ''}`;
    const routes = (rule.then || []).map(route => `${route.if === 'error' ? 'if it fails' : 'if it works'}, put ${route.show === '' ? 'nothing (clearing it)' : quoted(route.show)} into ${elementName(route.into)}${route.how && route.how !== 'replace' ? ` ${ROUTE_HOW[route.how]}` : ''}`);
    return `${when}, ${call}${routes.length ? `; ${routes.join('; ')}` : ''}.`;
}

// What a route's transform shows on the canvas: the one value it takes, or the start of its template.
export function routeSummary(route) {
    const show = String(route?.show ?? '');
    if (!show) return 'nothing';
    const single = show.match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
    if (single) return single[1];
    return show.length > 22 ? `${show.slice(0, 21)}…` : show;
}

export const isDefaultShow = route => String(route?.show ?? '') === (route?.if === 'error' ? DEFAULT_SHOW.error : DEFAULT_SHOW.ok);
