// The Outline's Try it: the app running, as people will use it, and what happened as they used it.
// It runs only while the Outline shows; the canvas runs the app in its own frame.

import { debounce, escapeHtml } from '../../workbench/util.js';
import { AppRunner } from '../runner.js';
import { AppElement } from './base.js';
import { TraceList } from './trace.js';

export class AppTry extends AppElement {
    setup(signal) {
        this.trace = new TraceList();
        this.waiting = null;
        this.runner = new AppRunner({
            shell: this.shell,
            workbench: this.workbench,
            getApp: () => this.apps.app,
            onTrace: entry => this.trace.add(entry),
            onLayout: ({ height }) => this.style.setProperty('--app-frame-height', `${Math.ceil(height)}px`),
            onAnswer: (ruleId, answer) => this.apps.setAnswer(ruleId, answer),
            signal,
        });
        this.reloadSoon = debounce(() => this.load({ start: false }), 300);
        this.apps.on('shown', () => {
            this.trace.entries = [];
            this.render({ start: true });
        }, signal);
        this.apps.on('view', () => this.render({ start: false }), signal);
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
            if (button.dataset.clearTrace !== undefined) this.trace.clear();
            if (button.dataset.openRun) this.apps.openRun(button.dataset.openRun);
        }, { signal });
    }

    render({ start = true } = {}) {
        const app = this.apps.app;
        if (!app || this.apps.view !== 'outline') {
            this.runner.stop();
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
        this.trace.attach(this.$('[data-trace]'));
        this.load({ start });
    }

    // Only a screen someone can see runs, so an app's "when it opens" calls wait until then.
    load({ start }) {
        if (!this.frame || !this.apps.app || this.apps.view !== 'outline') return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = { start: start || !!this.waiting?.start };
            return;
        }
        this.waiting = null;
        this.runner.load(this.frame, { start });
    }

    restart() {
        if (this.apps.view !== 'outline') return;
        this.trace.add({ time: Date.now(), kind: 'note', text: 'Restarted the app.' });
        this.load({ start: true });
    }
}
