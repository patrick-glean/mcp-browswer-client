// The app builder's Try it: the app running, as people will use it, and what happened as they
// used it, step by step: what they did, each call with what it sent, the answer, and where it went.

import { debounce, escapeHtml } from '../../workbench/util.js';
import { AppRunner } from '../runner.js';
import { AppElement } from './base.js';

const MAX_TRACE = 200;
const MARKS = { event: '●', call: '→', ok: '✓', error: '!', route: '↳', note: '·' };

const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export class AppPreview extends AppElement {
    setup(signal) {
        this.entries = [];
        this.waiting = null;
        this.runner = new AppRunner({
            shell: this.shell,
            workbench: this.workbench,
            getApp: () => this.apps.app,
            onTrace: entry => this.addTrace(entry),
            onSize: height => this.style.setProperty('--app-frame-height', `${Math.ceil(height)}px`),
            signal,
        });
        this.reloadSoon = debounce(() => this.load({ start: false }), 300);
        this.apps.on('shown', () => {
            this.entries = [];
            this.render();
        }, signal);
        this.apps.on('app', ({ part }) => {
            if (part === 'screen') this.reloadSoon();
            if (part === 'flow') this.runner.flowChanged();
        }, signal);
        this.apps.on('restart', () => this.restart(), signal);
        this.apps.on('highlight', ({ elements }) => this.runner.highlight(elements), signal);
        this.shell.on('mode', ({ mode }) => {
            if (mode === 'apps' && this.waiting) this.load(this.waiting);
        }, signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.restart !== undefined) this.restart();
            if (button.dataset.clearTrace !== undefined) {
                this.entries = [];
                this.renderTrace();
            }
            if (button.dataset.openRun) this.apps.openRun(button.dataset.openRun);
        }, { signal });
    }

    render() {
        const app = this.apps.app;
        if (!app) {
            this.innerHTML = '';
            this.frame = null;
            return;
        }
        this.innerHTML = `
            <section class="app-section app-try" aria-labelledby="appTryTitle">
                <header class="app-section-head">
                    <h3 id="appTryTitle"><span class="app-step" aria-hidden="true">3</span>Try it</h3>
                    <button type="button" class="btn-sm" data-restart title="Runs the app from the start, with its When the app opens rules"><span class="icon icon-refresh" aria-hidden="true"></span>Restart</button>
                </header>
                <p class="app-section-note text-secondary">The app as people will use it. Its calls are real, and each one is in History too. Point at a rule or a component to see where it is.</p>
                <div class="app-frame-box">
                    <iframe class="app-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(app.name)}, running"></iframe>
                </div>
                <div class="app-trace-head">
                    <h4>What happened</h4>
                    <button type="button" class="btn-sm btn-tertiary" data-clear-trace>Clear</button>
                </div>
                <ol class="app-trace" data-trace aria-live="polite"></ol>
            </section>`;
        this.frame = this.$('iframe');
        this.renderTrace();
        this.load({ start: true });
    }

    // Only a screen someone can see runs, so an app's "when it opens" calls wait until then.
    load({ start }) {
        if (!this.frame || !this.apps.app) return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = { start: start || !!this.waiting?.start };
            return;
        }
        this.waiting = null;
        this.runner.load(this.frame, { start });
    }

    restart() {
        this.addTrace({ time: Date.now(), kind: 'note', text: 'Restarted the app.' });
        this.load({ start: true });
    }

    addTrace(entry) {
        this.entries.push(entry);
        if (this.entries.length > MAX_TRACE) this.entries.shift();
        const list = this.$('[data-trace]');
        if (!list) return;
        if (this.entries.length === 1 || list.childElementCount > MAX_TRACE) return this.renderTrace();
        list.insertAdjacentHTML('beforeend', this.traceRow(entry));
        list.scrollTop = list.scrollHeight;
    }

    traceRow(entry) {
        return `
            <li class="app-trace-entry app-trace-${escapeHtml(entry.kind)}">
                <time class="app-trace-time">${clock(entry.time)}</time>
                <span class="app-trace-mark" aria-hidden="true">${MARKS[entry.kind] || '·'}</span>
                <span class="app-trace-text">${escapeHtml(entry.text)}${entry.runId ? ` <button type="button" class="link-button" data-open-run="${escapeHtml(entry.runId)}">Open in the Workbench</button>` : ''}</span>
            </li>`;
    }

    renderTrace() {
        const list = this.$('[data-trace]');
        if (!list) return;
        list.innerHTML = this.entries.length
            ? this.entries.map(entry => this.traceRow(entry)).join('')
            : '<li class="app-trace-empty text-secondary">Use the app: each click, call and answer shows up here, in order.</li>';
        list.scrollTop = list.scrollHeight;
    }
}
