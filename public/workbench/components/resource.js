// The request area while the tool list shows resources: the picked resource, or a resource
// template with a field for each of its variables and the URI they make, and Read. What the
// server returns shows in wb-contents. Template fields take {{variables}} and Pre-fill's test data.

import { testData } from '../prefill.js';
import { resolveArguments } from '../template.js';
import { expandTemplate, templateVariables } from '../uri-template.js';
import { escapeHtml, serverLabel } from '../util.js';
import { WbElement } from './base.js';

// A template's variables as a schema, for the shared form fields and Pre-fill's test data.
const variablesSchema = names => ({
    type: 'object',
    properties: Object.fromEntries(names.map(name => [name, { type: 'string', description: `Fills {${name}} in the URI.` }])),
    required: names,
});

export class WbResource extends WbElement {
    setup(signal) {
        this.workbench.on('view', () => this.render(), signal);
        this.workbench.on('item', ({ refreshed }) => (refreshed ? this.showUri() : this.render()), signal);
        this.workbench.on('environment', () => this.showUri(), signal);
        this.workbench.on('run-request', () => {
            if (!this.hidden) this.read();
        }, signal);
        this.addEventListener('input', event => {
            if (event.target.closest('#resourceForm')) this.showUri();
        }, { signal });
        this.addEventListener('submit', event => {
            event.preventDefault();
            this.read();
        }, { signal });
    }

    get picked() {
        const item = this.workbench.item;
        return item && item.kind !== 'prompt' ? item : null;
    }

    render() {
        this.hidden = this.workbench.view !== 'resources';
        if (this.hidden) return;
        const picked = this.picked;
        if (!picked) {
            this.innerHTML = '<div class="wb-empty">Pick a resource or a resource template to read it.</div>';
            return;
        }
        const { kind, item } = picked;
        const names = kind === 'template' ? templateVariables(item.uriTemplate) : [];
        this.schema = variablesSchema(names);
        const badges = [kind === 'template' ? 'template' : 'resource', item.mimeType].filter(Boolean);
        this.innerHTML = `
            <header class="wb-pane-head">
                <nav class="wb-crumb" aria-label="This resource">
                    <span class="wb-crumb-server">${escapeHtml(serverLabel(this.workbench.server))}</span>
                    <span class="wb-crumb-sep" aria-hidden="true">›</span>
                    <span class="wb-crumb-tool mono">${escapeHtml(item.name || item.uri || item.uriTemplate)}</span>
                </nav>
                <div class="wb-title-row">
                    <h2 class="wb-request-title">${escapeHtml(item.title || item.name || item.uri || item.uriTemplate)}</h2>
                    <span class="wb-spacer"></span>
                    <div class="wb-request-actions">
                        <button type="submit" form="resourceForm" class="btn-primary btn-sm" data-read title="Read (⌘↵ or Ctrl+Enter)" aria-keyshortcuts="Meta+Enter Control+Enter"><span class="icon icon-play" aria-hidden="true"></span>Read</button>
                    </div>
                </div>
                <span class="badge-row">${badges.map(text => `<span class="badge">${escapeHtml(text)}</span>`).join('')}</span>
                ${item.description ? `<div class="wb-description"><p>${escapeHtml(item.description)}</p></div>` : ''}
            </header>
            <div class="wb-pane-body">
                <form id="resourceForm" class="wb-form" novalidate autocomplete="off"></form>
                <p class="wb-item-uri"><span class="text-secondary">${kind === 'template' ? 'Reads' : 'URI'}</span> <code class="mono" data-uri></code></p>
                <p class="wb-item-problem text-error" hidden></p>
            </div>`;
        const form = this.$('#resourceForm');
        for (const name of names) form.appendChild(this.shell.renderInputField(name, this.schema.properties[name], true));
        if (names.length) this.shell.fillToolForm(form, this.schema, testData(this.schema, { variables: this.workbench.variables }).values);
        this.showUri();
    }

    // The URI to read. Throws, saying what's wrong, when a field uses an unknown variable.
    uri() {
        const { kind, item } = this.picked;
        if (kind === 'resource') return item.uri;
        const written = this.shell.serializeToolForm(this.$('#resourceForm'), this.schema);
        return expandTemplate(item.uriTemplate, resolveArguments(written, this.workbench.variables, this.schema));
    }

    showUri() {
        const shown = this.$('[data-uri]');
        if (!shown || !this.picked) return;
        const problem = this.$('.wb-item-problem');
        try {
            shown.textContent = this.uri();
            problem.hidden = true;
        } catch (error) {
            shown.textContent = this.picked.item.uriTemplate;
            problem.textContent = error.message;
            problem.hidden = false;
        }
    }

    async read() {
        const picked = this.picked;
        if (!picked) return;
        let uri;
        try {
            uri = this.uri();
        } catch (error) {
            this.workbench.emit('contents', { view: 'resources', phase: 'done', label: picked.item.uriTemplate, reply: { error: { kind: 'not_sent', message: error.message } } });
            return;
        }
        const url = this.shell.selectedServerUrl;
        this.workbench.emit('contents', { view: 'resources', phase: 'pending', label: uri });
        const reply = await this.shell.readResource(url, uri);
        this.workbench.emit('contents', { view: 'resources', phase: 'done', label: uri, reply });
    }
}
