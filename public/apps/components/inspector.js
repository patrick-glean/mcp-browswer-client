// The canvas's Inspector: what's picked on the canvas, to change. The screen, when nothing is; an
// element (a component's fields, a part's HTML and where it comes from, and its connections; a
// screen's name, what's on it and how people get there); a tool, as its rule; a wire, as the part
// of its rule it is; or Start.
//
// Its head says what's picked, in the canvas's color for it, and stays at the top as the rest
// scrolls. The rest is in sections that open and close, each saying in a line what's in it while
// it's closed; which are open is kept in this browser. A wire opens only its part of its rule.

import { confirmThen, escapeHtml, plural } from '../../workbench/util.js';
import { openRules } from '../apps.js';
import { BOX_KINDS } from '../boxes.js';
import { serversOf } from '../dml.js';
import { elementIdProblem, EVENTS, listed, routeSummary } from '../flow.js';
import { wiresOf } from '../graph.js';
import { canMove, COMPONENT_PROPS, COMPONENT_TYPES, ELEMENT_KINDS, screensOf } from '../screen.js';
import { AppElement } from './base.js';
import { HtmlSourceEditor } from './html-source.js';
import { propField, propValue, setProp } from './props.js';
import { RuleEditor } from './rule-editor.js';
import { ServerSwitch } from './server-switch.js';

// Which sections are open: { [section]: true | false }, for those someone opened or closed.
const FOLDS_KEY = 'appsInspectorFolds';
// Those that start closed: how the canvas works, and a rule's prompt, which a model's tool has.
const CLOSED_AT_FIRST = new Set(['screen.help', 'rule.prompt']);

function readFolds() {
    try {
        const folds = JSON.parse(localStorage.getItem(FOLDS_KEY) || '{}');
        return folds && typeof folds === 'object' ? folds : {};
    } catch {
        return {};
    }
}

export const foldOpen = key => readFolds()[key] ?? !CLOSED_AT_FIRST.has(key);

function keepFold(key, open) {
    localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...readFolds(), [key]: open }));
}

// The color the head takes, as the canvas draws what's picked: a screen, a tool, Start, an
// element by its kind, a wire by what it carries.
const ELEMENT_TONES = { button: 'button', input: 'input', output: 'output', static: 'static', screen: 'screen' };
const TONE_ICONS = { screen: 'monitor', tool: 'tool', start: 'play' };

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
        this.apps.on('runOnOpen', () => {
            if (this.apps.selection?.kind === 'start') this.render();
        }, signal);
        this.shell.on('tools', () => {
            this.ruleEditor?.refresh();
            this.source?.refresh();
            this.servers?.refresh();
        }, signal);
        this.shell.on('servers', () => this.servers?.refresh(), signal);
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
        this.servers = null;
        this.forcedFolds = false;
        if (!this.app || this.apps.view !== 'canvas') {
            this.innerHTML = '';
            return;
        }
        const selection = this.apps.selection;
        // Something else picked starts at the top; the same thing drawn again stays where it was.
        const picked = JSON.stringify([this.apps.shownId, selection?.kind, selection?.id]);
        if (picked !== this.picked) this.scrollTop = 0;
        this.picked = picked;
        if (selection?.kind === 'element') return this.renderElement(selection.id);
        if (selection?.kind === 'rule') return this.renderRule(selection.id);
        if (selection?.kind === 'wire') return this.renderWire(selection);
        if (selection?.kind === 'start') return this.renderStart();
        this.renderScreen();
    }

    // What's picked, in the color the canvas draws it in (`tone`), with a line under its title
    // (`sub`) that stays with it, and a note that scrolls away.
    head(kind, title, note = '', { tone = 'static', sub = '' } = {}) {
        const icon = TONE_ICONS[tone];
        return `
            <header class="app-inspector-head" data-tone="${tone}">
                <span class="app-inspector-kind">${icon ? `<span class="icon icon-${icon}" aria-hidden="true"></span>` : '<span class="app-inspector-swatch" aria-hidden="true"></span>'}${escapeHtml(kind)}</span>
                <h3 class="app-inspector-title">${escapeHtml(title)}</h3>
                ${sub ? `<p class="app-inspector-sub text-secondary">${escapeHtml(sub)}</p>` : ''}
            </header>
            ${note ? `<p class="app-inspector-note text-secondary">${note}</p>` : ''}`;
    }

    // A section that opens and closes, with what's in it in a line beside its title while it's closed.
    fold(key, title, body, { digest = '', open = foldOpen(key) } = {}) {
        return `
            <details class="app-fold" data-fold="${key}"${open ? ' open' : ''}>
                <summary class="app-fold-head"><span class="app-fold-title">${escapeHtml(title)}</span>${digest ? `<span class="app-fold-digest" title="${escapeHtml(digest)}">${escapeHtml(digest)}</span>` : ''}</summary>
                <div class="app-fold-body">${body}</div>
            </details>`;
    }

    renderScreen() {
        const screen = this.app.screen;
        const html = screen.kind === 'html';
        const screens = screensOf(screen.components || []).length;
        const count = (screen.components || []).filter(component => component.type !== 'screen').length;
        const servers = serversOf(this.app).map(url => this.apps.serverName(url));
        const layout = `
            <div class="wb-chips" role="group" aria-label="What the screen is made of">
                <button type="button" class="wb-chip" data-screen-kind="components" aria-pressed="${!html}">Components</button>
                <button type="button" class="wb-chip" data-screen-kind="html" aria-pressed="${html}" title="HTML a model or a tool makes, or that you paste in">HTML</button>
            </div>
            <div class="wb-chips" role="group" aria-label="How wide the screen is">
                <button type="button" class="wb-chip" data-screen-size="narrow" aria-pressed="${screen.size !== 'wide'}" title="One column, as a form or a phone shows it">Narrow</button>
                <button type="button" class="wb-chip" data-screen-size="wide" aria-pressed="${screen.size === 'wide'}" title="Room for boxes side by side, as a dashboard has">Wide</button>
            </div>
            ${html ? '<div data-screen-source></div>' : `<p class="text-secondary">${count} components${screens ? ` on ${screens} screens` : ''}. Add more from the Library: boxes for what a tool answers (a chart, a list, a number), a part a model or a tool makes, or another screen.</p>`}`;
        const tips = `
            <ul class="app-inspector-tips">
                <li><b>Screens</b> are blue cards, and <b>tools</b> violet nodes beside them. A ring of a pin starts a tool or fills its field; a solid one takes what comes out of it.</li>
                <li>Drag from an element's ● to a tool's <b>Run</b> to start the tool, or to one of its fields to fill that field with what the element holds.</li>
                <li>Drag from a tool's <b>Answer</b> or <b>Error</b> to an element to show it there. The label on the wire is its transform: what of the answer shows.</li>
                <li>A <b>box</b> says what it shows and what goes in it. Wired to a tool's Answer, it adds to the tool's prompt what it needs, so the layout writes the format of the answer.</li>
                <li>A <b>screen</b> is one step of the app, a card of its own, in the order people get to it. Wire a button to a screen's ● to go there when it's clicked, or a tool's Answer or Error to go there when the tool answers; the arrow shows the way.</li>
                <li><b>Point at</b> a pin or a wire to see what it's connected to. <b>Move</b> a card or a tool by its title, and the canvas by its background; <b>zoom</b> with − and +, or Ctrl or ⌘ and the wheel. Where you put them stays, and Tidy up puts them back in order.</li>
                <li><b>Start</b> begins the app. Wire it to a tool's Run to call the tool when the app opens, such as to fill a dashboard.</li>
                <li><b>Run</b> lets you use the screen; the wires light up as their rules run, and What happened says each step.</li>
            </ul>`;
        this.innerHTML = `
            ${this.head('Screen', this.app.name || 'App', 'Nothing is picked, so this is the app\'s screen. Pick a screen, an element, a tool, a wire or Start on the canvas to change it here.', { tone: 'screen' })}
            ${this.fold('screen.layout', 'Layout', layout, { digest: `${html ? 'HTML' : `${count} components${screens ? `, ${screens} screens` : ''}`}, ${screen.size === 'wide' ? 'wide' : 'narrow'}` })}
            ${this.fold('screen.servers', 'Servers it calls', '<div data-server-switch></div>', { digest: servers.length ? listed(servers) : 'none yet' })}
            ${this.fold('screen.help', 'How it works', tips, { digest: 'Colors, wiring, screens, moving' })}`;
        this.servers = new ServerSwitch({ shell: this.shell, apps: this.apps, container: this.$('[data-server-switch]'), signal: this.signal });
        this.servers.render();
        if (html) {
            this.source = new HtmlSourceEditor({
                shell: this.shell, workbench: this.workbench, apps: this.apps, container: this.$('[data-screen-source]'), signal: this.signal,
                get: () => this.app?.screen,
                change: mutate => this.apps.change(app => mutate(app.screen), { part: 'screen', by: this }),
            });
            this.source.render();
        }
    }

    // The wires of an element (or with null, of Start), each a click away.
    wiresOfElement(elementId) {
        return wiresOf(this.app.flow, this.apps.elements().map(element => element.id))
            .filter(wire => (elementId === null ? wire.from === 'start' : wire.element === elementId && wire.from !== 'start'));
    }

    connections(elementId) {
        const flow = this.app.flow;
        const wires = this.wiresOfElement(elementId);
        const tool = wire => flow.find(rule => rule.id === wire.ruleId)?.call?.toolName || 'a tool';
        const words = wire => {
            if (wire.kind === 'trigger') return wire.event === 'open' ? `▶ Starts ${tool(wire)} when the app opens` : `▶ Starts ${tool(wire)} when it ${EVENTS[wire.event]}`;
            if (wire.kind === 'arg') return `→ Fills ${tool(wire)}'s ${wire.arg}`;
            const route = flow.find(rule => rule.id === wire.ruleId).then[wire.index];
            return `← Shows ${tool(wire)}'s ${wire.kind === 'error' ? 'error' : 'answer'}: ${routeSummary(route, { max: 40 })}`;
        };
        return wires.length
            ? `<ul class="app-connections">${wires.map(wire => `<li><button type="button" class="app-connection" data-tone="${wire.kind}" data-select-wire="${escapeHtml(wire.id)}" data-rule="${escapeHtml(wire.ruleId)}">${escapeHtml(words(wire))}</button></li>`).join('')}</ul>`
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
            ? `<ul class="app-connections">${on.map(element => `<li><button type="button" class="app-connection" data-tone="${ELEMENT_TONES[element.kind] || 'static'}" data-select-element="${escapeHtml(element.id)}">${escapeHtml(`${ELEMENT_KINDS[element.kind]} ${element.id}${element.label !== element.id ? `: ${element.label}` : ''}`)}</button></li>`).join('')}</ul>`
            : '<p class="text-secondary">Nothing yet. With it picked, add components from the Library, or drag them onto its card.</p>';
    }

    // How people get to a screen: the app opening, the buttons that go there, and the rules that do.
    waysTo(id) {
        const flow = this.app.flow;
        const tool = wire => flow.find(rule => rule.id === wire.ruleId)?.call?.toolName || 'a tool';
        const when = { sent: name => `As ${name} is called`, answer: name => `When ${name} works`, error: name => `When ${name} fails` };
        const routes = wiresOf(flow, this.apps.elements().map(element => element.id)).filter(wire => wire.element === id && when[wire.kind]);
        const items = [
            ...(screensOf(this.app.screen.components)[0]?.id === id ? ['<li class="text-secondary">▶ When the app opens</li>'] : []),
            ...this.apps.elements().filter(element => element.go === id).map(button => `<li><button type="button" class="app-connection" data-tone="button" data-select-element="${escapeHtml(button.id)}">${escapeHtml(`↪ When ${button.id} is clicked`)}</button></li>`),
            ...routes.map(wire => `<li><button type="button" class="app-connection" data-tone="${wire.kind}" data-select-wire="${escapeHtml(wire.id)}" data-rule="${escapeHtml(wire.ruleId)}">${escapeHtml(`← ${when[wire.kind](tool(wire))}`)}</button></li>`),
        ];
        return {
            count: items.length,
            html: items.length
                ? `<ul class="app-connections">${items.join('')}</ul>`
                : "<p class=\"text-secondary\">Nothing goes here yet. Drag from a button's ● beside a screen, or from a tool's Answer or Error, to this screen's ● at the start of its card's title.</p>",
        };
    }

    renderElement(id) {
        const element = this.apps.elements().find(candidate => candidate.id === id);
        if (!element) return this.renderScreen();
        const component = this.component(id);
        const tone = ELEMENT_TONES[element.kind] || 'static';
        const wires = this.wiresOfElement(id).length;
        const wired = wires ? plural(wires, 'wire') : 'none yet';
        if (!component) {
            const where = element.part ? `It's in the part ${element.part}, which a ${this.component(element.part)?.ask ? 'model' : 'tool'} made; its id there is ${id.slice(element.part.length + 1)}.` : 'It\'s in the screen\'s HTML.';
            this.innerHTML = `
                ${this.head(ELEMENT_KINDS[element.kind], id, `${escapeHtml(element.label !== id ? `“${element.label}”. ` : '')}${escapeHtml(where)} The flow uses it by this id: {{${escapeHtml(id)}}} in a call is what it holds.`, { tone })}
                ${this.fold('element.connections', 'Connections', this.connections(id), { digest: wired })}`;
            return;
        }
        const components = this.app.screen.components;
        const props = COMPONENT_PROPS[component.type] || [];
        const screen = component.type === 'screen';
        const settings = `
            <label class="app-field"><span>id: how the flow names it, as {{${escapeHtml(component.id)}}}</span><input type="text" class="mono" data-inspect-id autocomplete="off" spellcheck="false"></label>
            <p class="app-field-error text-error" data-id-error hidden></p>
            ${props.map(([prop, label, kind, options]) => `<label class="app-field"><span>${label}</span>${propField(prop, kind, options, 'data-inspect-prop', { components })}</label>`).join('')}
            ${component.type === 'output' ? '<p class="app-note text-secondary" data-box-note></p>' : ''}
            <div class="button-row app-inspector-actions">
                <button type="button" class="btn-sm" data-move-component="-1" ${canMove(components, id, -1) ? '' : 'disabled'}>Move up</button>
                <button type="button" class="btn-sm" data-move-component="1" ${canMove(components, id, 1) ? '' : 'disabled'}>Move down</button>
                <button type="button" class="btn-sm btn-tertiary btn-danger" data-remove-component>${screen ? "Delete it and what's on it" : 'Delete'}</button>
            </div>`;
        const kind = COMPONENT_TYPES[component.type]?.label || component.type;
        const source = component.type === 'part'
            ? this.fold('element.source', 'Where it comes from', '<div data-part-source></div>', { digest: component.ask ? 'a model' : component.from?.toolName ? `${component.from.toolName}` : component.html ? 'its HTML' : 'nothing yet' })
            : '';
        let more;
        if (screen) {
            const on = this.apps.elements().filter(candidate => candidate.screen === id && candidate.id !== id && !candidate.part).length;
            const ways = this.waysTo(id);
            more = `
                ${this.fold('card.on', 'On it', this.screenContents(id), { digest: on ? plural(on, 'component') : 'nothing yet' })}
                ${this.fold('card.ways', 'How people get here', ways.html, { digest: ways.count ? plural(ways.count, 'way') : 'none yet' })}`;
        } else {
            more = this.fold('element.connections', 'Connections', this.connections(id), { digest: wired });
        }
        this.innerHTML = `
            ${this.head(kind, component.id, escapeHtml(this.whereItIs(element)), { tone })}
            ${this.fold(screen ? 'card.settings' : 'element.settings', screen ? 'Screen' : kind, settings, { digest: component.label || component.text || '' })}
            ${source}
            ${more}`;
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

    // The rule's editor, in sections; `focus` (a wire's part) opens only the section it's in.
    mountRuleEditor(ruleId, focus = null) {
        const flow = this.app.flow;
        const container = this.$('[data-rule-editor]');
        const opened = focus ? { when: focus.trigger !== undefined, call: focus.arg !== undefined, prompt: false, then: focus.route !== undefined } : null;
        this.forcedFolds = !!opened;
        this.ruleEditor = new RuleEditor({
            shell: this.shell, workbench: this.workbench, apps: this.apps, container, ruleId, signal: this.signal,
            index: flow.findIndex(rule => rule.id === ruleId), count: flow.length, by: this, focus,
            folds: { open: part => (opened ? opened[part] : foldOpen(`rule.${part}`)) },
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
        const server = rule.call?.serverUrl ? this.apps.serverName(rule.call.serverUrl) : '';
        this.innerHTML = `${this.head('Tool', rule.call?.toolName || 'Choose a tool', server ? '' : 'Choose the server and the tool it calls, under Call.', { tone: 'tool', sub: server && `on ${server}` })}<div data-rule-editor></div>`;
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
            trigger: wire.event === 'open' ? `Calls ${tool} when the app opens.` : `Starts ${tool} when ${wire.element} ${EVENTS[wire.event]}.`,
            arg: `Fills ${tool}'s ${wire.arg} with what ${wire.element} holds, as {{${wire.element}}}.`,
            sent: `Puts what ${tool} is called with into ${wire.element} as it's called; with nothing to show, it clears it.`,
            answer: `Puts ${tool}'s answer into ${wire.element}; its transform, below, says what of it shows.`,
            error: `Puts ${tool}'s error into ${wire.element} when it fails.`,
        }[wire.kind];
        const kind = toScreen ? 'Where it goes' : { trigger: 'What starts it', arg: 'What fills a field', sent: "What shows as it's sent", answer: 'Where the answer goes', error: 'Where an error goes' }[wire.kind];
        // Its two ends, a click away: the element or Start, and the tool.
        const element = wire.from === 'start'
            ? '<button type="button" class="app-end" data-tone="start" data-select-start>▶ Start</button>'
            : `<button type="button" class="app-end" data-tone="${toScreen ? 'screen' : ELEMENT_TONES[this.apps.elements().find(candidate => candidate.id === wire.element)?.kind] || 'static'}" data-select-element="${escapeHtml(wire.element)}">${escapeHtml(wire.element)}</button>`;
        const node = `<button type="button" class="app-end" data-tone="tool" data-select-rule="${escapeHtml(rule.id)}"><span class="icon icon-tool" aria-hidden="true"></span>${escapeHtml(tool)}</button>`;
        const into = wire.kind === 'trigger' || wire.kind === 'arg';
        this.innerHTML = `
            ${this.head(kind, title, escapeHtml(note), { tone: toScreen ? 'screen' : wire.kind })}
            <div class="app-ends" aria-label="Its two ends">${into ? `${element}<span aria-hidden="true">→</span>${node}` : `${node}<span aria-hidden="true">→</span>${element}`}</div>
            <div class="button-row app-inspector-actions"><button type="button" class="btn-sm btn-tertiary btn-danger" data-remove-wire="${escapeHtml(wire.id)}">Remove this connection</button></div>
            <div data-rule-editor></div>`;
        const focus = wire.kind === 'trigger' ? { trigger: wire.index } : wire.kind === 'arg' ? { arg: wire.arg } : { route: wire.index };
        this.mountRuleEditor(rule.id, focus);
        if (selection.edit && focus.route !== undefined) {
            const field = this.$(`[data-route="${focus.route}"] [data-route-show]`);
            field?.focus({ preventScroll: true });
            field?.select();
        }
    }

    renderStart() {
        const choice = this.apps.runOnOpen();
        const choices = [['', 'Ask', 'The app asks, as it opens, whether to run what Start calls'], ['yes', 'Run it', 'Opening the app runs what Start calls'], ['no', "Don't run it", 'Opening the app runs nothing until you choose Restart']];
        const calls = openRules(this.app).map(rule => rule.call?.toolName || 'a tool');
        this.innerHTML = `
            ${this.head('Start', 'Where the app begins', 'The app opens on this screen. Tools wired to Start are called as it opens, top to bottom, such as one that fills a dashboard.', { tone: 'start' })}
            ${this.fold('start.calls', 'What it calls', this.connections(null), { digest: calls.length ? listed(calls) : 'nothing yet' })}
            ${calls.length ? this.fold('start.open', 'When you open the app', `
                <div class="wb-chips" role="group" aria-label="When you open the app">
                    ${choices.map(([value, label, title]) => `<button type="button" class="wb-chip" data-run-on-open-choice="${value}" aria-pressed="${(choice ?? '') === value}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`).join('')}
                </div>
                <p class="text-secondary">Opening it here, or from a link to it, runs what Start calls only when this says so; it's kept for this app, in this browser. Restart, Preview and Launch always run it.</p>`, { digest: choices.find(([value]) => value === (choice ?? ''))[1] }) : ''}`;
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
        // A section someone opens or closes stays that way; one a wire opened for its part doesn't.
        // It's kept from the click, which opens or closes it once the click is done: its toggle
        // event can't say, since a section drawn open has one of its own, and the two can merge.
        const fold = event.target.closest('summary.app-fold-head')?.parentElement;
        if (fold && !event.defaultPrevented && !this.forcedFolds) keepFold(fold.dataset.fold, !fold.open);
        const button = event.target.closest('button');
        if (!button || button.disabled || button.closest('[data-rule-editor], [data-part-source], [data-screen-source], [data-server-switch]')) return;
        const { dataset } = button;
        if (dataset.runOnOpenChoice !== undefined) return this.apps.setRunOnOpen(dataset.runOnOpenChoice || null);
        if (dataset.screenKind) return this.apps.setScreenKind(dataset.screenKind);
        if (dataset.screenSize) return this.apps.setScreenSize(dataset.screenSize);
        if (dataset.selectWire) return this.apps.select({ kind: 'wire', id: dataset.selectWire, ruleId: dataset.rule });
        if (dataset.selectElement) return this.apps.select({ kind: 'element', id: dataset.selectElement });
        if (dataset.selectRule) return this.apps.select({ kind: 'rule', id: dataset.selectRule });
        if (dataset.selectStart !== undefined) return this.apps.select({ kind: 'start' });
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
