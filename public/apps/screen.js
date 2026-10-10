// An app's screen: what people see. Either built here from components (a title, text, text boxes,
// buttons, outputs, and parts a model or a tool makes, each with an id the flow names it by) or an
// HTML document, such as one a tool call made, whose elements with ids the flow names the same way.
//
// screen: { kind: 'components', components: [component] } or { kind: 'html', html, from, ask }
// where `from` is the call that made the HTML, { serverUrl, toolName, args }, if one did, and `ask`
// what a model was asked for when one made it.
//
// A part ({ type: 'part', html, from, ask }) is HTML a model or a tool returned, such as a
// dashboard, kept without its scripts. On the screen its ids get the part's id in front (`refresh` in the part
// `dashboard` is `dashboard.refresh`) and its styles reach only inside it, so parts can't clash;
// the flow takes over its buttons and fields by those ids.

import { escapeHtml } from '../workbench/util.js';
import { BOX_KINDS, WIDTHS } from './boxes.js';
import { elementIdProblem, htmlFromResult } from './flow.js';

export { htmlFromResult };

export const COMPONENT_TYPES = {
    title: { label: 'Title', kind: 'static', base: 'title' },
    text: { label: 'Text', kind: 'static', base: 'note' },
    textbox: { label: 'Text box', kind: 'input', base: 'input' },
    button: { label: 'Button', kind: 'button', base: 'button' },
    output: { label: 'Output', kind: 'output', base: 'output' },
    part: { label: 'HTML part', kind: 'output', base: 'part' },
};

export const ELEMENT_KINDS = { button: 'Button', input: 'Field', output: 'Output', static: 'Text' };

const WIDTH_PROP = ['width', 'Width', 'select', WIDTHS];
const SHOW_OPTIONS = Object.fromEntries(Object.entries(BOX_KINDS).map(([kind, { label }]) => [kind, label]));

// What each component lets you set, in order: [prop, label, kind of field, options of a select].
// An output's `show` and `about` make it a box: what it shows, and what goes in it, in words.
export const COMPONENT_PROPS = {
    title: [['text', 'Text', 'text']],
    text: [['text', 'Text', 'lines'], WIDTH_PROP],
    textbox: [['label', 'Label', 'text'], ['placeholder', 'Placeholder', 'text'], ['lines', 'Lines', 'number'], WIDTH_PROP],
    button: [['label', 'Label', 'text'], WIDTH_PROP],
    output: [['label', 'Label', 'text'], ['show', 'Shows', 'select', SHOW_OPTIONS], ['about', 'What goes here', 'lines'], ['placeholder', 'When empty', 'text'], WIDTH_PROP],
    part: [['label', 'Label', 'text'], WIDTH_PROP],
};

const DEFAULTS = {
    title: { text: 'Title' },
    text: { text: 'Some text.' },
    textbox: { label: 'Text box', placeholder: '', lines: 1, value: '' },
    button: { label: 'Button' },
    output: { label: 'Output', placeholder: 'What the tool returns shows here.', show: 'text', about: '' },
    part: { label: 'Part', html: '', from: null, ask: '' },
};

// The first free id for a new component: input, input2, input3…
export function freeId(base, takenIds) {
    const taken = new Set(takenIds);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

// A second one of a kind is numbered as its id is (output2 is "Output 2"), so menus that show
// labels can tell them apart.
export function newComponent(type, takenIds = [], props = {}) {
    const { base } = COMPONENT_TYPES[type];
    const id = props.id && !elementIdProblem(props.id, takenIds) ? props.id : freeId(base, takenIds);
    const number = id.startsWith(base) ? id.slice(base.length) : '';
    const numbered = DEFAULTS[type].label && props.label === undefined && /^\d+$/.test(number) ? { label: `${DEFAULTS[type].label} ${number}` } : {};
    return { ...DEFAULTS[type], ...numbered, ...props, id, type };
}

// What the builder calls an element: its label, its text, or its id.
export function componentName(component) {
    const text = String(component.label || component.text || '').trim().split('\n')[0];
    return text.length > 40 ? `${text.slice(0, 39)}…` : text || component.id;
}

export function elementsOfComponents(components = []) {
    return components.flatMap(component => [{
        id: component.id,
        kind: COMPONENT_TYPES[component.type]?.kind || 'static',
        type: component.type,
        label: componentName(component),
        width: WIDTHS[component.width] ? component.width : 'full',
        ...(component.type === 'output' ? { show: BOX_KINDS[component.show] ? component.show : 'text', about: component.about || '' } : {}),
    }, ...(component.type === 'part' ? partElements(component) : [])]);
}

const kindOfTag = (tag, type = '') => (tag === 'button' || tag === 'a' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type.toLowerCase())) ? 'button'
    : ['input', 'textarea', 'select'].includes(tag) ? 'input'
    : /^h[1-6]$|^label$/.test(tag) ? 'static'
    : 'output');

const shortLabel = text => {
    const line = String(text ?? '').trim().replace(/\s+/g, ' ');
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

// Start tags and their attributes, in HTML as a browser writes it out (values in double quotes).
const START_TAG = /<([a-z][a-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)(\s*\/?)>/gi;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const textOf = html => decode(html.replace(/<[^>]*>/g, ' '));

function attributesOf(text) {
    const attributes = {};
    for (const [, key, double, single, bare] of text.matchAll(ATTRIBUTE)) attributes[key.toLowerCase()] = decode(double ?? single ?? bare ?? '');
    return attributes;
}

// A part's HTML without its <style> elements, and their CSS.
function splitStyles(html) {
    const css = [...String(html ?? '').matchAll(STYLE)].map(match => match[1].trim()).filter(Boolean).join('\n');
    return { html: String(html ?? '').replace(STYLE, '').trim(), css };
}

// The elements with ids inside a part, named as the screen names them (part.id).
export function partElements(component) {
    const { html } = splitStyles(component.html);
    const labels = new Map([...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)]
        .map(([, attributes, inner]) => [attributesOf(attributes).for, textOf(inner)]).filter(([target]) => target));
    const elements = [];
    for (const match of html.matchAll(START_TAG)) {
        const tag = match[1].toLowerCase();
        const attributes = attributesOf(match[2]);
        if (!attributes.id || ['script', 'style', 'template'].includes(tag)) continue;
        const kind = kindOfTag(tag, attributes.type);
        let label = attributes['aria-label'] || labels.get(attributes.id) || attributes.placeholder || attributes.title || '';
        if (!label && (kind === 'button' || kind === 'static')) {
            const rest = html.slice(match.index + match[0].length);
            const close = rest.search(new RegExp(`</${tag}\\s*>`, 'i'));
            label = textOf(close >= 0 ? rest.slice(0, close) : '');
        }
        const id = `${component.id}.${attributes.id}`;
        elements.push({ id, kind, tag, part: component.id, label: shortLabel(label) || id });
    }
    return elements;
}

// The attributes that name another element, which move with a part's ids.
const ID_ATTRIBUTES = new Set(['id', 'for', 'list']);
const ID_LIST_ATTRIBUTES = new Set(['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']);

// A part's HTML as it goes on the screen: every id (and what refers to one) with `prefix.` in front.
export function prefixIds(html, prefix) {
    return String(html ?? '').replace(START_TAG, (tag, name, attributes, end) => {
        const rewritten = attributes.replace(ATTRIBUTE, (attribute, key, double, single, bare) => {
            const value = double ?? single ?? bare;
            const lower = key.toLowerCase();
            let next;
            if (value && ID_ATTRIBUTES.has(lower)) next = `${prefix}.${value}`;
            else if (value && ID_LIST_ATTRIBUTES.has(lower)) next = value.split(/\s+/).filter(Boolean).map(id => `${prefix}.${id}`).join(' ');
            else if (value && lower === 'href' && value.startsWith('#') && value.length > 1) next = `#${prefix}.${value.slice(1)}`;
            else return attribute;
            return `${key}="${next.replace(/"/g, '&quot;')}"`;
        });
        return `<${name}${rewritten}${end}>`;
    });
}

// A part's CSS, reaching only inside the part: its html, body and :root rules apply to the part,
// and #id follows its element to its name on the screen (#details is #dash\.details). Only the
// part's own ids (`ids`) are renamed, which keeps colors such as #f4f4f5 as they are.
export function scopeCss(css, partId, ids = []) {
    const own = new Set(ids);
    const rules = String(css ?? '')
        .replace(/#([A-Za-z_][\w-]*)/g, (match, id) => (own.has(id) ? `#${partId}\\.${id}` : match))
        .replace(/(^|[\s,{}>+~])(?:html|body|:root)(?=[\s,{.:#[>+~]|$)/g, '$1:scope');
    return `@scope ([data-part="${partId}"]) {\n${rules}\n}`;
}

// What a part keeps of the HTML a model or a tool returned: the body, and its styles, without
// anything that could run, load or go anywhere (scripts, frames, embeds, links to stylesheets, on…
// handlers and javascript: links); a form's fields stay, without the form. Needs a DOM, so it runs
// in the page.
export function sanitizePart(html) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const css = [...doc.querySelectorAll('style')].map(style => style.textContent.trim()).filter(Boolean).join('\n');
    doc.querySelectorAll('script, style, meta, base, link, iframe, frame, frameset, object, embed, title, noscript, template').forEach(node => node.remove());
    doc.querySelectorAll('form').forEach(form => form.replaceWith(...form.childNodes));
    for (const element of doc.body.querySelectorAll('*')) {
        for (const { name, value } of [...element.attributes]) {
            if (/^on/i.test(name) || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value))) element.removeAttribute(name);
        }
    }
    const body = doc.body.innerHTML.trim();
    return css ? `<style>\n${css}\n</style>\n${body}` : body;
}

// The elements with ids in an HTML document, and what each is: a button, a field or something
// that shows things. Needs a DOM, so it runs in the page.
export function elementsOfHtml(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const elements = [];
    for (const element of doc.body?.querySelectorAll('[id]') || []) {
        if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName) || !element.id) continue;
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') || '').toLowerCase();
        const kind = tag === 'button' || tag === 'a' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) ? 'button'
            : ['input', 'textarea', 'select'].includes(tag) ? 'input'
            : /^h[1-6]$|^label$/.test(tag) ? 'static'
            : 'output';
        const labelFor = doc.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent;
        const text = element.getAttribute('aria-label') || labelFor || element.getAttribute('placeholder')
            || (kind === 'button' || kind === 'static' ? element.textContent : '') || '';
        const label = text.trim().replace(/\s+/g, ' ');
        elements.push({ id: element.id, kind, tag, label: label.length > 40 ? `${label.slice(0, 39)}…` : label || element.id });
    }
    return elements;
}

export function elementsOf(screen) {
    return screen?.kind === 'html' ? elementsOfHtml(screen.html) : elementsOfComponents(screen?.components);
}

// The look of a screen built from components, light or dark with the system. It travels in the
// page itself: the screen can't load anything from the network.
export const SCREEN_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1b1b; --muted: #727272; --line: #dedede; --soft: #f6f6f6;
  --accent: #1b1b1b; --on-accent: #ffffff; --error: #c22f30; --chart: #4b63d8;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1a1a1a; --fg: #ffffff; --muted: #999999; --line: #404040; --soft: #242424;
    --accent: #ffffff; --on-accent: #1a1a1a; --error: #f39a9a; --chart: #8da0ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.app { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; align-items: start; max-width: 640px; margin: 0 auto; padding: 28px 24px 40px; }
.app-wide { max-width: 1080px; }
.app > * { grid-column: span 6; min-width: 0; }
.app > .w-two-thirds { grid-column: span 4; }
.app > .w-half { grid-column: span 3; }
.app > .w-third { grid-column: span 2; }
@media (max-width: 520px) { .app > * { grid-column: 1 / -1; } }
h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
.text { margin: 0; color: var(--muted); white-space: pre-wrap; }
.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: 0.8125rem; font-weight: 600; }
input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: inherit; font: inherit; }
input:focus, textarea:focus, select:focus { border-color: var(--accent); outline: none; }
button { justify-self: start; align-self: end; padding: 9px 20px; border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { cursor: progress; opacity: 0.55; }
.output { min-height: 46px; padding: 12px 14px; border-radius: 10px; background: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.output:empty::before { content: attr(data-placeholder); color: var(--muted); }
.output[aria-busy='true'] { opacity: 0.7; background-image: linear-gradient(100deg, transparent 30%, color-mix(in srgb, var(--fg) 8%, transparent) 50%, transparent 70%); background-size: 200% 100%; animation: busy 1.2s linear infinite; }
@keyframes busy { from { background-position: 150% 0; } to { background-position: -50% 0; } }
.output[data-state='error'] { color: var(--error); }
.output > .entry + .entry { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.box { white-space: normal; }
.box-text, .box-none, .box-problem { margin: 0; white-space: pre-wrap; }
.box-none { color: var(--muted); }
.box-problem { color: var(--error); }
.kpi { display: flex; flex-direction: column; gap: 2px; }
.kpi-value { font-size: 1.75rem; font-weight: 650; line-height: 1.15; letter-spacing: -0.02em; }
.kpi-note { color: var(--muted); font-size: 0.8125rem; }
.items { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.items li { display: flex; flex-direction: column; gap: 1px; }
.item-title { font-weight: 600; }
a.item-title { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
a.item-title:hover { text-decoration-color: currentColor; }
.item-detail { color: var(--muted); font-size: 0.875rem; }
.table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.table th, .table td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.table th { color: var(--muted); font-weight: 600; }
.chart-bars { display: flex; gap: 6px; height: 150px; }
.chart-col { display: flex; flex: 1; flex-direction: column; justify-content: flex-end; min-width: 0; }
.chart-value { color: var(--muted); font-size: 0.75rem; text-align: center; }
.chart-fill { min-height: 2px; border-radius: 4px 4px 0 0; background: var(--chart); }
.chart-axis { display: flex; gap: 6px; margin-top: 6px; color: var(--muted); font-size: 0.75rem; }
.chart-axis span { flex: 1; min-width: 0; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.chart-line .chart-axis { justify-content: space-between; }
.chart-line .chart-axis span { flex: 0 1 auto; }
.chart-plot { position: relative; height: 150px; }
.chart-plot svg { display: block; width: 100%; height: 100%; overflow: visible; }
.chart-plot polyline { fill: none; stroke: var(--chart); stroke-width: 2.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.box-conversation { display: flex; flex-direction: column; gap: 8px; min-height: 160px; max-height: 440px; overflow-y: auto; }
.box-conversation > .entry, .box-conversation > .entry + .entry { max-width: 88%; margin: 0; padding: 8px 12px; border: none; border-radius: 14px; background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; }
.box-conversation > .entry[data-role='you'] { align-self: flex-end; background: var(--accent); color: var(--on-accent); }
.box-conversation > .entry[data-role='tool'] { color: var(--muted); font: 0.8125rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.box-conversation > .entry[data-role='error'] { color: var(--error); }
.box-conversation[aria-busy='true'] { opacity: 1; background-image: none; animation: none; }
.box-conversation[aria-busy='true']::after { content: '…'; align-self: flex-start; padding: 2px 14px 8px; border-radius: 14px; background: var(--bg); color: var(--muted); font-weight: 700; letter-spacing: 2px; animation: typing 0.9s ease-in-out infinite alternate; }
@keyframes typing { from { opacity: 0.3; } to { opacity: 1; } }
.chart-high, .chart-low { position: absolute; left: 0; color: var(--muted); font-size: 0.6875rem; }
.chart-high { top: -2px; }
.chart-low { bottom: -2px; }
.part { display: block; min-width: 0; }
.part-empty { margin: 0; padding: 18px; border: 1px dashed var(--line); border-radius: 10px; color: var(--muted); text-align: center; }
`.trim();

// The class that sets how much of a row a component takes.
const widthClass = component => (WIDTHS[component.width] && component.width !== 'full' ? `w-${component.width}` : '');
const classes = (...names) => names.filter(Boolean).join(' ');

function componentHtml(component) {
    const id = escapeHtml(component.id);
    switch (component.type) {
        case 'title':
            return `<h1 id="${id}">${escapeHtml(component.text)}</h1>`;
        case 'text':
            return `<p id="${id}" class="${classes('text', widthClass(component))}">${escapeHtml(component.text)}</p>`;
        case 'textbox': {
            const placeholder = component.placeholder ? ` placeholder="${escapeHtml(component.placeholder)}"` : '';
            const lines = Math.max(1, Math.min(20, Number(component.lines) || 1));
            const field = lines > 1
                ? `<textarea id="${id}" rows="${lines}"${placeholder}>${escapeHtml(component.value || '')}</textarea>`
                : `<input id="${id}" type="text"${placeholder}${component.value ? ` value="${escapeHtml(component.value)}"` : ''} autocomplete="off">`;
            return `<div class="${classes('field', widthClass(component))}">\n      <label class="label" for="${id}">${escapeHtml(component.label)}</label>\n      ${field}\n    </div>`;
        }
        case 'button': {
            const width = widthClass(component);
            return `<button id="${id}" type="button"${width ? ` class="${width}"` : ''}>${escapeHtml(component.label)}</button>`;
        }
        case 'output': {
            const show = BOX_KINDS[component.show] && component.show !== 'text' ? component.show : '';
            return `<section class="${classes('field', widthClass(component))}">\n      <h2 class="label">${escapeHtml(component.label)}</h2>\n      <div id="${id}" class="${classes('output', show && `box box-${show}`)}" aria-label="${escapeHtml(component.label)}" aria-live="polite" data-placeholder="${escapeHtml(component.placeholder || '')}"></div>\n    </section>`;
        }
        case 'part': {
            const { html, css } = splitStyles(component.html);
            const ids = partElements(component).map(element => element.id.slice(component.id.length + 1));
            const style = css ? `\n      <style>\n${scopeCss(css, component.id, ids)}\n      </style>` : '';
            const body = html ? prefixIds(html, component.id) : `<p class="part-empty">${escapeHtml(component.label || component.id)}: nothing here yet. Ask a model for it, or get it from a tool.</p>`;
            return `<section id="${id}" class="${classes('part', widthClass(component))}" data-part="${id}" aria-label="${escapeHtml(component.label || component.id)}">${style}\n${body}\n    </section>`;
        }
        default:
            return '';
    }
}

// The HTML document a screen built from components is: what the preview runs and the zip's
// index.html. A wide screen (`size`) is a dashboard's, with room for boxes side by side.
export function componentsHtml(components = [], { title = 'App', size = 'narrow' } = {}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${SCREEN_CSS.split('\n').map(line => `    ${line}`).join('\n')}
  </style>
</head>
<body>
  <main class="${classes('app', size === 'wide' && 'app-wide')}">
${components.map(component => `    ${componentHtml(component)}`).join('\n')}
  </main>
</body>
</html>
`;
}

export function screenHtml(app) {
    return app?.screen?.kind === 'html' ? app.screen.html || '' : componentsHtml(app?.screen?.components, { title: app?.name, size: app?.screen?.size });
}
