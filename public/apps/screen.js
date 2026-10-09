// An app's screen: what people see. Either built here from components (a title, text, text boxes,
// buttons and outputs, each with an id the flow names it by) or an HTML document, such as one a
// tool call made, whose elements with ids the flow names the same way.
//
// screen: { kind: 'components', components: [component] } or { kind: 'html', html, from }
// where `from` is the call that made the HTML, { serverUrl, toolName, args }, if one did.

import { escapeHtml } from '../workbench/util.js';
import { elementIdProblem, resultText } from './flow.js';

export const COMPONENT_TYPES = {
    title: { label: 'Title', kind: 'static', base: 'title' },
    text: { label: 'Text', kind: 'static', base: 'note' },
    textbox: { label: 'Text box', kind: 'input', base: 'input' },
    button: { label: 'Button', kind: 'button', base: 'button' },
    output: { label: 'Output', kind: 'output', base: 'output' },
};

export const ELEMENT_KINDS = { button: 'Button', input: 'Field', output: 'Output', static: 'Text' };

const DEFAULTS = {
    title: { text: 'Title' },
    text: { text: 'Some text.' },
    textbox: { label: 'Text box', placeholder: '', lines: 1, value: '' },
    button: { label: 'Button' },
    output: { label: 'Output', placeholder: 'What the tool returns shows here.' },
};

// The first free id for a new component: input, input2, input3…
export function freeId(base, takenIds) {
    const taken = new Set(takenIds);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

export function newComponent(type, takenIds = [], props = {}) {
    const id = props.id && !elementIdProblem(props.id, takenIds) ? props.id : freeId(COMPONENT_TYPES[type].base, takenIds);
    return { ...DEFAULTS[type], ...props, id, type };
}

// What the builder calls an element: its label, its text, or its id.
export function componentName(component) {
    const text = String(component.label || component.text || '').trim().split('\n')[0];
    return text.length > 40 ? `${text.slice(0, 39)}…` : text || component.id;
}

export function elementsOfComponents(components = []) {
    return components.map(component => ({
        id: component.id,
        kind: COMPONENT_TYPES[component.type]?.kind || 'static',
        type: component.type,
        label: componentName(component),
    }));
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

// The look of a screen built from components, light or dark with the system. It travels in the
// page itself: the screen can't load anything from the network.
export const SCREEN_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1b1b; --muted: #727272; --line: #dedede; --soft: #f6f6f6;
  --accent: #1b1b1b; --on-accent: #ffffff; --error: #c22f30;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1a1a1a; --fg: #ffffff; --muted: #999999; --line: #404040; --soft: #242424;
    --accent: #ffffff; --on-accent: #1a1a1a; --error: #f39a9a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.app { display: flex; flex-direction: column; gap: 16px; max-width: 640px; margin: 0 auto; padding: 28px 24px 40px; }
h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
.text { margin: 0; color: var(--muted); white-space: pre-wrap; }
.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: 0.8125rem; font-weight: 600; }
input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: inherit; font: inherit; }
input:focus, textarea:focus, select:focus { border-color: var(--accent); outline: none; }
button { align-self: flex-start; padding: 9px 20px; border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { cursor: progress; opacity: 0.55; }
.output { min-height: 46px; padding: 12px 14px; border-radius: 10px; background: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.output:empty::before { content: attr(data-placeholder); color: var(--muted); }
.output[aria-busy='true'] { opacity: 0.6; }
.output[data-state='error'] { color: var(--error); }
.output > .entry + .entry { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
`.trim();

function componentHtml(component) {
    const id = escapeHtml(component.id);
    switch (component.type) {
        case 'title':
            return `<h1 id="${id}">${escapeHtml(component.text)}</h1>`;
        case 'text':
            return `<p id="${id}" class="text">${escapeHtml(component.text)}</p>`;
        case 'textbox': {
            const placeholder = component.placeholder ? ` placeholder="${escapeHtml(component.placeholder)}"` : '';
            const lines = Math.max(1, Math.min(20, Number(component.lines) || 1));
            const field = lines > 1
                ? `<textarea id="${id}" rows="${lines}"${placeholder}>${escapeHtml(component.value || '')}</textarea>`
                : `<input id="${id}" type="text"${placeholder}${component.value ? ` value="${escapeHtml(component.value)}"` : ''} autocomplete="off">`;
            return `<div class="field">\n      <label class="label" for="${id}">${escapeHtml(component.label)}</label>\n      ${field}\n    </div>`;
        }
        case 'button':
            return `<button id="${id}" type="button">${escapeHtml(component.label)}</button>`;
        case 'output':
            return `<section class="field">\n      <h2 class="label">${escapeHtml(component.label)}</h2>\n      <div id="${id}" class="output" aria-label="${escapeHtml(component.label)}" aria-live="polite" data-placeholder="${escapeHtml(component.placeholder || '')}"></div>\n    </section>`;
        default:
            return '';
    }
}

// The HTML document a screen built from components is: what the preview runs and the zip's index.html.
export function componentsHtml(components = [], { title = 'App' } = {}) {
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
  <main class="app">
${components.map(component => `    ${componentHtml(component)}`).join('\n')}
  </main>
</body>
</html>
`;
}

export function screenHtml(app) {
    return app?.screen?.kind === 'html' ? app.screen.html || '' : componentsHtml(app?.screen?.components, { title: app?.name });
}
