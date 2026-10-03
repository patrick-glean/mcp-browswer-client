// The request pane: the selected tool's arguments as a form, what the call will send with
// {{variables}} filled in, and the tool's schema, with Pre-fill, Save and Run.

import { NEW_COLLECTION } from '../workbench.js';
import { previewText, variablesIn } from '../template.js';
import { debounce, escapeHtml, plural, schemaOf, serverLabel, timeAgo, toolBadges, toolTitle } from '../util.js';
import { WbElement } from './base.js';

const TABS = [['arguments', 'Arguments'], ['sends', 'Sends'], ['schema', 'Schema']];

const schemaBlock = (label, value, open) => value
    ? `<details class="tool-schema" ${open ? 'open' : ''}><summary>${label}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`
    : '';

export class WbRequest extends WbElement {
    setup(signal) {
        this.tab = 'arguments';
        this.updateSoon = debounce(() => this.updatePreview(), 150);
        this.workbench.on('tool', ({ refreshed }) => this.render({ keepValues: refreshed }), signal);
        this.workbench.on('request', () => this.renderCrumb(), signal);
        this.workbench.on('fill', detail => this.fill(detail), signal);
        this.workbench.on('environment', () => this.updatePreview(), signal);
        this.workbench.on('run-request', () => this.run(), signal);
        this.workbench.on('save-request', () => this.openSavePanel(), signal);
        this.shell.on('servers', ({ url }) => {
            if (url === this.shell.selectedServerUrl) this.renderCrumb();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('input', event => {
            if (event.target.closest('#requestForm')) this.updateSoon();
        }, { signal });
        this.addEventListener('submit', event => {
            event.preventDefault();
            if (event.target.id === 'requestForm') this.run();
        }, { signal });
        // Enter in the save panel saves; it sits outside the form, so it never runs the tool.
        this.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || !event.target.closest('.save-request')) return;
            event.preventDefault();
            this.saveFromPanel({ asNew: false });
        }, { signal });
        // <details> toggle events don't bubble, so this listens while they travel down.
        this.addEventListener('toggle', event => {
            if (event.target.classList?.contains('prefill-menu') && event.target.open) this.renderPrefillMenu(event.target);
        }, { signal, capture: true });
    }

    get form() {
        return this.$('#requestForm');
    }

    render({ keepValues = false } = {}) {
        const tool = this.workbench.tool;
        if (!tool) {
            const server = this.workbench.server;
            this.shownTool = null;
            this.innerHTML = `<div class="wb-empty">${server?.tools?.length ? 'Pick a tool to fill in its arguments and run it.' : 'Tools you pick show up here, ready to fill in and run.'}</div>`;
            return;
        }
        // A refreshed definition of the same tool keeps what's been typed.
        let kept = null;
        if (keepValues && this.form && this.shownTool) {
            try { kept = this.shell.serializeToolForm(this.form, schemaOf(this.shownTool)); } catch { /* start over */ }
        }
        this.shownTool = tool;
        const schema = schemaOf(tool);
        const title = toolTitle(tool);
        this.innerHTML = `
            <header class="wb-pane-head">
                <nav class="wb-crumb" aria-label="This request"></nav>
                <div class="wb-title-row">
                    <h2 class="wb-request-title">${escapeHtml(title || tool.name)}</h2>
                    <span class="wb-spacer"></span>
                    <div class="wb-request-actions">
                        <div class="split-button">
                            <button type="button" class="btn-sm" data-prefill-best title="Fill the fields from what you last sent, a saved request or the schema">Pre-fill</button>
                            <details class="menu prefill-menu">
                                <summary class="btn-sm" aria-label="Choose what to pre-fill from">▾</summary>
                                <div class="menu-list" role="menu"></div>
                            </details>
                        </div>
                        <button type="button" class="btn-sm" data-save-request title="Save (⌘S or Ctrl+S)" aria-keyshortcuts="Meta+S Control+S">Save</button>
                        <button type="submit" form="requestForm" class="btn-primary btn-sm" id="runBtn" title="Run (⌘↵ or Ctrl+Enter)" aria-keyshortcuts="Meta+Enter Control+Enter"><span class="icon icon-play" aria-hidden="true"></span>Run</button>
                    </div>
                </div>
                ${toolBadges(tool)}
                ${tool.description ? `<div class="wb-description"><p data-description>${escapeHtml(tool.description)}</p><button type="button" class="link-button" data-more-description hidden>More</button></div>` : ''}
                <p class="wb-request-note text-secondary" aria-live="polite"></p>
                <div class="save-request" hidden></div>
                <div class="wb-tabs" role="tablist" aria-label="Request">
                    ${TABS.map(([id, label]) => `<button type="button" role="tab" class="wb-tab" data-request-tab="${id}" aria-selected="${id === this.tab}">${label}</button>`).join('')}
                </div>
            </header>
            <div class="wb-pane-body">
                <form id="requestForm" class="wb-form" data-panel="arguments" novalidate autocomplete="off"></form>
                <div id="sendsPreview" class="sends-preview" data-panel="sends">
                    <p class="wb-sends-head text-secondary"></p>
                    <pre></pre>
                    <p class="sends-error text-error" hidden></p>
                </div>
                <div class="tool-schemas" data-panel="schema">
                    ${schemaBlock('Input schema', schema, true)}
                    ${schemaBlock('Output schema', tool.outputSchema, true)}
                    ${schemaBlock('Definition (raw JSON)', tool, false)}
                </div>
            </div>`;
        this.renderFields(schema);
        this.renderCrumb();
        this.showTab(this.tab);
        if (kept) this.shell.fillToolForm(this.form, schema, kept);
        this.updatePreview();
        requestAnimationFrame(() => this.clampDescription());
    }

    // Required fields first. With several fields, the optional ones fold away until one has a value.
    renderFields(schema) {
        const form = this.form;
        const properties = Object.entries(schema?.properties || {});
        if (!properties.length) {
            form.innerHTML = '<p class="text-secondary">This tool takes no arguments.</p>';
            return;
        }
        const required = new Set(schema.required || []);
        const requiredFields = properties.filter(([key]) => required.has(key));
        const optionalFields = properties.filter(([key]) => !required.has(key));
        for (const [key, prop] of requiredFields) form.appendChild(this.shell.renderInputField(key, prop, true));
        if (requiredFields.length && optionalFields.length && properties.length > 3) {
            const more = document.createElement('details');
            more.className = 'wb-optional';
            more.innerHTML = `<summary>${plural(optionalFields.length, 'optional field')}: ${escapeHtml(optionalFields.map(([key]) => key).join(', '))}</summary>`;
            for (const [key, prop] of optionalFields) more.appendChild(this.shell.renderInputField(key, prop, false));
            form.appendChild(more);
        } else {
            for (const [key, prop] of optionalFields) form.appendChild(this.shell.renderInputField(key, prop, false));
        }
    }

    renderCrumb() {
        const crumb = this.$('.wb-crumb');
        const tool = this.workbench.tool;
        if (!crumb || !tool) return;
        const request = this.workbench.openRequest;
        crumb.innerHTML = `
            <button type="button" class="link-button wb-crumb-server" data-server-info title="Server details">${escapeHtml(serverLabel(this.workbench.server))}</button>
            <span class="wb-crumb-sep" aria-hidden="true">›</span>
            <span class="wb-crumb-tool mono">${escapeHtml(tool.name)}</span>
            ${request ? `<span class="wb-crumb-sep" aria-hidden="true">›</span><span class="wb-crumb-request">${escapeHtml(request.name)}</span>` : ''}`;
    }

    // Long descriptions show three lines until you ask for more.
    clampDescription() {
        const text = this.$('[data-description]');
        const more = this.$('[data-more-description]');
        if (text && more) more.hidden = text.scrollHeight <= text.clientHeight + 1;
    }

    showTab(tab) {
        this.tab = tab;
        this.querySelectorAll('[data-request-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.requestTab === tab)));
        this.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
    }

    note(text, unknownArguments = []) {
        const note = this.$('.wb-request-note');
        if (!note) return;
        const extra = unknownArguments.length ? ` Not in this tool's schema, so not sent: ${unknownArguments.join(', ')}.` : '';
        note.textContent = text ? `${text}${extra}` : '';
    }

    fill({ args, text }) {
        if (!this.form || !this.workbench.tool) return;
        const unknown = this.shell.fillToolForm(this.form, schemaOf(this.workbench.tool), args);
        const more = this.$('.wb-optional');
        if (more && [...more.querySelectorAll('[name]')].some(input => input.value)) more.open = true;
        this.note(text, unknown);
        this.updatePreview();
    }

    // Under each field that uses {{variables}}: its value once they're filled in.
    showResolvedValues() {
        this.form.querySelectorAll('.wb-resolved').forEach(hint => hint.remove());
        const variables = this.workbench.variables;
        const environment = this.workbench.environment?.name || 'this environment';
        for (const input of this.form.querySelectorAll('[name]')) {
            if (!variablesIn(input.value).size) continue;
            const { value, missing } = previewText(input.value, variables);
            const hint = document.createElement('span');
            hint.className = `wb-resolved${missing.length ? ' text-error' : ''}`;
            hint.textContent = missing.length
                ? `{{${missing[0]}}} isn't a variable in ${environment}`
                : `→ ${value} · from ${environment}`;
            (input.closest('.array-item') || input).after(hint);
        }
    }

    updatePreview() {
        const form = this.form;
        const tool = this.workbench.tool;
        if (!form || !tool) return;
        this.showResolvedValues();
        const box = this.$('#sendsPreview');
        const head = box.querySelector('.wb-sends-head');
        const pre = box.querySelector('pre');
        const error = box.querySelector('.sends-error');
        const tab = this.$('[data-request-tab="sends"]');
        const show = ({ text = '', heading, problem = '', label = 'Sends' }) => {
            head.textContent = heading;
            pre.textContent = text;
            pre.hidden = !!problem;
            error.textContent = problem;
            error.hidden = !problem;
            tab.textContent = label;
        };
        let args;
        try {
            args = this.shell.serializeToolForm(form, schemaOf(tool));
        } catch (problem) {
            return show({ heading: 'Check the fields first:', problem: problem.message, label: 'Sends · !' });
        }
        const used = variablesIn(args).size;
        try {
            const sent = this.workbench.prepare(tool, args).sentArgs;
            show({
                text: JSON.stringify(sent, null, 2),
                heading: used ? `With ${plural(used, 'variable')} from ${this.workbench.environment.name}:` : 'What the call sends:',
                label: used ? `Sends · ${plural(used, 'variable')}` : 'Sends',
            });
        } catch (problem) {
            show({ heading: 'A variable needs attention:', problem: problem.message, label: 'Sends · !' });
        }
    }

    run() {
        const tool = this.workbench.tool;
        if (!tool || !this.form) return;
        let args;
        try {
            args = this.shell.serializeToolForm(this.form, schemaOf(tool));
        } catch (error) {
            this.workbench.notSent(error.message);
            return;
        }
        this.workbench.run(args);
    }

    // --- Pre-fill ---

    async renderPrefillMenu(menu) {
        const list = menu.querySelector('.menu-list');
        list.innerHTML = '<span class="menu-note">Loading…</span>';
        const choices = await this.workbench.prefillChoices();
        const { last, saved } = choices;
        this.prefillShown = choices;
        const item = (source, label, disabled = false) =>
            `<button type="button" role="menuitem" class="menu-item" data-prefill-source="${escapeHtml(source)}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
        list.innerHTML = [
            item('last', last?.args ? `What you last sent, ${timeAgo(last.startedAt)}` : 'What you last sent (nothing yet)', !last?.args),
            ...saved.map(request => item(`saved:${request.id}`, `Saved: ${request.name}`)),
            saved.length ? '' : '<span class="menu-note">No saved requests for this tool yet</span>',
            item('schema', 'From the schema'),
            item('clear', 'Clear the fields'),
        ].join('');
    }

    // --- Save ---

    defaultRequestName(args) {
        const tool = this.workbench.tool;
        const first = Object.values(args || {}).find(value => typeof value === 'string' && value.trim());
        const name = first ? `${tool.name}: ${first.trim()}` : tool.name;
        return name.length > 60 ? `${name.slice(0, 57)}…` : name;
    }

    async openSavePanel({ toggle = false } = {}) {
        const panel = this.$('.save-request');
        if (!panel || !this.workbench.tool) return;
        if (!panel.hidden) {
            if (toggle) panel.hidden = true;
            else panel.querySelector('[data-save-name]')?.focus();
            return;
        }
        const collections = await this.workbench.collections();
        const editing = this.workbench.openRequest;
        let args = {};
        try { args = this.shell.serializeToolForm(this.form, schemaOf(this.workbench.tool)); } catch { /* named after the tool alone */ }
        panel.innerHTML = `
            <div class="save-request-fields">
                <label class="field"><span class="field-label">Name</span><input type="text" data-save-name autocomplete="off"></label>
                <label class="field"><span class="field-label">Collection</span>
                    <select data-save-collection>
                        <option value="">No collection</option>
                        ${collections.map(collection => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join('')}
                        <option value="${NEW_COLLECTION}">New collection…</option>
                    </select>
                </label>
                <label class="field" data-new-collection hidden><span class="field-label">New collection name</span><input type="text" data-save-new-collection autocomplete="off"></label>
            </div>
            <div class="button-row">
                <button type="button" class="btn-primary btn-sm" data-save-confirm>${editing ? `Save changes to ${escapeHtml(editing.name)}` : 'Save'}</button>
                ${editing ? '<button type="button" class="btn-sm" data-save-as-new>Save as new</button>' : ''}
                <button type="button" class="btn-sm btn-tertiary" data-save-cancel>Cancel</button>
            </div>
            <p class="text-error" data-save-error hidden></p>`;
        const name = panel.querySelector('[data-save-name]');
        const collection = panel.querySelector('[data-save-collection]');
        name.value = editing?.name || this.defaultRequestName(args);
        collection.value = editing?.collectionId || (collections.length === 1 ? collections[0].id : '');
        collection.addEventListener('change', () => {
            const adding = collection.value === NEW_COLLECTION;
            panel.querySelector('[data-new-collection]').hidden = !adding;
            if (adding) panel.querySelector('[data-save-new-collection]').focus();
        });
        panel.hidden = false;
        name.select();
    }

    async saveFromPanel({ asNew }) {
        const panel = this.$('.save-request');
        const fail = text => {
            const error = panel.querySelector('[data-save-error]');
            error.textContent = text;
            error.hidden = false;
        };
        let args;
        try {
            args = this.shell.serializeToolForm(this.form, schemaOf(this.workbench.tool));
        } catch (error) {
            return fail(error.message);
        }
        try {
            const saved = await this.workbench.saveRequest({
                name: panel.querySelector('[data-save-name]').value.trim() || this.defaultRequestName(args),
                collectionId: panel.querySelector('[data-save-collection]').value || null,
                newCollectionName: panel.querySelector('[data-save-new-collection]').value.trim(),
                args,
                asNew,
            });
            panel.hidden = true;
            this.note(`Saved as ${saved.name}.`);
        } catch (error) {
            fail(error.message);
        }
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const { dataset } = button;
        if (dataset.requestTab) return this.showTab(dataset.requestTab);
        if (dataset.prefillBest !== undefined) return this.workbench.prefillBest();
        if (dataset.prefillSource) {
            button.closest('details.menu').open = false;
            return this.workbench.prefill(dataset.prefillSource, this.prefillShown || {});
        }
        if (dataset.saveRequest !== undefined) return this.openSavePanel({ toggle: true });
        if (dataset.saveConfirm !== undefined) return this.saveFromPanel({ asNew: false });
        if (dataset.saveAsNew !== undefined) return this.saveFromPanel({ asNew: true });
        if (dataset.saveCancel !== undefined) {
            this.$('.save-request').hidden = true;
            return;
        }
        if (dataset.serverInfo !== undefined) return this.workbench.openSheet('server');
        if (dataset.moreDescription !== undefined) {
            const expanded = this.$('.wb-description').classList.toggle('expanded');
            button.textContent = expanded ? 'Less' : 'More';
        }
    }
}
