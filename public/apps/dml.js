// DML: an app written down as markup, so it can be downloaded, read, kept in version control and
// imported again. app.dml holds the screen (its components, or where its HTML is) and the flow:
//
//   <app dml="1" id="…" name="Ask the docs" version="3">
//     <screen src="index.html" built-from="components">
//       <textbox id="question" label="Question"/>
//       <button id="ask" label="Ask"/>
//       <output id="answer" label="Answer"/>
//     </screen>
//     <flow>
//       <when element="ask" event="click" x="660" y="96">
//         <or element="question" event="enter"/>
//         <call server="https://…/mcp" tool="search"><arg name="query">{{question}}</arg></call>
//         <then if="ok" into="answer">{{text}}</then>
//         <then if="error" into="answer">{{error}}</then>
//       </when>
//     </flow>
//
// A <when> names its first trigger, and <or> each other one; x and y are where its tool sits on
// the canvas.
//   </app>
//
// It's XML, read and written here without a DOM, so the worker and Node can use it too.

import { EVENTS, ROUTE_HOW, trigger, triggersOf, uid } from './flow.js';
import { COMPONENT_TYPES } from './screen.js';

export const DML_VERSION = 1;

export class DmlError extends Error {}

// --- Writing ---

const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// Markup inside markup reads best as it is, in CDATA; a CDATA section can't hold ]]> or keep a
// carriage return, so those are split across sections or escaped.
const cdataText = value => (String(value).includes('\r')
    ? escapeText(value)
    : `<![CDATA[${String(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`);

const isText = child => typeof child === 'string' || typeof child?.cdata === 'string';

// A node is [name, attributes, ...children], where a child is a node, text, or { cdata } for text
// written as CDATA. Attributes that are undefined or null are left out.
function writeNode([name, attributes = {}, ...children], depth = 0) {
    const pad = '  '.repeat(depth);
    const attrs = Object.entries(attributes)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
        .join('');
    if (!children.length) return `${pad}<${name}${attrs}/>`;
    if (children.every(isText)) {
        return `${pad}<${name}${attrs}>${children.map(child => (typeof child === 'string' ? escapeText(child) : cdataText(child.cdata))).join('')}</${name}>`;
    }
    return `${pad}<${name}${attrs}>\n${children.map(child => writeNode(child, depth + 1)).join('\n')}\n${pad}</${name}>`;
}

const orUndefined = value => (value === '' || value === null || value === undefined ? undefined : value);

function callNode(name, call) {
    const args = Object.entries(call?.args || {}).map(([key, value]) => (typeof value === 'string'
        ? ['arg', { name: key }, value]
        : ['arg', { name: key, type: 'json' }, JSON.stringify(value)]));
    return [name, { server: call?.serverUrl || '', tool: call?.toolName || '' }, ...args];
}

// Where a part's HTML goes in a zip.
export const partFile = id => `parts/${id}.html`;

function componentNode(component, { standalone }) {
    const { id, type } = component;
    switch (type) {
        case 'title':
        case 'text':
            return [type, { id }, component.text ?? ''];
        case 'textbox':
            return ['textbox', {
                id,
                label: component.label ?? '',
                placeholder: orUndefined(component.placeholder),
                lines: Number(component.lines) > 1 ? Number(component.lines) : undefined,
                value: orUndefined(component.value),
            }];
        case 'button':
            return ['button', { id, label: component.label ?? '' }];
        case 'output':
            return ['output', { id, label: component.label ?? '', placeholder: orUndefined(component.placeholder) }];
        case 'part':
            return ['part', { id, label: orUndefined(component.label), src: standalone ? undefined : partFile(id) },
                ...(component.ask ? [['ask', {}, component.ask]] : []),
                ...(component.from ? [callNode('from', component.from)] : []),
                ...(standalone ? [['html', {}, { cdata: component.html || '' }]] : [])];
        default:
            return [type, { id }];
    }
}

// Every server the app calls, for people reading it and for importing it somewhere new.
export function serversOf(app) {
    const parts = (app?.screen?.components || []).filter(component => component.type === 'part');
    const urls = [app?.screen?.from?.serverUrl, ...parts.map(part => part.from?.serverUrl), ...(app?.flow || []).map(rule => rule.call?.serverUrl)].filter(Boolean);
    return [...new Set(urls)];
}

const HEADER = `<!-- An app built in MCP Browser Client. <screen> is what people see and <flow> what happens
     when they use it: each <when> calls a tool, and its <then>s put the answer on the screen.
     {{question}} in a call is what the screen's question element holds; {{text}} in a <then> is
     the text the tool returned. Import the .zip, or this file, under Apps to run or change it. -->`;

// The app as DML. In a zip, the screen's HTML is index.html beside it; on its own (`standalone`),
// an HTML screen travels inside, in <html>.
export function toDml(app, { standalone = false, serverNames = {} } = {}) {
    const screen = app.screen || {};
    const src = standalone ? undefined : 'index.html';
    const screenNode = screen.kind === 'html'
        ? ['screen', { src },
            ...(screen.ask ? [['ask', {}, screen.ask]] : []),
            ...(screen.from ? [callNode('from', screen.from)] : []),
            ...(standalone ? [['html', {}, { cdata: screen.html || '' }]] : [])]
        : ['screen', { src, 'built-from': 'components' }, ...(screen.components || []).map(component => componentNode(component, { standalone }))];
    const servers = serversOf(app);
    const triggerAttributes = candidate => (candidate
        ? { element: candidate.event === 'open' ? undefined : candidate.element, event: candidate.event }
        : {});
    const flow = (app.flow || []).map(rule => [
        'when',
        {
            ...triggerAttributes(triggersOf(rule)[0]),
            x: rule.position ? Math.round(rule.position.x) : undefined,
            y: rule.position ? Math.round(rule.position.y) : undefined,
        },
        ...triggersOf(rule).slice(1).map(candidate => ['or', triggerAttributes(candidate)]),
        callNode('call', rule.call),
        ...(rule.then || []).map(route => ['then', {
            if: route.if === 'error' ? 'error' : 'ok',
            into: route.into || '',
            how: route.how && route.how !== 'replace' ? route.how : undefined,
        }, route.show ?? '']),
    ]);
    const root = ['app', { dml: DML_VERSION, id: app.id, name: app.name || 'App', version: app.version || undefined },
        ...(app.description ? [['description', {}, app.description]] : []),
        screenNode,
        ...(servers.length ? [['servers', {}, ...servers.map(url => ['server', { url, name: orUndefined(serverNames[url]) }])]] : []),
        ['flow', {}, ...flow],
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n${HEADER}\n${writeNode(root)}\n`;
}

// --- Reading ---

// Parses the XML DML is written in: elements, attributes, text, CDATA, comments and the XML
// declaration (no DOCTYPE, so no entities beyond XML's own). Nodes keep their offset (`at`), so
// errors can name a line.
export function parseXml(source) {
    const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let at = 0;
    const lineAt = index => text.slice(0, index).split('\n').length;
    const fail = (message, index = at) => {
        throw new DmlError(`Line ${lineAt(index)}: ${message}`);
    };
    const NAME = /[A-Za-z_][\w.:-]*/y;
    const readName = () => {
        NAME.lastIndex = at;
        const match = NAME.exec(text);
        if (!match) fail('Expected a name here.');
        at = NAME.lastIndex;
        return match[0];
    };
    const skipSpace = () => {
        while (at < text.length && /\s/.test(text[at])) at++;
    };
    const decode = (raw, offset) => raw.replace(/&([^;\s&<]*)(;?)/g, (match, ref, semicolon, index) => {
        if (!semicolon) fail('A & has to be written as &amp;.', offset + index);
        const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[ref];
        if (named) return named;
        const code = /^#x[0-9a-f]+$/i.test(ref) ? parseInt(ref.slice(2), 16) : /^#\d+$/.test(ref) ? Number(ref.slice(1)) : NaN;
        if (Number.isNaN(code)) fail(`&${ref}; isn't something XML knows; write &lt;, &gt;, &amp;, &quot;, &apos; or a number like &#10;.`, offset + index);
        try {
            return String.fromCodePoint(code);
        } catch {
            return fail(`&${ref}; isn't a character.`, offset + index);
        }
    });
    const skipUntil = (end, what) => {
        const found = text.indexOf(end, at);
        if (found < 0) fail(`${what} never ends with ${end}.`);
        at = found + end.length;
    };
    const skipMisc = () => {
        for (;;) {
            skipSpace();
            if (text.startsWith('<!--', at)) skipUntil('-->', 'A comment');
            else if (text.startsWith('<?', at)) skipUntil('?>', 'A <? instruction');
            else if (/^<!doctype/i.test(text.slice(at, at + 9))) fail("A DML file can't have a DOCTYPE.");
            else return;
        }
    };
    const parseElement = () => {
        const start = at;
        if (text[at] !== '<') fail('Expected an element here.');
        at++;
        const name = readName();
        const attrs = {};
        for (;;) {
            const before = at;
            skipSpace();
            if (text.startsWith('/>', at)) {
                at += 2;
                return { name, attrs, children: [], at: start };
            }
            if (text[at] === '>') {
                at++;
                break;
            }
            if (at >= text.length) fail(`<${name}> never ends with >.`, start);
            if (at === before) fail(`Expected a space, > or /> in <${name}>.`);
            const attributeStart = at;
            const key = readName();
            skipSpace();
            if (text[at] !== '=') fail(`${key} in <${name}> needs a value, as ${key}="…".`);
            at++;
            skipSpace();
            const quote = text[at];
            if (quote !== '"' && quote !== "'") fail(`The value of ${key} has to be in quotes.`);
            const end = text.indexOf(quote, at + 1);
            if (end < 0) fail(`The value of ${key} never ends.`, attributeStart);
            const raw = text.slice(at + 1, end);
            if (raw.includes('<')) fail(`The value of ${key} can't hold <; write &lt;.`, attributeStart);
            if (Object.hasOwn(attrs, key)) fail(`<${name}> has ${key} twice.`, attributeStart);
            attrs[key] = decode(raw.replace(/[\n\t]/g, ' '), at + 1);
            at = end + 1;
        }
        const children = [];
        for (;;) {
            if (at >= text.length) fail(`<${name}> is never closed with </${name}>.`, start);
            if (text.startsWith('</', at)) {
                const closeStart = at;
                at += 2;
                const closing = readName();
                skipSpace();
                if (text[at] !== '>') fail(`Expected > after </${closing}.`);
                at++;
                if (closing !== name) fail(`</${closing}> can't close <${name}> from line ${lineAt(start)}.`, closeStart);
                return { name, attrs, children, at: start };
            }
            if (text.startsWith('<!--', at)) {
                skipUntil('-->', 'A comment');
            } else if (text.startsWith('<![CDATA[', at)) {
                const end = text.indexOf(']]>', at);
                if (end < 0) fail('A <![CDATA[ section never ends with ]]>.');
                children.push(text.slice(at + 9, end));
                at = end + 3;
            } else if (text.startsWith('<?', at)) {
                skipUntil('?>', 'A <? instruction');
            } else if (text[at] === '<') {
                children.push(parseElement());
            } else {
                const end = text.indexOf('<', at);
                const stop = end < 0 ? text.length : end;
                children.push(decode(text.slice(at, stop), at));
                at = stop;
            }
        }
    };
    skipMisc();
    if (at >= text.length) fail('There is nothing in the file.');
    const root = parseElement();
    skipMisc();
    if (at < text.length) fail(`There is more after </${root.name}>.`);
    root.lineAt = lineAt;
    return root;
}

const elementsIn = (node, name) => node.children.filter(child => typeof child === 'object' && (!name || child.name === name));
const textIn = node => node.children.filter(child => typeof child === 'string').join('');

// An app from its DML: { app, servers }, where servers lists the ones it calls ({ url, name }).
// `files` are the other files of a zip by name, as text: an HTML screen's src is one of them.
// Throws a DmlError that names the line of what's wrong.
export function fromDml(source, { files = {} } = {}) {
    const root = parseXml(source);
    const fail = (node, message) => {
        throw new DmlError(`Line ${root.lineAt(node.at)}: ${message}`);
    };
    const one = (node, name, { required = true } = {}) => {
        const found = elementsIn(node, name);
        if (found.length > 1) fail(found[1], `<${node.name}> has more than one <${name}>.`);
        if (!found.length && required) fail(node, `<${node.name}> needs a <${name}>.`);
        return found[0] || null;
    };
    if (root.name !== 'app') fail(root, `A DML file starts with <app>, not <${root.name}>.`);
    const version = Number(root.attrs.dml);
    if (!Number.isInteger(version) || version < 1) fail(root, `<app> needs dml="${DML_VERSION}", the version of DML it's written in.`);
    if (version > DML_VERSION) fail(root, `This app is written in DML version ${version}, and this client reads version ${DML_VERSION}. Open it in a newer MCP Browser Client.`);

    const readCall = node => {
        if (!node.attrs.server) fail(node, `<${node.name}> needs server="…", the MCP server's URL.`);
        if (!node.attrs.tool) fail(node, `<${node.name}> needs tool="…", the tool's name.`);
        const args = {};
        for (const arg of elementsIn(node, 'arg')) {
            const name = arg.attrs.name;
            if (!name) fail(arg, '<arg> needs name="…".');
            if (Object.hasOwn(args, name)) fail(arg, `The call has ${name} twice.`);
            const value = textIn(arg);
            if (arg.attrs.type === 'json') {
                try {
                    args[name] = JSON.parse(value);
                } catch {
                    fail(arg, `${name} says type="json", but its value isn't JSON.`);
                }
            } else {
                args[name] = value;
            }
        }
        return { serverUrl: node.attrs.server, toolName: node.attrs.tool, args };
    };

    const screenNode = one(root, 'screen');
    let screen;
    if (screenNode.attrs['built-from'] === 'components') {
        const components = [];
        const ids = new Set();
        for (const node of elementsIn(screenNode)) {
            if (!COMPONENT_TYPES[node.name]) fail(node, `<${node.name}> isn't a component; a screen has ${Object.keys(COMPONENT_TYPES).map(type => `<${type}>`).join(', ')}.`);
            const id = node.attrs.id;
            if (!id) fail(node, `<${node.name}> needs id="…", the name the flow uses for it.`);
            if (ids.has(id)) fail(node, `Two components are ${id}; each needs its own id.`);
            ids.add(id);
            const attr = name => node.attrs[name] ?? '';
            const component = { id, type: node.name };
            if (node.name === 'title' || node.name === 'text') component.text = textIn(node);
            if (node.name === 'textbox') Object.assign(component, { label: attr('label'), placeholder: attr('placeholder'), lines: Math.max(1, Number(node.attrs.lines) || 1), value: attr('value') });
            if (node.name === 'button') component.label = attr('label');
            if (node.name === 'output') Object.assign(component, { label: attr('label'), placeholder: attr('placeholder') });
            if (node.name === 'part') {
                const inline = one(node, 'html', { required: false });
                const src = node.attrs.src;
                if (!inline && src && typeof files[src] !== 'string') fail(node, `The part ${id} is in ${src}, which isn't with this file. Import the .zip it came in.`);
                const from = one(node, 'from', { required: false });
                const ask = one(node, 'ask', { required: false });
                Object.assign(component, {
                    label: attr('label'),
                    html: inline ? textIn(inline) : src ? files[src] : '',
                    from: from ? readCall(from) : null,
                    ask: ask ? textIn(ask) : '',
                });
            }
            components.push(component);
        }
        screen = { kind: 'components', components };
    } else {
        const inline = one(screenNode, 'html', { required: false });
        const src = screenNode.attrs.src;
        const html = inline ? textIn(inline) : src ? files[src] : undefined;
        if (typeof html !== 'string') {
            fail(screenNode, src
                ? `The screen is in ${src}, which isn't with this file. Import the .zip it came in.`
                : '<screen> needs built-from="components", src="index.html" or an <html> inside it.');
        }
        const from = one(screenNode, 'from', { required: false });
        const ask = one(screenNode, 'ask', { required: false });
        screen = { kind: 'html', html, from: from ? readCall(from) : null, ask: ask ? textIn(ask) : '' };
    }

    // A trigger's attributes. A <when> may have none yet: nothing starts its rule.
    const readTrigger = (node, { optional = false } = {}) => {
        const { event, element } = node.attrs;
        if (optional && event === undefined && element === undefined) return null;
        if (!Object.hasOwn(EVENTS, event)) fail(node, `<${node.name}> needs event="…", one of ${Object.keys(EVENTS).join(', ')}.`);
        if (event !== 'open' && !element) fail(node, `<${node.name} event="${event}"> needs element="…", the id of what it waits for.`);
        return trigger(element, event);
    };
    const flow = [];
    for (const node of elementsIn(one(root, 'flow'), 'when')) {
        const when = [readTrigger(node, { optional: true }), ...elementsIn(node, 'or').map(or => readTrigger(or))].filter(Boolean);
        let position = null;
        if (node.attrs.x !== undefined || node.attrs.y !== undefined) {
            position = { x: Number(node.attrs.x), y: Number(node.attrs.y) };
            if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) fail(node, 'x and y are numbers together: where its tool sits on the canvas.');
        }
        const then = elementsIn(node, 'then').map(route => {
            const how = route.attrs.how || 'replace';
            if (!Object.hasOwn(ROUTE_HOW, how)) fail(route, `how="${how}" isn't one of ${Object.keys(ROUTE_HOW).join(', ')}.`);
            if (!['ok', 'error', undefined].includes(route.attrs.if)) fail(route, `if="${route.attrs.if}" has to be ok or error.`);
            if (!route.attrs.into) fail(route, '<then> needs into="…", the id of where the answer goes.');
            return { if: route.attrs.if === 'error' ? 'error' : 'ok', show: textIn(route), into: route.attrs.into, how };
        });
        flow.push({ id: uid('rule'), when, call: readCall(one(node, 'call')), then, ...(position ? { position } : {}) });
    }

    const servers = elementsIn(one(root, 'servers', { required: false }) || { children: [] }, 'server')
        .filter(server => server.attrs.url)
        .map(server => ({ url: server.attrs.url, name: server.attrs.name || '' }));
    const description = one(root, 'description', { required: false });
    const app = {
        id: root.attrs.id || null,
        name: root.attrs.name || 'Imported app',
        description: description ? textIn(description) : '',
        version: Math.max(0, Number(root.attrs.version) || 0),
        screen,
        flow,
    };
    return { app, servers };
}
