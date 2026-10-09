// The app builder's Screen: what people see. Either components (a title, text, text boxes, buttons
// and outputs) with the ids the flow names them by, or HTML: from a tool call, or pasted in.

import { debounce, escapeHtml, plural, schemaOf } from '../../workbench/util.js';
import { answerOf, callArguments, elementIdProblem, toolResult } from '../flow.js';
import { COMPONENT_TYPES, componentsHtml, ELEMENT_KINDS, htmlFromResult, newComponent } from '../screen.js';
import { AppElement } from './base.js';
import { CallEditor } from './call-editor.js';

// What each component lets you set, in order: [prop, label, kind].
const PROPS = {
    title: [['text', 'Text', 'text']],
    text: [['text', 'Text', 'lines']],
    textbox: [['label', 'Label', 'text'], ['placeholder', 'Placeholder', 'text'], ['lines', 'Lines', 'number']],
    button: [['label', 'Label', 'text']],
    output: [['label', 'Label', 'text'], ['placeholder', 'When empty', 'text']],
};

export class AppScreen extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.renderFoundSoon = debounce(() => this.renderFound(), 250);
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'screen' && by !== this) this.render();
        }, signal);
        this.shell.on('tools', () => {
            if (this.apps.app?.screen.kind === 'html' && !this.contains(document.activeElement)) this.callEditor?.render();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('input', event => this.edited(event), { signal });
        this.addEventListener('change', event => {
            if (event.target.matches('[data-component-id]')) this.renameComponent(event.target);
        }, { signal });
        this.addEventListener('mouseover', event => {
            const row = event.target.closest('[data-component]');
            if (row && row.dataset.component !== this.pointedAt) {
                this.pointedAt = row.dataset.component;
                this.apps.emit('highlight', { elements: [row.dataset.component] });
            }
        }, { signal });
        this.addEventListener('mouseleave', () => {
            this.pointedAt = null;
            this.apps.emit('highlight', { elements: [] });
        }, { signal });
    }

    get screen() {
        return this.apps.app?.screen;
    }

    change(mutate, { render = false } = {}) {
        this.apps.change(app => mutate(app.screen), { part: 'screen', by: this });
        if (render) this.render();
    }

    render() {
        const screen = this.screen;
        if (!screen) {
            this.innerHTML = '';
            return;
        }
        const html = screen.kind === 'html';
        this.innerHTML = `
            <section class="app-section" aria-labelledby="appScreenTitle">
                <header class="app-section-head">
                    <h3 id="appScreenTitle"><span class="app-step" aria-hidden="true">1</span>Screen</h3>
                    <div class="wb-chips" role="group" aria-label="What the screen is made of">
                        <button type="button" class="wb-chip" data-screen-kind="components" aria-pressed="${!html}">Components</button>
                        <button type="button" class="wb-chip" data-screen-kind="html" aria-pressed="${html}">HTML from a tool</button>
                    </div>
                </header>
                ${html ? this.htmlEditor() : this.componentsEditor()}
            </section>`;
        if (html) {
            this.callEditor = new CallEditor({
                shell: this.shell,
                workbench: this.workbench,
                container: this.$('[data-screen-call]'),
                getCall: () => this.screen?.from,
                setCall: call => this.change(screen => { screen.from = call; }),
                signal: this.signal,
            });
            this.callEditor.render();
            this.$('[data-html]').value = screen.html || '';
            this.renderFound();
        } else {
            this.callEditor = null;
            for (const component of screen.components) {
                const row = this.$(`[data-component="${CSS.escape(component.id)}"]`);
                row.querySelector('[data-component-id]').value = component.id;
                for (const field of row.querySelectorAll('[data-prop]')) field.value = component[field.dataset.prop] ?? '';
            }
        }
    }

    componentsEditor() {
        const { components } = this.screen;
        const rows = components.map((component, index) => `
            <li class="app-component" data-component="${escapeHtml(component.id)}">
                <div class="app-component-head">
                    <span class="badge">${escapeHtml(COMPONENT_TYPES[component.type]?.label || component.type)}</span>
                    <label class="app-id" title="The id the flow names it by. In a call, {{${escapeHtml(component.id)}}} is what it holds.">
                        <span class="app-id-mark" aria-hidden="true">#</span>
                        <input type="text" class="mono" data-component-id autocomplete="off" spellcheck="false" aria-label="id of this ${escapeHtml(COMPONENT_TYPES[component.type]?.label || 'component')}">
                    </label>
                    <span class="wb-spacer"></span>
                    <button type="button" class="btn-icon btn-sm btn-tertiary" data-move="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn-icon btn-sm btn-tertiary" data-move="1" aria-label="Move down" ${index === components.length - 1 ? 'disabled' : ''}>↓</button>
                    <button type="button" class="btn-icon btn-sm btn-tertiary" data-remove-component aria-label="Remove ${escapeHtml(component.id)}"><span class="icon icon-x" aria-hidden="true"></span></button>
                </div>
                <p class="app-field-error text-error" data-id-error hidden></p>
                <div class="app-component-props">${(PROPS[component.type] || []).map(([prop, label, kind]) => `
                    <label class="app-field ${kind === 'number' ? 'app-field-narrow' : ''}"><span>${label}</span>${kind === 'lines'
                        ? `<textarea rows="2" data-prop="${prop}"></textarea>`
                        : `<input type="text" data-prop="${prop}" ${kind === 'number' ? 'inputmode="numeric"' : ''} autocomplete="off">`}</label>`).join('')}
                </div>
            </li>`).join('');
        return `
            <p class="app-section-note text-secondary">What people see, top to bottom. Each part's id is how the flow names it: it waits for clicks on a button, reads what a text box holds as <code>{{id}}</code>, and puts answers into an output.</p>
            ${components.length ? `<ol class="app-components">${rows}</ol>` : '<p class="wb-list-note">Nothing on the screen yet. Add a component.</p>'}
            <div class="app-add" role="group" aria-label="Add a component">
                <span class="app-add-label">Add</span>
                ${Object.entries(COMPONENT_TYPES).map(([type, { label }]) => `<button type="button" class="btn-sm" data-add-component="${type}"><span class="icon icon-plus" aria-hidden="true"></span>${label}</button>`).join('')}
            </div>`;
    }

    htmlEditor() {
        return `
            <p class="app-section-note text-secondary">Any HTML can be the screen: the flow names its elements by id. Get it from a tool, such as one that returns a page or a model that writes one, or paste it in. It runs without its scripts and can't load anything from the network.</p>
            <div class="app-call" data-screen-call></div>
            <div class="app-html-actions">
                <button type="button" class="btn-sm" data-get-html><span class="icon icon-play" aria-hidden="true"></span>Get the HTML</button>
                <span class="app-html-status text-secondary" data-html-status aria-live="polite"></span>
            </div>
            <label class="app-field"><span>HTML</span><textarea class="mono app-html-source" rows="10" data-html spellcheck="false" placeholder="&lt;button id=&quot;go&quot;&gt;Go&lt;/button&gt;"></textarea></label>
            <p class="app-found text-secondary" data-found></p>`;
    }

    // The elements with ids the flow can use, as found in the HTML.
    renderFound() {
        const found = this.$('[data-found]');
        if (!found) return;
        const elements = this.apps.elements();
        found.innerHTML = elements.length
            ? `${plural(elements.length, 'element')} with ids the flow can use: ${elements.map(element => `<code>${escapeHtml(element.id)}</code> <span class="app-kind">${escapeHtml(ELEMENT_KINDS[element.kind].toLowerCase())}</span>`).join(', ')}`
            : 'No elements with ids yet. The flow names elements by id, as in <code>&lt;button id="go"&gt;</code>.';
    }

    status(text, { error = false } = {}) {
        const status = this.$('[data-html-status]');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('text-error', error);
    }

    edited(event) {
        const target = event.target;
        if (target.matches('[data-html]')) {
            this.change(screen => { screen.html = target.value; });
            this.renderFoundSoon();
            return;
        }
        if (!target.matches('[data-prop]')) return;
        const id = target.closest('[data-component]').dataset.component;
        const prop = target.dataset.prop;
        const value = prop === 'lines' ? Math.max(1, Math.min(20, Number(target.value) || 1)) : target.value;
        this.change(screen => {
            const component = screen.components.find(candidate => candidate.id === id);
            if (component) component[prop] = value;
        });
    }

    renameComponent(input) {
        const row = input.closest('[data-component]');
        const from = row.dataset.component;
        const to = input.value.trim();
        if (to === from) return;
        const error = row.querySelector('[data-id-error]');
        const problem = elementIdProblem(to, this.screen.components.map(component => component.id).filter(id => id !== from));
        error.textContent = problem ? `${problem} It's still ${from}.` : '';
        error.hidden = !problem;
        if (problem) {
            input.value = from;
            return;
        }
        this.apps.renameElement(from, to);
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || !this.screen) return;
        const { dataset } = button;
        const row = button.closest('[data-component]');
        if (dataset.screenKind) return this.chooseKind(dataset.screenKind);
        if (dataset.addComponent) {
            const added = newComponent(dataset.addComponent, this.screen.components.map(component => component.id));
            this.change(screen => { screen.components.push(added); }, { render: true });
            this.$(`[data-component="${CSS.escape(added.id)}"] [data-prop]`)?.focus();
            return;
        }
        if (dataset.move) {
            const id = row.dataset.component;
            this.change(screen => {
                const from = screen.components.findIndex(component => component.id === id);
                const to = from + Number(dataset.move);
                if (to < 0 || to >= screen.components.length) return;
                const [moved] = screen.components.splice(from, 1);
                screen.components.splice(to, 0, moved);
            }, { render: true });
            return;
        }
        if (dataset.removeComponent !== undefined) {
            const id = row.dataset.component;
            this.change(screen => { screen.components = screen.components.filter(component => component.id !== id); }, { render: true });
            return;
        }
        if (dataset.getHtml !== undefined) this.getHtml(button);
    }

    // HTML starts as what the components make, so there's something to change.
    chooseKind(kind) {
        if (kind === this.screen.kind) return;
        this.change(screen => {
            screen.kind = kind;
            if (kind === 'html' && !screen.html?.trim()) screen.html = componentsHtml(screen.components, { title: this.apps.app.name });
            if (kind === 'html' && !screen.from) screen.from = { serverUrl: '', toolName: '', args: {} };
            screen.components ??= [];
        }, { render: true });
    }

    async getHtml(button) {
        const call = this.screen.from;
        const server = this.shell.servers[call?.serverUrl];
        if (!call?.toolName || !server) return this.status('Choose a server and the tool that makes the HTML first.', { error: true });
        const tool = (server.tools || []).find(candidate => candidate.name === call.toolName) || { name: call.toolName };
        let prepared;
        try {
            prepared = callArguments(call, { variables: this.workbench.variables, environmentName: this.workbench.environment?.name, schema: schemaOf(tool) });
        } catch (error) {
            return this.status(error.message, { error: true });
        }
        button.disabled = true;
        this.status(`Calling ${tool.name}…`);
        const message = await this.shell.runTool({ url: server.url, tool, args: call.args || {}, sentArgs: prepared.sentArgs, show: false, source: 'app' });
        button.disabled = false;
        const answer = answerOf(message);
        if (!answer.ok) return this.status(`${tool.name} failed: ${answer.values.error}`, { error: true });
        const html = htmlFromResult(toolResult(message.result));
        if (!html) return this.status(`${tool.name} answered, but not with HTML: “${answer.values.text.slice(0, 80)}”`, { error: true });
        this.change(screen => { screen.html = html; });
        this.$('[data-html]').value = html;
        this.renderFound();
        this.status(`Got ${html.length.toLocaleString()} characters of HTML from ${tool.name}.`);
    }
}
