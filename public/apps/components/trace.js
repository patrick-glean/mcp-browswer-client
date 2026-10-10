// What happened as someone used the app, step by step: what they did, each call with what it sent,
// the answer, and where it went. Try it (in the Outline) and the canvas each show one.

import { escapeHtml } from '../../workbench/util.js';

const MAX_TRACE = 200;
const MARKS = { event: '●', call: '→', ok: '✓', error: '!', route: '↳', note: '·' };

const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export class TraceList {
    constructor() {
        this.entries = [];
        this.list = null;
    }

    // Draws the entries into an <ol>, now and as they come.
    attach(list) {
        this.list = list;
        this.render();
    }

    add(entry) {
        this.entries.push(entry);
        if (this.entries.length > MAX_TRACE) this.entries.shift();
        if (!this.list?.isConnected) return;
        if (this.entries.length === 1 || this.list.childElementCount > MAX_TRACE) return this.render();
        this.list.insertAdjacentHTML('beforeend', this.row(entry));
        this.list.scrollTop = this.list.scrollHeight;
    }

    clear() {
        this.entries = [];
        this.render();
    }

    row(entry) {
        return `
            <li class="app-trace-entry app-trace-${escapeHtml(entry.kind)}">
                <time class="app-trace-time">${clock(entry.time)}</time>
                <span class="app-trace-mark" aria-hidden="true">${MARKS[entry.kind] || '·'}</span>
                <span class="app-trace-text">${escapeHtml(entry.text)}${entry.runId ? ` <button type="button" class="link-button" data-open-run="${escapeHtml(entry.runId)}">Open in the Workbench</button>` : ''}</span>
            </li>`;
    }

    render() {
        if (!this.list?.isConnected) return;
        this.list.innerHTML = this.entries.length
            ? this.entries.map(entry => this.row(entry)).join('')
            : '<li class="app-trace-empty text-secondary">Use the app: each click, call and answer shows up here, in order.</li>';
        this.list.scrollTop = this.list.scrollHeight;
    }
}
