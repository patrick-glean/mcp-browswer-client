// Where some HTML comes from: a model you ask ("a ticket dashboard"), or a tool you call. It's for
// a screen that is HTML and for a part of a screen built from components, and it keeps the HTML
// with what made it: the call (`from`) and, from a model, what it was asked (`ask`).

import { escapeHtml, plural } from '../../workbench/util.js';
import { ELEMENT_KINDS, partElements, sanitizePart } from '../screen.js';
import { CallEditor } from './call-editor.js';
import { ModelPicker } from './model-picker.js';

export class HtmlSourceEditor {
    // `get()` is what holds the HTML ({ html, from, ask }); `change(mutate)` edits it. With `part`,
    // the HTML is kept as a part keeps it, and its elements are named after the part. Its owner
    // calls refresh() when the tool lists change, and modelChanged() on the Apps state's 'model'.
    constructor({ shell, workbench, apps, container, get, change, part = false, signal }) {
        Object.assign(this, { shell, workbench, apps, container, get, change, part, signal });
        const target = get();
        this.source = target?.ask || (!target?.from?.toolName && apps.model()) ? 'model' : 'tool';
        container.addEventListener('click', event => this.clicked(event), { signal });
        container.addEventListener('input', event => {
            if (event.target.matches('[data-ask]')) this.change(found => { found.ask = event.target.value; });
            if (event.target.matches('[data-html]')) {
                this.change(found => { found.html = event.target.value; });
                this.renderFound();
            }
        }, { signal });
        container.addEventListener('change', event => {
            if (event.target.matches('[data-html]') && this.part) {
                const kept = sanitizePart(event.target.value);
                event.target.value = kept;
                this.change(found => { found.html = kept; });
                this.renderFound();
            }
        }, { signal });
    }

    render() {
        const target = this.get();
        if (!target) {
            this.container.innerHTML = '';
            return;
        }
        const html = target.html || '';
        const model = this.source === 'model';
        this.container.innerHTML = `
            <div class="app-source">
                <div class="wb-chips" role="group" aria-label="Where it comes from">
                    <button type="button" class="wb-chip" data-source="model" aria-pressed="${model}">Ask a model</button>
                    <button type="button" class="wb-chip" data-source="tool" aria-pressed="${!model}">Call a tool</button>
                </div>
                ${model ? `
                    <label class="app-field"><span>What to make, or what to change</span><textarea rows="2" data-ask placeholder="${this.part ? 'A ticket dashboard with a search field, a Refresh button and a list' : 'A form to ask a question, with an answer area below it'}"></textarea></label>
                    <div data-model-picker></div>
                    <div class="app-html-actions">
                        <button type="button" class="btn-sm" data-make><span class="icon icon-zap" aria-hidden="true"></span>Make it</button>
                        <button type="button" class="btn-sm btn-tertiary" data-change-html ${html.trim() ? '' : 'disabled'} title="Sends the HTML there is now, with what to change">Change it</button>
                        <span class="app-html-status text-secondary" data-html-status aria-live="polite"></span>
                    </div>` : `
                    <div class="app-call" data-source-call></div>
                    <div class="app-html-actions">
                        <button type="button" class="btn-sm" data-get-html><span class="icon icon-play" aria-hidden="true"></span>Get the HTML</button>
                        <span class="app-html-status text-secondary" data-html-status aria-live="polite"></span>
                    </div>`}
                <details class="app-html-details" ${html.trim() && !this.part ? 'open' : ''}>
                    <summary>HTML <span class="text-secondary" data-html-size></span></summary>
                    <textarea class="mono app-html-source" rows="10" data-html spellcheck="false" placeholder="&lt;button id=&quot;go&quot;&gt;Go&lt;/button&gt;"></textarea>
                </details>
                <p class="app-found text-secondary" data-found></p>
            </div>`;
        this.callEditor = null;
        this.picker = null;
        if (model) {
            this.container.querySelector('[data-ask]').value = target.ask || '';
            this.picker = new ModelPicker({ shell: this.shell, apps: this.apps, container: this.container.querySelector('[data-model-picker]'), signal: this.signal });
            this.picker.render();
        } else {
            this.callEditor = new CallEditor({
                shell: this.shell,
                workbench: this.workbench,
                container: this.container.querySelector('[data-source-call]'),
                getCall: () => this.get()?.from || { serverUrl: '', toolName: '', args: {} },
                setCall: call => this.change(found => { found.from = call; }),
                signal: this.signal,
            });
            this.callEditor.render();
        }
        this.container.querySelector('[data-html]').value = html;
        this.renderFound();
    }

    // The tool list changed: the call's menus and the model's follow it, unless someone is using them.
    refresh() {
        if (this.callEditor && !this.container.contains(document.activeElement)) this.callEditor.render();
        this.picker?.refresh();
    }

    modelChanged() {
        this.picker?.render();
    }

    elements() {
        const target = this.get();
        return this.part ? partElements(target) : this.apps.elements();
    }

    // The elements with ids the flow can use, as found in the HTML.
    renderFound() {
        const found = this.container.querySelector('[data-found]');
        const size = this.container.querySelector('[data-html-size]');
        if (!found) return;
        const html = this.get()?.html || '';
        size.textContent = html ? `(${plural(html.length, 'character')})` : '(none yet)';
        const elements = this.elements().filter(element => !this.part || element.part);
        found.innerHTML = elements.length
            ? `${plural(elements.length, 'element')} with ids the flow can use: ${elements.map(element => `<code>${escapeHtml(element.id)}</code> <span class="app-kind">${escapeHtml(ELEMENT_KINDS[element.kind].toLowerCase())}</span>`).join(', ')}`
            : html.trim() ? 'None of its elements has an id, so the flow can\'t use them. Ask for ids, or add them below.' : '';
    }

    status(text, { error = false } = {}) {
        const status = this.container.querySelector('[data-html-status]');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('text-error', error);
    }

    // Keeps the HTML a tool or a model sent, with what made it.
    keep({ html, call }, { ask = null } = {}) {
        this.change(found => {
            found.html = html;
            found.from = call;
            if (ask !== null) found.ask = ask;
        });
        this.container.querySelector('[data-html]').value = html;
        this.container.querySelector('[data-change-html]')?.removeAttribute('disabled');
        this.renderFound();
    }

    async clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || !this.container.contains(button) || button.closest('[data-source-call]')) return;
        const { dataset } = button;
        if (dataset.source) {
            if (dataset.source === this.source) return;
            this.source = dataset.source;
            return this.render();
        }
        if (dataset.getHtml === undefined && dataset.make === undefined && dataset.changeHtml === undefined) return;
        const target = this.get();
        const changing = dataset.changeHtml !== undefined;
        button.disabled = true;
        this.status(dataset.getHtml !== undefined ? `Calling ${target.from?.toolName || 'the tool'}…` : changing ? 'Asking the model to change it…' : 'Asking the model…');
        const reply = dataset.getHtml !== undefined
            ? await this.apps.htmlFrom(target.from, { part: this.part })
            : await this.apps.htmlFromModel(target.ask, { part: this.part, current: changing ? target.html || '' : '' });
        button.disabled = false;
        if (reply.error) return this.status(reply.error, { error: true });
        this.keep(reply, { ask: dataset.getHtml !== undefined ? '' : target.ask });
        this.status(`Got ${plural(reply.html.length, 'character')} of HTML from ${reply.call.toolName}.`);
    }
}
