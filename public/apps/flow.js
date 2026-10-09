// An app's flow: rules that say, in order, when something happens on the screen, which tool to
// call with what, and where on the screen its answer goes. Values move with {{name}}: in a call's
// arguments, {{question}} is what the screen's `question` element holds; in what a rule shows,
// {{text}} is the text the tool returned (and {{structured.…}}, {{json.…}}, {{result.…}}, {{error}}).
//
// A rule: { id, when: { element, event }, call: { serverUrl, toolName, args }, then: [route] }
// A route: { if: 'ok' | 'error', show, into, how: 'replace' | 'append' | 'html' }
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
export const ANSWER_NAMES = ['text', 'structured', 'json', 'result', 'error'];

const PLACEHOLDERS = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
export const ELEMENT_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class FlowError extends Error {}

export const uid = prefix => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export function newRule({ element = '', event = 'click', serverUrl = '', toolName = '', args = {}, into = '' } = {}) {
    return {
        id: uid('rule'),
        when: { element: event === 'open' ? '' : element, event },
        call: { serverUrl, toolName, args },
        then: [
            { if: 'ok', show: '{{text}}', into, how: 'replace' },
            { if: 'error', show: '{{error}}', into, how: 'replace' },
        ],
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
        values: { text, structured: result?.structuredContent ?? null, json: parsedJson(text), result, error },
    };
}

// A value at a path: `json.items.0.title` walks objects by key and arrays by index.
export function valueAt(values, path) {
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
        if (rule.when?.event && rule.when.event !== 'open' && rule.when.element) watch.push({ element: rule.when.element, event: rule.when.event });
        for (const name of screenNamesIn(rule, elementIds)) read.add(name);
    }
    return { watch, read: [...read] };
}

export function rulesFor(flow, element, event) {
    return (flow || []).filter(rule => rule.when?.event === event && (event === 'open' || rule.when.element === element));
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
// follow it to its new name.
export function renameInFlow(flow, from, to) {
    return (flow || []).map(rule => ({
        ...rule,
        when: { ...rule.when, element: rule.when?.element === from ? to : rule.when?.element },
        call: { ...rule.call, args: renameInValue(rule.call?.args || {}, from, to) },
        then: (rule.then || []).map(route => ({
            ...route,
            into: route.into === from ? to : route.into,
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
        const { element, event } = rule.when || {};
        if (event !== 'open' && !element) problems.push('Choose what it waits for.');
        else if (event !== 'open' && !ids.has(element)) problems.push(`${element} isn't on the screen.`);
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
    const { element, event } = rule.when || {};
    const when = event === 'open' ? 'When the app opens' : `When ${elementName(element)} ${EVENTS[event] || event}`;
    const args = Object.entries(rule.call?.args || {}).map(([key, value]) => `${key} = ${typeof value === 'string' ? quoted(value) : JSON.stringify(value)}`);
    const call = `call ${rule.call?.toolName || '(no tool)'} on ${serverName(rule.call?.serverUrl)}${args.length ? ` with ${args.join(', ')}` : ''}`;
    const routes = (rule.then || []).map(route => `${route.if === 'error' ? 'if it fails' : 'if it works'}, put ${route.show === '' ? 'nothing (clearing it)' : quoted(route.show)} into ${elementName(route.into)}${route.how && route.how !== 'replace' ? ` ${ROUTE_HOW[route.how]}` : ''}`);
    return `${when}, ${call}${routes.length ? `; ${routes.join('; ')}` : ''}.`;
}
