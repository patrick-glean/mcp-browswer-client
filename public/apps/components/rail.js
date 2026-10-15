// The Apps page's left rail: the examples to start from (each asks before adding a copy), the
// apps you've built, and New app and Import. With no app shown, AppsStart offers the examples on
// the page itself.

import { confirmThen, escapeHtml } from '../../workbench/util.js';
import { EXAMPLES } from '../apps.js';
import { AppElement } from './base.js';
import { ModelPicker } from './model-picker.js';

const SHOWN_EXAMPLES = ['chat', 'dashboard', 'frontdesk'];

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
            // Delete asks for a second click, so its menu stays open for it.
            if (button.dataset.deleteApp) return confirmThen(button, () => this.apps.remove(button.dataset.deleteApp));
            button.closest('details.menu')?.removeAttribute('open');
            if (button.dataset.showApp) this.apps.show(button.dataset.showApp);
            if (button.dataset.example) this.apps.offerExample(button.dataset.example);
            if (button.dataset.launchApp) this.apps.launchInTab(button.dataset.launchApp);
            if (button.dataset.duplicateApp) this.apps.duplicate(button.dataset.duplicateApp);
            if (button.id === 'newAppBtn') this.apps.create();
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
        const row = (attributes, label, meta, title) => `
            <li>
                <button type="button" class="wb-row" ${attributes} title="${escapeHtml(title)}">
                    <span class="wb-row-label">${escapeHtml(label)}</span>
                    ${meta ? `<span class="wb-meta">${escapeHtml(meta)}</span>` : ''}
                </button>
            </li>`;
        this.innerHTML = `
            <section class="wb-section" aria-labelledby="appsExamples">
                <header class="wb-section-head"><h2 id="appsExamples">Examples</h2></header>
                <ul class="wb-list">${SHOWN_EXAMPLES.map(example => {
                    const { name, kind, about } = EXAMPLES[example];
                    return row(`data-example="${example}"`, name, kind, `${about}. Asks before adding a copy under Your apps, to look at and change.`);
                }).join('')}</ul>
            </section>
            <section class="wb-section" aria-labelledby="appsYours">
                <header class="wb-section-head"><h2 id="appsYours">Your apps</h2></header>
                <ul class="wb-list" id="appList">${this.apps.list.length
                    ? this.apps.list.map(app => this.appRow(app, shown === app.id)).join('')
                    : '<li class="wb-list-note">None yet. An app is a screen and a flow: when something happens on the screen, call a tool, and show what it returns.</li>'}
                </ul>
                <div class="apps-rail-actions">
                    <button type="button" id="newAppBtn" class="btn-sm" title="${escapeHtml(EXAMPLES.blank.about)}"><span class="icon icon-plus" aria-hidden="true"></span>New app</button>
                    <button type="button" id="importAppBtn" class="btn-sm btn-tertiary" title="A zip from Download, or an app.dml file">Import…</button>
                    <input type="file" id="importAppInput" accept=".zip,.dml,.xml,application/zip,application/xml,text/xml" hidden>
                </div>
            </section>`;
    }

    // One of your apps, with its own menu: Launch, Duplicate and Delete. The shown app's ⋯ is
    // always there; the others' show when pointed at or focused.
    appRow(app, current) {
        const name = app.name || 'Untitled app';
        const id = escapeHtml(app.id);
        return `
            <li class="apps-row">
                <button type="button" class="wb-row" data-show-app="${id}" ${current ? 'aria-current="true"' : ''} title="${escapeHtml(app.description || name)}">
                    <span class="wb-row-label">${escapeHtml(name)}</span>
                    ${app.version ? `<span class="wb-meta">v${app.version}</span>` : ''}
                </button>
                <details class="menu item-menu apps-row-menu">
                    <summary class="btn-icon btn-sm btn-tertiary" aria-label="${escapeHtml(`More for ${name}`)}" title="Launch, duplicate or delete it"><span class="wb-more" aria-hidden="true">⋯</span></summary>
                    <div class="menu-list" role="menu">
                        <button type="button" class="menu-item" role="menuitem" data-launch-app="${id}" title="The app on its own, in a new tab, at an address you can bookmark">Launch in a new tab</button>
                        <button type="button" class="menu-item" role="menuitem" data-duplicate-app="${id}">Duplicate</button>
                        <button type="button" class="menu-item" role="menuitem" data-delete-app="${id}">Delete</button>
                    </div>
                </details>
            </li>`;
    }
}

// What the Apps page shows when there's no app to show: the examples, and a blank app, to start
// from, and the model the examples call; or, launched, why the app can't run.
export class AppsStart extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.apps.on('shown', () => {
            if (this.apps.launched) this.render();
        }, signal);
        this.apps.on('model', () => this.picker?.render(), signal);
        this.shell.on('tools', () => this.picker?.refresh(), signal);
        this.shell.on('servers', () => this.picker?.refresh(), signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('[data-example]');
            if (button) this.apps.offerExample(button.dataset.example);
        }, { signal });
    }

    render() {
        const problem = this.apps.launched?.problem;
        if (problem) {
            this.picker = null;
            this.innerHTML = `
                <header class="wb-apps-head">
                    <h2>This app can't run</h2>
                    <p class="text-secondary">${escapeHtml(problem)}</p>
                </header>
                <p><a href="./">Open MCP Browser Client</a></p>`;
            return;
        }
        this.innerHTML = `
            <header class="wb-apps-head">
                <h2>Start an app</h2>
                <p class="text-secondary">An app is a screen and a flow: when something happens on the screen, it calls a tool and shows what comes back. Start from an example and change it, or from a blank one.</p>
            </header>
            <ul class="apps-start-list">${[...SHOWN_EXAMPLES, 'blank'].map(example => `
                <li>
                    <button type="button" class="apps-start-card" data-example="${example}">
                        <span class="apps-start-name">${escapeHtml(EXAMPLES[example].name)}</span>
                        <span class="text-secondary">${escapeHtml(EXAMPLES[example].about)}.</span>
                    </button>
                </li>`).join('')}
            </ul>
            <div class="apps-start-model">
                <p class="app-note text-secondary">Chat and Project pulse call this model: Glean's chat if you've added Glean, else a server's chat tool, else the demo model, built in, which makes up its answers. Front desk calls no model: it comes with a demo server of its own. Both run in this page, so the examples work with nothing to install.</p>
                <div data-model-picker></div>
            </div>`;
        this.picker = new ModelPicker({ shell: this.shell, apps: this.apps, container: this.$('[data-model-picker]'), signal: this.signal });
        this.picker.render();
    }
}
