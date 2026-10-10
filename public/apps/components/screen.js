// The Outline's Screen: what people see. Either components (a title, text, text boxes, buttons,
// outputs, and parts a tool or a model makes) with the ids the flow names them by, or HTML: from
// a model, from a tool call, or pasted in.

import { escapeHtml } from '../../workbench/util.js';
import { elementIdProblem } from '../flow.js';
import { COMPONENT_PROPS, COMPONENT_TYPES, newComponent } from '../screen.js';
import { AppElement } from './base.js';
import { HtmlSourceEditor } from './html-source.js';
import { propField, propValue } from './props.js';

export class AppScreen extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.sources = [];
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('view', () => this.render(), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'screen' && by !== this) this.render();
        }, signal);
        this.shell.on('tools', () => this.sources.forEach(source => source.refresh()), signal);
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
        this.sources = [];
        const screen = this.screen;
        if (!screen || this.apps.view !== 'outline') {
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
                        <button type="button" class="wb-chip" data-screen-kind="html" aria-pressed="${html}" title="HTML a model or a tool makes, or that you paste in">HTML</button>
                    </div>
                    <div class="wb-chips" role="group" aria-label="How wide the screen is">
                        <button type="button" class="wb-chip" data-screen-size="narrow" aria-pressed="${screen.size !== 'wide'}" title="One column, as a form or a phone shows it">Narrow</button>
                        <button type="button" class="wb-chip" data-screen-size="wide" aria-pressed="${screen.size === 'wide'}" title="Room for boxes side by side, as a dashboard has">Wide</button>
                    </div>
                </header>
                ${html ? this.htmlEditor() : this.componentsEditor()}
            </section>`;
        if (html) {
            this.addSource(this.$('[data-screen-source]'), () => this.screen, mutate => this.change(mutate), false);
            return;
        }
        for (const component of screen.components) {
            const row = this.$(`[data-component="${CSS.escape(component.id)}"]`);
            row.querySelector('[data-component-id]').value = component.id;
            for (const field of row.querySelectorAll('[data-prop]')) field.value = propValue(component, field, field.dataset.prop);
            if (component.type === 'part') {
                const id = component.id;
                this.addSource(row.querySelector('[data-part-source]'),
                    () => this.screen?.components.find(candidate => candidate.id === id),
                    mutate => this.change(found => mutate(found.components.find(candidate => candidate.id === id))), true);
            }
        }
    }

    addSource(container, get, change, part) {
        const source = new HtmlSourceEditor({ shell: this.shell, workbench: this.workbench, apps: this.apps, container, get, change, part, signal: this.signal });
        source.render();
        this.sources.push(source);
    }

    componentsEditor() {
        const { components } = this.screen;
        const rows = components.map((component, index) => `
            <li class="app-component${component.type === 'part' ? ' app-component-part' : ''}" data-component="${escapeHtml(component.id)}">
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
                <div class="app-component-props">${(COMPONENT_PROPS[component.type] || []).map(([prop, label, kind, options]) => `
                    <label class="app-field ${kind === 'number' ? 'app-field-narrow' : ''}"><span>${label}</span>${propField(prop, kind, options, 'data-prop', { rows: 2 })}</label>`).join('')}
                </div>
                ${component.type === 'part' ? '<div class="app-part-source" data-part-source></div>' : ''}
            </li>`).join('');
        return `
            <p class="app-section-note text-secondary">What people see, top to bottom. Each part's id is how the flow names it: it waits for clicks on a button, reads what a text box holds as <code>{{id}}</code>, and puts answers into an output. A part from a tool, such as a dashboard a model makes, brings its own buttons and fields, named <code>part.id</code>.</p>
            ${components.length ? `<ol class="app-components">${rows}</ol>` : '<p class="wb-list-note">Nothing on the screen yet. Add a component.</p>'}
            <div class="app-add" role="group" aria-label="Add a component">
                <span class="app-add-label">Add</span>
                ${Object.entries(COMPONENT_TYPES).map(([type, { label }]) => `<button type="button" class="btn-sm" data-add-component="${type}"><span class="icon icon-plus" aria-hidden="true"></span>${label}</button>`).join('')}
            </div>`;
    }

    htmlEditor() {
        return `
            <p class="app-section-note text-secondary">Any HTML can be the screen: the flow names its elements by id. Ask a model for it, get it from a tool that returns a page, or paste it in. It runs without its scripts and can't load anything from the network.</p>
            <div data-screen-source></div>`;
    }

    edited(event) {
        const target = event.target;
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
        if (!button || button.disabled || !this.screen || button.closest('[data-part-source], [data-screen-source]')) return;
        const { dataset } = button;
        const row = button.closest('[data-component]');
        if (dataset.screenKind) return this.apps.setScreenKind(dataset.screenKind);
        if (dataset.screenSize) return this.apps.setScreenSize(dataset.screenSize);
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
        }
    }

}
