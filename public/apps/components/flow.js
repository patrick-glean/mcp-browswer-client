// The app builder's Flow: its rules, top to bottom. Each says when (something happens on the
// screen), what to call (a tool, with values from the screen) and then where its answer goes, if it
// works and if it fails, with what to show there ({{text}} and the rest).

import { escapeHtml, schemaOf } from '../../workbench/util.js';
import { ANSWER_NAMES, describeRule, ELEMENT_ID, EVENTS, EVENTS_BY_KIND, flowProblems, newRule, ROUTE_HOW } from '../flow.js';
import { AppElement } from './base.js';
import { CallEditor } from './call-editor.js';

const ANSWER_CHIPS = [
    ['text', 'The text the tool returned'],
    ['structured', 'Its structured content; add .name for one value, as {{structured.count}}'],
    ['json', 'Its text read as JSON; add .name for one value, as {{json.items.0.title}}'],
    ['result', 'The whole result, as JSON'],
    ['error', 'Why it failed'],
];
const KIND_GROUPS = { button: 'Buttons', input: 'Fields', output: 'Outputs', static: 'Text' };

export class AppFlow extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.editors = new Map();
        this.lastShow = null;
        this.apps.on('shown', () => this.render(), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'flow' && by !== this) this.render();
            if (part === 'screen') this.refreshElements();
        }, signal);
        const serversChanged = () => {
            if (this.contains(document.activeElement)) return this.updateAll();
            this.render();
        };
        this.shell.on('tools', serversChanged, signal);
        this.shell.on('servers', serversChanged, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('change', event => this.changed(event), { signal });
        this.addEventListener('input', event => {
            if (event.target.matches('[data-route-show]')) this.editRoute(event.target, route => { route.show = event.target.value; });
        }, { signal });
        this.addEventListener('focusin', event => {
            if (event.target.matches('[data-route-show]')) this.lastShow = event.target;
        }, { signal });
        this.addEventListener('mouseover', event => {
            const card = event.target.closest('[data-rule]');
            if (card?.dataset.rule === this.pointedAt) return;
            this.pointedAt = card?.dataset.rule || null;
            const rule = card && this.rule(card.dataset.rule);
            this.apps.emit('highlight', { elements: rule ? [rule.when.element, ...rule.then.map(route => route.into)].filter(Boolean) : [] });
        }, { signal });
        this.addEventListener('mouseleave', () => {
            this.pointedAt = null;
            this.apps.emit('highlight', { elements: [] });
        }, { signal });
    }

    get flow() {
        return this.apps.app?.flow || [];
    }

    rule(id) {
        return this.flow.find(rule => rule.id === id) || null;
    }

    change(mutate, ruleId = null) {
        this.apps.change(app => mutate(app.flow, app), { part: 'flow', by: this });
        if (ruleId) this.updateRule(ruleId);
    }

    render() {
        if (!this.apps.app) {
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
                ${flow.length ? `<ol class="app-rules">${flow.map((rule, index) => this.ruleHtml(rule, index)).join('')}</ol>` : '<p class="wb-list-note">No rules yet, so nothing happens when people use the screen. Add a rule.</p>'}
            </section>`;
        this.editors.clear();
        for (const rule of flow) {
            const card = this.card(rule.id);
            const editor = new CallEditor({
                shell: this.shell,
                workbench: this.workbench,
                container: card.querySelector('[data-rule-call]'),
                getCall: () => this.rule(rule.id)?.call,
                setCall: call => this.change(() => { this.rule(rule.id).call = call; }, rule.id),
                screenIds: () => this.valueIds(),
                signal: this.signal,
            });
            editor.render();
            this.editors.set(rule.id, editor);
            this.fillRule(rule);
        }
    }

    card(id) {
        return this.$(`[data-rule="${CSS.escape(id)}"]`);
    }

    ruleHtml(rule, index) {
        const last = this.flow.length - 1;
        return `
            <li class="app-rule" data-rule="${escapeHtml(rule.id)}">
                <div class="app-rule-head">
                    <span class="app-rule-number" aria-hidden="true">${index + 1}</span>
                    <p class="app-rule-sentence" data-sentence></p>
                    <span class="app-rule-actions">
                        <button type="button" class="btn-icon btn-sm btn-tertiary" data-move-rule="-1" aria-label="Move rule ${index + 1} up" ${index === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" class="btn-icon btn-sm btn-tertiary" data-move-rule="1" aria-label="Move rule ${index + 1} down" ${index === last ? 'disabled' : ''}>↓</button>
                        <button type="button" class="btn-icon btn-sm btn-tertiary btn-danger" data-remove-rule aria-label="Delete rule ${index + 1}"><span class="icon icon-trash" aria-hidden="true"></span></button>
                    </span>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">When</span>
                    <div class="app-rule-when">
                        <select data-when-element aria-label="What it waits for"></select>
                        <select data-when-event aria-label="What happens"></select>
                    </div>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">Call</span>
                    <div class="app-call" data-rule-call></div>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">Then</span>
                    <div class="app-routes">
                        <ol class="app-route-list">${rule.then.map((route, routeIndex) => this.routeHtml(routeIndex)).join('')}</ol>
                        <div class="app-chips" data-route-chips></div>
                        <div class="app-route-add">
                            <button type="button" class="btn-sm btn-tertiary" data-add-route="ok"><span class="icon icon-plus" aria-hidden="true"></span>If it works</button>
                            <button type="button" class="btn-sm btn-tertiary" data-add-route="error"><span class="icon icon-plus" aria-hidden="true"></span>If it fails</button>
                        </div>
                    </div>
                </div>
                <ul class="app-rule-problems" data-problems hidden></ul>
            </li>`;
    }

    routeHtml(index) {
        return `
            <li class="app-route" data-route="${index}">
                <select data-route-if aria-label="When this happens"><option value="ok">If it works</option><option value="error">If it fails</option></select>
                <span class="app-route-word">put</span>
                <input type="text" class="mono" data-route-show aria-label="What to show" placeholder="nothing, which clears it" autocomplete="off" spellcheck="false">
                <span class="app-route-word">into</span>
                <select data-route-into aria-label="Where it goes"></select>
                <select data-route-how aria-label="How">${Object.entries(ROUTE_HOW).map(([how, label]) => `<option value="${how}">${label}</option>`).join('')}</select>
                <button type="button" class="btn-icon btn-sm btn-tertiary" data-remove-route aria-label="Remove this"><span class="icon icon-x" aria-hidden="true"></span></button>
            </li>`;
    }

    // The elements as options, grouped by kind; one that isn't on the screen anymore stays chosen.
    elementOptions(kinds, chosen, { app = false } = {}) {
        const elements = this.apps.elements();
        const name = element => (element.label && element.label.toLowerCase() !== element.id.toLowerCase() ? `${element.label} (${element.id})` : element.id);
        const groups = kinds.map(kind => {
            const members = elements.filter(element => element.kind === kind);
            return members.length ? `<optgroup label="${KIND_GROUPS[kind]}">${members.map(element => `<option value="${escapeHtml(element.id)}">${escapeHtml(name(element))}</option>`).join('')}</optgroup>` : '';
        }).join('');
        const missing = chosen && !elements.some(element => element.id === chosen) ? `<option value="${escapeHtml(chosen)}">${escapeHtml(chosen)} (not on the screen)</option>` : '';
        const none = !chosen && !app ? '<option value="">Choose…</option>' : '';
        return `${app ? '<option value="">The app</option>' : ''}${none}${missing}${groups}`;
    }

    // The ids {{id}} can bring in: fields first.
    valueIds() {
        const order = { input: 0, output: 1, static: 2, button: 3 };
        return this.apps.elements()
            .filter(element => ELEMENT_ID.test(element.id) && !ANSWER_NAMES.includes(element.id))
            .sort((a, b) => order[a.kind] - order[b.kind])
            .map(element => element.id);
    }

    fillRule(rule) {
        const card = this.card(rule.id);
        const when = card.querySelector('[data-when-element]');
        when.innerHTML = this.elementOptions(['button', 'input', 'output', 'static'], rule.when.element, { app: true });
        when.value = rule.when.event === 'open' ? '' : rule.when.element;
        this.fillEvents(rule);
        card.querySelectorAll('[data-route]').forEach(row => {
            const route = rule.then[Number(row.dataset.route)];
            row.querySelector('[data-route-if]').value = route.if === 'error' ? 'error' : 'ok';
            row.querySelector('[data-route-show]').value = route.show ?? '';
            const into = row.querySelector('[data-route-into]');
            into.innerHTML = this.elementOptions(['output', 'input', 'static', 'button'], route.into);
            into.value = route.into || '';
            row.querySelector('[data-route-how]').value = route.how || 'replace';
        });
        const chips = card.querySelector('[data-route-chips]');
        const answerChips = ANSWER_CHIPS.map(([name, help]) => `<button type="button" class="wb-chip mono" data-insert-show="{{${name}}}" title="${escapeHtml(help)}">${name}</button>`);
        const screenChips = this.valueIds().map(id => `<button type="button" class="wb-chip mono" data-insert-show="{{${escapeHtml(id)}}}" title="What ${escapeHtml(id)} held when the rule ran">${escapeHtml(id)}</button>`);
        chips.hidden = !rule.then.length;
        chips.innerHTML = `<span class="app-chips-label">From the answer</span>${answerChips.join('')}${screenChips.length ? `<span class="app-chips-label">From the screen</span>${screenChips.join('')}` : ''}`;
        this.updateRule(rule.id);
    }

    fillEvents(rule) {
        const select = this.card(rule.id).querySelector('[data-when-event]');
        const element = this.apps.elements().find(candidate => candidate.id === rule.when.element);
        const events = rule.when.event === 'open' ? ['open'] : element ? EVENTS_BY_KIND[element.kind] : [rule.when.event].filter(Boolean);
        select.innerHTML = events.map(event => `<option value="${event}">${EVENTS[event]}</option>`).join('');
        select.value = rule.when.event;
        select.disabled = events.length < 2;
    }

    // The rule's sentence and what keeps it from running, after any change to it.
    updateRule(id) {
        const rule = this.rule(id);
        const card = rule && this.card(id);
        if (!card) return;
        card.querySelector('[data-sentence]').textContent = describeRule(rule, {
            elementName: element => element || '…',
            serverName: url => (url ? this.apps.serverName(url) : '…'),
        });
        const [[, problems]] = flowProblems([rule], { elements: this.apps.elements(), servers: this.shell.servers });
        const list = card.querySelector('[data-problems]');
        const missingServer = rule.call?.serverUrl && !this.shell.servers[rule.call.serverUrl] ? rule.call.serverUrl : null;
        list.hidden = !problems.length;
        list.innerHTML = problems.map(problem => `<li>${escapeHtml(problem)}${missingServer && problem.startsWith(missingServer)
            ? ` <button type="button" class="link-button" data-add-server="${escapeHtml(missingServer)}">Add ${escapeHtml(this.apps.serverName(missingServer) === missingServer ? 'it' : this.apps.serverName(missingServer))}</button>`
            : ''}</li>`).join('');
        card.classList.toggle('app-rule-incomplete', problems.length > 0);
    }

    updateAll() {
        this.flow.forEach(rule => this.updateRule(rule.id));
    }

    // The screen changed: the element menus follow it, without drawing the rules again.
    refreshElements() {
        for (const rule of this.flow) {
            if (!this.card(rule.id)) return this.render();
            const focused = this.card(rule.id).contains(document.activeElement);
            if (!focused) this.fillRule(rule);
            this.editors.get(rule.id)?.renderChips();
        }
    }

    editRoute(target, mutate) {
        const ruleId = target.closest('[data-rule]').dataset.rule;
        const index = Number(target.closest('[data-route]').dataset.route);
        this.change(() => mutate(this.rule(ruleId).then[index]), ruleId);
    }

    changed(event) {
        const target = event.target;
        const ruleId = target.closest('[data-rule]')?.dataset.rule;
        if (!ruleId) return;
        if (target.matches('[data-when-element]')) {
            const element = this.apps.elements().find(candidate => candidate.id === target.value);
            this.change(() => {
                const rule = this.rule(ruleId);
                const allowed = element ? EVENTS_BY_KIND[element.kind] : ['open'];
                rule.when = { element: target.value, event: allowed.includes(rule.when.event) ? rule.when.event : allowed[0] };
            }, ruleId);
            this.fillEvents(this.rule(ruleId));
        } else if (target.matches('[data-when-event]')) {
            this.change(() => { this.rule(ruleId).when.event = target.value; }, ruleId);
        } else if (target.matches('[data-route-if]')) {
            this.editRoute(target, route => { route.if = target.value; });
        } else if (target.matches('[data-route-into]')) {
            this.editRoute(target, route => { route.into = target.value; });
        } else if (target.matches('[data-route-how]')) {
            this.editRoute(target, route => { route.how = target.value; });
        }
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
        this.change(flow => { flow.push(rule); });
        this.render();
        this.card(rule.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const { dataset } = button;
        if (dataset.addRule !== undefined) return this.addRule();
        const ruleId = button.closest('[data-rule]')?.dataset.rule;
        if (!ruleId) return;
        if (dataset.removeRule !== undefined) {
            this.change(flow => flow.splice(flow.findIndex(rule => rule.id === ruleId), 1));
            return this.render();
        }
        if (dataset.moveRule) {
            this.change(flow => {
                const from = flow.findIndex(rule => rule.id === ruleId);
                const to = from + Number(dataset.moveRule);
                if (to < 0 || to >= flow.length) return;
                flow.splice(to, 0, ...flow.splice(from, 1));
            });
            return this.render();
        }
        if (dataset.addRoute) {
            const rule = this.rule(ruleId);
            const into = rule.then.at(-1)?.into || this.apps.elements().find(element => element.kind === 'output')?.id || '';
            this.change(() => rule.then.push({ if: dataset.addRoute, show: dataset.addRoute === 'error' ? '{{error}}' : '{{text}}', into, how: 'replace' }));
            return this.render();
        }
        if (dataset.removeRoute !== undefined) {
            const index = Number(button.closest('[data-route]').dataset.route);
            this.change(() => this.rule(ruleId).then.splice(index, 1));
            return this.render();
        }
        if (dataset.insertShow) {
            const card = this.card(ruleId);
            const field = this.lastShow?.isConnected && card.contains(this.lastShow) ? this.lastShow : card.querySelector('[data-route-show]');
            if (!field) return;
            const start = field.selectionStart ?? field.value.length;
            field.setRangeText(dataset.insertShow, start, field.selectionEnd ?? start, 'end');
            field.focus();
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        if (dataset.addServer) {
            const url = dataset.addServer;
            const name = this.apps.serverName(url);
            this.shell.addServer(url, name === url ? '' : name, { show: false });
        }
    }
}
