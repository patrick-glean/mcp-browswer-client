// The Outline's Flow: the app's rules, top to bottom, each a rule card (RuleEditor). Each says
// when (something happens on the screen), what to call (a tool, with values from the screen) and
// then where its answer goes, if it works and if it fails, with what to show there.

import { schemaOf } from '../../workbench/util.js';
import { newRule, triggersOf } from '../flow.js';
import { AppElement } from './base.js';
import { RuleEditor } from './rule-editor.js';

export class AppFlow extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.editors = [];
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('view', () => this.render(), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'flow' && by !== this) this.render();
            if (part === 'screen') this.editors.forEach(editor => editor.refresh());
        }, signal);
        this.apps.on('answer', ({ ruleId }) => this.editors.find(editor => editor.ruleId === ruleId)?.renderPicks(), signal);
        const serversChanged = () => {
            if (this.contains(document.activeElement)) return this.editors.forEach(editor => editor.update());
            this.render();
        };
        this.shell.on('tools', serversChanged, signal);
        this.shell.on('servers', serversChanged, signal);
        this.addEventListener('click', event => {
            if (event.target.closest('[data-add-rule]')) this.addRule();
        }, { signal });
        this.addEventListener('mouseover', event => {
            const card = event.target.closest('[data-rule]');
            if (card?.dataset.rule === this.pointedAt) return;
            this.pointedAt = card?.dataset.rule || null;
            const rule = card && this.flow.find(candidate => candidate.id === card.dataset.rule);
            const elements = rule ? [...triggersOf(rule).map(candidate => candidate.element), ...rule.then.map(route => route.into)].filter(Boolean) : [];
            this.apps.emit('highlight', { elements });
        }, { signal });
        this.addEventListener('mouseleave', () => {
            this.pointedAt = null;
            this.apps.emit('highlight', { elements: [] });
        }, { signal });
    }

    get flow() {
        return this.apps.app?.flow || [];
    }

    render() {
        this.editors = [];
        if (!this.apps.app || this.apps.view !== 'outline') {
            this.innerHTML = '';
            return;
        }
        const flow = this.flow;
        this.innerHTML = `
            <section class="app-section" aria-labelledby="appFlowTitle">
                <header class="app-section-head">
                    <h3 id="appFlowTitle"><span class="app-step" aria-hidden="true">2</span>Flow</h3>
                    <button type="button" class="btn-sm" data-add-rule><span class="icon icon-plus" aria-hidden="true"></span>Add a rule</button>
                </header>
                <p class="app-section-note text-secondary">Rules that wait for the same thing run top to bottom. In a call, <code>{{id}}</code> is what that element holds; in what a rule shows, <code>{{text}}</code> is the text the tool returned.</p>
                ${flow.length ? `<ol class="app-rules">${flow.map(rule => `<li data-rule-card="${rule.id}"></li>`).join('')}</ol>` : '<p class="wb-list-note">No rules yet, so nothing happens when people use the screen. Add a rule.</p>'}
            </section>`;
        flow.forEach((rule, index) => {
            const editor = new RuleEditor({
                shell: this.shell,
                workbench: this.workbench,
                apps: this.apps,
                container: this.querySelector(`[data-rule-card="${CSS.escape(rule.id)}"]`),
                ruleId: rule.id,
                index,
                count: flow.length,
                by: this,
                onRemove: id => this.removeRule(id),
                onMove: (id, step) => this.moveRule(id, step),
                signal: this.signal,
            });
            editor.render();
            this.editors.push(editor);
        });
    }

    removeRule(id) {
        this.apps.change(app => { app.flow = app.flow.filter(rule => rule.id !== id); }, { part: 'flow', by: this });
        this.render();
    }

    moveRule(id, step) {
        this.apps.change(app => {
            const from = app.flow.findIndex(rule => rule.id === id);
            const to = from + step;
            if (to < 0 || to >= app.flow.length) return;
            app.flow.splice(to, 0, ...app.flow.splice(from, 1));
        }, { part: 'flow', by: this });
        this.render();
    }

    // A new rule waits for the first button and sends its answer to the first output, calling the
    // last rule's tool, so the next one is a few changes away.
    addRule() {
        const elements = this.apps.elements();
        const button = elements.find(element => element.kind === 'button');
        const output = elements.find(element => element.kind === 'output');
        const last = this.flow.at(-1)?.call;
        const serverUrl = last?.serverUrl || Object.keys(this.shell.servers)[0] || '';
        const tool = (this.shell.servers[serverUrl]?.tools || []).find(candidate => candidate.name === last?.toolName) || this.shell.servers[serverUrl]?.tools?.[0];
        const args = tool && schemaOf(tool) ? this.workbench.testDataFor(schemaOf(tool)).args : {};
        const rule = newRule({ element: button?.id || '', event: button ? 'click' : 'open', serverUrl, toolName: tool?.name || '', args, into: output?.id || '' });
        this.apps.change(app => { app.flow.push(rule); }, { part: 'flow', by: this });
        this.render();
        this.querySelector(`[data-rule-card="${CSS.escape(rule.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}
