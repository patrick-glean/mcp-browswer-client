// Preview: the app as it is when it's launched. Its screen is the window: it starts from the
// beginning (its "when the app opens" rules run) and makes its real calls, with nothing of the
// builder on it, no ports, wires or trace. A bar above says what it's doing, sets its width (a
// phone's, a tablet's or the window's) and restarts or ends it; Escape ends it too, on the screen
// or off it.

import { escapeHtml } from '../../workbench/util.js';
import { PREVIEW } from '../apps.js';
import { AppRunner } from '../runner.js';
import { AppElement } from './base.js';

const DEVICE_KEY = 'appsPreviewDevice';
// A phone's and a tablet's screen in CSS pixels, held upright; a desktop's is the window.
export const DEVICES = {
    phone: { label: 'Phone', width: 390, height: 844 },
    tablet: { label: 'Tablet', width: 820, height: 1180 },
    desktop: { label: 'Desktop' },
};

export class AppPreview extends AppElement {
    setup(signal) {
        const saved = localStorage.getItem(DEVICE_KEY);
        this.device = DEVICES[saved] ? saved : 'desktop';
        this.frame = null;
        this.waiting = false;
        this.runner = new AppRunner({
            shell: this.shell,
            workbench: this.workbench,
            getApp: () => this.apps.app,
            onActivity: activity => this.showActivity(activity),
            onAnswer: (ruleId, answer) => this.apps.setAnswer(ruleId, answer),
            onEscape: () => this.apps.exitPreview(),
            signal,
        });
        this.apps.on('view', ({ view }) => this.render({ entering: view === PREVIEW }), signal);
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', ({ part }) => {
            if (part === 'flow') this.runner.flowChanged();
        }, signal);
        this.shell.on('mode', ({ mode }) => {
            if (mode === 'apps' && this.waiting) this.load();
        }, signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.device) this.setDevice(button.dataset.device);
            if (button.dataset.restart !== undefined) this.load();
            if (button.dataset.exitPreview !== undefined) this.apps.exitPreview();
        }, { signal });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || this.apps.view !== PREVIEW || document.body.dataset.mode !== 'apps') return;
            // Escape closes what's open over the preview first: a menu, or Go to.
            if (document.querySelector('details.menu[open]') || !document.getElementById('palette')?.hidden) return;
            event.preventDefault();
            this.apps.exitPreview();
        }, { signal });
    }

    render({ entering = false } = {}) {
        const app = this.apps.app;
        if (!app || this.apps.view !== PREVIEW) {
            this.runner.stop();
            this.innerHTML = '';
            this.frame = null;
            this.waiting = false;
            return;
        }
        this.setAttribute('aria-label', `Preview of ${app.name || 'the app'}`);
        this.innerHTML = `
            <div class="app-preview-bar">
                <span class="app-preview-badge">Preview</span>
                <span class="app-preview-name">${escapeHtml(app.name || 'Untitled app')}</span>
                <span class="app-preview-status text-secondary" data-preview-status aria-live="polite"></span>
                <span class="wb-spacer"></span>
                <div class="wb-chips" role="group" aria-label="Width">
                    ${Object.entries(DEVICES).map(([key, { label, width }]) => `<button type="button" class="wb-chip" data-device="${key}" aria-pressed="${key === this.device}" title="${width ? `${width} pixels wide, as on a ${label.toLowerCase()}` : 'As wide as the window'}">${label}</button>`).join('')}
                </div>
                <button type="button" class="btn-sm btn-tertiary" data-restart title="Starts the app again from the beginning, as when it's launched"><span class="icon icon-refresh" aria-hidden="true"></span>Restart</button>
                <button type="button" class="btn-sm" data-exit-preview title="Back to the builder"><span class="icon icon-x" aria-hidden="true"></span>Exit preview<kbd>Esc</kbd></button>
            </div>
            <div class="app-preview-stage" data-preview-stage>
                <iframe class="app-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(app.name || 'The app')}"></iframe>
            </div>`;
        this.frame = this.$('iframe');
        this.applyDevice();
        this.load();
        if (entering) this.$('[data-exit-preview]').focus();
    }

    // Only a screen someone can see runs, so its "when it opens" calls wait for the Apps page.
    load() {
        if (!this.frame) return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = true;
            return;
        }
        this.waiting = false;
        this.status("As it is when it's launched: its calls are real, and each is in History.");
        this.runner.load(this.frame, { start: true });
    }

    setDevice(device) {
        if (!DEVICES[device] || device === this.device) return;
        this.device = device;
        localStorage.setItem(DEVICE_KEY, device);
        this.querySelectorAll('[data-device]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.device === device)));
        this.applyDevice();
    }

    // The screen keeps what's on it when its width changes, as a window being resized does.
    applyDevice() {
        const stage = this.$('[data-preview-stage]');
        if (!stage) return;
        const { width, height } = DEVICES[this.device];
        stage.dataset.device = this.device;
        stage.style.setProperty('--device-w', width ? `${width}px` : '100%');
        stage.style.setProperty('--device-h', height ? `${height}px` : '100%');
    }

    showActivity({ ruleId, phase, durationMs }) {
        const rule = (this.apps.app?.flow || []).find(candidate => candidate.id === ruleId);
        const tool = rule?.call?.toolName || 'The tool';
        const took = typeof durationMs === 'number' ? ` in ${Math.round(durationMs)} ms` : '';
        if (phase === 'call') return this.status(`Calling ${tool} on ${this.apps.serverName(rule?.call?.serverUrl)}…`);
        if (phase === 'ok') return this.status(`${tool} answered${took}`);
        // People using the app see a failure only where its rule puts one.
        const shown = (rule?.then || []).some(route => route.if === 'error');
        this.status(`${tool} failed${took}.${shown ? '' : ' Its rule puts nothing on the screen when it fails, so people won\'t know.'}`, { error: true });
    }

    status(text, { error = false } = {}) {
        const status = this.$('[data-preview-status]');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('text-error', error);
    }
}
