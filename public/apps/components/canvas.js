// The app builder's canvas: the app's screens, each a card with a port beside each of its
// elements; Start, where the app begins; a node for each rule's tool; and wires between them,
// each one part of a rule (graph.js): what starts the tool, what fills its fields, and where its
// answer and error go, through a transform that says what of the answer is shown. Drag from a port
// to another to wire them, a tool or a card by its title to move it, and the background to look
// around; pick anything to change it in the Inspector. In Design, clicks on a screen pick its
// elements; in Run, the screen takes them, and wires light up as rules run. The Library adds
// components, tools and transforms.
//
// An app with several screens is a storyboard (storyboard.js): a card for each screen, in the
// order people go through them, with an arrow from each button or tool's answer that goes to a
// screen into that screen's card. The app runs in one frame, which sits on the card of the screen
// it's on and moves to the next one as the app goes there; the other cards show their screens as
// they are before anyone uses them. Where the cards and tools sit is part of the app; how far the
// canvas is zoomed and where it's scrolled stay in this browser, for each app.

import { debounce, escapeHtml, schemaOf, serverLabel } from '../../workbench/util.js';
import { answerKey, BOX_KINDS, BOX_WIDTHS, isBox, promptFieldOf } from '../boxes.js';
import { EVENTS, FlowError, flowProblems, isDefaultShow, newRule, routeSummary, triggersOf } from '../flow.js';
import { canConnect, connect, goPairOf, parsePort, wiresOf } from '../graph.js';
import { AppRunner, ScreenStill } from '../runner.js';
import { COMPONENT_TYPES, endOfScreen, freeId, GO_PLACES, newComponent, screenOfEach, screensOf } from '../screen.js';
import { homeScreen, placeStoryboard, screenFinder, screenLinks } from '../storyboard.js';
import { AppElement } from './base.js';
import { TraceList } from './trace.js';

// The canvas's geometry, which the styles read as custom properties. A wide screen (a
// dashboard's) runs at `wide` instead of `width`.
const SCREEN = { x: 24, y: 76, width: 300, wide: 600, bar: 30, gutter: 112 };
// The gutter widens for its longest name up to this; past it, a name shows in full when pointed at.
const GUTTER_MAX = 220;
// Beside a name in the gutter: the lead from the screen, the gap and the port.
const GUTTER_ROOM = 38;
// Room between a card's ports and the tools beside it, for a transform's label on a wire.
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
const WIRE_KINDS = ['trigger', 'arg', 'sent', 'answer', 'error', 'go'];
// The wires that carry something to the screen, each with its transform: what of it shows.
const ROUTE_KINDS = new Set(['sent', 'answer', 'error']);
// How near an edge of the canvas a wire being dragged starts it scrolling.
const EDGE = 40;
// The zooms − and + step through, and how far out and in the canvas goes.
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
const ZOOM_MIN = ZOOMS[0];
const ZOOM_MAX = ZOOMS.at(-1);
// Each app's zoom and scroll, as { [app id]: { zoom, left, top } } in the canvas's own units.
const VIEWS_KEY = 'appsCanvasViews';
// The one card of an app without screens.
const ONE = '';
// Which way a wire leaves a port.
const RIGHT = { x: 1, y: 0 };
const LEFT = { x: -1, y: 0 };
const UP = { x: 0, y: -1 };

const elementPort = id => `el:${id}`;

function readViews() {
    try {
        const views = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}');
        return views && typeof views === 'object' ? views : {};
    } catch {
        return {};
    }
}

export class AppCanvas extends AppElement {
    setup(signal) {
        this.signal = signal;
        this.mode = 'design';
        // Where each card's elements are, from its still: Map<card id, { height, rects }>.
        this.layouts = new Map();
        // Where the running app's are, and which screen it's on: { height, rects, screen }.
        this.playerLayout = null;
        this.gutterWidth = SCREEN.gutter;
        this.zoom = 1;
        // Each card on the canvas: Map<card id, { element, frame, still, abort }>.
        this.cards = new Map();
        this.at = { cards: new Map(), tools: new Map() };
        this.trace = new TraceList();
        this.runner = new AppRunner({
            shell: this.shell,
            workbench: this.workbench,
            getApp: () => this.apps.app,
            onTrace: entry => this.trace.add(entry),
            onLayout: layout => {
                this.playerLayout = layout;
                this.renderGraph();
            },
            onActivity: activity => this.showActivity(activity),
            onAnswer: (ruleId, answer) => this.apps.setAnswer(ruleId, answer),
            onScreen: (id, { button = null } = {}) => {
                const moved = id !== this.screenId;
                this.screenId = id;
                this.renderGraph({ animate: moved });
                if (moved) this.revealCard(id);
                if (button) this.lightGo(button);
            },
            signal,
        });
        // Which of the app's screens the running app is on.
        this.screenId = null;
        this.reloadSoon = debounce(() => this.load({ start: false }), 300);
        this.saveViewSoon = debounce(() => this.saveView(), 300);
        this.drawSoon = () => {
            cancelAnimationFrame(this.drawFrame);
            this.drawFrame = requestAnimationFrame(() => this.drawWires());
        };
        this.apps.on('shown', () => {
            this.trace.entries = [];
            this.mode = 'design';
            this.screenId = null;
            this.render({ start: true });
        }, signal);
        this.apps.on('view', () => this.render({ start: false }), signal);
        this.apps.on('app', ({ part, by }) => {
            if (part === 'screen') {
                this.syncCards();
                for (const [id, layout] of this.layouts) this.layouts.set(id, { ...layout, rects: {} });
                if (this.playerLayout) this.playerLayout = { ...this.playerLayout, rects: {} };
                this.renderGraph();
                this.reloadSoon();
            }
            if (part === 'flow') this.runner.flowChanged();
            if ((part === 'flow' || part === 'layout' || part === 'name') && by !== this) this.renderGraph();
        }, signal);
        this.apps.on('select', () => {
            this.followSelection();
            this.markSelection();
        }, signal);
        this.apps.on('restart', () => this.restart(), signal);
        this.apps.on('highlight', ({ elements }) => {
            this.runner.highlight(elements);
            for (const card of this.cards.values()) card.still?.highlight(elements);
        }, signal);
        this.shell.on('mode', ({ mode }) => {
            if (mode !== 'apps') return;
            if (this.waiting) this.load(this.waiting);
            this.renderGraph();
        }, signal);
        this.shell.on('tools', () => this.renderGraph(), signal);
        this.shell.on('servers', () => this.renderGraph(), signal);
        this.addEventListener('click', event => {
            this.focusCanvas(event);
            this.clicked(event);
        }, { signal });
        this.addEventListener('pointerdown', event => this.pointerDown(event), { signal });
        this.addEventListener('keydown', event => this.keyDown(event), { signal });
        this.addEventListener('wheel', event => this.wheeled(event), { signal, passive: false });
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
        this.dropCards();
        if (!app || this.apps.view !== 'canvas') {
            this.runner.stop();
            this.innerHTML = '';
            this.frame = null;
            this.scroller = null;
            return;
        }
        this.layouts.clear();
        this.playerLayout = null;
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
                <button type="button" class="btn-sm btn-tertiary" data-tidy title="Puts the screens in the order people go through them, and every tool beside what starts it">Tidy up</button>
                <div class="app-zoom-controls" role="group" aria-label="Zoom">
                    <button type="button" class="btn-sm btn-tertiary btn-icon" data-zoom-step="-1" title="Zoom out (Ctrl or ⌘ and the wheel zooms too)" aria-label="Zoom out">−</button>
                    <button type="button" class="btn-sm btn-tertiary app-zoom-level" data-zoom-reset title="Back to 100%" aria-label="Zoom to 100%">100%</button>
                    <button type="button" class="btn-sm btn-tertiary btn-icon" data-zoom-step="1" title="Zoom in" aria-label="Zoom in">+</button>
                    <button type="button" class="btn-sm btn-tertiary" data-zoom-fit title="Zoom to show the whole app">Fit</button>
                </div>
                <span class="wb-spacer"></span>
                <span class="app-canvas-hint text-secondary" data-canvas-hint>Drag from a ● to another to connect them.</span>
            </div>
            <div class="app-canvas-scroll" data-canvas-scroll tabindex="-1">
                <div class="app-zoom" data-zoom>
                    <div class="app-surface" data-surface>
                        <svg class="app-wires" data-wires aria-hidden="true">
                            <defs>${WIRE_KINDS.map(kind => `<marker id="app-arrow-${kind}" class="app-arrow app-arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>`).join('')}</defs>
                            <g data-wire-paths></g>
                            <path class="app-wire-draft" data-draft d="" hidden/>
                        </svg>
                        <button type="button" class="app-start" data-start data-select-start title="The app starts here, on the first screen. Wire ● to a tool's Run to call it when the app opens.">
                            <span class="app-start-mark" aria-hidden="true">▶</span>Start
                            <span class="app-port app-port-start" data-port="start" role="presentation"></span>
                        </button>
                        <div class="app-cards" data-cards></div>
                        <iframe class="app-canvas-frame app-player" data-player sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(app.name)}, running"></iframe>
                        <div class="app-overlays" data-overlays></div>
                        <div class="app-nodes" data-nodes></div>
                        <div class="app-pills" data-pills></div>
                    </div>
                </div>
            </div>
            <apps-splitter data-pane="canvas"></apps-splitter>
            <section class="app-canvas-trace" aria-label="What happened">
                <div class="app-trace-head">
                    <h4>What happened</h4>
                    <button type="button" class="btn-sm btn-tertiary" data-clear-trace>Clear</button>
                </div>
                <ol class="app-trace" data-trace aria-live="polite"></ol>
            </section>`;
        this.dataset.mode = this.mode;
        this.markMode();
        this.gutterWidth = SCREEN.gutter;
        for (const [name, value] of Object.entries({ '--screen-bar': SCREEN.bar, '--gutter-w': SCREEN.gutter, '--tool-w': TOOL_WIDTH })) {
            this.style.setProperty(name, `${value}px`);
        }
        this.surface = this.$('[data-surface]');
        this.frame = this.$('[data-player]');
        this.scroller = this.$('[data-canvas-scroll]');
        this.scroller.addEventListener('scroll', () => this.saveViewSoon(), { signal: this.signal });
        this.frame.addEventListener('transitionend', () => this.frame?.classList.remove('app-player-moving'), { signal: this.signal });
        this.trace.attach(this.$('[data-trace]'));
        const view = readViews()[app.id];
        this.zoom = view ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(view.zoom) || 1)) : 1;
        // A storyboard opened for the first time shows all of it, once its screens have said how
        // tall they are, or after a moment without them; an app with one screen opens at 100%.
        const fit = !view && this.storyboard;
        this.pendingView = view ? { left: Number(view.left) || 0, top: Number(view.top) || 0 } : fit ? { fit: true, until: performance.now() + 1500 } : { left: 0, top: 0 };
        if (fit) setTimeout(() => this.pendingView?.fit && this.renderGraph(), 1600);
        this.syncCards();
        this.renderGraph();
        this.load({ start });
    }

    // Only a screen someone can see runs, so an app's "when it opens" calls wait until then. A
    // reload after an edit stays on the screen the app was on.
    load({ start }) {
        if (!this.frame || !this.app || this.apps.view !== 'canvas') return;
        if (document.body.dataset.mode !== 'apps') {
            this.waiting = { start: start || !!this.waiting?.start };
            return;
        }
        this.waiting = null;
        this.runner.load(this.frame, { start, screen: this.screenId });
        for (const [id, card] of this.cards) card.still?.load(card.frame, id);
    }

    // --- The cards: one for each screen, or one for an app without screens ---

    screens() {
        return this.app?.screen?.kind === 'html' ? [] : screensOf(this.app?.screen?.components || []);
    }

    cardIds() {
        const screens = this.screens();
        return screens.length ? screens.map(screen => screen.id) : [ONE];
    }

    get storyboard() {
        return this.cardIds()[0] !== ONE;
    }

    component(id) {
        return (this.app?.screen?.components || []).find(candidate => candidate.id === id) || null;
    }

    // The card the running app is on.
    activeCard() {
        const ids = this.cardIds();
        return ids.includes(this.screenId) ? this.screenId : ids[0];
    }

    // The card an element is on: its screen's, or the first's for one above the first screen.
    cardOf(id) {
        return this.storyboard ? screenFinder(this.elements())(id) ?? this.cardIds()[0] : ONE;
    }

    // The elements whose ports are beside a card: its screen's, and those on every screen on the first card.
    cardElements(id) {
        const elements = this.elements().filter(element => element.kind !== 'screen');
        if (id === ONE) return elements;
        const first = id === this.cardIds()[0];
        return elements.filter(element => element.screen === id || (first && element.screen === null));
    }

    // Where a card's elements are: the running app's, when it's on that card, else its still's.
    cardLayout(id) {
        const live = this.playerLayout && id === this.activeCard() && (id === ONE || this.playerLayout.screen === id);
        return (live ? this.playerLayout : this.layouts.get(id)) || { height: 0, rects: {} };
    }

    bodyHeight(id) {
        return Math.max(220, Math.ceil(this.cardLayout(id).height || 0));
    }

    // Cards whose screen has gone go, and new screens get one; a card keeps its frame while its
    // screen stays. A storyboard's cards each have a still, which the running app covers on its card.
    syncCards() {
        const container = this.$('[data-cards]');
        if (!container) return;
        const ids = this.cardIds();
        for (const [id, card] of this.cards) {
            if (ids.includes(id)) continue;
            card.abort.abort();
            card.element.remove();
            this.cards.delete(id);
            this.layouts.delete(id);
        }
        const stills = ids[0] !== ONE;
        for (const id of ids) {
            if (this.cards.has(id)) continue;
            const element = document.createElement('section');
            element.className = 'app-screen-card';
            element.dataset.card = id;
            element.innerHTML = `
                <div class="app-screen-window">
                    <div class="app-screen-bar" data-card-bar="${escapeHtml(id)}" role="button" tabindex="0"></div>
                    <div class="app-screen-body">${stills ? `<iframe class="app-canvas-frame app-still" data-still="${escapeHtml(id)}" sandbox="allow-scripts" referrerpolicy="no-referrer" tabindex="-1" title="${escapeHtml(`${this.component(id)?.label || id}, before anyone uses it`)}"></iframe>` : ''}</div>
                </div>
                <div class="app-screen-gutter" data-gutter="${escapeHtml(id)}"></div>`;
            container.append(element);
            const abort = new AbortController();
            const still = stills ? new ScreenStill({
                getApp: () => this.apps.app,
                onLayout: layout => {
                    this.layouts.set(id, layout);
                    this.renderGraph();
                },
                signal: abort.signal,
            }) : null;
            this.cards.set(id, { element, frame: element.querySelector('[data-still]'), still, abort });
        }
    }

    dropCards() {
        for (const card of this.cards.values()) card.abort.abort();
        this.cards.clear();
    }

    // Shows one of the app's screens on its card, as the app would go there.
    showScreen(id) {
        if (id === this.screenId) return;
        this.screenId = id;
        this.renderGraph({ animate: true });
        this.runner.showScreen(id);
    }

    // A screen picked elsewhere is where the app goes; an element picked on a card is brought into view.
    followSelection() {
        const selection = this.apps.selection;
        const element = selection?.kind === 'element' ? this.element(selection.id) : null;
        if (!element || !this.frame) return;
        if (element.kind === 'screen') this.showScreen(element.id);
        this.revealCard(element.kind === 'screen' ? element.id : this.cardOf(element.id));
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

    // --- The graph: cards, ports, tools, wires and transforms, from the app and where its screens put things ---

    elements() {
        return this.apps.elements();
    }

    elementIds() {
        return this.elements().map(element => element.id);
    }

    // Where each element's port goes in its card's gutter: level with the element, moved down just
    // enough that labels don't overlap. { id: { y, at } } in the card's coordinates below its title
    // bar, `at` the element's middle.
    portSlots(id) {
        const rects = this.cardLayout(id).rects;
        const slots = [];
        for (const element of this.cardElements(id)) {
            const rect = rects[element.id];
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

    // Where each card and tool sits: where it was put, else where the storyboard puts it, with a
    // card being dragged where it is now. A tool beside an app's one screen stays right of it,
    // which may have grown wider since the tool was put there.
    positions() {
        const app = this.app;
        const ids = this.cardIds();
        const storyboard = ids[0] !== ONE;
        const elements = this.elements();
        const screenOf = screenFinder(elements);
        const homeOf = rule => (storyboard ? homeScreen(rule, screenOf, ids[0]) : ONE);
        const stored = id => (id === ONE ? app.screen.position : this.component(id)?.position);
        const positionOf = id => (this.dragging?.id === id ? this.dragging.at : stored(id) || this.dragging?.others.get(id));
        const cards = ids.map(id => ({ id, height: this.bodyHeight(id), position: positionOf(id) || null }));
        const slots = new Map(ids.map(id => [id, this.portSlots(id)]));
        // A tool lines up with the highest of what it's wired to on its own card.
        const anchor = (rule, at) => {
            const home = homeOf(rule);
            const card = at.get(home);
            const ys = wiresOf([rule], this.elementIds())
                .filter(wire => this.cardOf(wire.element) === home)
                .map(wire => slots.get(home)?.[wire.element]?.y)
                .filter(y => y !== undefined);
            return card && ys.length ? card.y + SCREEN.bar + Math.min(...ys) - 48 : null;
        };
        const placed = placeStoryboard({
            cards,
            links: storyboard ? screenLinks(app.flow, elements) : [],
            rules: app.flow,
            homeOf,
            anchor,
            x: SCREEN.x,
            y: SCREEN.y,
            cardWidth: this.screenWidth(),
            gutter: this.gutterWidth,
            bar: SCREEN.bar,
            toolWidth: TOOL_WIDTH,
            toolHeight: rule => this.nodeHeight(rule),
            laneGap: TOOLS_GAP,
        });
        const lane = storyboard ? null : placed.cards.get(ONE).x + this.screenWidth() + this.gutterWidth + TOOLS_GAP;
        const tools = new Map(app.flow.map(rule => [rule.id, rule.position
            ? { x: lane === null ? rule.position.x : Math.max(rule.position.x, lane), y: rule.position.y }
            : placed.tools.get(rule.id)]));
        return { cards: placed.cards, tools };
    }

    renderGraph({ animate = false } = {}) {
        if (!this.surface?.isConnected || !this.app) return;
        this.style.setProperty('--screen-w', `${this.screenWidth()}px`);
        // The gutters first: how wide they are moves the tools beside the cards.
        this.renderGutters();
        this.at = this.positions();
        this.renderCards();
        this.placePlayer({ animate });
        this.renderOverlays();
        this.renderStart();
        this.renderNodes();
        this.renderPills();
        this.sizeSurface();
        this.markSelection();
        this.applyPendingView();
        this.drawSoon();
    }

    renderCards() {
        const ids = this.cardIds();
        const live = this.activeCard();
        for (const [id, card] of this.cards) {
            const at = this.at.cards.get(id);
            if (!at) continue;
            card.element.style.setProperty('--x', `${at.x}px`);
            card.element.style.setProperty('--y', `${at.y}px`);
            card.element.style.setProperty('--body-h', `${this.bodyHeight(id)}px`);
            card.element.toggleAttribute('data-live', id === live);
            const bar = card.element.querySelector('[data-card-bar]');
            if (id === ONE) {
                bar.innerHTML = `<span class="app-screen-dots" aria-hidden="true"></span><span class="app-screen-name">${escapeHtml(this.app.name || 'App')}</span>`;
                bar.title = 'The app\'s screen. Drag it by here to move it.';
                continue;
            }
            const label = this.component(id)?.label || id;
            const first = id === ids[0];
            bar.innerHTML = `
                <span class="app-port app-port-screen" data-port="${escapeHtml(elementPort(id))}" title="${escapeHtml(`${label} (${id}): wire a button or a tool's Answer here to go to this screen`)}"></span>
                <span class="app-screen-name">${escapeHtml(label)}</span>
                ${first ? '<span class="app-screen-opens">Opens here</span>' : ''}`;
            bar.title = `${label} (${id})${first ? ', where the app opens' : ''}: pick it, or drag it by here to move it.`;
            bar.setAttribute('aria-label', `${label}${id === live ? ', the screen the app is on' : ''}`);
        }
    }

    // The running app sits on the card of the screen it's on, covering that card's still, and
    // slides to the next card when it goes there.
    placePlayer({ animate = false } = {}) {
        const id = this.activeCard();
        const at = this.at.cards.get(id);
        if (!this.frame || !at) return;
        const moving = animate && this.frame.dataset.on !== undefined && this.frame.dataset.on !== id;
        if (moving) this.frame.classList.add('app-player-moving');
        this.frame.style.setProperty('--x', `${at.x}px`);
        this.frame.style.setProperty('--y', `${at.y + SCREEN.bar}px`);
        this.frame.style.setProperty('--h', `${this.bodyHeight(id)}px`);
        this.frame.dataset.on = id;
        for (const [cardId, card] of this.cards) card.frame?.toggleAttribute('data-covered', cardId === id);
    }

    renderStart() {
        const start = this.$('[data-start]');
        const first = this.at.cards.get(this.cardIds()[0]);
        if (!start || !first) return;
        start.style.setProperty('--x', `${first.x}px`);
        start.style.setProperty('--y', `${first.y - 56}px`);
    }

    renderGutters() {
        // A part's elements go under the part's own row, by the rest of their id (.refresh under part).
        const shortId = element => (element.part ? element.id.slice(element.part.length) : element.id);
        // A button that goes back or starts over says so; one that goes to a screen has a wire to it.
        const goes = element => (element.go === 'back' ? ' ↩' : element.go === 'start' ? ' ⟲' : '');
        const goTitle = element => (GO_PLACES[element.go] ? `. When clicked: ${GO_PLACES[element.go].toLowerCase()}` : '');
        const screens = this.storyboard;
        const portTitle = element => `${element.id}: drag to a tool's Run or one of its fields, or from a tool's Answer to here${element.kind === 'button' && screens ? ", or to a screen's ● for where it goes" : ''}`;
        let widest = 0;
        let measured = false;
        for (const [id, card] of this.cards) {
            const gutter = card.element.querySelector('[data-gutter]');
            const slots = this.portSlots(id);
            gutter.innerHTML = `
                <svg class="app-leads" aria-hidden="true">${Object.values(slots).map(slot => `<path d="M 0 ${SCREEN.bar + slot.at} C 9 ${SCREEN.bar + slot.at}, 7 ${SCREEN.bar + slot.y}, 16 ${SCREEN.bar + slot.y}"/>`).join('')}</svg>
                ${this.cardElements(id).filter(element => slots[element.id]).map(element => `
                    <div class="app-gutter-row" style="--y: ${SCREEN.bar + slots[element.id].y}px" data-gutter-row="${escapeHtml(element.id)}">
                        <span class="app-gutter-label mono" title="${escapeHtml(`${element.label} (${element.id})${goTitle(element)}`)}">${escapeHtml(shortId(element) + goes(element))}</span>
                        <span class="app-port app-port-element app-port-${element.kind}" data-port="${escapeHtml(elementPort(element.id))}" title="${escapeHtml(portTitle(element))}"></span>
                    </div>`).join('')}`;
            // A hidden canvas has nothing to measure, so the gutters keep their width until it shows.
            if (!gutter.offsetParent) continue;
            measured = true;
            widest = Math.max(widest, ...[...gutter.querySelectorAll('.app-gutter-label')].map(label => label.scrollWidth));
        }
        if (!measured) return;
        const width = Math.min(GUTTER_MAX, Math.max(SCREEN.gutter, Math.ceil(widest) + GUTTER_ROOM));
        if (width === this.gutterWidth) return;
        this.gutterWidth = width;
        this.style.setProperty('--gutter-w', `${width}px`);
    }

    // What picks each element in Design: a box over it, on each card it shows on.
    renderOverlays() {
        this.$('[data-overlays]').innerHTML = this.cardIds().map(id => {
            const at = this.at.cards.get(id);
            const { rects } = this.cardLayout(id);
            if (!at) return '';
            const boxes = this.elements().filter(element => element.kind !== 'screen' && rects[element.id]).map(element => {
                const rect = rects[element.id];
                return `<button type="button" class="app-element-box${element.part ? ' app-element-in-part' : ''}" data-element-box="${escapeHtml(element.id)}" style="--top: ${rect.top}px; --left: ${rect.left}px; --width: ${rect.width}px; --height: ${rect.height}px" aria-label="${escapeHtml(`Pick ${element.id}`)}" title="${escapeHtml(`${element.label} (${element.id})`)}"></button>`;
            }).join('');
            return `<div class="app-screen-overlay" data-overlay="${escapeHtml(id)}" style="--x: ${at.x}px; --y: ${at.y + SCREEN.bar}px; --h: ${this.bodyHeight(id)}px">${boxes}</div>`;
        }).join('');
    }

    renderNodes() {
        const app = this.app;
        const problems = new Map(flowProblems(app.flow, { elements: this.elements(), servers: this.shell.servers }));
        this.$('[data-nodes]').innerHTML = app.flow.map(rule => {
            const at = this.at.tools.get(rule.id);
            const server = this.shell.servers[rule.call?.serverUrl];
            const triggers = triggersOf(rule);
            const when = triggers.length
                ? triggers.map(({ element, event }) => (event === 'open' ? 'the app opens' : `${element} ${EVENTS[event]}`)).join(' or ')
                : 'nothing yet';
            const issues = problems.get(rule.id) || [];
            const status = this.statuses?.get(rule.id);
            // Text a node shortens to fit has a title with all of it.
            const full = text => (text ? ` title="${escapeHtml(text)}"` : '');
            return `
                <div class="app-node${issues.length ? ' app-node-incomplete' : ''}" data-node="${escapeHtml(rule.id)}" tabindex="0" style="--x: ${at.x}px; --y: ${at.y}px" aria-label="${escapeHtml(`${rule.call?.toolName || 'A tool'} on ${server ? serverLabel(server) : 'no server'}`)}" title="${escapeHtml(issues.join(' '))}">
                    <div class="app-node-head" data-drag-node>
                        <span class="app-node-title mono"${full(rule.call?.toolName)}>${escapeHtml(rule.call?.toolName || 'Choose a tool')}</span>
                        <span class="app-node-server"${full(server ? `${serverLabel(server)}: ${rule.call.serverUrl}` : rule.call?.serverUrl)}>${escapeHtml(server ? serverLabel(server) : rule.call?.serverUrl ? 'not added' : '')}</span>
                    </div>
                    <div class="app-node-row app-node-run">
                        <span class="app-port app-port-run" data-port="run:${escapeHtml(rule.id)}" title="Run: wire a button, a field or Start here to start it"></span>
                        <span class="app-node-name">▶ Run</span><span class="app-node-value"${full(`When ${when}`)}>when ${escapeHtml(when)}</span>
                    </div>
                    ${this.shownArgs(rule).map(arg => {
                        const value = rule.call?.args?.[arg];
                        const shown = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
                        return `
                    <div class="app-node-row">
                        <span class="app-port app-port-arg" data-port="arg:${escapeHtml(rule.id)}:${escapeHtml(arg)}" title="${escapeHtml(`${arg}: wire a field here to fill it`)}"></span>
                        <span class="app-node-name">${escapeHtml(arg)}</span><span class="app-node-value mono"${full(shown && `${arg} = ${shown}`)}>${escapeHtml(shown.length > 28 ? `${shown.slice(0, 27)}…` : shown || '—')}</span>
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
    }

    // A transform on every Sent, Answer and Error wire to an element: what of it shows. A wire to a
    // screen goes there and shows nothing, so it has none. Placed when the wires are.
    renderPills() {
        const wires = wiresOf(this.app.flow, this.elementIds()).filter(wire => ROUTE_KINDS.has(wire.kind) && this.kindOf(wire.element) !== 'screen');
        this.$('[data-pills]').innerHTML = wires.map(wire => {
            const route = this.app.flow.find(rule => rule.id === wire.ruleId).then[wire.index];
            const custom = !isDefaultShow(route) || route.how === 'html';
            return `<button type="button" class="app-pill app-pill-${wire.kind}${custom ? ' app-pill-custom' : ''}" data-pill="${escapeHtml(wire.id)}" title="${escapeHtml(`What it shows: ${route.show || 'nothing'}${route.how && route.how !== 'replace' ? `, ${route.how}` : ''}`)}">${escapeHtml(routeSummary(route))}</button>`;
        }).join('');
    }

    // The surface holds everything, with room around it, and fills the view however far out it's zoomed.
    sizeSurface() {
        const right = Math.max(
            0,
            ...[...this.at.cards.values()].map(at => at.x + this.screenWidth() + this.gutterWidth),
            ...[...this.at.tools.values()].map(at => at.x + TOOL_WIDTH),
        ) + 60;
        const bottom = Math.max(
            0,
            ...[...this.at.cards].map(([id, at]) => at.y + SCREEN.bar + this.bodyHeight(id)),
            ...this.app.flow.map(rule => (this.at.tools.get(rule.id)?.y ?? 0) + this.nodeHeight(rule)),
        ) + 60;
        this.content = { right, bottom };
        this.applyZoom();
    }

    applyZoom() {
        if (!this.surface || !this.scroller || !this.content) return;
        const width = Math.max(this.content.right, this.scroller.clientWidth / this.zoom);
        const height = Math.max(this.content.bottom, this.scroller.clientHeight / this.zoom);
        this.surface.style.width = `${width}px`;
        this.surface.style.height = `${height}px`;
        this.surface.style.transform = `scale(${this.zoom})`;
        const sizer = this.$('[data-zoom]');
        sizer.style.width = `${width * this.zoom}px`;
        sizer.style.height = `${height * this.zoom}px`;
        const level = this.$('[data-zoom-reset]');
        if (level) level.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    // --- Zoom and where the canvas is scrolled, kept for each app ---

    // A point on the page, in the canvas's own units.
    toSurface(clientX, clientY) {
        const box = this.surface.getBoundingClientRect();
        return { x: (clientX - box.left) / this.zoom, y: (clientY - box.top) / this.zoom };
    }

    zoomTo(next, { around = null } = {}) {
        if (!this.scroller) return;
        const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        if (Math.abs(zoom - this.zoom) < 0.001) return;
        const box = this.scroller.getBoundingClientRect();
        const point = around ? { x: around.x - box.left, y: around.y - box.top } : { x: this.scroller.clientWidth / 2, y: this.scroller.clientHeight / 2 };
        const x = (this.scroller.scrollLeft + point.x) / this.zoom;
        const y = (this.scroller.scrollTop + point.y) / this.zoom;
        this.zoom = zoom;
        this.pendingView = null;
        this.applyZoom();
        this.scroller.scrollLeft = x * zoom - point.x;
        this.scroller.scrollTop = y * zoom - point.y;
        this.saveViewSoon();
    }

    stepZoom(direction) {
        const next = direction > 0 ? ZOOMS.find(level => level > this.zoom + 0.001) : [...ZOOMS].reverse().find(level => level < this.zoom - 0.001);
        this.zoomTo(next ?? this.zoom);
    }

    // Zooms to show the whole app, up to 100%, and scrolls to its top left.
    fit() {
        if (!this.scroller || !this.content) return;
        const left = Math.max(0, Math.min(...[...this.at.cards.values()].map(at => at.x), ...[...this.at.tools.values()].map(at => at.x)) - 16);
        const width = this.content.right - left;
        const height = this.content.bottom;
        const zoom = Math.min(1, Math.max(ZOOM_MIN, Math.min(this.scroller.clientWidth / width, this.scroller.clientHeight / height)));
        this.zoom = Math.floor(zoom * 100) / 100;
        this.pendingView = null;
        this.applyZoom();
        this.scroller.scrollLeft = left * this.zoom;
        this.scroller.scrollTop = 0;
        this.saveViewSoon();
    }

    // Puts the canvas back where it was for this app, once there's room to scroll there; an app
    // seen for the first time fits, once its screens have said how tall they are.
    applyPendingView() {
        const view = this.pendingView;
        if (!view || !this.scroller || !this.scroller.clientWidth) return;
        if (view.fit) {
            const sized = this.cardIds().every(id => this.cardLayout(id).height > 0);
            if (sized || performance.now() > view.until) this.fit();
            return;
        }
        this.applyZoom();
        const left = view.left * this.zoom;
        const top = view.top * this.zoom;
        this.scroller.scrollLeft = left;
        this.scroller.scrollTop = top;
        if (Math.abs(this.scroller.scrollLeft - left) < 2 && Math.abs(this.scroller.scrollTop - top) < 2) this.pendingView = null;
    }

    saveView() {
        if (!this.app || !this.scroller || this.pendingView) return;
        const views = readViews();
        delete views[this.app.id];
        views[this.app.id] = {
            zoom: Math.round(this.zoom * 1000) / 1000,
            left: Math.round(this.scroller.scrollLeft / this.zoom),
            top: Math.round(this.scroller.scrollTop / this.zoom),
        };
        const kept = Object.entries(views).slice(-50);
        localStorage.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(kept)));
    }

    // Brings a card into view when it's out of it, as the app moves there or it's picked.
    revealCard(id) {
        const card = this.cards.get(id)?.element;
        if (!card || !this.scroller || this.pendingView) return;
        const box = card.getBoundingClientRect();
        const view = this.scroller.getBoundingClientRect();
        if (box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom) return;
        const at = this.at.cards.get(id);
        const left = Math.max(0, at.x * this.zoom - 24);
        const top = Math.max(0, (at.y - 60) * this.zoom);
        const partly = box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
        this.scroller.scrollTo({ left: box.left < view.left || box.right > view.right ? left : this.scroller.scrollLeft, top: box.top < view.top || (!partly && box.bottom > view.bottom) ? top : this.scroller.scrollTop, behavior: 'smooth' });
    }

    wheeled(event) {
        if (!(event.ctrlKey || event.metaKey) || !event.target.closest('[data-canvas-scroll]')) return;
        event.preventDefault();
        this.zoomTo(this.zoom * Math.exp(-event.deltaY * 0.0025), { around: { x: event.clientX, y: event.clientY } });
    }

    // --- Wires ---

    // A port on the surface: where it is, the way a wire leaves it, and what it's on, so a wire
    // can end on the side that faces the other end. Elements' ports are right of their card, and
    // a tool's on its left.
    portPoint(port) {
        const element = this.surface.querySelector(`[data-port="${CSS.escape(port)}"]`);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const { x, y } = this.toSurface(box.left + box.width / 2, box.top + box.height / 2);
        const parsed = parsePort(port);
        if (parsed.kind === 'start') return { x, y, dir: RIGHT };
        if (parsed.kind === 'el') {
            const screen = this.kindOf(parsed.element) === 'screen';
            const card = this.at.cards.get(screen ? parsed.element : this.cardOf(parsed.element));
            if (!card) return null;
            return screen ? { x, y, dir: LEFT, entry: card } : { x, y, dir: RIGHT, card };
        }
        const tool = this.at.tools.get(parsed.ruleId);
        return tool ? { x, y, dir: LEFT, tool } : null;
    }

    // A wire's end on the side that faces its other end: from a tool to what's right of it, the
    // tool's right edge; to an element from left of its card, the card's left edge, level with
    // the element. A wire into a screen comes into its title bar from the left; from beside the
    // card, into the bar's right end; and from further right, a way back, down from above.
    facing(end, other) {
        if (end.tool && other.x > end.tool.x + TOOL_WIDTH) return { x: end.tool.x + TOOL_WIDTH, y: end.y, dir: RIGHT };
        if (end.card && other.x < end.card.x) return { x: end.card.x, y: end.y, dir: LEFT };
        if (end.entry && other.x > end.entry.x + 24) {
            const right = end.entry.x + this.screenWidth();
            return other.x <= right + this.gutterWidth + 40
                ? { x: right, y: end.entry.y + SCREEN.bar / 2, dir: RIGHT }
                : { x: end.entry.x + this.screenWidth() * 0.7, y: end.entry.y, dir: UP };
        }
        return end;
    }

    // A way back to an earlier screen: out of the side it leaves, up to a lane above the cards it
    // passes over (`lane`, a y), along it, and down into the screen's title bar.
    backPath(from, to, lane) {
        const out = { x: from.x + from.dir.x * 18, y: from.y };
        const points = [from, out, { x: out.x, y: lane }, { x: to.x, y: lane }, to];
        let d = `M ${from.x} ${from.y}`;
        for (let n = 1; n < points.length - 1; n++) {
            const [a, b, c] = [points[n - 1], points[n], points[n + 1]];
            const r = Math.min(10, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
            const toward = (p, q) => {
                const length = Math.hypot(q.x - p.x, q.y - p.y) || 1;
                return { x: p.x + ((q.x - p.x) / length) * r, y: p.y + ((q.y - p.y) / length) * r };
            };
            const before = toward(b, a);
            const after = toward(b, c);
            d += ` L ${before.x} ${before.y} Q ${b.x} ${b.y}, ${after.x} ${after.y}`;
        }
        return `${d} L ${to.x} ${to.y}`;
    }

    // How high a way back runs: above every card between its ends, each one a little higher than the last.
    laneAbove(from, to, count) {
        const low = Math.min(from.x, to.x) - 20;
        const high = Math.max(from.x, to.x) + 20;
        const tops = [...this.at.cards.values()].filter(at => at.x < high && at.x + this.screenWidth() + this.gutterWidth > low).map(at => at.y);
        return Math.max(6, Math.min(from.y, to.y, ...tops) - 22 - count * 8);
    }

    ends(a, b) {
        const from = this.portPoint(a);
        const to = this.portPoint(b);
        return from && to ? [this.facing(from, to), this.facing(to, from)] : null;
    }

    // A curve out of each end the way it faces, with its middle, where a transform's label goes.
    curve(from, to) {
        const reach = dir => (dir.y ? Math.min(90, Math.max(50, Math.abs(to.y - from.y) / 2)) : Math.max(40, Math.abs(to.x - from.x) / 2));
        const a = { x: from.x + from.dir.x * reach(from.dir), y: from.y + from.dir.y * reach(from.dir) };
        const b = { x: to.x + to.dir.x * reach(to.dir), y: to.y + to.dir.y * reach(to.dir) };
        return {
            d: `M ${from.x} ${from.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${to.x} ${to.y}`,
            middle: { x: (from.x + 3 * a.x + 3 * b.x + to.x) / 8, y: (from.y + 3 * a.y + 3 * b.y + to.y) / 8 },
        };
    }

    // The buttons that go to a screen, each a wire to that screen's card.
    goWires() {
        const screens = new Set(this.screens().map(screen => screen.id));
        return this.elements().filter(element => element.kind === 'button' && screens.has(element.go))
            .map(element => ({ id: `g:${element.id}`, button: element.id, from: elementPort(element.id), to: elementPort(element.go) }));
    }

    drawWires() {
        if (!this.surface?.isConnected || !this.app) return;
        const group = this.$('[data-wire-paths]');
        const wires = wiresOf(this.app.flow, this.elementIds());
        const paths = [];
        const middles = new Map();
        // Start points into the screen it begins on.
        const start = this.$('[data-start]');
        const first = this.at.cards.get(this.cardIds()[0]);
        if (start && first) {
            const box = start.getBoundingClientRect();
            const bottom = this.toSurface(box.left + 22 * this.zoom, box.bottom);
            paths.push(`<path class="app-entry" d="M ${bottom.x} ${bottom.y} L ${bottom.x} ${first.y - 4}" marker-end="url(#app-arrow-trigger)"/>`);
        }
        let backs = 0;
        const pathOf = ([from, to]) => {
            if (to.dir !== UP) return this.curve(from, to);
            return { d: this.backPath(from, to, this.laneAbove(from, to, backs++)), middle: null };
        };
        for (const wire of wires) {
            const ends = this.ends(wire.from, wire.to);
            if (!ends) continue;
            const { d, middle } = pathOf(ends);
            if (middle) middles.set(wire.id, middle);
            const transition = ROUTE_KINDS.has(wire.kind) && this.kindOf(wire.element) === 'screen' ? ' app-wire-transition' : '';
            paths.push(`<g class="app-wire app-wire-${wire.kind}${transition}" data-wire="${escapeHtml(wire.id)}"><path class="app-wire-hit" d="${d}"/><path class="app-wire-line" d="${d}" marker-end="url(#app-arrow-${wire.kind})"/></g>`);
        }
        for (const wire of this.goWires()) {
            const ends = this.ends(wire.from, wire.to);
            if (!ends) continue;
            const { d } = pathOf(ends);
            paths.push(`<g class="app-wire app-wire-go app-wire-transition" data-go-wire="${escapeHtml(wire.button)}"><path class="app-wire-hit" d="${d}"/><path class="app-wire-line" d="${d}" marker-end="url(#app-arrow-go)"/></g>`);
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
        const element = selection?.kind === 'element' ? selection.id : null;
        this.querySelectorAll('[data-wire]').forEach(wire => wire.classList.toggle('app-selected', selection?.kind === 'wire' && wire.dataset.wire === selection.id));
        this.querySelectorAll('[data-go-wire]').forEach(wire => wire.classList.toggle('app-selected', wire.dataset.goWire === element));
        this.querySelectorAll('[data-card-bar]').forEach(bar => bar.classList.toggle('app-selected', bar.dataset.cardBar === element));
        this.querySelectorAll('[data-pill]').forEach(pill => pill.classList.toggle('app-selected', selection?.kind === 'wire' && pill.dataset.pill === selection.id));
        this.querySelectorAll('[data-node]').forEach(node => node.classList.toggle('app-selected', selection?.kind === 'rule' && node.dataset.node === selection.id));
        this.querySelectorAll('[data-element-box]').forEach(box => box.classList.toggle('app-selected', box.dataset.elementBox === element));
        this.querySelectorAll('[data-gutter-row]').forEach(row => row.classList.toggle('app-selected', row.dataset.gutterRow === element));
        this.$('[data-start]')?.classList.toggle('app-selected', selection?.kind === 'start');
    }

    // --- Rules running: their wires light up ---

    light(ids) {
        for (const id of ids) {
            for (const element of this.querySelectorAll(`[data-wire="${CSS.escape(id)}"], [data-pill="${CSS.escape(id)}"], [data-go-wire="${CSS.escape(id)}"]`)) {
                element.classList.remove('app-live');
                void element.getBoundingClientRect();
                element.classList.add('app-live');
                setTimeout(() => element.classList.remove('app-live'), 1600);
            }
        }
    }

    // A button that went to a screen lights its arrow there.
    lightGo(button) {
        this.light([button]);
    }

    showActivity({ ruleId, phase, trigger, routes = [], durationMs }) {
        this.statuses ??= new Map();
        const node = this.$(`[data-node="${CSS.escape(ruleId)}"]`);
        const rule = this.app?.flow.find(candidate => candidate.id === ruleId);
        if (!rule) return;
        if (phase === 'call') {
            node?.classList.add('app-node-running');
            const args = wiresOf([rule], this.elementIds()).filter(wire => wire.kind === 'arg').map(wire => wire.id);
            this.light([`t:${ruleId}:${trigger}`, ...args, ...routes.map(index => `r:${ruleId}:${index}`)]);
            this.statuses.set(ruleId, 'Calling…');
        } else {
            node?.classList.remove('app-node-running');
            this.light(routes.map(index => `r:${ruleId}:${index}`));
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
        const go = goPairOf(a, b, { kindOf: id => this.kindOf(id) });
        if (go) return this.setGo(go.button, go.screen);
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

    // A button wired to a screen's card goes there when it's clicked.
    setGo(buttonId, screenId) {
        const component = this.app.screen.components.find(candidate => candidate.id === buttonId);
        if (!component) return this.hint(`${buttonId} is in a part, which says itself what its buttons do: wire it to a tool's Run, and the tool's Answer to the screen.`, { error: true });
        if (component.go === screenId) return this.hint('Those are connected already.');
        this.apps.change(app => { app.screen.components.find(candidate => candidate.id === buttonId).go = screenId; }, { part: 'screen' });
        this.apps.select({ kind: 'element', id: buttonId });
        this.hint(`Connected: ${buttonId} goes to ${this.apps.elementName(screenId)} when it's clicked.`);
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
    addBox(kind, place = {}) {
        const { label, base } = BOX_KINDS[kind];
        const ids = (this.app.screen.components || []).map(component => component.id);
        return this.addComponent('output', place, { id: freeId(base, ids), label, show: kind, width: BOX_WIDTHS[kind], placeholder: 'Filled in when the app runs.' });
    }

    // The screen what the Library adds goes on: the one picked, or the one an element picked is on,
    // else the one the app is on.
    targetScreen() {
        const selection = this.apps.selection;
        const element = selection?.kind === 'element' ? this.element(selection.id) : null;
        const screen = element?.kind === 'screen' ? element.id : element?.screen;
        return this.cardIds().includes(screen) ? screen : this.activeCard();
    }

    // A component goes where it was dropped (`index`), or at the end of `screen`; a screen goes
    // after the others, on a card of its own.
    addComponent(type, { index = null, screen = this.targetScreen() } = {}, props = {}) {
        const app = this.app;
        if (app.screen.kind === 'html') return this.hint('This screen is HTML, so it has no components: switch it to Components in the Inspector first.', { error: true });
        if (type === 'screen') {
            const titled = app.screen.components[0]?.type === 'title';
            const before = screensOf(app.screen.components).length;
            const added = this.apps.addScreen();
            const screens = screensOf(this.app.screen.components);
            this.apps.select({ kind: 'element', id: added.id });
            return this.hint(!before && screens.length === 2
                ? `Added ${added.id}. What was on the screen is on ${screens[0].id} now${titled ? ', and the title above them shows on both' : ''}. Wire a button or a tool's Answer to a screen's ● to go there.`
                : `Added ${added.id}. Add components to it from the Library, and wire a button or a tool's Answer to its ● to go there.`);
        }
        const added = newComponent(type, app.screen.components.map(component => component.id), props);
        this.apps.change(found => {
            const at = index ?? endOfScreen(found.screen.components, screen);
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

    // Puts the screens in the order people go through them and every tool beside what starts it,
    // as a new app has them, and keeps that.
    tidy() {
        const storyboard = this.storyboard;
        this.apps.change(app => {
            app.flow = app.flow.map(({ position, ...rule }) => rule);
            delete app.screen.position;
            for (const component of app.screen.components || []) delete component.position;
        }, { part: 'layout', by: this });
        this.at = this.positions();
        const { cards, tools } = this.at;
        const round = at => ({ x: Math.round(at.x), y: Math.round(at.y) });
        this.apps.change(app => {
            app.flow = app.flow.map(rule => ({ ...rule, position: round(tools.get(rule.id)) }));
            if (!storyboard) return;
            for (const component of app.screen.components) {
                if (cards.has(component.id)) component.position = round(cards.get(component.id));
            }
        }, { part: 'layout', by: this });
        this.renderGraph();
    }

    // Moves a card, keeping where every other card is as it's shown now: the first card moved
    // fixes them all in place.
    placeCard(id, position) {
        const to = { x: Math.round(Math.max(0, position.x)), y: Math.round(Math.max(0, position.y)) };
        const shown = this.at.cards;
        this.apps.change(app => {
            if (id === ONE) {
                app.screen.position = to;
                return;
            }
            for (const component of app.screen.components) {
                if (component.type !== 'screen') continue;
                if (component.id === id) component.position = to;
                else if (!component.position && shown.has(component.id)) component.position = { ...shown.get(component.id) };
            }
        }, { part: 'layout', by: this });
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
            <p class="app-library-note text-secondary">Click to add, or drag onto the canvas: a component onto a screen, a tool anywhere, a transform onto a wire from a tool's Answer.</p>`;
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
            screen: 'Another screen, which a button or an answer goes to',
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
        if (item.libraryItem === 'component') return this.addComponent(item.type, at || {});
        if (item.libraryItem === 'box') return this.addBox(item.show, at || {});
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

    // The card under a point on the surface, if any.
    cardAt(point) {
        return this.cardIds().find(id => {
            const at = this.at.cards.get(id);
            return at && point.x >= at.x && point.x <= at.x + this.screenWidth() + this.gutterWidth && point.y >= at.y && point.y <= at.y + SCREEN.bar + this.bodyHeight(id);
        }) ?? null;
    }

    dropped(event) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('application/x-mcp-app') || 'null');
        } catch { /* not ours */ }
        if (!data || !this.surface) return;
        event.preventDefault();
        const point = this.toSurface(event.clientX, event.clientY);
        if (data.libraryItem === 'component' || data.libraryItem === 'box') {
            // On the card it was dropped on, before the first component there whose middle is below it.
            const card = this.cardAt(point);
            const screen = card === null ? this.targetScreen() : card;
            const components = this.app.screen.components || [];
            const on = screenOfEach(components);
            const at = this.at.cards.get(screen);
            const { rects } = this.cardLayout(screen);
            const index = card === null || !at ? -1 : components.findIndex(component => {
                const rect = component.type !== 'screen' && (screen === ONE || on.get(component.id) === screen) && rects[component.id];
                return rect && at.y + SCREEN.bar + rect.top + rect.height / 2 > point.y;
            });
            return this.useLibraryItem(data, { at: { index: index < 0 ? null : index, screen } });
        }
        if (data.libraryItem === 'tool') return this.useLibraryItem(data, { at: { point: { x: Math.max(0, point.x - 20), y: Math.max(0, point.y - 16) } } });
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-wire], [data-pill]');
        return this.useLibraryItem(data, { target: target?.dataset.wire || target?.dataset.pill || null });
    }

    // --- Pointer: wiring, moving tools and cards, looking around ---

    pointerDown(event) {
        if (event.button !== 0) return;
        if (event.target.closest('[data-canvas-scroll]')) this.pendingView = null;
        // A wire starts from a port, or from the label or row it's on.
        const port = event.target.closest('[data-port]') || event.target.closest('[data-gutter-row], .app-node-row, [data-start]')?.querySelector('[data-port]');
        if (port && this.mode === 'design') return this.startWiring(event, port.dataset.port);
        const head = event.target.closest('[data-drag-node]');
        if (head) return this.startMoving(event, head.closest('[data-node]'));
        const bar = event.target.closest('[data-card-bar]');
        if (bar) return this.startMovingCard(event, bar.dataset.cardBar);
        if (event.target.closest('[data-canvas-scroll]') && !event.target.closest('button, [data-node], [data-card], [data-overlay], [data-wire], [data-go-wire], iframe')) this.startPanning(event);
    }

    startWiring(event, from) {
        event.preventDefault();
        const draft = this.$('[data-draft]');
        const start = this.portPoint(from);
        if (!start) return;
        const kindOf = id => this.kindOf(id);
        this.querySelectorAll('[data-port]').forEach(port => port.classList.toggle('app-port-can', canConnect(from, port.dataset.port, { kindOf })));
        this.classList.add('app-wiring');
        const scroller = this.scroller;
        let pointer = null;
        let frame = 0;
        const follow = () => {
            const at = this.toSurface(pointer.clientX, pointer.clientY);
            draft.hidden = false;
            draft.setAttribute('d', this.curve(start, { ...at, dir: { x: -start.dir.x, y: -start.dir.y } }).d);
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

    // The port under the pointer (or the port of the label, row, element or card title under it),
    // or the nearest one it can connect to within a few pixels.
    portNear(x, y, from) {
        const kindOf = id => this.kindOf(id);
        const at = document.elementFromPoint(x, y);
        const box = at?.closest('[data-element-box]')?.dataset.elementBox;
        const under = at?.closest('[data-port]') || at?.closest('[data-gutter-row], .app-node-row, [data-start], [data-card-bar]')?.querySelector('[data-port]');
        if (under && under.dataset.port !== from) return under.dataset.port;
        if (box && canConnect(from, elementPort(box), { kindOf })) return elementPort(box);
        let best = null;
        for (const port of this.querySelectorAll('[data-port]')) {
            if (!canConnect(from, port.dataset.port, { kindOf })) continue;
            const rect = port.getBoundingClientRect();
            const distance = Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y);
            if (distance < 22 && (!best || distance < best.distance)) best = { port: port.dataset.port, distance };
        }
        return best?.port || null;
    }

    // Drags something by its title: `place(moved)` gets how far it's moved, in the canvas's units,
    // as it moves, and `done(moved)` once it's let go; a press that doesn't move is a click.
    drag(event, { place, done }) {
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;
        let frame = 0;
        let last = null;
        const offset = moving => ({ x: (moving.clientX - startX) / this.zoom, y: (moving.clientY - startY) / this.zoom });
        const move = moving => {
            moved = moved || Math.hypot(moving.clientX - startX, moving.clientY - startY) > 3;
            if (!moved) return;
            last = offset(moving);
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (last) place(last);
            });
        };
        const end = ended => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            cancelAnimationFrame(frame);
            if (!moved) return;
            this.draggedAt = performance.now();
            done(offset(ended));
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
    }

    startMoving(event, node) {
        const id = node.dataset.node;
        const origin = { ...this.at.tools.get(id) };
        const to = moved => ({ x: Math.max(0, origin.x + moved.x), y: Math.max(0, origin.y + moved.y) });
        let clicked = true;
        this.drag(event, {
            place: moved => {
                clicked = false;
                const at = to(moved);
                node.style.setProperty('--x', `${at.x}px`);
                node.style.setProperty('--y', `${at.y}px`);
                this.at.tools.set(id, at);
                this.drawSoon();
            },
            done: moved => {
                clicked = false;
                this.placeNode(id, to(moved));
            },
        });
        // A press on a tool's title that doesn't move it picks it.
        document.addEventListener('pointerup', () => {
            if (clicked) this.apps.select({ kind: 'rule', id });
        }, { once: true });
    }

    placeNode(id, position) {
        this.apps.change(app => {
            const rule = app.flow.find(candidate => candidate.id === id);
            if (rule) rule.position = { x: Math.round(position.x), y: Math.round(position.y) };
        }, { part: 'layout', by: this });
        this.renderGraph();
    }

    // A card moves by its title bar, its ports, still and the running app with it; the tools
    // beside it that haven't been put anywhere follow.
    startMovingCard(event, id) {
        this.raise(id);
        const origin = { ...this.at.cards.get(id) };
        // The other cards stay where they're shown while this one moves, placed or not.
        const others = new Map(this.at.cards);
        const to = moved => ({ x: Math.max(0, origin.x + moved.x), y: Math.max(0, origin.y + moved.y) });
        this.drag(event, {
            place: moved => {
                this.dragging = { id, at: to(moved), others };
                this.renderGraph();
            },
            done: moved => {
                this.dragging = null;
                this.placeCard(id, to(moved));
            },
        });
    }

    // Dragging the background scrolls the canvas, as a hand would move a sheet of paper.
    startPanning(event) {
        const scroller = this.scroller;
        const startX = event.clientX;
        const startY = event.clientY;
        const left = scroller.scrollLeft;
        const top = scroller.scrollTop;
        let moved = false;
        const move = moving => {
            moved = moved || Math.hypot(moving.clientX - startX, moving.clientY - startY) > 3;
            if (!moved) return;
            this.classList.add('app-panning');
            scroller.scrollLeft = left - (moving.clientX - startX);
            scroller.scrollTop = top - (moving.clientY - startY);
        };
        const end = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            this.classList.remove('app-panning');
            if (moved) this.draggedAt = performance.now();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
    }

    keyDown(event) {
        if (event.target.closest('input, textarea, select')) return;
        if (event.target.closest('[data-canvas-scroll]')) this.pendingView = null;
        const selection = this.apps.selection;
        if ((event.key === 'Delete' || event.key === 'Backspace') && selection?.kind === 'wire') {
            event.preventDefault();
            return this.removeWire(selection.id);
        }
        if (event.key === 'Escape') {
            if (!this.$('[data-library]')?.hidden) return this.toggleLibrary(false);
            return this.apps.select(null);
        }
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const distance = event.shiftKey ? 40 : 8;
        const node = event.target.closest?.('[data-node]');
        if (node && step) {
            event.preventDefault();
            const at = this.at.tools.get(node.dataset.node);
            this.placeNode(node.dataset.node, { x: Math.max(0, at.x + step[0] * distance), y: Math.max(0, at.y + step[1] * distance) });
            this.$(`[data-node="${CSS.escape(node.dataset.node)}"]`)?.focus();
        }
        if (node && event.key === 'Enter') this.apps.select({ kind: 'rule', id: node.dataset.node });
        const bar = event.target.closest?.('[data-card-bar]');
        if (bar && step) {
            event.preventDefault();
            const at = this.at.cards.get(bar.dataset.cardBar);
            this.placeCard(bar.dataset.cardBar, { x: at.x + step[0] * distance, y: at.y + step[1] * distance });
            this.$(`[data-card-bar="${CSS.escape(bar.dataset.cardBar)}"]`)?.focus();
        }
        if (bar && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            this.pickCard(bar.dataset.cardBar);
        }
    }

    // Picking a card picks its screen, which the app then goes to; an app's one card is the app.
    pickCard(id) {
        this.raise(id);
        this.apps.select(id === ONE ? null : { kind: 'element', id });
    }

    // The card moved or picked last is in front of the others where they overlap.
    raise(id) {
        for (const [cardId, card] of this.cards) card.element.toggleAttribute('data-front', cardId === id);
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
        if (button?.dataset.zoomStep) return this.stepZoom(Number(button.dataset.zoomStep));
        if (button?.dataset.zoomReset !== undefined) return this.zoomTo(1);
        if (button?.dataset.zoomFit !== undefined) return this.fit();
        if (button?.dataset.clearTrace !== undefined) return this.trace.clear();
        if (button?.dataset.openRun) return this.apps.openRun(button.dataset.openRun);
        if (target.closest('[data-port]')) return;
        const bar = target.closest('[data-card-bar]');
        if (bar) return this.pickCard(bar.dataset.cardBar);
        if (button?.dataset.selectStart !== undefined) return this.apps.select({ kind: 'start' });
        if (button?.dataset.elementBox) return this.apps.select({ kind: 'element', id: button.dataset.elementBox });
        if (button?.dataset.pill) return this.apps.select({ kind: 'wire', id: button.dataset.pill, ruleId: button.dataset.pill.split(':')[1] });
        const wire = target.closest('[data-wire]');
        if (wire) return this.apps.select({ kind: 'wire', id: wire.dataset.wire, ruleId: wire.dataset.wire.split(':')[1] });
        const goWire = target.closest('[data-go-wire]');
        if (goWire) return this.apps.select({ kind: 'element', id: goWire.dataset.goWire });
        const row = target.closest('[data-gutter-row]');
        if (row) return this.apps.select({ kind: 'element', id: row.dataset.gutterRow });
        const node = target.closest('[data-node]');
        if (node) {
            if (!target.closest('[data-drag-node]')) this.apps.select({ kind: 'rule', id: node.dataset.node });
            return;
        }
        const overlay = target.closest('[data-overlay]');
        if (overlay) return this.pickCard(overlay.dataset.overlay);
        if (target.closest('[data-surface]')) this.apps.select(null);
    }

    // Clicks on wires and the surface leave the keyboard with the canvas, so Delete and Escape work.
    focusCanvas(event) {
        if (!event.target.closest('button, input, textarea, select, [data-node], [data-card-bar]')) this.scroller?.focus({ preventScroll: true });
    }
}
