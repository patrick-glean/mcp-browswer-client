// The question an app asks as it opens, when it calls tools as it opens (what Start calls) and
// nobody has said whether to: run them each time you open it here, or wait for Restart. The
// answer is kept for the app (Apps.setRunOnOpen); Start's Inspector changes it.

import { escapeHtml } from '../../workbench/util.js';
import { openRules, PREVIEW } from '../apps.js';
import { AppElement } from './base.js';

// The question, for the builder's bar and a launched app's (preview.js).
export function openAskHtml(apps) {
    const app = apps.app;
    return `
        <p class="app-open-ask-text"><strong>${escapeHtml(app.name || 'This app')} calls ${escapeHtml(apps.openCallsText())} as it opens.</strong> Run that each time you open it? <span class="text-secondary">The answer is kept for this app; Start, on the canvas, changes it.</span></p>
        <div class="app-open-ask-actions">
            <button type="button" class="btn-sm btn-primary" data-answer-run-on-open="yes" title="Runs it now, and each time this app opens">Run it each time</button>
            <button type="button" class="btn-sm" data-answer-run-on-open="no" title="Opening the app runs nothing until you choose Restart">Don't run it</button>
        </div>`;
}

export class AppOpenAsk extends AppElement {
    setup(signal) {
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('view', () => this.render(), signal);
        this.apps.on('runOnOpen', () => this.render(), signal);
        this.apps.on('app', ({ part }) => {
            if (part === 'flow') this.render();
        }, signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('[data-answer-run-on-open]');
            if (button) this.apps.answerRunOnOpen(button.dataset.answerRunOnOpen);
        }, { signal });
    }

    render() {
        const app = this.apps.app;
        const asking = !!app && this.apps.view !== PREVIEW && this.apps.startHeld && this.apps.runOnOpen() === null && openRules(app).length > 0;
        this.hidden = !asking;
        this.setAttribute('role', 'region');
        this.setAttribute('aria-label', 'Run it as it opens?');
        this.innerHTML = asking ? `<div class="app-open-ask">${openAskHtml(this.apps)}</div>` : '';
    }
}
