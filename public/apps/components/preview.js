// Preview: the app as it is when it's launched. Its screen is the window: it starts from the
// beginning (its "when the app opens" rules run) and makes its real calls, with nothing of the
// builder on it, no ports, wires or trace. A bar above says what it's doing, sets its width (a
// phone's, a tablet's or the window's) and restarts or ends it; Escape ends it too, on the screen
// or off it.
//
// A launched app (index.html?app= or #run=, Apps.launch) is this too, with no builder to go back
// to: its bar offers to add it to Your apps or open it in the builder, and says what it needs
// first, the servers it calls that you haven't added or signed in to, and for an app from a link
// that calls tools as it opens, whether to run them.

import { escapeHtml, serverState } from '../../workbench/util.js';
import { openRules, PREVIEW } from '../apps.js';
import { serversOf } from '../dml.js';
import { AppRunner } from '../runner.js';
import { AppElement } from './base.js';
import { openAskHtml } from './open-ask.js';

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
            onScreen: id => this.showScreenName(id),
            onEscape: () => this.apps.exitPreview(),
            signal,
        });
        this.apps.on('view', ({ view }) => this.render({ entering: view === PREVIEW }), signal);
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', ({ part }) => {
            if (part === 'flow') this.runner.flowChanged();
        }, signal);
        // A launched app's answer to whether it runs what Start calls, when it's yes.
        this.apps.on('restart', () => {
            if (this.apps.launched && this.frame) this.load();
        }, signal);
        this.apps.on('runOnOpen', () => this.renderNotes(), signal);
        this.apps.on('list', () => this.renderNotes(), signal);
        for (const type of ['servers', 'tools', 'auth']) this.shell.on(type, () => this.renderNotes(), signal);
        this.shell.on('mode', ({ mode }) => {
            if (mode === 'apps' && this.waiting) this.load(this.waiting);
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || this.apps.view !== PREVIEW || this.apps.launched || document.body.dataset.mode !== 'apps') return;
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
        const launched = this.apps.launched;
        this.setAttribute('aria-label', launched ? app.name || 'The app' : `Preview of ${app.name || 'the app'}`);
        this.innerHTML = `
            <div class="app-preview-bar">
                ${launched ? '' : '<span class="app-preview-badge">Preview</span>'}
                <span class="app-preview-name">${escapeHtml(app.name || 'Untitled app')}</span>
                <span class="app-preview-screen" data-preview-screen hidden></span>
                <span class="app-preview-status text-secondary" data-preview-status aria-live="polite"></span>
                <span class="wb-spacer"></span>
                ${launched ? '' : `<div class="wb-chips" role="group" aria-label="Width">
                    ${Object.entries(DEVICES).map(([key, { label, width }]) => `<button type="button" class="wb-chip" data-device="${key}" aria-pressed="${key === this.device}" title="${width ? `${width} pixels wide, as on a ${label.toLowerCase()}` : 'As wide as the window'}">${label}</button>`).join('')}
                </div>`}
                <button type="button" class="btn-sm btn-tertiary" data-restart title="Starts the app again from the beginning, as when it's launched"><span class="icon icon-refresh" aria-hidden="true"></span>Restart</button>
                ${launched ? '<span data-launch-actions></span>' : '<button type="button" class="btn-sm" data-exit-preview title="Back to the builder"><span class="icon icon-x" aria-hidden="true"></span>Exit preview<kbd>Esc</kbd></button>'}
            </div>
            ${launched ? '<div class="app-launch-notes" data-launch-notes hidden></div>' : ''}
            <div class="app-preview-stage" data-preview-stage>
                <iframe class="app-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(app.name || 'The app')}"></iframe>
            </div>`;
        this.frame = this.$('iframe');
        this.applyDevice();
        this.renderNotes();
        // An app from a link waits to run what Start calls until you've said to (Apps.launch).
        this.load({ start: !(launched && this.apps.startHeld) });
        if (entering) this.$('[data-exit-preview]').focus();
    }

    // Only a screen someone can see runs, so its "when it opens" calls wait for the Apps page.
    load({ start = true } = {}) {
        if (!this.frame) return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = { start: start || !!this.waiting?.start };
            return;
        }
        this.waiting = false;
        if (start && this.apps.launched) {
            this.apps.ranStart();
            this.renderNotes();
        }
        // An embed's History is in the storage the browser keeps for it, which no page of the client shows.
        const real = this.apps.launched?.embedded ? 'Its calls are real.' : 'Its calls are real, and each is in History.';
        this.status(this.apps.launched
            ? (start || !openRules(this.apps.app).length ? real : "It hasn't run what it calls as it opens.")
            : "As it is when it's launched: its calls are real, and each is in History.");
        this.runner.load(this.frame, { start });
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button) return;
        const { dataset } = button;
        if (dataset.device) this.setDevice(dataset.device);
        if (dataset.restart !== undefined) this.load();
        if (dataset.exitPreview !== undefined) this.apps.exitPreview();
        if (dataset.answerRunOnOpen) this.apps.answerRunOnOpen(dataset.answerRunOnOpen);
        if (dataset.keepApp !== undefined) this.apps.keepLaunched();
        if (dataset.openBuilder !== undefined) this.apps.openInBuilder();
        if (dataset.addServerForApp) {
            const url = dataset.addServerForApp;
            const name = this.apps.serverName(url);
            this.shell.addServer(url, name === url ? '' : name, { show: false });
        }
        if (dataset.signInForApp) this.shell.signIn(dataset.signInForApp);
    }

    // A launched app's own way on, and what it needs before it can run: the servers it calls that
    // you haven't added or signed in to, and for one from a link, what it calls as it opens.
    renderNotes() {
        const notes = this.$('[data-launch-notes]');
        const actions = this.$('[data-launch-actions]');
        const app = this.apps.app;
        const launched = this.apps.launched;
        if (!launched || !app || !notes) return;
        const fromLink = launched.fromLink && !this.apps.isYours();
        if (launched.embedded) {
            // In another page's iframe. On its own, a tab away, it has this client's own storage,
            // where it can sign in.
            const own = new URL(location.href);
            own.searchParams.delete('embed');
            actions.innerHTML = `<a class="btn-sm app-preview-own" href="${escapeHtml(own.href)}" target="_blank" rel="noopener" title="The app on its own, in a tab of MCP Browser Client: there it can sign in to the servers it calls">Open on its own<span class="icon icon-external-link" aria-hidden="true"></span></a>`;
        } else {
            actions.innerHTML = fromLink
                ? '<button type="button" class="btn-sm" data-keep-app title="Adds it under Your apps, to change it in the builder">Add to Your apps</button>'
                : `<button type="button" class="btn-sm" data-open-builder title="${escapeHtml(launched.fromLink ? 'Your copy of this app, in the builder: the one you have may be a different version from the link\'s'
                    : launched.fromFile ? "This folder's app, in the builder here, to change it and download it again" : 'The app in the builder, to change it')}">Open in the builder</button>`;
        }
        const rows = [];
        if (launched.fromLink && !launched.embedded) rows.push('<p class="app-launch-note">This app came in a link. It calls your servers, signed in as you, and each call is in History.</p>');
        for (const url of serversOf(app)) {
            const server = this.shell.servers[url];
            const name = this.apps.serverName(url);
            const named = name === url ? escapeHtml(url) : `${escapeHtml(name)} (${escapeHtml(url)})`;
            if (!server) rows.push(`<p class="app-launch-note">It calls ${named}, which isn't one of your servers${launched.embedded ? ' here' : ''}. <button type="button" class="btn-sm" data-add-server-for-app="${escapeHtml(url)}">Add it</button></p>`);
            // A sign-in inside another site's page comes back to the client's own storage, not the embed's.
            else if (serverState(server, this.shell.authStatus[url]) === 'signin') {
                rows.push(launched.embedded
                    ? `<p class="app-launch-note">${escapeHtml(name)} needs you to sign in, which works with the app on its own: Open on its own, above.</p>`
                    : `<p class="app-launch-note">${escapeHtml(name)} needs you to sign in. <button type="button" class="btn-sm" data-sign-in-for-app="${escapeHtml(url)}">Sign in</button></p>`);
            }
        }
        if (this.apps.startHeld && openRules(app).length) {
            rows.push(this.apps.runOnOpen() === null
                ? `<div class="app-open-ask">${openAskHtml(this.apps, { kept: 'The answer is kept for this app, in this browser.' })}</div>`
                : `<p class="app-launch-note">It didn't run what it calls as it opens (${escapeHtml(this.apps.openCallsText())}), as you chose for this app. <button type="button" class="btn-sm" data-restart>Run it now</button></p>`);
        }
        notes.innerHTML = rows.join('');
        notes.hidden = !rows.length;
    }

    setDevice(device) {
        if (!DEVICES[device] || device === this.device) return;
        this.device = device;
        localStorage.setItem(DEVICE_KEY, device);
        this.querySelectorAll('[data-device]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.device === device)));
        this.applyDevice();
    }

    // The screen keeps what's on it when its width changes, as a window being resized does. A
    // launched app's window is its screen.
    applyDevice() {
        const stage = this.$('[data-preview-stage]');
        if (!stage) return;
        const device = this.apps.launched ? 'desktop' : this.device;
        const { width, height } = DEVICES[device];
        stage.dataset.device = device;
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

    // Which of the app's screens shows, for an app with several.
    showScreenName(id) {
        const shown = this.$('[data-preview-screen]');
        const screen = this.apps.elements().find(element => element.id === id && element.kind === 'screen');
        if (!shown) return;
        shown.hidden = !screen;
        shown.textContent = screen ? screen.label : '';
        shown.title = screen ? `The screen showing: ${screen.label} (${screen.id})` : '';
    }

    status(text, { error = false } = {}) {
        const status = this.$('[data-preview-status]');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('text-error', error);
    }
}
