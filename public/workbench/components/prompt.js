// The request area while the tool list shows prompts: the picked prompt's arguments, the required
// ones filled in with Pre-fill's test data, and Get. Fill beside an argument fills that one. The
// messages the server returns show in wb-contents. Arguments are text, and take {{variables}}
// like a tool's fields.

import { testData } from '../prefill.js';
import { resolveArguments } from '../template.js';
import { addFillButtons, escapeHtml, fillField, serverLabel } from '../util.js';
import { WbElement } from './base.js';

// A prompt's arguments as a schema, for the shared form fields and Pre-fill's test data.
const argumentsSchema = prompt => {
    const list = Array.isArray(prompt.arguments) ? prompt.arguments : [];
    return {
        type: 'object',
        properties: Object.fromEntries(list.map(argument => [argument.name, { type: 'string', ...(argument.description ? { description: argument.description } : {}) }])),
        required: list.filter(argument => argument.required).map(argument => argument.name),
    };
};

export class WbPrompt extends WbElement {
    setup(signal) {
        this.workbench.on('view', () => this.render(), signal);
        this.workbench.on('item', ({ refreshed }) => {
            if (!refreshed) this.render();
        }, signal);
        this.workbench.on('run-request', () => {
            if (!this.hidden) this.get();
        }, signal);
        this.workbench.on('environment', () => {
            const form = this.$('#promptForm');
            if (form && this.schema) addFillButtons(form, this.schema, this.workbench);
        }, signal);
        this.addEventListener('submit', event => {
            event.preventDefault();
            this.get();
        }, { signal });
        this.addEventListener('click', event => {
            const path = event.target.closest('[data-fill-field]')?.dataset.fillField;
            if (path) fillField(this.$('#promptForm'), this.schema, path, this);
        }, { signal });
    }

    get picked() {
        const item = this.workbench.item;
        return item?.kind === 'prompt' ? item.item : null;
    }

    render() {
        this.hidden = this.workbench.view !== 'prompts';
        if (this.hidden) return;
        const prompt = this.picked;
        if (!prompt) {
            this.innerHTML = '<div class="wb-empty">Pick a prompt to fill in its arguments and get it.</div>';
            return;
        }
        this.schema = argumentsSchema(prompt);
        const names = Object.keys(this.schema.properties);
        const required = new Set(this.schema.required);
        this.innerHTML = `
            <header class="wb-pane-head">
                <nav class="wb-crumb" aria-label="This prompt">
                    <span class="wb-crumb-server">${escapeHtml(serverLabel(this.workbench.server))}</span>
                    <span class="wb-crumb-sep" aria-hidden="true">›</span>
                    <span class="wb-crumb-tool mono">${escapeHtml(prompt.name)}</span>
                </nav>
                <div class="wb-title-row">
                    <h2 class="wb-request-title">${escapeHtml(prompt.title || prompt.name)}</h2>
                    <span class="wb-spacer"></span>
                    <div class="wb-request-actions">
                        <button type="submit" form="promptForm" class="btn-primary btn-sm" data-get title="Get (⌘↵ or Ctrl+Enter)" aria-keyshortcuts="Meta+Enter Control+Enter"><span class="icon icon-play" aria-hidden="true"></span>Get</button>
                    </div>
                </div>
                ${prompt.description ? `<div class="wb-description"><p>${escapeHtml(prompt.description)}</p></div>` : ''}
            </header>
            <div class="wb-pane-body">
                <form id="promptForm" class="wb-form" novalidate autocomplete="off">
                    ${names.length ? '' : '<p class="text-secondary">This prompt takes no arguments.</p>'}
                </form>
            </div>`;
        const form = this.$('#promptForm');
        const ordered = [...names.filter(name => required.has(name)), ...names.filter(name => !required.has(name))];
        for (const name of ordered) form.appendChild(this.shell.renderInputField(name, this.schema.properties[name], required.has(name)));
        if (names.length) this.shell.fillToolForm(form, this.schema, testData(this.schema, { variables: this.workbench.variables }).values);
        addFillButtons(form, this.schema, this.workbench);
    }

    async get() {
        const prompt = this.picked;
        if (!prompt) return;
        let args;
        try {
            const written = this.shell.serializeToolForm(this.$('#promptForm'), this.schema);
            args = resolveArguments(written, this.workbench.variables, this.schema);
        } catch (error) {
            this.workbench.emit('contents', { view: 'prompts', phase: 'done', label: prompt.name, reply: { error: { kind: 'not_sent', message: error.message } } });
            return;
        }
        const url = this.shell.selectedServerUrl;
        this.workbench.emit('contents', { view: 'prompts', phase: 'pending', label: prompt.name });
        const reply = await this.shell.getPrompt(url, prompt.name, args);
        this.workbench.emit('contents', { view: 'prompts', phase: 'done', label: prompt.name, reply });
    }
}
