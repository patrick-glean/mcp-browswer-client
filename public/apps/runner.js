// Runs an app: its screen in a sandboxed frame, its flow in this page. The frame only reports the
// events the flow waits for (with the values it reads) and shows what the flow sends it; it can't
// call tools, reach the network or run the screen's own scripts. Each call goes to the worker like
// a Workbench call, and is recorded as a run from the app.
//
// Frame -> page: ready { values }, event { element, event, values },
//                layout { height, rects: { id: { top, left, width, height } } }, open { url },
//                escape
// Page -> frame: config { config }, show { element, value, how, failed }, busy { elements, busy },
//                highlight { elements }
// Every message carries the token this load of the frame was given. `layout` says where each
// element the config tracks is, so the canvas can put its ports on the running screen. `open`
// asks the page to open a link's http(s) address in a new tab, which the sandbox can't. `escape`
// is Escape pressed in the frame, which the page's own keys never see (Preview closes on it).

import { schemaOf, serverLabel } from '../workbench/util.js';
import { allowedCall, composePrompt, serverWithTool, toolCallsIn } from './agent.js';
import { asksOf, BOX_KINDS, CONVERSATION_ROLES, formatRequest, isBox, isConversation, renderBox, ROUTE_ROLES } from './boxes.js';
import {
    answerOf, callArguments, displayValue, frameConfig, listed, renderTemplate, routeWhen, rulesFor, templateValue, triggerIndex, triggersOf,
} from './flow.js';
import { elementsOf, screenHtml } from './screen.js';

// The screen's runtime. It's injected into the frame as source, so it may use nothing from outside;
// `roles` names who each entry of a conversation is from, as its value says.
export function frameRuntime({ config, token, roles = {} }) {
    let { watch, read, track = [] } = config;
    const send = message => parent.postMessage({ ...message, token }, '*');
    const byId = id => document.getElementById(id);
    const isField = element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
    const textIn = element => (element.innerText ?? element.textContent ?? '').trim();
    const valueOf = element => {
        // A conversation is its entries, each with who it's from: what a model is told came before.
        if (element.classList.contains('box-conversation')) {
            return [...element.children].filter(child => child.classList.contains('entry')).map(entry => `${roles[entry.dataset.role] || 'Note'}: ${textIn(entry)}`);
        }
        if (!isField(element)) return textIn(element);
        if (element.type === 'checkbox' || element.type === 'radio') return String(element.checked);
        return element.value;
    };
    const values = () => {
        const found = {};
        for (const id of read) {
            const element = byId(id);
            if (element) found[id] = valueOf(element);
        }
        return found;
    };
    const waitsFor = (id, event) => watch.some(entry => entry.element === id && entry.event === event);
    const report = (element, event) => send({ type: 'event', element: element.id, event, values: values() });

    document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]');
        if (link && !link.getAttribute('href').startsWith('#')) event.preventDefault();
        for (let element = event.target; element && element !== document.documentElement; element = element.parentElement) {
            if (element.id && waitsFor(element.id, 'click')) {
                event.preventDefault();
                report(element, 'click');
                return;
            }
        }
        if (link && /^https?:$/.test(link.protocol)) send({ type: 'open', url: link.href });
    }, true);
    document.addEventListener('keydown', event => {
        const element = event.target;
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey || !element?.id || !waitsFor(element.id, 'enter')) return;
        if (element instanceof HTMLTextAreaElement && !event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        report(element, 'enter');
    }, true);
    document.addEventListener('change', event => {
        const element = event.target;
        if (element?.id && waitsFor(element.id, 'change')) report(element, 'change');
    }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);

    // Where each tracked element is, after things settle.
    let layoutTimer = null;
    const layout = () => {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(() => {
            const rects = {};
            for (const id of track) {
                const box = byId(id)?.getBoundingClientRect();
                if (box && (box.width || box.height)) rects[id] = { top: box.top + scrollY, left: box.left + scrollX, width: box.width, height: box.height };
            }
            send({ type: 'layout', height: document.documentElement.scrollHeight, rects });
        }, 30);
    };

    // HTML a rule shows (how: 'html') goes in without anything that could run, load or navigate; a
    // form's fields stay, without the form. Inside a part, its ids get the part's id in front and
    // its styles reach only inside the part, as when the part was made; elsewhere, only inside the
    // element.
    const fragment = (html, target) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const css = [...doc.querySelectorAll('style')].map(style => style.textContent).join('\n');
        doc.querySelectorAll('script, style, meta, base, link, iframe, frame, frameset, object, embed, title, noscript, template').forEach(node => node.remove());
        doc.querySelectorAll('form').forEach(form => form.replaceWith(...form.childNodes));
        const part = target.closest('[data-part]')?.dataset.part;
        const own = new Set([...doc.body.querySelectorAll('[id]')].map(element => element.id));
        for (const element of doc.body.querySelectorAll('*')) {
            for (const { name, value } of [...element.attributes]) {
                if (/^on/i.test(name) || (/^(href|src|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(value))) element.removeAttribute(name);
            }
            if (!part) continue;
            if (element.id) element.id = `${part}.${element.id}`;
            for (const name of ['for', 'list']) if (element.getAttribute(name)) element.setAttribute(name, `${part}.${element.getAttribute(name)}`);
            for (const name of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
                const ids = element.getAttribute(name);
                if (ids) element.setAttribute(name, ids.split(/\s+/).filter(Boolean).map(id => `${part}.${id}`).join(' '));
            }
            const href = element.getAttribute('href');
            if (href?.startsWith('#') && href.length > 1) element.setAttribute('href', `#${part}.${href.slice(1)}`);
        }
        const nodes = [...doc.body.childNodes];
        if (css.trim()) {
            const style = document.createElement('style');
            const root = part ? `[data-part="${part}"]` : `[id="${target.id.replace(/["\\]/g, '\\$&')}"]`;
            const named = part ? css.replace(/#([A-Za-z_][\w-]*)/g, (match, id) => (own.has(id) ? `#${CSS.escape(`${part}.${id}`)}` : match)) : css;
            style.textContent = `@scope (${root}) {\n${named.replace(/(^|[\s,{}>+~])(?:html|body|:root)(?=[\s,{.:#[>+~]|$)/g, '$1:scope')}\n}`;
            nodes.unshift(style);
        }
        return nodes;
    };
    const show = ({ element: id, value, how, failed, role }) => {
        const element = byId(id);
        if (!element) return;
        if (isField(element)) {
            element.value = how === 'append' && element.value ? `${element.value}\n${value}` : value;
        } else if (how === 'html') {
            element.replaceChildren(...fragment(value, element));
        } else if (how === 'append') {
            const entry = document.createElement('div');
            entry.className = 'entry';
            if (role) entry.dataset.role = role;
            entry.textContent = value;
            element.append(entry);
            element.scrollTop = element.scrollHeight;
        } else {
            element.textContent = value;
        }
        if (failed) element.dataset.state = 'error';
        else delete element.dataset.state;
        layout();
    };
    const busy = (ids, on) => {
        for (const element of ids.map(byId).filter(Boolean)) {
            if (on) element.setAttribute('aria-busy', 'true');
            else element.removeAttribute('aria-busy');
            if (!(element instanceof HTMLButtonElement)) continue;
            if (on && !element.disabled) {
                element.disabled = true;
                element.dataset.appBusy = '';
            } else if (!on && 'appBusy' in element.dataset) {
                element.disabled = false;
                delete element.dataset.appBusy;
            }
        }
    };
    let highlighted = [];
    const highlight = ids => {
        highlighted.forEach(element => element.removeAttribute('data-app-highlight'));
        highlighted = (ids || []).map(byId).filter(Boolean);
        highlighted.forEach(element => element.setAttribute('data-app-highlight', ''));
        highlighted[0]?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('message', event => {
        if (event.source !== parent || event.data?.token !== token) return;
        const message = event.data;
        if (message.type === 'config') {
            ({ watch, read, track = [] } = message.config);
            layout();
        } else if (message.type === 'show') show(message);
        else if (message.type === 'busy') busy(message.elements || [], message.busy);
        else if (message.type === 'highlight') highlight(message.elements);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') send({ type: 'escape' });
    }, true);
    new ResizeObserver(layout).observe(document.documentElement);
    send({ type: 'ready', values: values() });
    layout();
}

const FRAME_CSS = '[data-app-highlight] { outline: 2px dashed #2468fa !important; outline-offset: 3px; }';

const randomToken = () => crypto.randomUUID().replaceAll('-', '');

// JSON that can sit inside a <script> element.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// The frame's document: the screen's HTML without its scripts, under a policy that lets nothing
// load from the network and only the runtime run.
export function frameDocument(html, { config, token }) {
    const nonce = randomToken();
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('script, base, meta[http-equiv]').forEach(node => node.remove());
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'`;
    doc.head.prepend(policy);
    const style = doc.createElement('style');
    style.textContent = FRAME_CSS;
    doc.head.append(style);
    const script = doc.createElement('script');
    script.setAttribute('nonce', nonce);
    script.textContent = `(${frameRuntime.toString()})(${scriptJson({ config, token, roles: CONVERSATION_ROLES })});`;
    doc.body.append(script);
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

const PAST = { click: 'was clicked', enter: 'got Enter', change: 'changed' };

const shortText = (text, max = 80) => {
    const line = String(text).replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Runs one app in one frame. `getApp` returns the app as it is now, so edits to the flow apply to
// the next event. It tells its owner what happens: `onTrace` each step in words, `onLayout` where
// the screen's elements are, `onActivity` a rule starting its call ({ ruleId, phase: 'call',
// trigger }) and finishing it ({ ruleId, phase: 'ok' | 'error', routes }), `onAnswer` each
// rule's answer, for picking values from it, and `onEscape` Escape pressed on the screen.
export class AppRunner {
    constructor({ shell, workbench, getApp, onTrace = () => {}, onLayout = () => {}, onActivity = () => {}, onAnswer = () => {}, onEscape = () => {}, signal }) {
        Object.assign(this, { shell, workbench, getApp, onTrace, onLayout, onActivity, onAnswer, onEscape });
        this.frame = null;
        this.token = null;
        this.running = new Set();
        // When each rule's answers last called tools: Map<ruleId, [time]>.
        this.replyCalls = new Map();
        window.addEventListener('message', event => this.received(event), { signal });
    }

    // Lets go of the frame: its messages and the runs still out are ignored from now on.
    stop() {
        this.frame = null;
        this.token = null;
        this.ready = false;
    }

    // Shows the app's screen; with `start`, its "when the app opens" rules run once it's ready.
    load(frame, { start = false } = {}) {
        const app = this.getApp();
        if (this.frame !== frame) {
            frame.addEventListener('load', () => {
                if (this.frame !== frame) return;
                this.loads++;
                if (this.loads > 1 && !this.navigated) {
                    this.navigated = true;
                    this.trace({ kind: 'error', text: 'The screen went to another page, so the app stopped. Choose Restart to run it again.' });
                }
            });
        }
        this.frame = frame;
        this.token = randomToken();
        this.loads = 0;
        this.ready = false;
        this.navigated = false;
        this.starting = start;
        this.elementIds = elementsOf(app.screen).map(element => element.id);
        frame.srcdoc = frameDocument(screenHtml(app), { config: frameConfig(app.flow, this.elementIds), token: this.token });
    }

    // The flow changed: the frame watches for what its rules wait for now.
    flowChanged() {
        const app = this.getApp();
        if (app && this.ready && this.elementIds) this.post({ type: 'config', config: frameConfig(app.flow, this.elementIds) });
    }

    highlight(elements) {
        this.post({ type: 'highlight', elements });
    }

    post(message) {
        if (!this.ready || this.navigated || !this.frame?.contentWindow) return;
        this.frame.contentWindow.postMessage({ ...message, token: this.token }, '*');
    }

    received(event) {
        if (!this.frame || event.source !== this.frame.contentWindow || event.data?.token !== this.token || this.navigated) return;
        const message = event.data;
        if (message.type === 'ready') {
            this.ready = true;
            // The flow may have changed while the frame loaded.
            this.flowChanged();
            if (this.starting) {
                this.starting = false;
                this.fire('', 'open', message.values || {});
            }
        } else if (message.type === 'event' && typeof message.element === 'string' && PAST[message.event]) {
            this.fire(message.element, message.event, message.values || {});
        } else if (message.type === 'layout' && Number.isFinite(message.height)) {
            this.onLayout({ height: message.height, rects: message.rects && typeof message.rects === 'object' ? message.rects : {} });
        } else if (message.type === 'open' && typeof message.url === 'string') {
            this.open(message.url);
        } else if (message.type === 'escape') {
            this.onEscape();
        }
    }

    // A link on the screen, in a tab of its own: only web addresses, and without this page as its opener.
    open(url) {
        let address;
        try {
            address = new URL(url);
        } catch {
            return;
        }
        if (address.protocol !== 'https:' && address.protocol !== 'http:') return;
        window.open(address.href, '_blank', 'noopener,noreferrer');
        this.trace({ kind: 'note', text: `Opened ${address.href}` });
    }

    trace(entry) {
        this.onTrace({ time: Date.now(), group: this.group, ...entry });
    }

    // Runs the rules that wait for this, top to bottom. Each sees the screen's values as the event
    // found them, plus what the rules before it put there.
    async fire(element, event, values) {
        const app = this.getApp();
        const rules = rulesFor(app?.flow, element, event);
        if (!rules.length) return;
        this.group = crypto.randomUUID();
        this.trace({ kind: 'event', text: event === 'open' ? 'The app opened' : `${element} ${PAST[event]}` });
        const screen = { ...values };
        for (const rule of rules) await this.run(rule, screen, triggerIndex(rule, element, event));
    }

    async run(rule, screen, trigger) {
        if (this.running.has(rule.id)) {
            this.trace({ kind: 'note', text: 'That rule is still waiting for its last call, so it was skipped this time.' });
            return;
        }
        const { serverUrl, toolName } = rule.call || {};
        const server = this.shell.servers[serverUrl];
        const fail = text => {
            this.trace({ kind: 'error', text });
            const answer = answerOf({ error: text });
            this.onActivity({ ruleId: rule.id, phase: 'error', trigger, routes: this.route(rule, answer, screen) });
        };
        if (!serverUrl || !toolName) return fail('This rule has no tool to call yet. Choose a server and a tool.');
        if (!server) return fail(`${serverUrl} isn't in your servers. Add it with + beside Servers in the Workbench.`);
        const tool = (server.tools || []).find(candidate => candidate.name === toolName) || { name: toolName };
        let prepared;
        try {
            prepared = callArguments(rule.call, {
                screen,
                variables: this.workbench.variables,
                environmentName: this.workbench.environment?.name || 'this environment',
                schema: schemaOf(tool),
            });
        } catch (error) {
            return fail(`Didn't call ${toolName}: ${error.message}`);
        }
        const where = serverLabel(server, serverUrl);
        // The prompt field also gets the rule's instructions, the tools its model may call, and
        // what the boxes it fills need.
        const app = this.getApp();
        const added = [];
        if (rule.prompt) {
            const asks = asksOf(rule, elementsOf(app?.screen));
            const instructions = String(rule.instructions ?? '').trim();
            const servers = rule.tools ? Object.fromEntries(Object.entries(this.shell.servers).filter(([, candidate]) => candidate.tools?.length)) : null;
            if (instructions) added.push('its instructions');
            if (servers) added.push(`the tools of ${Object.keys(servers).length === 1 ? 'your server' : `your ${Object.keys(servers).length} servers`}`);
            if (asks.length) added.push(`a request for ${listed(asks.map(ask => `${ask.key} (${BOX_KINDS[ask.kind].noun})`))}`);
            if (added.length) {
                prepared.sentArgs[rule.prompt] = composePrompt(prepared.sentArgs[rule.prompt], {
                    instructions, servers, request: asks.length ? formatRequest(asks, { size: app?.screen?.size }) : '',
                });
            }
        }
        this.trace({ kind: 'call', text: `Calling ${toolName} on ${where} with ${shortText(JSON.stringify(prepared.sentArgs), 120)}` });
        if (added.length) this.trace({ kind: 'note', text: `Added to ${rule.prompt} ${listed(added)}.` });
        // What goes on the screen as it's sent, with the values the call was made with: a chat's
        // message into its conversation, say.
        const sentRoutes = this.route(rule, { ok: true, values: {} }, screen, 'sent');
        this.onActivity({ ruleId: rule.id, phase: 'call', trigger, routes: sentRoutes });
        const triggerElement = triggersOf(rule)[trigger]?.element || '';
        const busy = [...new Set([triggerElement, ...(rule.then || []).map(route => route.into)].filter(Boolean))];
        this.post({ type: 'busy', elements: busy, busy: true });
        // Until the tool calls in its answer have run too, so the next message gets their results.
        this.running.add(rule.id);
        try {
            const message = await this.shell.runTool({
                url: serverUrl, tool, args: rule.call.args || {}, sentArgs: prepared.sentArgs, show: false, source: 'app',
                environmentName: prepared.variablesUsed.length ? this.workbench.environment?.name || null : null,
            });
            const answer = answerOf(message);
            const took = typeof message?.run?.durationMs === 'number' ? ` in ${Math.round(message.run.durationMs)} ms` : '';
            this.trace(answer.ok
                ? { kind: 'ok', text: `${toolName} answered${took}: ${shortText(answer.values.text || JSON.stringify(answer.values.result))}`, runId: message.run?.id }
                : { kind: 'error', text: `${toolName} failed${took}: ${shortText(answer.values.error, 160)}`, runId: message.run?.id });
            this.onAnswer(rule.id, answer);
            this.onActivity({ ruleId: rule.id, phase: answer.ok ? 'ok' : 'error', trigger, routes: this.route(rule, answer, screen), durationMs: message?.run?.durationMs });
            if (answer.ok && rule.tools) await this.runToolCalls(rule, answer, screen);
        } finally {
            this.running.delete(rule.id);
            this.post({ type: 'busy', elements: busy, busy: false });
        }
    }

    // The tool calls in a model's answer, run one after another as runs from a reply. Their results
    // join the conversations the answer went to, which the model gets with the next message.
    async runToolCalls(rule, answer, screen) {
        const calls = toolCallsIn(answer.values.text);
        if (!calls.length) return;
        const elements = new Map(elementsOf(this.getApp()?.screen).map(element => [element.id, element]));
        const conversations = [...new Set((rule.then || []).filter(route => routeWhen(route) === 'ok' && isConversation(elements.get(route.into))).map(route => route.into))];
        const add = (text, role) => conversations.forEach(id => {
            this.post({ type: 'show', element: id, value: text, how: 'append', role });
            screen[id] = [...(Array.isArray(screen[id]) ? screen[id] : []), `${CONVERSATION_ROLES[role]}: ${text}`];
        });
        for (const call of calls) {
            const limit = allowedCall(this.replyCalls.get(rule.id));
            this.replyCalls.set(rule.id, limit.times);
            if (!limit.allowed) {
                const skipped = `Skipped ${call.method}: an answer's tool calls run at most 3 in 10 seconds.`;
                this.trace({ kind: 'note', text: skipped });
                add(skipped, 'error');
                continue;
            }
            const found = serverWithTool(this.shell.servers, call.method);
            if (!found) {
                this.trace({ kind: 'error', text: `The answer asks for ${call.method}, which none of your servers has.` });
                add(`${call.method} isn't one of your servers' tools.`, 'error');
                continue;
            }
            const params = call.params && typeof call.params === 'object' && !Array.isArray(call.params) ? call.params : {};
            const { server, tool } = found;
            this.trace({ kind: 'call', text: `The answer asks for ${tool.name}: calling it on ${serverLabel(server, server.url)} with ${shortText(JSON.stringify(params), 120)}` });
            const message = await this.shell.runTool({ url: server.url, tool, args: params, sentArgs: params, show: false, source: 'reply' });
            const result = answerOf(message);
            const took = typeof message?.run?.durationMs === 'number' ? ` in ${Math.round(message.run.durationMs)} ms` : '';
            this.trace(result.ok
                ? { kind: 'ok', text: `${tool.name} answered${took}: ${shortText(result.values.text || JSON.stringify(result.values.result))}`, runId: message.run?.id }
                : { kind: 'error', text: `${tool.name} failed${took}: ${shortText(result.values.error, 160)}`, runId: message.run?.id });
            add(`${tool.name}: ${result.ok ? result.values.text : result.values.error}`, result.ok ? 'tool' : 'error');
        }
    }

    // Puts the answer where the rule's routes for this outcome (`phase`: sent, ok or error) say,
    // and returns their indexes. Routes as it's sent have only the screen's values.
    route(rule, answer, screen, phase = answer.ok ? 'ok' : 'error') {
        const taken = (rule.then || []).map((route, index) => [route, index]).filter(([route]) => routeWhen(route) === phase);
        if (!taken.length) {
            if (phase !== 'sent') this.trace({ kind: 'note', text: `This rule doesn't say what to do when it ${answer.ok ? 'works' : 'fails'}.` });
            return [];
        }
        const elements = new Map(elementsOf(this.getApp()?.screen).map(element => [element.id, element]));
        let notJson = false;
        for (const [route] of taken) {
            if (!this.elementIds.includes(route.into)) {
                this.trace({ kind: 'error', text: `${route.into || 'Where the answer goes'} isn't on the screen.` });
                continue;
            }
            const values = { ...screen, ...answer.values };
            if (answer.ok && answer.values.json === null && /^\s*\{\{\s*json\./.test(String(route.show ?? ''))) {
                this.post({ type: 'show', element: route.into, value: "The answer wasn't JSON, so it has nothing for this.", how: 'replace', failed: true });
                if (!notJson) this.trace({ kind: 'error', text: `The answer wasn't JSON, so ${route.into} and the others that take a piece of it got nothing.` });
                notJson = true;
                continue;
            }
            const box = elements.get(route.into);
            // A conversation keeps each piece as an entry from whoever it's from; nothing clears it.
            if (isConversation(box)) {
                const { text, missing } = renderTemplate(route.show, values);
                const role = ROUTE_ROLES[phase];
                this.post(text ? { type: 'show', element: route.into, value: text, how: 'append', role } : { type: 'show', element: route.into, value: '', how: 'replace' });
                screen[route.into] = text ? [...(Array.isArray(screen[route.into]) ? screen[route.into] : []), `${CONVERSATION_ROLES[role]}: ${text}`] : [];
                const empty = missing.length ? ` ({{${missing[0]}}} had no value)` : '';
                this.trace({ kind: 'route', text: text ? `Added “${shortText(text)}” to ${route.into}${empty}` : `Cleared ${route.into}${empty}` });
                continue;
            }
            if (answer.ok && isBox(box) && route.how !== 'append') {
                const value = templateValue(route.show, values);
                const { html, problem } = renderBox(box.show, value);
                this.post({ type: 'show', element: route.into, value: html, how: 'html', failed: !!problem });
                screen[route.into] = displayValue(value);
                this.trace(problem ? { kind: 'error', text: `${route.into}: ${problem}` }
                    : value === null || value === undefined ? { kind: 'note', text: `The answer has nothing for ${route.into}.` }
                    : { kind: 'route', text: box.show === 'text' ? `Put “${shortText(displayValue(value))}” into ${route.into}` : `Put ${box.show === 'html' ? 'HTML' : `a ${BOX_KINDS[box.show].noun}`} into ${route.into}` });
                continue;
            }
            const { text, missing } = renderTemplate(route.show, values);
            this.post({ type: 'show', element: route.into, value: text, how: route.how || 'replace', failed: !answer.ok });
            screen[route.into] = route.how === 'append' && screen[route.into] ? `${screen[route.into]}\n${text}` : text;
            const empty = missing.length ? ` ({{${missing[0]}}} had no value)` : '';
            this.trace({ kind: 'route', text: text ? `Put “${shortText(text)}” into ${route.into}${empty}` : `Cleared ${route.into}${empty}` });
        }
        return taken.map(([, index]) => index);
    }
}
