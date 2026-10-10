// The top of the app builder: the app's name and description, which version it's at, and
// Download (a zip of the flow's DML, the screen's HTML and a README), with the DML alone,
// Duplicate and Delete in its menu.

import { confirmThen, escapeHtml, timeAgo } from '../../workbench/util.js';
import { VIEWS } from '../apps.js';
import { AppElement } from './base.js';

export class AppHeader extends AppElement {
    setup(signal) {
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', () => this.renderVersion(), signal);
        this.apps.on('view', () => this.markView(), signal);
        this.addEventListener('input', event => {
            if (event.target.id === 'appName') this.apps.change(app => { app.name = event.target.value; }, { part: 'name', by: this });
            if (event.target.id === 'appDescription') this.apps.change(app => { app.description = event.target.value; }, { part: 'name', by: this });
        }, { signal });
        this.addEventListener('change', event => {
            if (event.target.id === 'appName' && !event.target.value.trim()) {
                event.target.value = 'Untitled app';
                this.apps.change(app => { app.name = 'Untitled app'; }, { part: 'name', by: this });
            }
        }, { signal });
        this.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            // Delete asks for a second click, so its menu stays open for it.
            if (button.id === 'deleteAppBtn') return confirmThen(button, () => this.apps.remove());
            if (button.dataset.appViewChoice) return this.apps.showView(button.dataset.appViewChoice);
            button.closest('details.menu')?.removeAttribute('open');
            if (button.id === 'downloadAppBtn') this.apps.download();
            if (button.id === 'downloadDmlBtn') this.apps.download({ standalone: true });
            if (button.id === 'duplicateAppBtn') this.apps.duplicate();
        }, { signal });
    }

    render() {
        const app = this.apps.app;
        if (!app) {
            this.innerHTML = '';
            return;
        }
        this.innerHTML = `
            <div class="app-head">
                <div class="app-head-text">
                    <input type="text" id="appName" class="app-name" aria-label="App name" autocomplete="off" spellcheck="false">
                    <input type="text" id="appDescription" class="app-description" aria-label="What the app does" placeholder="What it does, in a sentence (optional)" autocomplete="off">
                </div>
                <div class="wb-chips app-views" role="group" aria-label="How to see the app">
                    ${Object.entries(VIEWS).map(([view, label]) => `<button type="button" class="wb-chip" data-app-view-choice="${view}" aria-pressed="${this.apps.view === view}" title="${view === 'canvas' ? 'The screen running, wired to its tools' : 'The screen and the flow as cards, with the app beside them'}">${label}</button>`).join('')}
                </div>
                <span class="app-version text-secondary" id="appVersion" aria-live="polite"></span>
                <div class="split-button">
                    <button type="button" id="downloadAppBtn" class="btn-primary btn-sm" title="A zip with app.dml (the flow, as markup), index.html (the screen) and a README"><span class="icon icon-download" aria-hidden="true"></span>Download</button>
                    <details class="menu app-menu">
                        <summary class="btn-sm" aria-label="More for this app">▾</summary>
                        <div class="menu-list" role="menu">
                            <button type="button" class="menu-item" role="menuitem" id="downloadDmlBtn" title="One file with the screen and the flow">Download app.dml only</button>
                            <button type="button" class="menu-item" role="menuitem" id="duplicateAppBtn">Duplicate</button>
                            <button type="button" class="menu-item" role="menuitem" id="deleteAppBtn">Delete this app</button>
                        </div>
                    </details>
                </div>
            </div>
            <p class="app-intro text-secondary" data-outline-only>An app is a <strong>screen</strong> and a <strong>flow</strong>. Build the screen from components, or from HTML a model or a tool makes. The flow is rules: <em>when</em> something happens on the screen, <em>call</em> a tool, <em>then</em> put what it returns back on the screen. On the canvas, each rule is a tool with wires to the screen.</p>`;
        this.$('#appName').value = app.name || '';
        this.$('#appDescription').value = app.description || '';
        this.renderVersion();
        this.markView();
    }

    // The canvas explains itself in its Inspector, so the intro is the Outline's.
    markView() {
        this.querySelectorAll('[data-app-view-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appViewChoice === this.apps.view)));
        this.querySelectorAll('[data-outline-only]').forEach(element => { element.hidden = this.apps.view !== 'outline'; });
    }

    renderVersion() {
        const app = this.apps.app;
        const label = this.$('#appVersion');
        if (!app || !label) return;
        const changed = !app.downloadedAt || app.updatedAt > app.downloadedAt;
        label.textContent = !app.version
            ? 'Not downloaded yet'
            : changed ? `Version ${app.version}, changed since` : `Version ${app.version}, downloaded ${timeAgo(app.downloadedAt)}`;
        label.title = changed ? `Download makes version ${(app.version || 0) + 1}` : 'Nothing changed since this version was downloaded';
        this.$('#downloadAppBtn').innerHTML = `<span class="icon icon-download" aria-hidden="true"></span>${escapeHtml(changed ? `Download v${(app.version || 0) + 1}` : `Download v${app.version}`)}`;
    }
}
