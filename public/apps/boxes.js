// Boxes: the outputs of a screen such as a dashboard, each saying what it shows (text, a number,
// a list, a table, a chart or HTML) and what goes in it, in words. A rule whose answer fills boxes
// asks its tool for them: the boxes add to its prompt (one of the call's fields) what each needs
// and in what shape, and each box draws its piece of the answer, the JSON value under its key.
// So the screen's layout writes the format half of the prompt. Pure, for the runner, the builder
// and the tests.

import { escapeHtml } from '../workbench/util.js';
import { answerKey } from './flow.js';

export { answerKey };

// What a box can show: its name in menus and in a prompt, what the Library says of it, the shape
// of JSON it takes, the id a new one gets, and an example of what goes in one.
export const BOX_KINDS = {
    text: { label: 'Text', noun: 'text', help: 'Words a tool or model writes, such as a summary', shape: 'a string', base: 'summary', example: 'Where things stand, in at most 3 sentences' },
    number: { label: 'Number', noun: 'number', help: 'One number or word, large, with a note', shape: '{"value": number or short text, "note": string}', base: 'number', example: 'How many tickets are open, with the change since last week' },
    list: { label: 'List', noun: 'list', help: 'Items, each with a title, a note and a link', shape: '[{"title": string, "detail": string, "url": string}]', base: 'list', example: 'The 5 most useful documents, with a one-line note each' },
    table: { label: 'Table', noun: 'table', help: 'Rows and columns', shape: '{"columns": [string], "rows": [[string or number]]}', base: 'table', example: 'Open escalations: the customer, the owner and the status' },
    bar: { label: 'Bar chart', noun: 'bar chart', help: 'Numbers as bars, one for each label', shape: '{"labels": [string], "values": [number]}', base: 'chart', example: 'Tickets opened per week, the last 8 weeks, oldest first' },
    line: { label: 'Line chart', noun: 'line chart', help: 'Numbers over time, as a line', shape: '{"labels": [string], "values": [number]}', base: 'trend', example: 'Weekly active users, the last 12 weeks, oldest first' },
    html: { label: 'HTML', noun: 'HTML', help: 'HTML the model writes to fit this box', shape: 'a string of HTML', base: 'panel', example: 'A one-line status banner, green when things are on track' },
};

// How much of a row a component takes, on a screen wide enough for rows.
export const WIDTHS = { full: 'Full width', 'two-thirds': 'Two thirds', half: 'Half', third: 'A third' };
const FRACTION = { full: 1, 'two-thirds': 2 / 3, half: 1 / 2, third: 1 / 3 };

// A box from the Library starts as wide as its kind usually is.
export const BOX_WIDTHS = { text: 'full', number: 'third', list: 'half', table: 'full', bar: 'two-thirds', line: 'two-thirds', html: 'full' };

// How wide a screen's content is, in a browser: narrow for a form, wide for a dashboard.
export const SCREEN_SIZES = { narrow: 592, wide: 1032 };

export class BoxError extends Error {}

const ASK_KEY = /^\s*\{\{\s*json\.([A-Za-z_][\w-]*)\s*\}\}\s*$/;

// An output that takes part of an answer by shape: it shows something other than text, or says
// what goes in it.
export const isBox = element => element?.type === 'output' && ((element.show && element.show !== 'text') || !!element.about);

// What a rule asks its tool for: one key for each element its answer fills as {{json.key}}, with
// the element's kind and what goes in it. [{ key, kind, about, width, into }]
export function asksOf(rule, elements = []) {
    const byId = new Map(elements.map(element => [element.id, element]));
    const asks = [];
    for (const route of rule?.then || []) {
        if (route.if === 'error') continue;
        const key = String(route.show ?? '').match(ASK_KEY)?.[1];
        const element = byId.get(route.into);
        if (!key || !element || asks.some(ask => ask.key === key)) continue;
        const kind = BOX_KINDS[element.show] ? element.show : 'text';
        asks.push({ key, kind, about: String(element.about || element.label || key).trim(), width: element.width || 'full', into: element.id });
    }
    return asks;
}

const sentence = text => {
    const trimmed = String(text).trim().replace(/\s+/g, ' ');
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

// What the boxes add to a prompt: the keys of one JSON object, each with what goes in it and its
// shape. An HTML box says how wide it is, from the screen's `size`.
export function formatRequest(asks, { size = 'narrow' } = {}) {
    const lines = asks.map(({ key, kind, about, width }) => {
        const { noun, shape } = BOX_KINDS[kind] || BOX_KINDS.text;
        const px = Math.round((SCREEN_SIZES[size] || SCREEN_SIZES.narrow) * (FRACTION[width] || 1) / 10) * 10;
        const as = kind === 'html' ? `${shape} for a box about ${px} px wide: no scripts, nothing from the network, inline styles only` : shape;
        return `- "${key}" (${noun}): ${sentence(about)} As ${as}.`;
    });
    return [
        "This answer fills the boxes on an app's screen. Answer with one JSON object in a ```json block, and nothing else, with exactly these keys:",
        ...lines,
        'Use null for a key you have nothing for.',
    ].join('\n');
}

// The tool's field a prompt goes in: one named like a prompt, else its first required text field.
const PROMPT_NAMES = ['message', 'prompt', 'question', 'query', 'input', 'text', 'q'];

export function promptFieldOf(schema) {
    const fields = Object.entries(schema?.properties || {}).filter(([, prop]) => prop?.type === 'string' && !prop.enum).map(([key]) => key);
    return PROMPT_NAMES.find(name => fields.includes(name)) || fields.find(key => (schema.required || []).includes(key)) || fields[0] || null;
}

// --- Drawing a box's piece of the answer ---

// Text as a box shows it: without the footnote marks a model's citations leave ([^1]), whose
// notes aren't in the box, or the space around it.
const tidy = text => String(text).replace(/\s*\[\^[\w-]+\]/g, '').trim();
const textOf = value => (value === null || value === undefined ? '' : typeof value === 'string' ? tidy(value) : typeof value === 'object' ? JSON.stringify(value) : String(value));
const safeUrl = value => (typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : '');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortNumber = value => String(Math.round(value * 100) / 100);
const NOTHING = '<p class="box-none">Nothing for this.</p>';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A chart's labels as short as they can be: days written as dates (2026-08-31) as Aug 31.
const shortLabels = labels => (labels.length && labels.every(label => /^\d{4}-\d{2}-\d{2}$/.test(label))
    ? labels.map(label => `${MONTHS[Number(label.slice(5, 7)) - 1] ?? label.slice(5, 7)} ${Number(label.slice(8, 10))}`)
    : labels);

function series(value) {
    let labels;
    let values;
    if (Array.isArray(value?.labels) && (Array.isArray(value.values) || Array.isArray(value.series?.[0]?.values))) {
        labels = value.labels;
        values = Array.isArray(value.values) ? value.values : value.series[0].values;
    } else if (Array.isArray(value) && value.length && value.every(isRecord)) {
        labels = value.map(point => point.label ?? point.name ?? point.x ?? '');
        values = value.map(point => point.value ?? point.count ?? point.y);
    } else if (isRecord(value) && Object.keys(value).length && Object.values(value).every(item => typeof item === 'number')) {
        labels = Object.keys(value);
        values = Object.values(value);
    } else {
        throw new BoxError('A chart takes {"labels": [...], "values": [...]}.');
    }
    const numbers = values.slice(0, 60).map(item => (typeof item === 'string' ? Number(item.replace(/[,\s]/g, '')) : Number(item)));
    if (!numbers.length || numbers.some(number => !Number.isFinite(number))) throw new BoxError('A chart takes numbers in "values".');
    return { labels: shortLabels(numbers.map((number, index) => textOf(labels[index]))), values: numbers };
}

const chartLabel = ({ labels, values }) => labels.map((label, index) => `${label || index + 1}: ${shortNumber(values[index])}`).join(', ');
// A chart's labels under it: at most about six, evenly spread, so each has room; the rest keep
// their place, empty, with their label as a tooltip.
const axis = labels => {
    const every = Math.ceil(labels.length / 6);
    return `<div class="chart-axis">${labels.map((label, index) => `<span title="${escapeHtml(label)}">${index % every === 0 ? escapeHtml(label) : ''}</span>`).join('')}</div>`;
};

const RENDER = {
    text: value => `<p class="box-text">${escapeHtml(typeof value === 'string' ? tidy(value) : JSON.stringify(value, null, 2))}</p>`,
    number(value) {
        const record = isRecord(value);
        const shown = record ? value.value ?? value.number ?? value.count ?? value.total : value;
        const note = record ? value.note ?? value.detail ?? value.change ?? value.label ?? value.description : '';
        if (shown === undefined || shown === null || typeof shown === 'object') throw new BoxError('A number takes {"value": ..., "note": ...}, or a number.');
        return `<div class="kpi"><span class="kpi-value">${escapeHtml(typeof shown === 'number' ? shortNumber(shown) : tidy(shown))}</span>${note ? `<span class="kpi-note">${escapeHtml(textOf(note))}</span>` : ''}</div>`;
    },
    list(value) {
        const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : null;
        if (!items) throw new BoxError('A list takes [{"title": ..., "detail": ..., "url": ...}].');
        if (!items.length) return NOTHING;
        return `<ul class="items">${items.slice(0, 50).map(item => {
            const entry = isRecord(item) ? item : { title: textOf(item) };
            const title = textOf(entry.title ?? entry.name ?? entry.label ?? entry.text ?? '');
            const detail = textOf(entry.detail ?? entry.description ?? entry.note ?? entry.summary ?? '');
            const url = safeUrl(entry.url ?? entry.link ?? entry.href);
            const head = url ? `<a class="item-title" href="${escapeHtml(url)}">${escapeHtml(title || url)}</a>` : `<span class="item-title">${escapeHtml(title)}</span>`;
            return `<li>${head}${detail ? `<span class="item-detail">${escapeHtml(detail)}</span>` : ''}</li>`;
        }).join('')}</ul>`;
    },
    table(value) {
        const given = isRecord(value) && Array.isArray(value.rows);
        if (!given && !Array.isArray(value)) throw new BoxError('A table takes {"columns": [...], "rows": [[...]]}.');
        let rows = (given ? value.rows : value).slice(0, 100);
        let columns = given && Array.isArray(value.columns) ? value.columns.map(textOf) : [];
        if (rows.some(isRecord)) {
            if (!columns.length) columns = [...new Set(rows.flatMap(row => (isRecord(row) ? Object.keys(row) : [])))].slice(0, 8);
            rows = rows.map(row => (isRecord(row) ? columns.map(column => row[column]) : row));
        }
        if (!rows.length) return NOTHING;
        const head = columns.length ? `<thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>` : '';
        return `<table class="table">${head}<tbody>${rows.map(row => `<tr>${(Array.isArray(row) ? row : [row]).map(cell => `<td>${escapeHtml(textOf(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    },
    bar(value) {
        const data = series(value);
        const top = Math.max(...data.values, 0) || 1;
        const bars = data.values.map(number => `<div class="chart-col"><span class="chart-value">${escapeHtml(shortNumber(number))}</span><div class="chart-fill" style="height: ${Math.round((Math.max(0, number) / top) * 850) / 10}%"></div></div>`).join('');
        return `<div class="chart chart-bar" role="img" aria-label="${escapeHtml(chartLabel(data))}"><div class="chart-bars">${bars}</div>${axis(data.labels)}</div>`;
    },
    line(value) {
        const data = series(value);
        const low = Math.min(...data.values);
        const high = Math.max(...data.values);
        const span = high - low || 1;
        const last = data.values.length - 1;
        const points = data.values.map((number, index) => `${last ? Math.round((index / last) * 1000) / 10 : 50},${Math.round((95 - ((number - low) / span) * 90) * 10) / 10}`).join(' ');
        return `<div class="chart chart-line" role="img" aria-label="${escapeHtml(chartLabel(data))}"><div class="chart-plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg><span class="chart-high">${escapeHtml(shortNumber(high))}</span><span class="chart-low">${escapeHtml(shortNumber(low))}</span></div>${axis(data.labels)}</div>`;
    },
    html(value) {
        if (typeof value !== 'string') throw new BoxError('An HTML box takes a string of HTML.');
        return value;
    },
};

// A box's piece of the answer as HTML for the screen: { html, problem }, where `problem` says
// why the value doesn't fit the box (and `html` says so too). Nothing (null) shows as nothing.
export function renderBox(kind, value) {
    if (value === null || value === undefined || value === '') return { html: NOTHING, problem: null };
    try {
        return { html: (RENDER[kind] || RENDER.text)(value), problem: null };
    } catch (error) {
        if (!(error instanceof BoxError)) throw error;
        return { html: `<p class="box-problem">${escapeHtml(error.message)}</p>`, problem: error.message };
    }
}
