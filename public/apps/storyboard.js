// The storyboard: how the canvas lays out an app with several screens. Each screen is a card, in
// columns by how people get there from the first, where the app opens: a screen that a button or
// a tool's answer goes to from one column is in the next. A tool sits in the lane right of the
// screen that starts it, level with what starts it. An app with one screen is one card, with its
// tools in the lane beside it. Pure functions, so the tests can check them without a page.

import { variablesIn } from '../workbench/template.js';
import { triggersOf } from './flow.js';

// The screen an element is on, given the app's elements ({ id, kind, screen }): a screen is on
// itself, and an element above the first screen, on every one, counts as the first's.
export function screenFinder(elements = []) {
    const first = elements.find(element => element.kind === 'screen')?.id ?? null;
    const byId = new Map(elements.map(element => [element.id, element]));
    return id => {
        const element = byId.get(id);
        if (!element) return null;
        return element.kind === 'screen' ? element.id : element.screen ?? first;
    };
}

// Where people go from screen to screen: [{ from, to, kind: 'go', button } or { from, to, kind:
// 'rule', ruleId }]. A button goes where its `go` says; a rule goes from where it's started (the
// first screen, when the app opens) to the screens it routes to or puts its answer on. A field
// a rule reads on another screen doesn't count: people aren't there.
export function screenLinks(flow = [], elements = []) {
    const screenOf = screenFinder(elements);
    const first = elements.find(element => element.kind === 'screen')?.id ?? null;
    const screens = new Set(elements.filter(element => element.kind === 'screen').map(element => element.id));
    const links = [];
    for (const button of elements.filter(element => element.kind === 'button' && screens.has(element.go))) {
        const from = screenOf(button.id);
        if (from && from !== button.go) links.push({ from, to: button.go, kind: 'go', button: button.id });
    }
    for (const rule of flow) {
        const from = new Set(triggersOf(rule).map(({ element, event }) => (event === 'open' ? first : screenOf(element))).filter(Boolean));
        const to = new Set((rule.then || []).map(route => screenOf(route.into)).filter(Boolean));
        for (const source of from) {
            for (const target of to) if (source !== target) links.push({ from: source, to: target, kind: 'rule', ruleId: rule.id });
        }
    }
    return links;
}

// Each screen's column, counting the screens people pass through from the first, and the order
// they're reached in: { column: Map<id, n>, order: [id] }. Screens nothing leads to come last.
export function screenColumns(ids = [], links = []) {
    const column = new Map();
    const order = [];
    if (ids.length) {
        column.set(ids[0], 0);
        order.push(ids[0]);
    }
    for (let at = 0; at < order.length; at++) {
        const from = order[at];
        for (const link of links) {
            if (link.from !== from || column.has(link.to) || !ids.includes(link.to)) continue;
            column.set(link.to, column.get(from) + 1);
            order.push(link.to);
        }
    }
    const last = Math.max(-1, ...column.values()) + 1;
    for (const id of ids) {
        if (column.has(id)) continue;
        column.set(id, last);
        order.push(id);
    }
    return { column, order };
}

// The screen a rule's tool sits beside: the screen of what starts it, else of a field that fills
// it, else of where its answer goes, else the first.
export function homeScreen(rule, screenOf, first) {
    for (const { element, event } of triggersOf(rule)) {
        if (event === 'open') return first;
        const screen = screenOf(element);
        if (screen) return screen;
    }
    for (const value of Object.values(rule.call?.args || {})) {
        for (const name of variablesIn(value)) {
            const screen = screenOf(name);
            if (screen) return screen;
        }
    }
    for (const route of rule.then || []) {
        const screen = screenOf(route.into);
        if (screen) return screen;
    }
    return first;
}

// Where each card and tool goes: { cards: Map<id, { x, y }>, tools: Map<ruleId, { x, y }> }.
// `cards` are [{ id, height, position? }] in the app's order, the first where it opens; a card
// with a position stays there, and one without goes in its column, or, once any card has been
// placed, right of those. `homeOf(rule)` is the card its tool sits beside, and `anchor(rule,
// cards)` the y it lines up with there, or null. Tools with a position stay; the others go in
// their card's lane, clear of the tools already there. Heights don't count a card's title bar.
export function placeStoryboard({
    cards = [], links = [], rules = [], homeOf = () => cards[0]?.id, anchor = () => null,
    x = 24, y = 76, cardWidth = 300, gutter = 112, bar = 30, toolWidth = 220, toolHeight = () => 160,
    laneGap = 120, cardGap = 56, toolGap = 24, toolTop = 24,
} = {}) {
    const heightOf = new Map(cards.map(card => [card.id, card.height || 0]));
    const { column, order } = screenColumns(cards.map(card => card.id), links);
    const homes = new Map(rules.map(rule => [rule.id, homeOf(rule)]));
    const columns = [];
    for (const id of order) (columns[column.get(id)] ??= []).push(id);
    const placed = new Map();
    let left = x;
    columns.forEach((ids = [], n) => {
        let top = y;
        for (const id of ids) {
            placed.set(id, { x: left, y: top });
            top += bar + heightOf.get(id) + cardGap;
        }
        const tools = rules.some(rule => ids.includes(homes.get(rule.id)));
        left += cardWidth + gutter + laneGap + (tools ? toolWidth + laneGap : 0);
    });
    const kept = cards.filter(card => card.position);
    const at = new Map();
    if (!kept.length) {
        for (const card of cards) at.set(card.id, placed.get(card.id));
    } else {
        for (const card of kept) at.set(card.id, { x: card.position.x, y: card.position.y });
        const right = Math.max(...kept.map(card => card.position.x)) + cardWidth + gutter + laneGap;
        let top = y;
        for (const card of cards.filter(candidate => !candidate.position)) {
            at.set(card.id, { x: right, y: top });
            top += bar + heightOf.get(card.id) + cardGap;
        }
    }
    const lanes = [];
    const takenNear = laneX => lanes.filter(lane => Math.abs(lane.x - laneX) < toolWidth).map(lane => [lane.y, lane.y + lane.height]);
    for (const rule of rules.filter(candidate => candidate.position)) lanes.push({ x: rule.position.x, y: rule.position.y, height: toolHeight(rule) });
    const waiting = rules.filter(rule => !rule.position).map((rule, index) => {
        const home = at.get(homes.get(rule.id)) || at.get(cards[0]?.id) || { x, y };
        const wanted = anchor(rule, at);
        return { rule, index, x: home.x + cardWidth + gutter + laneGap, wanted: Number.isFinite(wanted) ? wanted : Infinity };
    }).sort((a, b) => a.x - b.x || a.wanted - b.wanted || a.index - b.index);
    const tools = new Map();
    for (const { rule, x: laneX, wanted } of waiting) {
        const tall = toolHeight(rule);
        const taken = takenNear(laneX);
        let top = Number.isFinite(wanted) ? Math.max(toolTop, wanted) : toolTop;
        for (let moved = true; moved;) {
            moved = false;
            for (const [start, end] of taken) {
                if (top < end + toolGap && top + tall + toolGap > start) {
                    top = end + toolGap;
                    moved = true;
                }
            }
        }
        lanes.push({ x: laneX, y: top, height: tall });
        tools.set(rule.id, { x: laneX, y: top });
    }
    return { cards: at, tools };
}
