// The app builder's canvas: the app's screen, running, with a port for each of its elements; Start,
// where the app begins; a node for each rule's tool; and wires between them, each one part of a
// rule (graph.js): what starts the tool, what fills its fields, and where its answer and error go,
// through a transform that says what of the answer is shown. Drag from a port to another to wire
// them, drag a tool by its title to move it, and pick anything to change it in the Inspector. In
// Design, clicks on the screen pick its elements; in Run, the screen takes them, and wires light up
// as rules run. The Library adds components, tools and transforms.

import { debounce, escapeHtml, schemaOf, serverLabel } from '../../workbench/util.js';
import { answerKey, BOX_KINDS, BOX_WIDTHS, isBox, promptFieldOf } from '../boxes.js';
import { EVENTS, FlowError, flowProblems, isDefaultShow, newRule, routeSummary, triggersOf } from '../flow.js';
import { canConnect, connect, parsePort, placeRules, wiresOf } from '../graph.js';
import { AppRunner } from '../runner.js';
import { COMPONENT_TYPES, freeId, newComponent } from '../screen.js';
import { AppElement } from './base.js';
import { TraceList } from './trace.js';

// The canvas's geometry, which the styles read as custom properties. A wide screen (a
// dashboard's) runs at `wide` instead of `width`.
const SCREEN = { x: 24, y: 76, width: 300, wide: 600, bar: 30, gutter: 112 };
// Room between the screen's ports and the tools for a transform's label on a wire.
const TOOLS_GAP = 120;
const TOOL_WIDTH = 220;
const ROW = 26;
const TRANSFORMS = [
    ['text', 'Text', 'The text the tool returned', { show: '{{text}}', how: 'replace' }],
    ['value', 'A value', 'One value from its structured content or JSON; pick it in the Inspector', { show: '{{structured}}', how: 'replace' }],
    ['template', 'Template', 'Your words around values: You said {{question}}: {{text}}', { show: '{{text}}', how: 'replace' }],
    ['json', 'JSON', 'The whole result, as JSON', { show: '{{result}}', how: 'replace' }],
    ['html', 'HTML', 'The HTML in its answer, shown as HTML', { show: '{{html}}', how: 'html' }],
];
const WIRE_KINDS = ['trigger', 'arg', 'sent', 'answer', 'error'];
// The wires that carry something to the screen, each with its transform: what of it shows.
const ROUTE_KINDS = new Set(['sent', 'answer', 'error']);
// How near an edge of the canvas a wire being dragged starts it scrolling.
const EDGE = 40;

const elementPort = id => `el:${id}`;

export class AppCanvas extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.mode = 'design';
        this.layout = { height: 0, rects: {} };
        this.trace = new TraceList();
        this.runner = new AppRunner({
            shell: this.shell,
            workbench: this.workbench,
            getApp: () => this.apps.app,
            onTrace: entry => this.trace.add(entry),
            onLayout: layout => {
                this.layout = layout;
                this.renderGraph();
            },
            onActivity: activity => this.showActivity(activity),
            onAnswer: (ruleId, answer) => this.apps.setAnswer(ruleId, answer),
            signal,
        });
        this.reloadSoon = debounce(() => this.load({ start: false }), 300);
        this.drawSoon = () => {
            cancelAnimationFrame(this.drawFrame);
            this.drawFrame = requestAnimationFrame(() => this.drawWires());
        };
        this.apps.on('shown', () => {
            this.trace.entries = [];
            this.mode = 'design';
            this.render({ start: true });
        }, signal);
        this.apps.on('view', () => this.render({ start: false }), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'screen') {
                this.layout = { height: this.layout.height, rects: {} };
                this.renderGraph();
                this.reloadSoon();
            }
            if (part === 'flow') this.runner.flowChanged();
            if ((part === 'flow' || part === 'layout' || part === 'name') && by !== this) this.renderGraph();
        }, signal);
        this.apps.on('select', () => this.markSelection(), signal);
        this.apps.on('restart', () => this.restart(), signal);
        this.apps.on('highlight', ({ elements }) => this.runner.highlight(elements), signal);
        this.shell.on('mode', ({ mode }) => {
            if (mode === 'apps' && this.waiting) this.load(this.waiting);
        }, signal);
        this.shell.on('tools', () => this.renderGraph(), signal);
        this.shell.on('servers', () => this.renderGraph(), signal);
        this.addEventListener('click', event => {
            this.focusCanvas(event);
            this.clicked(event);
        }, { signal });
        this.addEventListener('pointerdown', event => this.pointerDown(event), { signal });
        this.addEventListener('keydown', event => this.keyDown(event), { signal });
        this.addEventListener('input', event => {
            if (event.target.matches('[data-library-filter]')) this.renderLibraryItems();
        }, { signal });
        this.addEventListener('dragstart', event => this.dragStart(event), { signal });
        this.addEventListener('dragover', event => {
            if (event.dataTransfer?.types.includes('application/x-mcp-app')) event.preventDefault();
        }, { signal });
        this.addEventListener('drop', event => this.dropped(event), { signal });
        document.addEventListener('pointerdown', event => {
            const library = this.$('[data-library]');
            if (library && !library.hidden && !library.contains(event.target) && !event.target.closest('[data-toggle-library]')) this.toggleLibrary(false);
        }, { signal });
    }

    get app() {
        return this.apps.app;
    }

    // --- The canvas itself, drawn when an app opens ---

    render({ start = true } = {}) {
        const app = this.app;
        if (!app || this.apps.view !== 'canvas') {
            this.runner.stop();
            this.innerHTML = '';
            this.frame = null;
            return;
        }
        this.layout = { height: 0, rects: {} };
        this.innerHTML = `
            <div class="app-canvas-toolbar">
                <div class="app-library-anchor">
                    <button type="button" class="btn-sm" data-toggle-library aria-expanded="false" title="Components, your servers' tools and transforms, to drag onto the canvas or click to add"><span class="icon icon-plus" aria-hidden="true"></span>Library</button>
                    <div class="app-library" data-library role="dialog" aria-label="Library" hidden></div>
                </div>
                <div class="wb-chips" role="group" aria-label="Design or run">
                    <button type="button" class="wb-chip" data-canvas-mode="design" aria-pressed="true" title="Clicks on the screen pick its parts, to change them">Design</button>
                    <button type="button" class="wb-chip" data-canvas-mode="run" aria-pressed="false" title="The screen takes clicks and typing, as people will use it"><span class="icon icon-play" aria-hidden="true"></span>Run</button>
                </div>
                <button type="button" class="btn-sm btn-tertiary" data-restart title="Runs the app from the start, with what Start calls"><span class="icon icon-refresh" aria-hidden="true"></span>Restart</button>
                <button type="button" class="btn-sm btn-tertiary" data-tidy title="Puts every tool beside what it's wired to">Tidy up</button>
                <span class="wb-spacer"></span>
                <span class="app-canvas-hint text-secondary" data-canvas-hint>Drag from a ● to another to connect them.</span>
            </div>
            <div class="app-canvas-scroll" data-canvas-scroll tabindex="-1">
                <div class="app-surface" data-surface>
                    <svg class="app-wires" data-wires aria-hidden="true">
                        <defs>${WIRE_KINDS.map(kind => `<marker id="app-arrow-${kind}" class="app-arrow app-arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>`).join('')}</defs>
                        <g data-wire-paths></g>
                        <path class="app-wire-draft" data-draft d="" hidden/>
                    </svg>
                    <button type="button" class="app-start" data-start data-select-start title="The app starts here, on this screen. Wire ● to a tool's Run to call it when the app opens.">
                        <span class="app-start-mark" aria-hidden="true">▶</span>Start
                        <span class="app-port app-port-start" data-port="start" role="presentation"></span>
                    </button>
                    <div class="app-screen-card" data-screen-card>
                        <div class="app-screen-window">
                            <div class="app-screen-bar"><span class="app-screen-dots" aria-hidden="true"></span><span class="app-screen-name" data-screen-name></span></div>
                            <div class="app-screen-body">
                                <iframe class="app-canvas-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(app.name)}, running"></iframe>
                                <div class="app-screen-overlay" data-overlay></div>
                            </div>
                        </div>
                        <div class="app-screen-gutter" data-gutter></div>
                    </div>
                    <div class="app-nodes" data-nodes></div>
                    <div class="app-pills" data-pills></div>
                </div>
            </div>
            <section class="app-canvas-trace" aria-label="What happened">
                <div class="app-trace-head">
                    <h4>What happened</h4>
                    <button type="button" class="btn-sm btn-tertiary" data-clear-trace>Clear</button>
                </div>
                <ol class="app-trace" data-trace aria-live="polite"></ol>
            </section>`;
        this.dataset.mode = this.mode;
        this.markMode();
        for (const [name, value] of Object.entries({ '--screen-x': SCREEN.x, '--screen-y': SCREEN.y, '--screen-bar': SCREEN.bar, '--gutter-w': SCREEN.gutter, '--tool-w': TOOL_WIDTH })) {
            this.style.setProperty(name, `${value}px`);
        }
        this.surface = this.$('[data-surface]');
        this.frame = this.$('iframe');
        this.trace.attach(this.$('[data-trace]'));
        this.renderGraph();
        this.load({ start });
    }

    // Only a screen someone can see runs, so an app's "when it opens" calls wait until then.
    load({ start }) {
        if (!this.frame || !this.app || this.apps.view !== 'canvas') return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = { start: start || !!this.waiting?.start };
            return;
        }
        this.waiting = null;
        this.runner.load(this.frame, { start });
    }

    restart() {
        if (this.apps.view !== 'canvas') return;
        this.trace.add({ time: Date.now(), kind: 'note', text: 'Restarted the app.' });
        this.load({ start: true });
    }

    setMode(mode) {
        this.mode = mode;
        this.dataset.mode = mode;
        this.markMode();
        this.hint(mode === 'run' ? 'Use the app on the screen: wires light up as its rules run.' : 'Drag from a ● to another to connect them.');
    }

    markMode() {
        this.querySelectorAll('[data-canvas-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.canvasMode === this.mode)));
    }

    hint(text, { error = false } = {}) {
        const hint = this.$('[data-canvas-hint]');
        if (!hint) return;
        hint.textContent = text;
        hint.classList.toggle('text-error', error);
        clearTimeout(this.hintTimer);
        if (error) this.hintTimer = setTimeout(() => this.hint(this.mode === 'run' ? 'Use the app on the screen: wires light up as its rules run.' : 'Drag from a ● to another to connect them.'), 6000);
    }

    // --- The graph: ports, tools, wires and transforms, from the app and where the screen put things ---

    elements() {
        return this.apps.elements();
    }

    elementIds() {
        return this.elements().map(element => element.id);
    }

    // Where each element's port goes in the gutter: level with the element, moved down just enough
    // that labels don't overlap. { id: { y, at } } in gutter coordinates, `at` the element's middle.
    portSlots() {
        const slots = [];
        for (const element of this.elements()) {
            const rect = this.layout.rects[element.id];
            if (!rect) continue;
            slots.push({ id: element.id, at: rect.top + Math.min(rect.height, 40) / 2 });
        }
        slots.sort((a, b) => a.at - b.at);
        let last = -Infinity;
        for (const slot of slots) {
            slot.y = Math.max(slot.at, last + 20);
            last = slot.y;
        }
        return Object.fromEntries(slots.map(slot => [slot.id, slot]));
    }

    // The fields a tool's node shows: the required ones and any with a value.
    shownArgs(rule) {
        const tool = this.toolOf(rule);
        const required = schemaOf(tool)?.required || [];
        return [...new Set([...required, ...Object.keys(rule.call?.args || {})])];
    }

    toolOf(rule) {
        return (this.shell.servers[rule.call?.serverUrl]?.tools || []).find(tool => tool.name === rule.call?.toolName) || null;
    }

    nodeHeight(rule) {
        return 40 + (1 + this.shownArgs(rule).length) * ROW + 10 + 3 * ROW + 22;
    }

    screenWidth() {
        return this.app?.screen?.size === 'wide' ? SCREEN.wide : SCREEN.width;
    }

    // Where the tools' column starts, right of the screen and its ports.
    toolsX() {
        return SCREEN.x + this.screenWidth() + SCREEN.gutter + TOOLS_GAP;
    }

    // Where each rule's tool is: where it was put (never over the screen, which may have grown
    // wider since), or beside what it's wired to.
    positions() {
        const flow = this.app?.flow || [];
        const slots = this.portSlots();
        const top = SCREEN.y + SCREEN.bar;
        const anchor = rule => {
            const ys = wiresOf([rule], this.elementIds()).map(wire => slots[wire.element]?.y).filter(y => y !== undefined);
            return ys.length ? top + Math.min(...ys) - 48 : null;
        };
        const placed = placeRules(flow, {
            x: this.toolsX(),
            top: 24,
            width: TOOL_WIDTH,
            anchor,
            height: rule => this.nodeHeight(rule),
        });
        return new Map(flow.map(rule => [rule.id, rule.position ? { x: Math.max(rule.position.x, this.toolsX()), y: rule.position.y } : placed.get(rule.id)]));
    }

    renderGraph() {
        if (!this.surface?.isConnected || !this.app) return;
        const app = this.app;
        this.style.setProperty('--screen-w', `${this.screenWidth()}px`);
        this.$('[data-screen-name]').textContent = app.name || 'App';
        this.style.setProperty('--frame-h', `${Math.max(220, Math.ceil(this.layout.height || 0))}px`);
        this.renderGutter();
        this.renderOverlay();
        this.renderNodes();
        this.renderPills();
        this.markSelection();
        this.drawSoon();
    }

    renderGutter() {
        const slots = this.portSlots();
        const elements = this.elements();
        // A part's elements go under the part's own row, by the rest of their id (.refresh under part).
        const shortId = element => (element.part ? element.id.slice(element.part.length) : element.id);
        this.$('[data-gutter]').innerHTML = `
            <svg class="app-leads" aria-hidden="true">${Object.values(slots).map(slot => `<path d="M 0 ${SCREEN.bar + slot.at} C 9 ${SCREEN.bar + slot.at}, 7 ${SCREEN.bar + slot.y}, 16 ${SCREEN.bar + slot.y}"/>`).join('')}</svg>
            ${elements.filter(element => slots[element.id]).map(element => `
                <div class="app-gutter-row" style="--y: ${SCREEN.bar + slots[element.id].y}px" data-gutter-row="${escapeHtml(element.id)}">
                    <span class="app-gutter-label mono" title="${escapeHtml(`${element.label} (${element.id})`)}">${escapeHtml(shortId(element))}</span>
                    <span class="app-port app-port-element app-port-${element.kind}" data-port="${escapeHtml(elementPort(element.id))}" title="${escapeHtml(`${element.id}: drag to a tool's Run or one of its fields, or from a tool's Answer to here`)}"></span>
                </div>`).join('')}`;
    }

    renderOverlay() {
        const overlay = this.$('[data-overlay]');
        overlay.innerHTML = this.elements().filter(element => this.layout.rects[element.id]).map(element => {
            const rect = this.layout.rects[element.id];
            return `<button type="button" class="app-element-box${element.part ? ' app-element-in-part' : ''}" data-element-box="${escapeHtml(element.id)}" style="--top: ${rect.top}px; --left: ${rect.left}px; --width: ${rect.width}px; --height: ${rect.height}px" aria-label="${escapeHtml(`Pick ${element.id}`)}" title="${escapeHtml(`${element.label} (${element.id})`)}"></button>`;
        }).join('');
    }

    renderNodes() {
        const app = this.app;
        const positions = this.positions();
        const problems = new Map(flowProblems(app.flow, { elements: this.elements(), servers: this.shell.servers }));
        this.$('[data-nodes]').innerHTML = app.flow.map(rule => {
            const at = positions.get(rule.id);
            const server = this.shell.servers[rule.call?.serverUrl];
            const triggers = triggersOf(rule);
            const when = triggers.length
                ? triggers.map(({ element, event }) => (event === 'open' ? 'the app opens' : `${element} ${EVENTS[event]}`)).join(' or ')
                : 'nothing yet';
            const issues = problems.get(rule.id) || [];
            const status = this.statuses?.get(rule.id);
            return `
                <div class="app-node${issues.length ? ' app-node-incomplete' : ''}" data-node="${escapeHtml(rule.id)}" tabindex="0" style="--x: ${at.x}px; --y: ${at.y}px" aria-label="${escapeHtml(`${rule.call?.toolName || 'A tool'} on ${server ? serverLabel(server) : 'no server'}`)}" title="${escapeHtml(issues.join(' '))}">
                    <div class="app-node-head" data-drag-node>
                        <span class="app-node-title mono">${escapeHtml(rule.call?.toolName || 'Choose a tool')}</span>
                        <span class="app-node-server">${escapeHtml(server ? serverLabel(server) : rule.call?.serverUrl ? 'not added' : '')}</span>
                    </div>
                    <div class="app-node-row app-node-run">
                        <span class="app-port app-port-run" data-port="run:${escapeHtml(rule.id)}" title="Run: wire a button, a field or Start here to start it"></span>
                        <span class="app-node-name">▶ Run</span><span class="app-node-value">when ${escapeHtml(when)}</span>
                    </div>
                    ${this.shownArgs(rule).map(arg => {
                        const value = rule.call?.args?.[arg];
                        const shown = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
                        return `
                    <div class="app-node-row">
                        <span class="app-port app-port-arg" data-port="arg:${escapeHtml(rule.id)}:${escapeHtml(arg)}" title="${escapeHtml(`${arg}: wire a field here to fill it`)}"></span>
                        <span class="app-node-name">${escapeHtml(arg)}</span><span class="app-node-value mono">${escapeHtml(shown.length > 28 ? `${shown.slice(0, 27)}…` : shown || '—')}</span>
                    </div>`;
                    }).join('')}
                    <div class="app-node-split"></div>
                    <div class="app-node-row app-node-out">
                        <span class="app-port app-port-sent" data-port="sent:${escapeHtml(rule.id)}" title="Sent: wire it to where what's sent shows as it goes, such as a chat's conversation, or to a field to clear it"></span>
                        <span class="app-node-name">↗ Sent</span>
                    </div>
                    <div class="app-node-row app-node-out">
                        <span class="app-port app-port-answer" data-port="ok:${escapeHtml(rule.id)}" title="Answer: wire it to where it goes on the screen"></span>
                        <span class="app-node-name">✓ Answer</span>
                    </div>
                    <div class="app-node-row app-node-out">
                        <span class="app-port app-port-error" data-port="err:${escapeHtml(rule.id)}" title="Error: wire it to where a failure shows"></span>
                        <span class="app-node-name">! Error</span>
                    </div>
                    <div class="app-node-status" data-node-status>${escapeHtml(status || (issues.length ? issues[0] : ''))}</div>
                </div>`;
        }).join('') || '';
        const right = Math.max(this.toolsX() + TOOL_WIDTH, ...[...positions.values()].map(at => at.x + TOOL_WIDTH)) + 60;
        const bottom = Math.max(SCREEN.y + SCREEN.bar + Math.max(220, this.layout.height || 0), ...app.flow.map(rule => positions.get(rule.id).y + this.nodeHeight(rule))) + 60;
        this.style.setProperty('--surface-w', `${right}px`);
        this.style.setProperty('--surface-h', `${bottom}px`);
    }

    // A transform on every Sent, Answer and Error wire: what of it shows. Placed when the wires are.
    renderPills() {
        const wires = wiresOf(this.app.flow, this.elementIds()).filter(wire => ROUTE_KINDS.has(wire.kind));
        this.$('[data-pills]').innerHTML = wires.map(wire => {
            const route = this.app.flow.find(rule => rule.id === wire.ruleId).then[wire.index];
            const custom = !isDefaultShow(route) || route.how === 'html';
            return `<button type="button" class="app-pill app-pill-${wire.kind}${custom ? ' app-pill-custom' : ''}" data-pill="${escapeHtml(wire.id)}" title="${escapeHtml(`What it shows: ${route.show || 'nothing'}${route.how && route.how !== 'replace' ? `, ${route.how}` : ''}`)}">${escapeHtml(routeSummary(route))}</button>`;
        }).join('');
    }

    // The middle of a port, in the surface's coordinates, and which way its wire leaves.
    portPoint(port) {
        const element = this.surface.querySelector(`[data-port="${CSS.escape(port)}"]`);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const surface = this.surface.getBoundingClientRect();
        const kind = parsePort(port).kind;
        return { x: box.left + box.width / 2 - surface.left, y: box.top + box.height / 2 - surface.top, out: kind === 'el' || kind === 'start' ? 1 : -1 };
    }

    curve(from, to) {
        const reach = Math.max(40, Math.abs(to.x - from.x) / 2);
        return `M ${from.x} ${from.y} C ${from.x + from.out * reach} ${from.y}, ${to.x + to.out * reach} ${to.y}, ${to.x} ${to.y}`;
    }

    drawWires() {
        if (!this.surface?.isConnected || !this.app) return;
        const group = this.$('[data-wire-paths]');
        const wires = wiresOf(this.app.flow, this.elementIds());
        const paths = [];
        const middles = new Map();
        // Start points into the screen it begins on.
        const start = this.$('[data-start]');
        if (start) {
            const box = start.getBoundingClientRect();
            const surface = this.surface.getBoundingClientRect();
            const x = box.left - surface.left + 22;
            paths.push(`<path class="app-entry" d="M ${x} ${box.bottom - surface.top} L ${x} ${SCREEN.y - 4}" marker-end="url(#app-arrow-trigger)"/>`);
        }
        for (const wire of wires) {
            const from = this.portPoint(wire.from);
            const to = this.portPoint(wire.to);
            if (!from || !to) continue;
            const d = this.curve(from, to);
            // A route's wire leaves the tool leftwards and reaches the screen from the right, so its
            // curve's middle is halfway between its ends.
            middles.set(wire.id, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
            paths.push(`<g class="app-wire app-wire-${wire.kind}" data-wire="${escapeHtml(wire.id)}"><path class="app-wire-hit" d="${d}"/><path class="app-wire-line" d="${d}" marker-end="url(#app-arrow-${wire.kind})"/></g>`);
        }
        group.innerHTML = paths.join('');
        // Transforms sit on their wires, nudged apart where wires meet.
        const taken = [];
        for (const pill of this.querySelectorAll('[data-pill]')) {
            const middle = middles.get(pill.dataset.pill);
            pill.hidden = !middle;
            if (!middle) continue;
            let y = middle.y;
            while (taken.some(other => Math.abs(other.y - y) < 22 && Math.abs(other.x - middle.x) < 90)) y += 22;
            taken.push({ x: middle.x, y });
            pill.style.setProperty('--x', `${middle.x}px`);
            pill.style.setProperty('--y', `${y}px`);
        }
        this.markSelection();
    }

    markSelection() {
        const selection = this.apps.selection;
        this.querySelectorAll('[data-wire]').forEach(wire => wire.classList.toggle('app-selected', selection?.kind === 'wire' && wire.dataset.wire === selection.id));
        this.querySelectorAll('[data-pill]').forEach(pill => pill.classList.toggle('app-selected', selection?.kind === 'wire' && pill.dataset.pill === selection.id));
        this.querySelectorAll('[data-node]').forEach(node => node.classList.toggle('app-selected', selection?.kind === 'rule' && node.dataset.node === selection.id));
        this.querySelectorAll('[data-element-box]').forEach(box => box.classList.toggle('app-selected', selection?.kind === 'element' && box.dataset.elementBox === selection.id));
        this.querySelectorAll('[data-gutter-row]').forEach(row => row.classList.toggle('app-selected', selection?.kind === 'element' && row.dataset.gutterRow === selection.id));
        this.$('[data-start]')?.classList.toggle('app-selected', selection?.kind === 'start');
    }

    // --- Rules running: their wires light up ---

    showActivity({ ruleId, phase, trigger, routes = [], durationMs }) {
        this.statuses ??= new Map();
        const node = this.$(`[data-node="${CSS.escape(ruleId)}"]`);
        const light = ids => ids.forEach(id => {
            for (const element of this.querySelectorAll(`[data-wire="${CSS.escape(id)}"], [data-pill="${CSS.escape(id)}"]`)) {
                element.classList.remove('app-live');
                void element.getBoundingClientRect();
                element.classList.add('app-live');
                setTimeout(() => element.classList.remove('app-live'), 1600);
            }
        });
        const rule = this.app?.flow.find(candidate => candidate.id === ruleId);
        if (!rule) return;
        if (phase === 'call') {
            node?.classList.add('app-node-running');
            const args = wiresOf([rule], this.elementIds()).filter(wire => wire.kind === 'arg').map(wire => wire.id);
            light([`t:${ruleId}:${trigger}`, ...args, ...routes.map(index => `r:${ruleId}:${index}`)]);
            this.statuses.set(ruleId, 'Calling…');
        } else {
            node?.classList.remove('app-node-running');
            light(routes.map(index => `r:${ruleId}:${index}`));
            this.statuses.set(ruleId, phase === 'ok' ? `✓ Answered${typeof durationMs === 'number' ? ` in ${Math.round(durationMs)} ms` : ''}` : '! Failed: see What happened');
            node?.classList.toggle('app-node-failed', phase === 'error');
        }
        const status = node?.querySelector('[data-node-status]');
        if (status) status.textContent = this.statuses.get(ruleId);
    }

    // --- Changing the flow from the canvas ---

    changeFlow(mutate) {
        this.apps.change(app => { app.flow = mutate(app.flow); }, { part: 'flow', by: this });
        this.renderGraph();
    }

    element(id) {
        return this.elements().find(element => element.id === id) || null;
    }

    kindOf(id) {
        return this.element(id)?.kind || 'static';
    }

    // What a new wire to the screen shows. A box takes its own key of the answer. As it's sent,
    // an element shows what the call sends (the prompt, or the one value a field takes), and the
    // field that value came from is cleared.
    defaultShow(element, phase, rule) {
        if (phase === 'ok') return isBox(this.element(element)) ? `{{json.${answerKey(element)}}}` : null;
        if (phase !== 'sent') return null;
        const lone = value => String(value ?? '').match(/^\s*\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}\s*$/)?.[1];
        const args = rule.call?.args || {};
        const sent = lone(args[rule.prompt]) || Object.values(args).map(lone).find(Boolean);
        return sent && sent !== element ? `{{${sent}}}` : '';
    }

    wire(a, b) {
        try {
            let made;
            this.changeFlow(flow => {
                const result = connect(flow, a, b, {
                    kindOf: id => this.kindOf(id),
                    defaultShow: ({ element, phase, rule }) => this.defaultShow(element, phase, rule),
                });
                made = result.made;
                if (made.kind !== 'route') return result.flow;
                // A box wired to a tool asks it, in the tool's prompt field, for what the box shows.
                return result.flow.map(rule => {
                    const route = rule.id === made.ruleId ? rule.then[made.index] : null;
                    if (!route || rule.prompt || route.if !== 'ok' || !isBox(this.element(route.into))) return rule;
                    const prompt = promptFieldOf(schemaOf(this.toolOf(rule)));
                    return prompt ? { ...rule, prompt } : rule;
                });
            });
            if (made.kind === 'already') return this.hint('Those are connected already.');
            const id = made.kind === 'trigger' ? `t:${made.ruleId}:${made.index}`
                : made.kind === 'arg' ? `a:${made.ruleId}:${made.arg}:${[a, b].map(parsePort).find(port => port.kind === 'el').element}`
                : `r:${made.ruleId}:${made.index}`;
            this.apps.select({ kind: 'wire', id, ruleId: made.ruleId });
            const rule = this.app.flow.find(candidate => candidate.id === made.ruleId);
            const route = made.kind === 'route' ? rule?.then[made.index] : null;
            const box = route?.if === 'ok' && rule?.prompt ? this.element(route?.into) : null;
            this.hint(made.kind === 'trigger' ? 'Connected: that starts the tool. Choose what it waits for in the Inspector.'
                : made.kind === 'arg' ? 'Connected: that fills the field.'
                : route?.if === 'sent' ? (route.show ? `Connected: ${route.into} shows ${route.show} as it's sent.` : `Connected: ${route.into} is cleared as it's sent.`)
                : isBox(box) ? `Connected: ${box.id} asks ${rule.call.toolName} for ${box.show === 'html' ? 'HTML' : box.show === 'text' ? 'text' : `a ${BOX_KINDS[box.show].noun}`}, in ${rule.prompt}.`
                : 'Connected: the answer goes there. Its transform says what of it shows.');
        } catch (error) {
            if (!(error instanceof FlowError)) throw error;
            this.hint(error.message, { error: true });
        }
    }

    removeWire(id) {
        if (this.apps.removeWire(id)) this.hint('Removed the connection.');
    }

    // A tool from the Library becomes a rule waiting to be wired.
    addTool(serverUrl, toolName, position = null) {
        const tool = (this.shell.servers[serverUrl]?.tools || []).find(candidate => candidate.name === toolName);
        const args = schemaOf(tool) ? this.workbench.testDataFor(schemaOf(tool)).args : {};
        const rule = newRule({ serverUrl, toolName, args, into: null, position });
        this.changeFlow(flow => [...flow, rule]);
        this.apps.select({ kind: 'rule', id: rule.id });
        this.hint(`Added ${toolName}. Wire what starts it to its Run, and its Answer to the screen.`);
        return rule;
    }

    // A box from the Library: an output that shows `kind`, named and sized for it.
    addBox(kind, index = null) {
        const { label, base } = BOX_KINDS[kind];
        const ids = (this.app.screen.components || []).map(component => component.id);
        return this.addComponent('output', index, { id: freeId(base, ids), label, show: kind, width: BOX_WIDTHS[kind], placeholder: 'Filled in when the app runs.' });
    }

    addComponent(type, index = null, props = {}) {
        const app = this.app;
        if (app.screen.kind === 'html') return this.hint('This screen is HTML, so it has no components: switch it to Components in the Inspector first.', { error: true });
        const added = newComponent(type, app.screen.components.map(component => component.id), props);
        this.apps.change(found => {
            const at = index === null ? found.screen.components.length : index;
            found.screen.components.splice(at, 0, added);
        }, { part: 'screen' });
        this.apps.select({ kind: 'element', id: added.id });
        this.hint(type === 'part' ? `Added ${added.id}. Ask a model for it, or get it from a tool, in the Inspector.`
            : props.show ? `Added ${added.id}. Say what goes in it in the Inspector, then wire a tool's Answer to it: the tool is asked for it.`
            : `Added ${COMPONENT_TYPES[type].label.toLowerCase()} ${added.id}.`);
    }

    applyTransform(transformId, wireId) {
        const transform = TRANSFORMS.find(([id]) => id === transformId);
        const wire = wiresOf(this.app.flow, this.elementIds()).find(candidate => candidate.id === wireId);
        if (!transform || !wire || (wire.kind !== 'answer' && wire.kind !== 'error')) {
            return this.hint("Transforms go on a wire from a tool's Answer or Error: pick one, or drop the transform on it.", { error: true });
        }
        const [, label, , { show, how }] = transform;
        this.changeFlow(flow => flow.map(rule => (rule.id !== wire.ruleId ? rule : {
            ...rule,
            then: rule.then.map((route, index) => (index === wire.index ? { ...route, show: wire.kind === 'error' && transformId === 'text' ? '{{error}}' : show, how } : route)),
        })));
        this.apps.select({ kind: 'wire', id: wire.id, ruleId: wire.ruleId, edit: true });
        this.hint(`${label}: change what it shows in the Inspector.`);
    }

    // Puts every tool beside what it's wired to again.
    tidy() {
        this.apps.change(app => { app.flow = app.flow.map(({ position, ...rule }) => rule); }, { part: 'layout', by: this });
        const positions = this.positions();
        this.apps.change(app => { app.flow = app.flow.map(rule => ({ ...rule, position: positions.get(rule.id) })); }, { part: 'layout', by: this });
        this.renderGraph();
    }

    // --- The Library ---

    toggleLibrary(open = this.$('[data-library]').hidden) {
        const library = this.$('[data-library]');
        library.hidden = !open;
        this.$('[data-toggle-library]').setAttribute('aria-expanded', String(open));
        if (!open) return;
        library.innerHTML = `
            <input type="search" data-library-filter placeholder="Filter components, tools and transforms" aria-label="Filter the library">
            <div class="app-library-scroll" data-library-items></div>
            <p class="app-library-note text-secondary">Click to add, or drag onto the canvas: a component onto the screen, a tool anywhere, a transform onto a wire from a tool's Answer.</p>`;
        this.renderLibraryItems();
        library.querySelector('[data-library-filter]').focus();
    }

    renderLibraryItems() {
        const library = this.$('[data-library]');
        const filter = library.querySelector('[data-library-filter]')?.value.trim().toLowerCase() || '';
        const matches = (...texts) => !filter || texts.some(text => String(text || '').toLowerCase().includes(filter));
        const html = this.app?.screen.kind === 'html';
        const item = (data, label, help, extra = '') => `<button type="button" class="app-library-item" draggable="true" ${Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(' ')} title="${escapeHtml(help)}" ${extra}><span class="app-library-name">${escapeHtml(label)}</span><span class="app-library-help">${escapeHtml(help)}</span></button>`;
        const components = Object.entries(COMPONENT_TYPES).filter(([type, { label }]) => matches(type, label)).map(([type, { label }]) => item({ 'library-item': 'component', type }, label, {
            title: 'A heading',
            text: 'A paragraph of text',
            textbox: 'A field people type in',
            button: 'Something to click, to start a tool',
            output: 'Where an answer shows',
            part: 'HTML a model or a tool makes: a dashboard, a card, a form',
        }[type], html ? 'disabled' : ''));
        const servers = Object.values(this.shell.servers).filter(server => server.tools?.length);
        const tools = servers.map(server => {
            const items = server.tools.filter(tool => matches(tool.name, tool.title, tool.description, serverLabel(server)));
            return items.length ? `<p class="app-library-group">${escapeHtml(serverLabel(server))}</p>${items.map(tool => item({ 'library-item': 'tool', server: server.url, tool: tool.name }, tool.name, tool.title || tool.description || '')).join('')}` : '';
        }).join('');
        const transforms = TRANSFORMS.filter(([id, label, help]) => matches(id, label, help)).map(([id, label, help]) => item({ 'library-item': 'transform', transform: id }, label, help));
        const boxes = Object.entries(BOX_KINDS).filter(([kind, { label, help }]) => matches(kind, label, help, 'box')).map(([kind, { label, help }]) => item({ 'library-item': 'box', show: kind }, label, help, html ? 'disabled' : ''));
        library.querySelector('[data-library-items]').innerHTML = `
            <section><h4>Components${html ? ' <span class="text-secondary">(the screen is HTML)</span>' : ''}</h4>${components.join('') || '<p class="wb-list-note">None match.</p>'}</section>
            <section><h4>Boxes <span class="text-secondary">for what a tool answers, as on a dashboard</span></h4>${boxes.join('') || '<p class="wb-list-note">None match.</p>'}</section>
            <section><h4>Tools</h4>${tools || `<p class="wb-list-note">${servers.length ? 'None match.' : 'Connect to a server in the Workbench to use its tools.'}</p>`}</section>
            <section><h4>Transforms</h4>${transforms.join('') || '<p class="wb-list-note">None match.</p>'}</section>`;
    }

    // A Library item, from its button's data: { libraryItem: 'component' | 'tool' | 'transform', type, server, tool, transform }.
    useLibraryItem(item, { at = null, target = null } = {}) {
        if (item.libraryItem === 'component') return this.addComponent(item.type, at?.index ?? null);
        if (item.libraryItem === 'box') return this.addBox(item.show, at?.index ?? null);
        if (item.libraryItem === 'tool') return this.addTool(item.server, item.tool, at?.point || null);
        if (item.libraryItem === 'transform') {
            const selection = this.apps.selection;
            return this.applyTransform(item.transform, target || (selection?.kind === 'wire' ? selection.id : null));
        }
    }

    dragStart(event) {
        const item = event.target.closest?.('[data-library-item]');
        if (!item) return;
        event.dataTransfer.setData('application/x-mcp-app', JSON.stringify({ ...item.dataset }));
        event.dataTransfer.effectAllowed = 'copy';
        setTimeout(() => this.toggleLibrary(false));
    }

    dropped(event) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('application/x-mcp-app') || 'null');
        } catch { /* not ours */ }
        if (!data || !this.surface) return;
        event.preventDefault();
        const surface = this.surface.getBoundingClientRect();
        const point = { x: event.clientX - surface.left, y: event.clientY - surface.top };
        if (data.libraryItem === 'component' || data.libraryItem === 'box') {
            // Before the first component whose middle is below where it was dropped.
            const top = SCREEN.y + SCREEN.bar;
            const components = this.app.screen.components || [];
            const index = components.findIndex(component => {
                const rect = this.layout.rects[component.id];
                return rect && top + rect.top + rect.height / 2 > point.y;
            });
            return this.useLibraryItem(data, { at: { index: index < 0 ? null : index } });
        }
        if (data.libraryItem === 'tool') return this.useLibraryItem(data, { at: { point: { x: Math.max(0, point.x - 20), y: Math.max(0, point.y - 16) } } });
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-wire], [data-pill]');
        return this.useLibraryItem(data, { target: target?.dataset.wire || target?.dataset.pill || null });
    }

    // --- Pointer: wiring, moving tools ---

    pointerDown(event) {
        if (event.button !== 0) return;
        // A wire starts from a port, or from the label or row it's on.
        const port = event.target.closest('[data-port]') || event.target.closest('[data-gutter-row], .app-node-row, [data-start]')?.querySelector('[data-port]');
        if (port && this.mode === 'design') return this.startWiring(event, port.dataset.port);
        const head = event.target.closest('[data-drag-node]');
        if (head) return this.startMoving(event, head.closest('[data-node]'));
    }

    startWiring(event, from) {
        event.preventDefault();
        const draft = this.$('[data-draft]');
        const start = this.portPoint(from);
        if (!start) return;
        this.querySelectorAll('[data-port]').forEach(port => port.classList.toggle('app-port-can', canConnect(from, port.dataset.port)));
        this.classList.add('app-wiring');
        const scroller = this.$('[data-canvas-scroll]');
        let pointer = null;
        let frame = 0;
        const follow = () => {
            const box = this.surface.getBoundingClientRect();
            draft.hidden = false;
            draft.setAttribute('d', this.curve(start, { x: pointer.clientX - box.left, y: pointer.clientY - box.top, out: -start.out }));
        };
        // Near an edge of the canvas, it scrolls, so a wire can reach what's out of view.
        const scroll = () => {
            frame = 0;
            if (!pointer) return;
            const box = scroller.getBoundingClientRect();
            const speed = (at, low, high) => (at < low + EDGE ? -Math.ceil((low + EDGE - at) / 3) : at > high - EDGE ? Math.ceil((at - high + EDGE) / 3) : 0);
            const dx = speed(pointer.clientX, box.left, box.right);
            const dy = speed(pointer.clientY, box.top, box.bottom);
            if (!dx && !dy) return;
            scroller.scrollBy(dx, dy);
            follow();
            frame = requestAnimationFrame(scroll);
        };
        const move = moved => {
            pointer = moved;
            follow();
            if (!frame) frame = requestAnimationFrame(scroll);
        };
        const end = ended => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            pointer = null;
            cancelAnimationFrame(frame);
            draft.hidden = true;
            this.classList.remove('app-wiring');
            this.querySelectorAll('.app-port-can').forEach(port => port.classList.remove('app-port-can'));
            const moved = Math.hypot(ended.clientX - event.clientX, ended.clientY - event.clientY) > 8;
            // Some browsers end a drag with a click where it ends, which would pick something else.
            if (moved) this.draggedAt = performance.now();
            const target = this.portNear(ended.clientX, ended.clientY, from);
            if (target) this.wire(from, target);
            else if (moved) this.hint('Drop the wire on a ● it can connect to: they light up while you drag.');
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
    }

    // The port under the pointer (or the port of the label or row under it), or the nearest one it
    // can connect to within a few pixels.
    portNear(x, y, from) {
        const at = document.elementFromPoint(x, y);
        const under = at?.closest('[data-port]') || at?.closest('[data-gutter-row], .app-node-row, [data-start]')?.querySelector('[data-port]');
        if (under && under.dataset.port !== from) return under.dataset.port;
        let best = null;
        for (const port of this.querySelectorAll('[data-port]')) {
            if (!canConnect(from, port.dataset.port)) continue;
            const box = port.getBoundingClientRect();
            const distance = Math.hypot(box.left + box.width / 2 - x, box.top + box.height / 2 - y);
            if (distance < 22 && (!best || distance < best.distance)) best = { port: port.dataset.port, distance };
        }
        return best?.port || null;
    }

    startMoving(event, node) {
        event.preventDefault();
        const id = node.dataset.node;
        const startX = event.clientX;
        const startY = event.clientY;
        const origin = { x: parseFloat(node.style.getPropertyValue('--x')), y: parseFloat(node.style.getPropertyValue('--y')) };
        let moved = false;
        const move = movedEvent => {
            const x = Math.max(0, origin.x + movedEvent.clientX - startX);
            const y = Math.max(0, origin.y + movedEvent.clientY - startY);
            moved = moved || Math.hypot(movedEvent.clientX - startX, movedEvent.clientY - startY) > 3;
            node.style.setProperty('--x', `${x}px`);
            node.style.setProperty('--y', `${y}px`);
            this.drawSoon();
        };
        const end = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            if (!moved) return this.apps.select({ kind: 'rule', id });
            this.placeNode(id, { x: parseFloat(node.style.getPropertyValue('--x')), y: parseFloat(node.style.getPropertyValue('--y')) });
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
    }

    placeNode(id, position) {
        this.apps.change(app => {
            const rule = app.flow.find(candidate => candidate.id === id);
            if (rule) rule.position = { x: Math.round(position.x), y: Math.round(position.y) };
        }, { part: 'layout', by: this });
        this.renderGraph();
    }

    keyDown(event) {
        if (event.target.closest('input, textarea, select')) return;
        const selection = this.apps.selection;
        if ((event.key === 'Delete' || event.key === 'Backspace') && selection?.kind === 'wire') {
            event.preventDefault();
            return this.removeWire(selection.id);
        }
        if (event.key === 'Escape') {
            if (!this.$('[data-library]')?.hidden) return this.toggleLibrary(false);
            return this.apps.select(null);
        }
        const node = event.target.closest?.('[data-node]');
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (node && step) {
            event.preventDefault();
            const distance = event.shiftKey ? 40 : 8;
            const x = Math.max(0, parseFloat(node.style.getPropertyValue('--x')) + step[0] * distance);
            const y = Math.max(0, parseFloat(node.style.getPropertyValue('--y')) + step[1] * distance);
            this.placeNode(node.dataset.node, { x, y });
            this.$(`[data-node="${CSS.escape(node.dataset.node)}"]`)?.focus();
        }
        if (node && event.key === 'Enter') this.apps.select({ kind: 'rule', id: node.dataset.node });
    }

    clicked(event) {
        const target = event.target;
        if (this.draggedAt && performance.now() - this.draggedAt < 100 && target.closest('[data-surface]')) {
            this.draggedAt = 0;
            return;
        }
        const button = target.closest('button');
        if (button?.dataset.toggleLibrary !== undefined) return this.toggleLibrary();
        if (button?.dataset.libraryItem) {
            this.toggleLibrary(false);
            return this.useLibraryItem({ ...button.dataset });
        }
        if (button?.dataset.canvasMode) return this.setMode(button.dataset.canvasMode);
        if (button?.dataset.restart !== undefined) return this.restart();
        if (button?.dataset.tidy !== undefined) return this.tidy();
        if (button?.dataset.clearTrace !== undefined) return this.trace.clear();
        if (button?.dataset.openRun) return this.apps.openRun(button.dataset.openRun);
        if (target.closest('[data-port]')) return;
        if (button?.dataset.selectStart !== undefined) return this.apps.select({ kind: 'start' });
        if (button?.dataset.elementBox) return this.apps.select({ kind: 'element', id: button.dataset.elementBox });
        if (button?.dataset.pill) return this.apps.select({ kind: 'wire', id: button.dataset.pill, ruleId: button.dataset.pill.split(':')[1] });
        const wire = target.closest('[data-wire]');
        if (wire) return this.apps.select({ kind: 'wire', id: wire.dataset.wire, ruleId: wire.dataset.wire.split(':')[1] });
        const row = target.closest('[data-gutter-row]');
        if (row) return this.apps.select({ kind: 'element', id: row.dataset.gutterRow });
        const node = target.closest('[data-node]');
        if (node) {
            if (!target.closest('[data-drag-node]')) this.apps.select({ kind: 'rule', id: node.dataset.node });
            return;
        }
        if (target.closest('[data-surface]')) this.apps.select(null);
    }

    // Clicks on wires and the surface leave the keyboard with the canvas, so Delete and Escape work.
    focusCanvas(event) {
        if (!event.target.closest('button, input, textarea, select, [data-node]')) this.$('[data-canvas-scroll]')?.focus({ preventScroll: true });
    }
}

