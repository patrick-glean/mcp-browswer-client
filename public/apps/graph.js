// The flow as the canvas draws it: ports on the screen's elements, on Start and on each rule's
// tool, and wires between them. Every wire is one part of a rule, so drawing a wire adds that
// part and removing it takes the part away:
//   trigger   an element (or Start) to the tool's Run          one of rule.when
//   argument  an element to one of the tool's fields           {{element}} in rule.call.args
//   sent      the tool's Sent to an element                    a route of rule.then, as it's sent
//   answer    the tool's Answer to an element                  a route of rule.then, if it works
//   error     the tool's Error to an element                   a route of rule.then, if it fails
// Ports are strings: 'start', 'el:<id>', 'run:<rule>', 'arg:<rule>:<field>', 'sent:<rule>',
// 'ok:<rule>', 'err:<rule>'. Pure functions, so the tests can check them without a page.

import { variablesIn } from '../workbench/template.js';
import { defaultEvent, DEFAULT_SHOW, FlowError, routeWhen, trigger, triggersOf } from './flow.js';

export function parsePort(port) {
    const [kind, ...rest] = String(port ?? '').split(':');
    if (kind === 'start') return { kind };
    if (kind === 'el') return { kind, element: rest.join(':') };
    if (kind === 'run' || kind === 'sent' || kind === 'ok' || kind === 'err') return { kind, ruleId: rest.join(':') };
    if (kind === 'arg') return { kind, ruleId: rest[0], arg: rest.slice(1).join(':') };
    return { kind: null };
}

// A route's port and wire kind, by when it runs.
const ROUTE_PORTS = { sent: ['sent', 'sent'], ok: ['ok', 'answer'], error: ['err', 'error'] };
const PHASE_OF = { sent: 'sent', ok: 'ok', err: 'error' };

// Which kinds of port a wire joins, in either direction.
const PAIRS = new Set(['el+run', 'run+start', 'arg+el', 'el+sent', 'el+ok', 'el+err']);
const pairOf = (a, b) => [parsePort(a).kind, parsePort(b).kind].sort().join('+');

export const canConnect = (a, b) => a !== b && PAIRS.has(pairOf(a, b));

// What to say when two ports don't join.
function whyNot(pair) {
    if (pair === 'el+el') return "Two parts of the screen don't connect to each other: connect them through a tool.";
    if (pair.includes('start')) return "Start connects to a tool's Run: that tool is called when the app opens.";
    if (pair === 'ok+run' || pair === 'err+run' || pair === 'arg+ok' || pair === 'arg+err') return "A tool's answer can't start another tool yet; send it to the screen.";
    if (pair.includes('sent')) return "A tool's Sent goes to the screen: wire it to where what's sent should show, or to a field to clear it.";
    return "Those don't connect. Wires go from the screen (or Start) to a tool's Run or one of its fields, and from a tool's Sent, Answer or Error back to the screen.";
}

// The wires the flow has, each with what it joins and which part of which rule it is. Wires to
// elements that aren't on the screen aren't drawn; the rule's problems say so.
export function wiresOf(flow, elementIds = []) {
    const onScreen = new Set(elementIds);
    const wires = [];
    for (const rule of flow || []) {
        triggersOf(rule).forEach((candidate, index) => {
            if (candidate.event !== 'open' && !onScreen.has(candidate.element)) return;
            wires.push({
                id: `t:${rule.id}:${index}`, kind: 'trigger', ruleId: rule.id, index, element: candidate.element, event: candidate.event,
                from: candidate.event === 'open' ? 'start' : `el:${candidate.element}`, to: `run:${rule.id}`,
            });
        });
        for (const [arg, value] of Object.entries(rule.call?.args || {})) {
            for (const element of variablesIn(value)) {
                if (!onScreen.has(element)) continue;
                wires.push({ id: `a:${rule.id}:${arg}:${element}`, kind: 'arg', ruleId: rule.id, arg, element, from: `el:${element}`, to: `arg:${rule.id}:${arg}` });
            }
        }
        (rule.then || []).forEach((route, index) => {
            if (!onScreen.has(route.into)) return;
            const [port, kind] = ROUTE_PORTS[routeWhen(route)];
            wires.push({ id: `r:${rule.id}:${index}`, kind, ruleId: rule.id, index, element: route.into, from: `${port}:${rule.id}`, to: `el:${route.into}` });
        });
    }
    return wires;
}

// The flow with a wire between two ports: { flow, made }, where `made` says which part of which
// rule the wire is ({ kind: 'trigger' | 'arg' | 'route', ruleId, index | arg }), or that the rule
// already had it ({ kind: 'already' }). `kindOf(id)` is an element's kind, for its trigger's event,
// and `defaultShow({ element, phase, rule })` what a new route shows (else DEFAULT_SHOW's).
// Throws a FlowError saying why when the ports don't join.
export function connect(flow, a, b, { kindOf = () => 'static', defaultShow = () => null } = {}) {
    const pair = pairOf(a, b);
    if (a === b || !PAIRS.has(pair)) throw new FlowError(whyNot(pair));
    const ports = [parsePort(a), parsePort(b)];
    const port = kind => ports.find(candidate => candidate.kind === kind);
    const { ruleId } = port('run') || port('arg') || port('sent') || port('ok') || port('err');
    const element = port('el')?.element;
    let made = null;
    const next = (flow || []).map(rule => {
        if (rule.id !== ruleId) return rule;
        if (pair === 'el+run' || pair === 'run+start') {
            const added = pair === 'run+start' ? trigger('', 'open') : trigger(element, defaultEvent(kindOf(element)));
            const when = triggersOf(rule);
            const index = when.findIndex(candidate => candidate.event === added.event && candidate.element === added.element);
            made = index >= 0 ? { kind: 'already', ruleId } : { kind: 'trigger', ruleId, index: when.length };
            return index >= 0 ? rule : { ...rule, when: [...when, added] };
        }
        if (pair === 'arg+el') {
            const { arg } = port('arg');
            made = { kind: 'arg', ruleId, arg };
            return { ...rule, call: { ...rule.call, args: { ...(rule.call?.args || {}), [arg]: `{{${element}}}` } } };
        }
        const phase = PHASE_OF[ports.find(candidate => candidate.kind !== 'el').kind];
        const then = rule.then || [];
        const index = then.findIndex(route => routeWhen(route) === phase && route.into === element);
        made = index >= 0 ? { kind: 'already', ruleId } : { kind: 'route', ruleId, index: then.length };
        const show = defaultShow({ element, phase, rule }) ?? DEFAULT_SHOW[phase];
        const route = { if: phase, show, into: element, how: 'replace' };
        return index >= 0 ? rule : { ...rule, then: [...then, route] };
    });
    if (!made) throw new FlowError("That tool isn't in the flow anymore.");
    return { flow: next, made };
}

function withoutName(value, name) {
    if (typeof value === 'string') {
        const left = value.replace(new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*\\}\\}`, 'g'), '');
        return left.trim() ? left : '';
    }
    if (Array.isArray(value)) return value.map(item => withoutName(item, name));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutName(item, name)]));
    return value;
}

// The flow without a wire's part. A field that held only the element's value is left empty when
// the tool requires it and left out when it doesn't (`required` lists the tool's required fields).
export function disconnect(flow, wire, { required = [] } = {}) {
    return (flow || []).map(rule => {
        if (rule.id !== wire.ruleId) return rule;
        if (wire.kind === 'trigger') return { ...rule, when: triggersOf(rule).filter((candidate, index) => index !== wire.index) };
        if (wire.kind === 'arg') {
            const args = { ...(rule.call?.args || {}) };
            const left = withoutName(args[wire.arg], wire.element);
            if (left === '' && !required.includes(wire.arg)) delete args[wire.arg];
            else args[wire.arg] = left;
            return { ...rule, call: { ...rule.call, args } };
        }
        return { ...rule, then: (rule.then || []).filter((route, index) => index !== wire.index) };
    });
}

// Positions for the tools that haven't been placed: in a column, each level with what it's
// wired to on the screen (`anchor(rule)`, a y or null) and clear of the others, placed or not.
// `height(rule)` is how tall a rule's tool is. Returns Map<ruleId, { x, y }>.
export function placeRules(flow, { x, top = 0, gap = 24, width = 240, anchor = () => null, height = () => 160 }) {
    const taken = (flow || [])
        .filter(rule => rule.position && Math.abs(rule.position.x - x) < width)
        .map(rule => [rule.position.y, rule.position.y + height(rule)]);
    const placed = new Map();
    // Tools wired to nothing on the screen come after the others.
    const waiting = (flow || []).filter(rule => !rule.position)
        .map((rule, order) => ({ rule, order, wanted: anchor(rule) ?? Infinity }))
        .sort((a, b) => a.wanted - b.wanted || a.order - b.order);
    for (const { rule, wanted } of waiting) {
        const tall = height(rule);
        let y = Number.isFinite(wanted) ? Math.max(top, wanted) : top;
        for (let moved = true; moved;) {
            moved = false;
            for (const [start, end] of taken) {
                if (y < end + gap && y + tall + gap > start) {
                    y = end + gap;
                    moved = true;
                }
            }
        }
        taken.push([y, y + tall]);
        placed.set(rule.id, { x, y });
    }
    return placed;
}
