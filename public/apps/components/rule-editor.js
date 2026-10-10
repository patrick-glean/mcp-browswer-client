// One rule, to read and change: its sentence, what starts it (any of its triggers), the tool it
// calls with what, and then where its answer goes, if it works and if it fails. The Outline's Flow
// shows one for each rule, and the Inspector one for the rule picked on the canvas.

import { escapeHtml, schemaOf } from '../../workbench/util.js';
import { answerKey, asksOf, BOX_KINDS, formatRequest, isBox } from '../boxes.js';
import {
    ANSWER_NAMES, DEFAULT_SHOW, describeRule, displayValue, ELEMENT_ID, EVENTS, EVENTS_BY_KIND, flowProblems, listed, ROUTE_HOW, trigger, triggersOf,
} from '../flow.js';
import { CallEditor } from './call-editor.js';

const ANSWER_CHIPS = [
    ['text', 'The text the tool returned'],
    ['structured', 'Its structured content; add .name for one value, as {{structured.count}}'],
    ['json', 'Its text read as JSON; add .name for one value, as {{json.items.0.title}}'],
    ['html', 'The HTML in its answer, to show as HTML'],
    ['result', 'The whole result, as JSON'],
    ['error', 'Why it failed'],
];
const KIND_GROUPS = { button: 'Buttons', input: 'Fields', output: 'Outputs', static: 'Text' };
const MAX_PICKS = 40;

// The values in an answer, by the path a template names them with: [[path, value]].
function picksOf(values) {
    const picks = [];
    const visit = (value, path, depth) => {
        if (picks.length >= MAX_PICKS) return;
        if (value !== null && typeof value === 'object' && depth < 4) {
            for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`, depth + 1);
            return;
        }
        if (value !== undefined && value !== null && value !== '') picks.push([path, value]);
    };
    if (values?.text) picks.push(['text', values.text]);
    if (values?.structured) visit(values.structured, 'structured', 0);
    if (values?.json && typeof values.json === 'object') visit(values.json, 'json', 0);
    if (values?.html) picks.push(['html', values.html]);
    return picks;
}

export class RuleEditor {
    // `by` is the component the edits come from; `onRemove` and `onMove(step)` change the flow
    // around the rule; `focus` points at one part of it: { trigger }, { arg } or { route }.
    constructor({ shell, workbench, apps, container, ruleId, index = 0, count = 1, by = null, focus = null, onRemove = null, onMove = null, signal }) {
        Object.assign(this, { shell, workbench, apps, container, ruleId, index, count, by, focus, onRemove, onMove, signal });
        this.lastShow = null;
        container.addEventListener('click', event => this.clicked(event), { signal });
        container.addEventListener('change', event => this.changed(event), { signal });
        container.addEventListener('input', event => {
            if (event.target.matches('[data-route-show]')) this.editRoute(event.target, route => { route.show = event.target.value; });
        }, { signal });
        container.addEventListener('focusin', event => {
            if (event.target.matches('[data-route-show]')) this.lastShow = event.target;
        }, { signal });
    }

    get rule() {
        return this.apps.app?.flow.find(rule => rule.id === this.ruleId) || null;
    }

    change(mutate) {
        const rule = this.rule;
        if (!rule) return;
        this.apps.change(() => mutate(rule), { part: 'flow', by: this.by });
        this.update();
    }

    // The elements as options, grouped by kind; one that isn't on the screen anymore stays chosen.
    // The id comes first, as on the canvas's ports, so a narrow menu still tells them apart.
    elementOptions(kinds, chosen, { app = false } = {}) {
        const elements = this.apps.elements();
        const name = element => (element.label && element.label.toLowerCase() !== element.id.toLowerCase() ? `${element.id} (${element.label})` : element.id);
        const groups = kinds.map(kind => {
            const members = elements.filter(element => element.kind === kind);
            return members.length ? `<optgroup label="${KIND_GROUPS[kind]}">${members.map(element => `<option value="${escapeHtml(element.id)}">${escapeHtml(name(element))}</option>`).join('')}</optgroup>` : '';
        }).join('');
        const missing = chosen && !elements.some(element => element.id === chosen) ? `<option value="${escapeHtml(chosen)}">${escapeHtml(chosen)} (not on the screen)</option>` : '';
        const none = !chosen && !app ? '<option value="">Choose…</option>' : '';
        return `${app ? '<option value="">The app</option>' : ''}${none}${missing}${groups}`;
    }

    // The ids {{id}} usually brings in: fields, then outputs (any element's id works).
    valueIds() {
        const order = { input: 0, output: 1 };
        return this.apps.elements()
            .filter(element => element.kind in order && (ELEMENT_ID.test(element.id) || element.part) && !ANSWER_NAMES.includes(element.id))
            .sort((a, b) => order[a.kind] - order[b.kind])
            .map(element => element.id);
    }

    render() {
        const rule = this.rule;
        if (!rule) {
            this.container.innerHTML = '';
            return;
        }
        const triggers = triggersOf(rule);
        const focused = (kind, index) => (this.focus?.[kind] === index ? ' app-focus' : '');
        this.container.innerHTML = `
            <div class="app-rule" data-rule="${escapeHtml(rule.id)}">
                <div class="app-rule-head">
                    <span class="app-rule-number" aria-hidden="true">${this.index + 1}</span>
                    <p class="app-rule-sentence" data-sentence></p>
                    <span class="app-rule-actions">
                        ${this.onMove ? `<button type="button" class="btn-icon btn-sm btn-tertiary" data-move-rule="-1" aria-label="Move rule ${this.index + 1} up" ${this.index === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" class="btn-icon btn-sm btn-tertiary" data-move-rule="1" aria-label="Move rule ${this.index + 1} down" ${this.index === this.count - 1 ? 'disabled' : ''}>↓</button>` : ''}
                        ${this.onRemove ? `<button type="button" class="btn-icon btn-sm btn-tertiary btn-danger" data-remove-rule aria-label="Delete rule ${this.index + 1}"><span class="icon icon-trash" aria-hidden="true"></span></button>` : ''}
                    </span>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">When</span>
                    <div class="app-rule-when">
                        <ol class="app-trigger-list">${triggers.map((candidate, index) => `
                            <li class="app-trigger${focused('trigger', index)}" data-trigger="${index}">
                                ${index ? '<span class="app-route-word">or</span>' : ''}
                                <select data-when-element aria-label="What it waits for"></select>
                                <select data-when-event aria-label="What happens"></select>
                                <button type="button" class="btn-icon btn-sm btn-tertiary" data-remove-trigger aria-label="Stop waiting for this"><span class="icon icon-x" aria-hidden="true"></span></button>
                            </li>`).join('')}
                        </ol>
                        <button type="button" class="btn-sm btn-tertiary app-add-trigger" data-add-trigger><span class="icon icon-plus" aria-hidden="true"></span>${triggers.length ? 'Or when…' : 'When…'}</button>
                    </div>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">Call</span>
                    <div class="app-call" data-rule-call></div>
                </div>
                <div class="app-rule-row" data-prompt-row hidden>
                    <span class="app-rule-label">Asks</span>
                    <div class="app-prompt">
                        <label class="app-field"><span>What its boxes need goes in</span><select data-prompt-field aria-label="The field the call asks for its boxes in"></select></label>
                        <p class="app-note text-secondary" data-prompt-note></p>
                        <details class="app-prompt-preview" data-prompt-details><summary>What it adds to the prompt</summary><pre class="mono" data-prompt-preview></pre></details>
                    </div>
                </div>
                <div class="app-rule-row">
                    <span class="app-rule-label">Then</span>
                    <div class="app-routes">
                        <ol class="app-route-list">${(rule.then || []).map((route, index) => `
                            <li class="app-route${focused('route', index)}" data-route="${index}">
                                <select data-route-if aria-label="When this happens"><option value="ok">If it works</option><option value="error">If it fails</option></select>
                                <span class="app-route-word">put</span>
                                <input type="text" class="mono" data-route-show aria-label="What to show" placeholder="nothing, which clears it" autocomplete="off" spellcheck="false">
                                <span class="app-route-where">
                                    <span class="app-route-word">into</span>
                                    <select data-route-into aria-label="Where it goes"></select>
                                    <select data-route-how aria-label="How">${Object.entries(ROUTE_HOW).map(([how, label]) => `<option value="${how}">${label}</option>`).join('')}</select>
                                    <button type="button" class="btn-icon btn-sm btn-tertiary" data-remove-route aria-label="Remove this"><span class="icon icon-x" aria-hidden="true"></span></button>
                                </span>
                            </li>`).join('')}
                        </ol>
                        <div class="app-chips" data-route-chips></div>
                        <div class="app-picks" data-picks hidden></div>
                        <div class="app-route-add">
                            <button type="button" class="btn-sm btn-tertiary" data-add-route="ok"><span class="icon icon-plus" aria-hidden="true"></span>If it works</button>
                            <button type="button" class="btn-sm btn-tertiary" data-add-route="error"><span class="icon icon-plus" aria-hidden="true"></span>If it fails</button>
                        </div>
                    </div>
                </div>
                <ul class="app-rule-problems" data-problems hidden></ul>
            </div>`;
        this.callEditor = new CallEditor({
            shell: this.shell,
            workbench: this.workbench,
            container: this.container.querySelector('[data-rule-call]'),
            getCall: () => this.rule?.call,
            setCall: call => this.change(rule => { rule.call = call; }),
            screenIds: () => this.valueIds(),
            signal: this.signal,
        });
        this.callEditor.render();
        this.fill();
        const focus = this.container.querySelector('.app-focus');
        if (this.focus?.arg) this.container.querySelector(`[data-rule-call] [name="${CSS.escape(this.focus.arg)}"]`)?.closest('.tool-input-card')?.classList.add('app-focus');
        (focus || this.container.querySelector('.app-focus'))?.scrollIntoView({ block: 'nearest' });
    }

    // Puts the rule's values into the card's controls.
    fill() {
        const rule = this.rule;
        if (!rule) return;
        const triggers = triggersOf(rule);
        this.container.querySelectorAll('[data-trigger]').forEach(row => {
            const candidate = triggers[Number(row.dataset.trigger)];
            if (!candidate) return;
            const select = row.querySelector('[data-when-element]');
            select.innerHTML = this.elementOptions(['button', 'input', 'output', 'static'], candidate.event === 'open' ? '' : candidate.element, { app: true });
            select.value = candidate.event === 'open' ? '' : candidate.element;
            this.fillEvents(row, candidate);
        });
        this.container.querySelectorAll('[data-route]').forEach(row => {
            const route = rule.then[Number(row.dataset.route)];
            if (!route) return;
            row.querySelector('[data-route-if]').value = route.if === 'error' ? 'error' : 'ok';
            row.querySelector('[data-route-show]').value = route.show ?? '';
            const into = row.querySelector('[data-route-into]');
            into.innerHTML = this.elementOptions(['output', 'input', 'static', 'button'], route.into);
            into.value = route.into || '';
            row.querySelector('[data-route-how]').value = route.how || 'replace';
        });
        const chips = this.container.querySelector('[data-route-chips]');
        const answerChips = ANSWER_CHIPS.map(([name, help]) => `<button type="button" class="wb-chip mono" data-insert-show="{{${name}}}" title="${escapeHtml(help)}">${name}</button>`);
        const screenChips = this.valueIds().map(id => `<button type="button" class="wb-chip mono" data-insert-show="{{${escapeHtml(id)}}}" title="What ${escapeHtml(id)} held when the rule ran">${escapeHtml(id)}</button>`);
        chips.hidden = !rule.then.length;
        chips.innerHTML = `<span class="app-chips-label">From the answer</span>${answerChips.join('')}${screenChips.length ? `<span class="app-chips-label">From the screen</span>${screenChips.join('')}` : ''}`;
        this.renderPicks();
        this.update();
    }

    fillEvents(row, candidate) {
        const select = row.querySelector('[data-when-event]');
        const element = this.apps.elements().find(found => found.id === candidate.element);
        const events = candidate.event === 'open' ? ['open'] : element ? EVENTS_BY_KIND[element.kind] : [candidate.event];
        select.innerHTML = events.map(event => `<option value="${event}">${EVENTS[event]}</option>`).join('');
        select.value = candidate.event;
        select.disabled = events.length < 2;
    }

    // The values of the rule's last answer, each a click away from what a route shows.
    renderPicks() {
        const box = this.container.querySelector('[data-picks]');
        const answer = this.apps.answers.get(this.ruleId);
        const picks = answer?.ok && this.rule?.then.length ? picksOf(answer.values) : [];
        box.hidden = !picks.length;
        box.innerHTML = picks.length ? `<span class="app-chips-label">From its last answer</span>${picks.map(([path, value]) => {
            const shown = displayValue(value).replace(/\s+/g, ' ');
            return `<button type="button" class="app-pick" data-insert-show="{{${escapeHtml(path)}}}" title="Put {{${escapeHtml(path)}}} where the cursor was"><span class="mono">${escapeHtml(path)}</span><span class="app-pick-value">${escapeHtml(shown.length > 60 ? `${shown.slice(0, 59)}…` : shown)}</span></button>`;
        }).join('')}` : '';
    }

    // Where the call asks for what the rule's boxes show, and what it adds there. Shown once the
    // rule fills a box (or asks in a field).
    fillPrompt() {
        const rule = this.rule;
        const row = this.container.querySelector('[data-prompt-row]');
        if (!rule || !row) return;
        const elements = this.apps.elements();
        const asks = asksOf(rule, elements);
        const fillsBoxes = (rule.then || []).some(route => route.if !== 'error' && isBox(elements.find(element => element.id === route.into)));
        row.hidden = !rule.prompt && !fillsBoxes && !asks.length;
        if (row.hidden) return;
        const fields = Object.entries(schemaOf(this.callEditor?.tool)?.properties || {}).filter(([, prop]) => prop?.type === 'string').map(([key]) => key);
        if (rule.prompt && !fields.includes(rule.prompt)) fields.unshift(rule.prompt);
        const select = row.querySelector('[data-prompt-field]');
        if (document.activeElement !== select) {
            select.innerHTML = `<option value="">Nowhere: don't ask for them</option>${fields.map(field => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join('')}`;
            select.value = rule.prompt || '';
        }
        const tool = rule.call?.toolName || 'The tool';
        row.querySelector('[data-prompt-note]').textContent = !rule.prompt
            ? 'Its boxes each take a piece of a JSON answer. Choose the field its question goes in, and the call asks there for what each box shows.'
            : asks.length
                ? `Each call adds to ${rule.prompt} a request for ${listed(asks.map(ask => `${ask.key} (${BOX_KINDS[ask.kind].noun})`))}, as one JSON object, from what each box says goes in it.`
                : `Wire ${tool}'s Answer to a box, and the call asks in ${rule.prompt} for what the box shows.`;
        const details = row.querySelector('[data-prompt-details]');
        details.hidden = !rule.prompt || !asks.length;
        row.querySelector('[data-prompt-preview]').textContent = asks.length ? formatRequest(asks, { size: this.apps.app?.screen?.size }) : '';
    }

    // The sentence and what keeps the rule from running, after any change to it.
    update() {
        const rule = this.rule;
        const card = this.container.querySelector('.app-rule');
        if (!rule || !card) return;
        this.fillPrompt();
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

    // The screen changed: the menus follow it, unless someone is using them.
    refresh() {
        if (!this.container.contains(document.activeElement)) this.fill();
        this.callEditor?.renderChips();
    }

    editRoute(target, mutate) {
        const index = Number(target.closest('[data-route]').dataset.route);
        this.change(rule => mutate(rule.then[index]));
    }

    editTrigger(target, mutate) {
        const index = Number(target.closest('[data-trigger]').dataset.trigger);
        this.change(rule => {
            const triggers = triggersOf(rule);
            triggers[index] = mutate(triggers[index]);
            rule.when = triggers;
        });
    }

    changed(event) {
        const target = event.target;
        if (target.matches('[data-when-element]')) {
            const element = this.apps.elements().find(candidate => candidate.id === target.value);
            this.editTrigger(target, candidate => {
                const allowed = element ? EVENTS_BY_KIND[element.kind] : ['open'];
                return trigger(target.value, allowed.includes(candidate.event) ? candidate.event : allowed[0]);
            });
            const row = target.closest('[data-trigger]');
            this.fillEvents(row, triggersOf(this.rule)[Number(row.dataset.trigger)]);
        } else if (target.matches('[data-when-event]')) {
            this.editTrigger(target, candidate => trigger(candidate.element, target.value));
        } else if (target.matches('[data-route-if]')) {
            this.editRoute(target, route => {
                if (route.show === DEFAULT_SHOW[route.if === 'error' ? 'error' : 'ok']) route.show = DEFAULT_SHOW[target.value];
                route.if = target.value;
            });
            this.fill();
        } else if (target.matches('[data-route-into]')) {
            // An answer sent to a box takes the box's key of it, unless it was made to show more.
            const box = isBox(this.apps.elements().find(element => element.id === target.value));
            this.editRoute(target, route => {
                const plain = route.show === DEFAULT_SHOW.ok || route.show === `{{json.${answerKey(route.into)}}}`;
                if (route.if !== 'error' && plain && (box || this.rule.prompt)) route.show = `{{json.${answerKey(target.value)}}}`;
                route.into = target.value;
            });
            this.fill();
        } else if (target.matches('[data-route-how]')) {
            this.editRoute(target, route => { route.how = target.value; });
        } else if (target.matches('[data-prompt-field]')) {
            this.change(rule => {
                if (target.value) rule.prompt = target.value;
                else delete rule.prompt;
            });
        }
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || !this.container.contains(button)) return;
        const { dataset } = button;
        if (dataset.removeRule !== undefined) return this.onRemove?.(this.ruleId);
        if (dataset.moveRule) return this.onMove?.(this.ruleId, Number(dataset.moveRule));
        if (dataset.addTrigger !== undefined) {
            // The next thing to wait for: a button it doesn't wait for yet, else a field, else the app opening.
            const triggers = triggersOf(this.rule);
            const taken = new Set(triggers.map(candidate => candidate.element));
            const free = kind => this.apps.elements().find(element => element.kind === kind && !taken.has(element.id));
            const next = free('button') ? trigger(free('button').id, 'click')
                : free('input') ? trigger(free('input').id, 'enter')
                : triggers.some(candidate => candidate.event === 'open') ? null : trigger('', 'open');
            if (!next) return;
            this.change(rule => { rule.when = [...triggersOf(rule), next]; });
            return this.render();
        }
        if (dataset.removeTrigger !== undefined) {
            const index = Number(button.closest('[data-trigger]').dataset.trigger);
            this.change(rule => { rule.when = triggersOf(rule).filter((candidate, at) => at !== index); });
            return this.render();
        }
        if (dataset.addRoute) {
            const rule = this.rule;
            const into = rule.then.at(-1)?.into || this.apps.elements().find(element => element.kind === 'output')?.id || '';
            this.change(found => found.then.push({ if: dataset.addRoute, show: DEFAULT_SHOW[dataset.addRoute], into, how: 'replace' }));
            return this.render();
        }
        if (dataset.removeRoute !== undefined) {
            const index = Number(button.closest('[data-route]').dataset.route);
            this.change(rule => rule.then.splice(index, 1));
            return this.render();
        }
        if (dataset.insertShow) {
            const focusedRoute = this.focus?.route !== undefined ? this.container.querySelector(`[data-route="${this.focus.route}"] [data-route-show]`) : null;
            const placed = this.lastShow?.isConnected && this.container.contains(this.lastShow) ? this.lastShow : null;
            const field = placed || focusedRoute || this.container.querySelector('[data-route-show]');
            if (!field) return;
            // Where no cursor was put, a value takes the place of the one value shown, as {{text}}.
            const whole = !placed && /^\s*\{\{[^{}]*\}\}\s*$/.test(field.value);
            const start = whole ? 0 : field.selectionStart ?? field.value.length;
            field.setRangeText(dataset.insertShow, start, whole ? field.value.length : field.selectionEnd ?? start, 'end');
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
