// The Apps page's left rail: the examples to start from, the apps you've built, and New app and
// Import. With no app shown, AppsStart offers the examples on the page itself.

import { escapeHtml } from '../../workbench/util.js';
import { EXAMPLES } from '../apps.js';
import { AppElement } from './base.js';
import { ModelPicker } from './model-picker.js';

const SHOWN_EXAMPLES = ['chat', 'dashboard'];

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
            if (button.dataset.example) this.apps.create(button.dataset.example);
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
                    return row(`data-example="${example}"`, name, kind, `${about}. Makes one you can change, under Your apps.`);
                }).join('')}</ul>
            </section>
            <section class="wb-section" aria-labelledby="appsYours">
                <header class="wb-section-head"><h2 id="appsYours">Your apps</h2></header>
                <ul class="wb-list" id="appList">${this.apps.list.length
                    ? this.apps.list.map(app => row(`data-show-app="${escapeHtml(app.id)}" ${shown === app.id ? 'aria-current="true"' : ''}`, app.name || 'Untitled app', app.version ? `v${app.version}` : '', app.description || app.name)).join('')
                    : '<li class="wb-list-note">None yet. An app is a screen and a flow: when something happens on the screen, call a tool, and show what it returns.</li>'}
                </ul>
                <div class="apps-rail-actions">
                    <button type="button" id="newAppBtn" class="btn-sm" title="${escapeHtml(EXAMPLES.blank.about)}"><span class="icon icon-plus" aria-hidden="true"></span>New app</button>
                    <button type="button" id="importAppBtn" class="btn-sm btn-tertiary" title="A zip from Download, or an app.dml file">Import…</button>
                    <input type="file" id="importAppInput" accept=".zip,.dml,.xml,application/zip,application/xml,text/xml" hidden>
                </div>
            </section>`;
    }
}

// What the Apps page shows when there's no app to show: the examples, and a blank app, to start
// from, and the model the examples call.
export class AppsStart extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.apps.on('model', () => this.picker?.render(), signal);
        this.shell.on('tools', () => this.picker?.refresh(), signal);
        this.shell.on('servers', () => this.picker?.refresh(), signal);
        this.addEventListener('click', event => {
            const button = event.target.closest('[data-example]');
            if (button) this.apps.create(button.dataset.example);
        }, { signal });
    }

    render() {
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
                <p class="app-note text-secondary">The examples call this model. Without Glean, the mock server's chat tool stands in for one.</p>
                <div data-model-picker></div>
            </div>`;
        this.picker = new ModelPicker({ shell: this.shell, apps: this.apps, container: this.$('[data-model-picker]'), signal: this.signal });
        this.picker.render();
    }
}
