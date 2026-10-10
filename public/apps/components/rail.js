// The Apps page's left rail: the built-in Chat app, the apps you've built, and New app and Import.

import { escapeHtml } from '../../workbench/util.js';
import { CHAT } from '../apps.js';
import { AppElement } from './base.js';

export class AppsRail extends AppElement {
    setup(signal) {
        this.apps.on('list', () => this.render(), signal);
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', ({ part }) => {
            if (part === 'version') this.render();
        }, signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.showApp) this.apps.show(button.dataset.showApp);
            if (button.id === 'newAppBtn') this.apps.create();
            if (button.id === 'newDashboardBtn') this.apps.create('dashboard');
            if (button.id === 'importAppBtn') this.$('#importAppInput').click();
        }, { signal });
        this.addEventListener('change', event => {
            if (event.target.id !== 'importAppInput') return;
            const [file] = event.target.files;
            event.target.value = '';
            if (file) this.apps.importFile(file);
        }, { signal });
    }

    render() {
        const shown = this.apps.shownId;
        const row = (id, label, meta, title) => `
            <li>
                <button type="button" class="wb-row" data-show-app="${escapeHtml(id)}" ${shown === id ? 'aria-current="true"' : ''} title="${escapeHtml(title)}">
                    <span class="wb-row-label">${escapeHtml(label)}</span>
                    ${meta ? `<span class="wb-meta">${escapeHtml(meta)}</span>` : ''}
                </button>
            </li>`;
        this.innerHTML = `
            <section class="wb-section" aria-labelledby="appsBuiltIn">
                <header class="wb-section-head"><h2 id="appsBuiltIn">Built in</h2></header>
                <ul class="wb-list">${row(CHAT, 'Chat', 'agent loop', 'A model as an MCP tool, with your servers\' tools to call')}</ul>
            </section>
            <section class="wb-section" aria-labelledby="appsYours">
                <header class="wb-section-head"><h2 id="appsYours">Your apps</h2></header>
                <ul class="wb-list" id="appList">${this.apps.list.length
                    ? this.apps.list.map(app => row(app.id, app.name || 'Untitled app', app.version ? `v${app.version}` : '', app.description || app.name)).join('')
                    : '<li class="wb-list-note">None yet. An app is a screen and a flow: when something happens on the screen, call a tool, and show what it returns.</li>'}
                </ul>
                <div class="apps-rail-actions">
                    <button type="button" id="newAppBtn" class="btn-sm"><span class="icon icon-plus" aria-hidden="true"></span>New app</button>
                    <button type="button" id="newDashboardBtn" class="btn-sm" title="A dashboard whose boxes each ask one tool for their piece of its answer: Glean's chat if you've added Glean, else the Chat app's model"><span class="icon icon-plus" aria-hidden="true"></span>Dashboard</button>
                    <button type="button" id="importAppBtn" class="btn-sm btn-tertiary" title="A zip from Download, or an app.dml file">Import…</button>
                    <input type="file" id="importAppInput" accept=".zip,.dml,.xml,application/zip,application/xml,text/xml" hidden>
                </div>
            </section>`;
    }
}
