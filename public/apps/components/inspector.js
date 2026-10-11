// The canvas's Inspector: what's picked on the canvas, to change. The screen, when nothing is; an
// element (a component's fields, a part's HTML and where it comes from, and its connections; a
// screen's name, what's on it and how people get there); a tool, as its rule; a wire, as the part
// of its rule it is; or Start.

import { confirmThen, escapeHtml } from '../../workbench/util.js';
import { BOX_KINDS } from '../boxes.js';
import { elementIdProblem, EVENTS, routeSummary } from '../flow.js';
import { wiresOf } from '../graph.js';
import { canMove, COMPONENT_PROPS, COMPONENT_TYPES, ELEMENT_KINDS, screensOf } from '../screen.js';
import { AppElement } from './base.js';
import { HtmlSourceEditor } from './html-source.js';
import { propField, propValue, setProp } from './props.js';
import { RuleEditor } from './rule-editor.js';

export class AppInspector extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('view', () => this.render(), signal);
        this.apps.on('select', () => this.render(), signal);
        this.apps.on('app', ({ part, by }) => {
            if (by === this || !['flow', 'screen', 'layout'].includes(part)) return;
            if (!this.stillThere()) return this.apps.select(null);
            if (this.contains(document.activeElement)) {
                this.ruleEditor?.refresh();
                return;
            }
            if (part !== 'layout') this.render();
        }, signal);
        this.apps.on('answer', ({ ruleId }) => {
            if (this.ruleEditor?.ruleId === ruleId) this.ruleEditor.renderPicks();
        }, signal);
        this.shell.on('tools', () => {
            this.ruleEditor?.refresh();
            this.source?.refresh();
        }, signal);
        this.apps.on('model', () => this.source?.modelChanged(), signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('input', event => {
            const field = event.target.closest('[data-inspect-prop]');
            if (!field) return;
            const id = this.apps.selection?.id;
            const prop = field.dataset.inspectProp;
            this.apps.change(app => {
                const component = app.screen.components.find(candidate => candidate.id === id);
                if (component) setProp(component, prop, field.value);
            }, { part: 'screen', by: this });
            if (prop === 'show') this.markBox(field.value);
        }, { signal });
        this.addEventListener('change', event => {
            if (event.target.matches('[data-inspect-id]')) this.rename(event.target);
        }, { signal });
    }

    get app() {
        return this.apps.app;
    }

    component(id) {
        return this.app?.screen.components?.find(candidate => candidate.id === id) || null;
    }

    // Whether what's picked is still in the app.
    stillThere() {
        const selection = this.apps.selection;
        if (!selection || selection.kind === 'start') return true;
        if (selection.kind === 'element') return this.apps.elements().some(element => element.id === selection.id);
        const rule = this.app?.flow.find(candidate => candidate.id === (selection.ruleId || selection.id));
        if (!rule) return false;
        return selection.kind !== 'wire' || wiresOf([rule], this.apps.elements().map(element => element.id)).some(wire => wire.id === selection.id);
    }

    render() {
        this.ruleEditor = null;
        this.source = null;
        if (!this.app || this.apps.view !== 'canvas') {
            this.innerHTML = '';
            return;
        }
        const selection = this.apps.selection;
        if (selection?.kind === 'element') return this.renderElement(selection.id);
        if (selection?.kind === 'rule') return this.renderRule(selection.id);
        if (selection?.kind === 'wire') return this.renderWire(selection);
        if (selection?.kind === 'start') return this.renderStart();
        this.renderScreen();
    }

    head(kind, title, note = '') {
        return `
            <header class="app-inspector-head">
                <span class="app-inspector-kind">${escapeHtml(kind)}</span>
                <h3 class="app-inspector-title">${escapeHtml(title)}</h3>
                ${note ? `<p class="app-inspector-note text-secondary">${note}</p>` : ''}
            </header>`;
    }

    renderScreen() {
        const screen = this.app.screen;
        const html = screen.kind === 'html';
        const screens = screensOf(screen.components || []).length;
        const count = (screen.components || []).filter(component => component.type !== 'screen').length;
        this.innerHTML = `
            ${this.head('Screen', this.app.name || 'App', 'Nothing is picked, so this is the screen. Pick an element, a tool, a wire or Start on the canvas to change it here.')}
            <div class="wb-chips" role="group" aria-label="What the screen is made of">
                <button type="button" class="wb-chip" data-screen-kind="components" aria-pressed="${!html}">Components</button>
                <button type="button" class="wb-chip" data-screen-kind="html" aria-pressed="${html}" title="HTML a model or a tool makes, or that you paste in">HTML</button>
            </div>
            <div class="wb-chips" role="group" aria-label="How wide the screen is">
                <button type="button" class="wb-chip" data-screen-size="narrow" aria-pressed="${screen.size !== 'wide'}" title="One column, as a form or a phone shows it">Narrow</button>
                <button type="button" class="wb-chip" data-screen-size="wide" aria-pressed="${screen.size === 'wide'}" title="Room for boxes side by side, as a dashboard has">Wide</button>
            </div>
            ${html ? '<div data-screen-source></div>' : `<p class="text-secondary">${count} components${screens ? ` on ${screens} screens` : ''}. Add more from the Library: boxes for what a tool answers (a chart, a list, a number), a part a model or a tool makes, or another screen.</p>`}
            <h4 class="app-inspector-section">How it works</h4>
            <ul class="app-inspector-tips">
                <li>Drag from an element's ● to a tool's <b>Run</b> to start the tool, or to one of its fields to fill that field with what the element holds.</li>
                <li>Drag from a tool's <b>Answer</b> or <b>Error</b> to an element to show it there. The label on the wire is its transform: what of the answer shows.</li>
                <li>A <b>box</b> says what it shows and what goes in it. Wired to a tool's Answer, it adds to the tool's prompt what it needs, so the layout writes the format of the answer.</li>
                <li>A <b>screen</b> is one step of the app, with a tab above it. Wire a button to a screen's ● to go there when it's clicked, or a tool's Answer or Error to go there when the tool answers.</li>
                <li><b>Start</b> begins the app. Wire it to a tool's Run to call the tool when the app opens, such as to fill a dashboard.</li>
                <li><b>Run</b> lets you use the screen; the wires light up as their rules run, and What happened says each step.</li>
            </ul>`;
        if (html) {
            this.source = new HtmlSourceEditor({
                shell: this.shell, workbench: this.workbench, apps: this.apps, container: this.$('[data-screen-source]'), signal: this.signal,
                get: () => this.app?.screen,
                change: mutate => this.apps.change(app => mutate(app.screen), { part: 'screen', by: this }),
            });
            this.source.render();
        }
    }

    connections(elementId) {
        const flow = this.app.flow;
        const wires = wiresOf(flow, this.apps.elements().map(element => element.id)).filter(wire => (elementId === null ? wire.from === 'start' : wire.element === elementId && wire.from !== 'start'));
        const tool = wire => flow.find(rule => rule.id === wire.ruleId)?.call?.toolName || 'a tool';
        const words = wire => {
            if (wire.kind === 'trigger') return wire.event === 'open' ? `▶ Starts ${tool(wire)} when the app opens` : `▶ Starts ${tool(wire)} when it ${EVENTS[wire.event]}`;
            if (wire.kind === 'arg') return `→ Fills ${tool(wire)}'s ${wire.arg}`;
            const route = flow.find(rule => rule.id === wire.ruleId).then[wire.index];
            return `← Shows ${tool(wire)}'s ${wire.kind === 'error' ? 'error' : 'answer'}: ${routeSummary(route, { max: 40 })}`;
        };
        return wires.length
            ? `<ul class="app-connections">${wires.map(wire => `<li><button type="button" class="app-connection" data-select-wire="${escapeHtml(wire.id)}" data-rule="${escapeHtml(wire.ruleId)}">${escapeHtml(words(wire))}</button></li>`).join('')}</ul>`
            : `<p class="text-secondary">No wires yet. ${elementId === null ? "Drag from Start's ● to a tool's Run." : "Drag from its ● beside the screen to a tool's Run or field, or from a tool's Answer to it."}</p>`;
    }

    // Which of the app's screens an element is on, when it has several.
    whereItIs(element) {
        const screens = screensOf(this.app.screen.components);
        if (!screens.length) return '';
        if (element.kind === 'screen') {
            return `${screens[0].id === element.id ? 'The app opens on this screen. ' : ''}What's below it, up to the next screen, shows on it; moving or deleting it takes that along.`;
        }
        const screen = screens.find(candidate => candidate.id === element.screen);
        return screen ? `On the screen “${screen.label}”.` : "Above the app's screens, so it shows on every one.";
    }

    // What's on a screen, each a click away.
    screenContents(id) {
        const on = this.apps.elements().filter(element => element.screen === id && element.id !== id && !element.part);
        return on.length
            ? `<ul class="app-connections">${on.map(element => `<li><button type="button" class="app-connection" data-select-element="${escapeHtml(element.id)}">${escapeHtml(`${ELEMENT_KINDS[element.kind]} ${element.id}${element.label !== element.id ? `: ${element.label}` : ''}`)}</button></li>`).join('')}</ul>`
            : '<p class="text-secondary">Nothing yet. With its tab picked, add components from the Library.</p>';
    }

    // How people get to a screen: the app opening, the buttons that go there, and the rules that do.
    waysTo(id) {
        const flow = this.app.flow;
        const tool = wire => flow.find(rule => rule.id === wire.ruleId)?.call?.toolName || 'a tool';
        const when = { sent: name => `As ${name} is called`, answer: name => `When ${name} works`, error: name => `When ${name} fails` };
        const routes = wiresOf(flow, this.apps.elements().map(element => element.id)).filter(wire => wire.element === id && when[wire.kind]);
        const items = [
            ...(screensOf(this.app.screen.components)[0]?.id === id ? ['<li class="text-secondary">▶ When the app opens</li>'] : []),
            ...this.apps.elements().filter(element => element.go === id).map(button => `<li><button type="button" class="app-connection" data-select-element="${escapeHtml(button.id)}">${escapeHtml(`↪ When ${button.id} is clicked`)}</button></li>`),
            ...routes.map(wire => `<li><button type="button" class="app-connection" data-select-wire="${escapeHtml(wire.id)}" data-rule="${escapeHtml(wire.ruleId)}">${escapeHtml(`← ${when[wire.kind](tool(wire))}`)}</button></li>`),
        ];
        return items.length
            ? `<ul class="app-connections">${items.join('')}</ul>`
            : "<p class=\"text-secondary\">Nothing goes here yet. Drag from a button's ● beside the screen, or from a tool's Answer or Error, to this screen's ● on its tab.</p>";
    }

    renderElement(id) {
        const element = this.apps.elements().find(candidate => candidate.id === id);
        if (!element) return this.renderScreen();
        const component = this.component(id);
        if (!component) {
            const where = element.part ? `It's in the part ${element.part}, which a ${this.component(element.part)?.ask ? 'model' : 'tool'} made; its id there is ${id.slice(element.part.length + 1)}.` : 'It\'s in the screen\'s HTML.';
            this.innerHTML = `
                ${this.head(ELEMENT_KINDS[element.kind], id, `${escapeHtml(element.label !== id ? `“${element.label}”. ` : '')}${escapeHtml(where)} The flow uses it by this id: {{${escapeHtml(id)}}} in a call is what it holds.`)}
                <h4 class="app-inspector-section">Connections</h4>
                ${this.connections(id)}`;
            return;
        }
        const components = this.app.screen.components;
        const props = COMPONENT_PROPS[component.type] || [];
        const screen = component.type === 'screen';
        this.innerHTML = `
            ${this.head(COMPONENT_TYPES[component.type]?.label || component.type, component.id, escapeHtml(this.whereItIs(element)))}
            <label class="app-field"><span>id: how the flow names it, as {{${escapeHtml(component.id)}}}</span><input type="text" class="mono" data-inspect-id autocomplete="off" spellcheck="false"></label>
            <p class="app-field-error text-error" data-id-error hidden></p>
            ${props.map(([prop, label, kind, options]) => `<label class="app-field"><span>${label}</span>${propField(prop, kind, options, 'data-inspect-prop', { components })}</label>`).join('')}
            ${component.type === 'output' ? '<p class="app-note text-secondary" data-box-note></p>' : ''}
            ${component.type === 'part' ? '<h4 class="app-inspector-section">Where it comes from</h4><div data-part-source></div>' : ''}
            <div class="button-row app-inspector-actions">
                <button type="button" class="btn-sm" data-move-component="-1" ${canMove(components, id, -1) ? '' : 'disabled'}>Move up</button>
                <button type="button" class="btn-sm" data-move-component="1" ${canMove(components, id, 1) ? '' : 'disabled'}>Move down</button>
                <button type="button" class="btn-sm btn-tertiary btn-danger" data-remove-component>${screen ? "Delete it and what's on it" : 'Delete'}</button>
            </div>
            ${screen ? `<h4 class="app-inspector-section">On it</h4>${this.screenContents(id)}` : ''}
            <h4 class="app-inspector-section">${screen ? 'How people get here' : 'Connections'}</h4>
            ${screen ? this.waysTo(id) : this.connections(id)}`;
        this.$('[data-inspect-id]').value = component.id;
        for (const field of this.querySelectorAll('[data-inspect-prop]')) field.value = propValue(component, field, field.dataset.inspectProp);
        if (component.type === 'output') this.markBox(component.show);
        if (component.type === 'part') {
            this.source = new HtmlSourceEditor({
                shell: this.shell, workbench: this.workbench, apps: this.apps, container: this.$('[data-part-source]'), part: true, signal: this.signal,
                get: () => this.component(id),
                change: mutate => this.apps.change(() => mutate(this.component(id)), { part: 'screen', by: this }),
            });
            this.source.render();
        }
    }

    // An output's settings follow what it shows: an example of what goes in it, and what that's for.
    markBox(kind) {
        const box = BOX_KINDS[kind] || BOX_KINDS.text;
        const about = this.$('[data-inspect-prop="about"]');
        if (about) about.placeholder = `For example: ${box.example}`;
        const note = this.$('[data-box-note]');
        const as = kind === 'html' ? 'HTML' : box === BOX_KINDS.text ? 'text' : `a ${box.noun}`;
        if (note) note.textContent = `Say what goes here, and a tool whose Answer is wired to it is asked for it as ${as}, which the box draws.`;
    }

    mountRuleEditor(ruleId, focus = null) {
        const flow = this.app.flow;
        const container = this.$('[data-rule-editor]');
        this.ruleEditor = new RuleEditor({
            shell: this.shell, workbench: this.workbench, apps: this.apps, container, ruleId, signal: this.signal,
            index: flow.findIndex(rule => rule.id === ruleId), count: flow.length, by: this, focus,
            onRemove: id => {
                this.apps.change(app => { app.flow = app.flow.filter(rule => rule.id !== id); }, { part: 'flow', by: this });
                this.apps.select(null);
            },
        });
        this.ruleEditor.render();
    }

    renderRule(id) {
        const rule = this.app.flow.find(candidate => candidate.id === id);
        if (!rule) return this.renderScreen();
        this.innerHTML = `${this.head('Tool', rule.call?.toolName || 'Choose a tool', 'A tool and its rule: what starts it, what it\'s called with, and where its answer goes.')}<div data-rule-editor></div>`;
        this.mountRuleEditor(id);
    }

    renderWire(selection) {
        const rule = this.app.flow.find(candidate => candidate.id === selection.ruleId);
        const wire = rule && wiresOf([rule], this.apps.elements().map(element => element.id)).find(candidate => candidate.id === selection.id);
        if (!wire) return this.renderScreen();
        const tool = rule.call?.toolName || 'the tool';
        const title = wire.kind === 'trigger' ? (wire.event === 'open' ? `Start → ${tool}` : `${wire.element} → ${tool}`)
            : wire.kind === 'arg' ? `${wire.element} → ${tool}.${wire.arg}` : `${tool} → ${wire.element}`;
        const toScreen = this.apps.elements().some(element => element.id === wire.element && element.kind === 'screen');
        const note = toScreen ? {
            sent: `Goes to the screen ${wire.element} as ${tool} is called, before its answer.`,
            answer: `Goes to the screen ${wire.element} when ${tool} works.`,
            error: `Goes to the screen ${wire.element} when ${tool} fails.`,
        }[wire.kind] : {
            trigger: wire.event === 'open' ? `Calls ${tool} when the app opens.` : `Starts ${tool} when ${wire.element} ${EVENTS[wire.event]}; choose what it waits for below.`,
            arg: `Fills ${tool}'s ${wire.arg} with what ${wire.element} holds, as {{${wire.element}}}.`,
            sent: `Puts what ${tool} is called with into ${wire.element} as it's called, before there's an answer. With nothing to show, it clears ${wire.element}.`,
            answer: `Puts ${tool}'s answer into ${wire.element}. What it shows is its transform, below: {{text}} is the text, {{structured.…}} a value, or your own words around them.`,
            error: `Puts ${tool}'s error into ${wire.element} when it fails.`,
        }[wire.kind];
        const kind = toScreen ? 'Where it goes' : { trigger: 'What starts it', arg: 'What fills a field', sent: "What shows as it's sent", answer: 'Where the answer goes', error: 'Where an error goes' }[wire.kind];
        this.innerHTML = `
            ${this.head(kind, title, escapeHtml(note))}
            <div class="button-row app-inspector-actions"><button type="button" class="btn-sm btn-tertiary btn-danger" data-remove-wire="${escapeHtml(wire.id)}">Remove this connection</button></div>
            <div data-rule-editor></div>`;
        const focus = wire.kind === 'trigger' ? { trigger: wire.index } : wire.kind === 'arg' ? { arg: wire.arg } : { route: wire.index };
        this.mountRuleEditor(rule.id, focus);
        if (selection.edit && focus.route !== undefined) {
            const field = this.$(`[data-route="${focus.route}"] [data-route-show]`);
            field?.focus();
            field?.select();
        }
    }

    renderStart() {
        this.innerHTML = `
            ${this.head('Start', 'Where the app begins', 'The app opens on this screen. Tools wired to Start are called as it opens, top to bottom, such as one that fills a dashboard.')}
            <h4 class="app-inspector-section">What it calls</h4>
            ${this.connections(null)}`;
    }

    rename(input) {
        const from = this.apps.selection?.id;
        const to = input.value.trim();
        if (!from || to === from) return;
        const error = this.$('[data-id-error]');
        const problem = elementIdProblem(to, this.app.screen.components.map(component => component.id).filter(id => id !== from));
        error.textContent = problem ? `${problem} It's still ${from}.` : '';
        error.hidden = !problem;
        if (problem) {
            input.value = from;
            return;
        }
        this.apps.renameElement(from, to);
        this.apps.select({ kind: 'element', id: to });
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || button.closest('[data-rule-editor], [data-part-source], [data-screen-source]')) return;
        const { dataset } = button;
        if (dataset.screenKind) return this.apps.setScreenKind(dataset.screenKind);
        if (dataset.screenSize) return this.apps.setScreenSize(dataset.screenSize);
        if (dataset.selectWire) return this.apps.select({ kind: 'wire', id: dataset.selectWire, ruleId: dataset.rule });
        if (dataset.selectElement) return this.apps.select({ kind: 'element', id: dataset.selectElement });
        if (dataset.removeWire) return this.apps.removeWire(dataset.removeWire);
        const id = this.apps.selection?.id;
        if (dataset.moveComponent) {
            this.apps.moveComponent(id, Number(dataset.moveComponent));
            return this.render();
        }
        if (dataset.removeComponent !== undefined) {
            const remove = () => {
                this.apps.removeComponent(id);
                this.apps.select(null);
            };
            // A screen goes with what's on it, so that takes a second click.
            if (this.component(id)?.type === 'screen') return confirmThen(button, remove);
            remove();
        }
    }
}

