// The apps you build, and the state the Apps page's components share: which app is shown, edits to
// it (saved as you go), the model the builder asks, the examples to start from, downloads and
// imports, and an app the page runs on its own (launched). Components reach each other only
// through here, AppShell and the Workbench state, as the Workbench's do.
//
// Events, with what their detail holds:
//   list       apps were added, renamed or deleted               { removed }
//   shown      the page shows another app, or none (id null)    { id }
//   model      the model the builder asks changed
//   app        the shown app changed
//              { part: 'screen' | 'flow' | 'layout' | 'name' | 'version', by }
//   view       the builder switched between Canvas and Outline,  { view }
//              or to Preview (view 'preview') and back
//   select     what's selected on the canvas changed            { selection }
//   answer     a rule got an answer, for picking values from it { ruleId }
//   restart    run the shown app again from the start           { note }
//   highlight  point these elements out on the screen           { elements }
//   runOnOpen  whether an app runs what Start calls as it opens  { id, choice }
//              changed
//   offer      ask whether to add a copy of an example           { example }

import { DEMO_SERVERS, demoServerAt } from '../demo-servers/index.js';
import { download, escapeHtml, schemaOf, serverLabel } from '../workbench/util.js';
import { conversationFieldOf } from './agent.js';
import { askPrompt, modelArgs, modelCall } from './ask.js';
import { BOX_KINDS, isBox, isConversation, promptFieldOf } from './boxes.js';
import { fromDml, partFile, SCREEN_FILE, serversOf, toDml } from './dml.js';
import { answerOf, callArguments, describeRule, listed, newRule, normalizeRule, renameInFlow, toolResult, trigger, triggersOf } from './flow.js';
import { disconnect, wiresOf } from './graph.js';
import { clientRoot, runLink, unpackApp } from './link.js';
import { componentsHtml, elementsOf, htmlFromResult, movedComponents, newComponent, sanitizePart, screenHtml, withNewScreen, withoutComponent } from './screen.js';
import { withCallsTo } from './servers.js';
import * as store from './store.js';
import { unzip, zip } from './zip.js';

const SHOWN_KEY = 'appsShown';
const VIEW_KEY = 'appsView';
const MODEL_KEY = 'appsModel';
// Whether each app runs what Start calls when it opens: { [app id]: 'yes' | 'no' }.
const RUN_ON_OPEN_KEY = 'appsRunOnOpen';
// index.html's: whether the page opens on the Workbench or Apps.
const MODE_KEY = 'mode';
export const VIEWS = { canvas: 'Canvas', outline: 'Outline' };
// The app as it is when it's launched: the window is its screen, and nothing of the builder shows.
// A view like the two above, so their components stop while it runs, but never the one kept.
export const PREVIEW = 'preview';

// An app as the builder keeps it, whatever shape it was saved in.
export const normalizeApp = app => ({ ...app, flow: (app.flow || []).map(normalizeRule) });

// The rules that run as the app opens: what Start calls.
export const openRules = app => (app?.flow || []).filter(rule => triggersOf(rule).some(candidate => candidate.event === 'open'));

// What Start calls holds nothing of anyone's: each of its rules calls a demo server, and none lets
// its model call your servers' tools, which would send its tool calls to them.
export const startCallsOnlyDemos = app => openRules(app).every(rule => !!demoServerAt(rule.call?.serverUrl) && !rule.tools);

function readChoices() {
    try {
        const choices = JSON.parse(localStorage.getItem(RUN_ON_OPEN_KEY) || '{}');
        return choices && typeof choices === 'object' ? choices : {};
    } catch {
        return {};
    }
}

// The worker is up to take calls, as it isn't yet on a first visit; or a few seconds have gone by.
const workerReady = () => Promise.race([navigator.serviceWorker?.ready ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 5000))]);
// The client's public site.
export const APP_URL = 'https://patrick-glean.github.io/mcp-browswer-client/';
// Where the client is served for others to reach, when it isn't this page's own address.
const CLIENT_ADDRESS_KEY = 'appsClientAddress';

// A client address as typed: the folder of its index.html, at http or https (http when it's on
// this computer and says neither). '' for none.
export function normalizeClientAddress(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    let url;
    try {
        url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `${isLocalAddress(`http://${text}`) ? 'http' : 'https'}://${text}`);
    } catch {
        throw new Error(`${text} isn't a web address`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the client runs at an http or https address');
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/index\.html?$/, '');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
}

// An address only this computer reaches.
export function isLocalAddress(address) {
    try {
        const { protocol, hostname } = new URL(address);
        return protocol === 'file:' || hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '[::1]' || hostname === '0.0.0.0';
    } catch {
        return false;
    }
}

// The HTML that runs an app inside a page: an iframe of the client in its embed mode, with the app
// in its address (`link`, Apps.linkTo with embed).
export function embedCode(link, { name = 'App', height = 640 } = {}) {
    return `<iframe src="${escapeHtml(link)}" title="${escapeHtml(name)}" width="100%" height="${height}" style="border: 0"></iframe>`;
}

// embed.html: a page that is the app, the iframe filling its window. Opened from a disk too, it
// runs the app in the client at `link`'s address.
export function embedPage(link, { name = 'App' } = {}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>html, body { height: 100%; margin: 0; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body>
<iframe src="${escapeHtml(link)}" title="${escapeHtml(name)}"></iframe>
</body>
</html>
`;
}

export const slug = name => String(name || 'app').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'app';

// A tool's first text field, preferring a required one: where the starter app's text box goes.
function textField(tool) {
    const schema = schemaOf(tool) || {};
    const fields = Object.entries(schema.properties || {}).filter(([, prop]) => prop?.type === 'string' && !prop.enum);
    const required = new Set(schema.required || []);
    return (fields.find(([key]) => required.has(key)) || fields[0] || [])[0] || null;
}

const newApp = ({ name, screen, flow }) => {
    const now = Date.now();
    return { id: crypto.randomUUID(), name, description: '', version: 0, createdAt: now, updatedAt: now, downloadedAt: null, screen, flow };
};

// What New app starts from: a title, a text box, a button and an output, with one rule that sends
// the text box to the first tool that takes text, on the selected server if it has one.
export function starterApp({ shell, workbench, name }) {
    const servers = [shell.servers[shell.selectedServerUrl], ...Object.values(shell.servers)].filter(Boolean);
    let call = { serverUrl: servers[0]?.url || '', toolName: '', args: {} };
    let help = '';
    for (const server of servers) {
        const tool = (server.tools || []).find(textField);
        if (!tool) continue;
        const field = textField(tool);
        const others = workbench?.testDataFor(schemaOf(tool)).args || {};
        call = { serverUrl: server.url, toolName: tool.name, args: { ...others, [field]: '{{input}}' } };
        help = schemaOf(tool)?.properties?.[field]?.description || '';
        break;
    }
    const components = [
        newComponent('title', [], { id: 'title', text: name }),
        newComponent('textbox', [], { id: 'input', label: 'Input', placeholder: help.length <= 80 ? help : 'Type something' }),
        newComponent('button', [], { id: 'run', label: 'Run' }),
        newComponent('output', [], { id: 'output', label: 'Output' }),
    ];
    return newApp({ name, screen: { kind: 'components', components }, flow: [newRule({ element: 'run', event: 'click', ...call, into: 'output' })] });
}

const isGlean = server => {
    try {
        return /(^|\.)glean\.com$/i.test(new URL(server.url).hostname);
    } catch {
        return false;
    }
};

// A tool as the model the builder asks: { serverUrl, toolName, messageField, conversationField },
// where the message field gets the prompt and the conversation field, if it has one, the
// conversation so far.
export function modelOf(server, tool) {
    const schema = schemaOf(tool);
    return { serverUrl: server.url, toolName: tool.name, messageField: promptFieldOf(schema), conversationField: conversationFieldOf(schema) };
}

// The model, unless you choose another: Glean's chat if you've added Glean, else a server's chat
// tool, else the demo model's, a stand-in. Null when no server has one.
export function foundModel(servers) {
    const list = Object.values(servers || {});
    const chatOf = server => (server.tools || []).find(tool => tool.name === 'chat');
    const real = list.filter(server => !demoServerAt(server.url));
    const server = real.find(candidate => isGlean(candidate) && chatOf(candidate)) || real.find(chatOf) || list.find(chatOf);
    return server ? modelOf(server, chatOf(server)) : null;
}

// The built-in demo model, as a model the examples call when there's no other.
export const demoModel = () => modelOf(DEMO_SERVERS.model, DEMO_SERVERS.model.tools[0]);

// A server's tool, from the tools it listed, or for a demo server the ones it lists once connected.
const toolOn = (shell, url, name) => [...(shell.servers[url]?.tools || []), ...(demoServerAt(url)?.tools || [])].find(tool => tool.name === name) || null;

// What an example's rule calls: the model, with `prompt` in its message field (see modelArgs).
// Without a model, the rule is left for you to choose a tool.
function modelRuleCall({ shell, workbench, model, ...asked }) {
    const tool = model && toolOn(shell, model.serverUrl, model.toolName);
    if (!tool || !model.messageField) return { call: { serverUrl: model?.serverUrl || Object.values(shell.servers)[0]?.url || '', toolName: model?.toolName || '', args: {} }, prompt: null };
    const schema = schemaOf(tool);
    const args = modelArgs(model, { ...asked, schema, base: workbench?.testDataFor(schema).args || {} });
    return { call: { serverUrl: model.serverUrl, toolName: model.toolName, args }, prompt: model.messageField };
}

// How an example names its model: Glean, the demo model, or the tool and its server.
export function modelName(model, servers = {}) {
    if (model?.serverUrl === DEMO_SERVERS.model.url && model.toolName === 'chat') return 'the demo model';
    const server = servers[model?.serverUrl];
    if (!model?.toolName || !server) return 'a model';
    return isGlean(server) && model.toolName === 'chat' ? 'Glean' : `${model.toolName} on ${serverLabel(server)}`;
}

const CHAT_INSTRUCTIONS = "You're the assistant in a chat app built with MCP Browser Client: answer briefly and plainly. Earlier messages come with this one, each starting with who it's from: User, Assistant, or Tool for a tool's result.";

// The Chat example: a conversation with the model, which can call your servers' tools. Its one
// rule sends the message with the conversation so far. As it's sent, the message joins the
// conversation and its field is cleared; the answer, or why there's none, joins it after, and so
// do the results of the tool calls in the answer.
export function chatApp({ shell, workbench, model, name }) {
    const { call, prompt } = modelRuleCall({ shell, workbench, model, prompt: '{{message}}', conversation: '{{conversation}}' });
    const components = [
        newComponent('title', [], { id: 'title', text: name }),
        newComponent('text', [], { id: 'intro', text: `A conversation with ${modelName(model, shell.servers)}, which can call your servers' tools. Each message goes with the conversation so far.` }),
        newComponent('output', [], { id: 'conversation', label: 'Conversation', show: 'conversation', placeholder: 'Say something to start.' }),
        newComponent('textbox', [], { id: 'message', label: 'Message', placeholder: 'Ask something, or ask it to use one of your tools', width: 'two-thirds' }),
        newComponent('button', [], { id: 'send', label: 'Send', width: 'third' }),
    ];
    const rule = {
        ...newRule({ element: 'send', event: 'click', ...call, into: null, prompt }),
        when: [trigger('send', 'click'), trigger('message', 'enter')],
        then: [
            { if: 'sent', show: '{{message}}', into: 'conversation', how: 'append' },
            { if: 'sent', show: '', into: 'message', how: 'replace' },
            { if: 'ok', show: '{{text}}', into: 'conversation', how: 'append' },
            { if: 'error', show: '{{error}}', into: 'conversation', how: 'append' },
        ],
        instructions: CHAT_INSTRUCTIONS,
        tools: true,
    };
    return newApp({ name, screen: { kind: 'components', components }, flow: [rule] });
}

const PULSE_QUESTION = "What's the latest on {{project}}? Use what you find in our documents, messages and tickets.";
const PULSE_GOAL = "What's the latest on {{project}}?";

// The Project pulse example: what's happening with a project, from one question to the model whose
// boxes each ask for their piece of the answer. It fills when it opens, on Refresh and on Enter.
export function dashboardApp({ shell, workbench, model, name }) {
    const { call, prompt } = modelRuleCall({ shell, workbench, model, prompt: PULSE_QUESTION, goal: PULSE_GOAL });
    const box = (id, label, show, about, width) => newComponent('output', [], { id, label, show, about, width, placeholder: 'Filled in when the app opens.' });
    const components = [
        newComponent('title', [], { id: 'title', text: name }),
        newComponent('text', [], { id: 'intro', text: `What's happening with a project, from one question to ${modelName(model, shell.servers)}: each box below asks for its piece of the answer. Change the project and choose Refresh.` }),
        newComponent('textbox', [], { id: 'project', label: 'Project', value: 'MCP Browser Client', placeholder: 'A project, a team or a launch', width: 'two-thirds' }),
        newComponent('button', [], { id: 'refresh', label: 'Refresh', width: 'third' }),
        box('summary', 'Where it stands', 'text', 'Where the project stands, in at most 3 sentences', 'full'),
        box('health', 'Health', 'number', "The project's health: On track, At risk or Off track, with why in a few words", 'third'),
        box('activity', 'Activity', 'bar', 'Updates about the project per week, the last 6 weeks, oldest first, each labeled by the day its week starts', 'two-thirds'),
        box('risks', 'Risks', 'list', 'Open risks or blockers, at most 4, each with who raised it', 'half'),
        box('docs', 'Read next', 'list', 'The most useful documents, at most 5, each with a one-line note', 'half'),
    ];
    const boxes = ['summary', 'health', 'activity', 'risks', 'docs'];
    const rule = {
        ...newRule({ event: 'open', ...call, into: null, prompt }),
        when: [trigger('', 'open'), trigger('refresh', 'click'), trigger('project', 'enter')],
        then: [
            ...boxes.map(id => ({ if: 'ok', show: `{{json.${id}}}`, into: id, how: 'replace' })),
            { if: 'error', show: '{{error}}', into: 'summary', how: 'replace' },
        ],
    };
    return newApp({ name, screen: { kind: 'components', size: 'wide', components }, flow: [rule] });
}

const VISIT_SHOWN = '{{structured.visitor}}, {{structured.company}}\nHere to see {{structured.host}} at {{structured.time}}, in {{structured.room}}';

// The Front desk example: a visitor kiosk over four screens, with no model in it. Welcome asks who
// you are; find_visit looks for today's visit, and the app goes to Confirm with it, or to Not found
// with why. Confirm's Yes checks you in (check_in) and goes to Checked in; Not me goes to Welcome.
// Checked in's Done starts over for the next visitor; Not found goes back to try again, or calls
// the front desk. It calls its own demo server, built in, until you move it to yours.
export function frontDeskApp({ name }) {
    const call = (toolName, args) => ({ serverUrl: DEMO_SERVERS.frontdesk.url, toolName, args });
    const add = (type, props) => newComponent(type, [], props);
    const components = [
        add('title', { id: 'title', text: name }),
        add('screen', { id: 'welcome', label: 'Welcome' }),
        add('text', { id: 'intro', text: "Welcome! Tell us who you are, and we'll let your host know you're here." }),
        add('textbox', { id: 'visitor', label: 'Your name', placeholder: 'As it is on your invitation' }),
        add('textbox', { id: 'host', label: "Who you're here to see", placeholder: 'If you know' }),
        add('button', { id: 'find', label: 'Find my visit' }),
        add('screen', { id: 'confirm', label: 'Confirm' }),
        add('output', { id: 'visit', label: 'Is this you?', placeholder: 'The visit find_visit found shows here.' }),
        add('button', { id: 'yes', label: 'Yes, check me in', width: 'two-thirds' }),
        add('button', { id: 'notme', label: 'Not me', width: 'third', go: 'welcome' }),
        add('screen', { id: 'done', label: 'Checked in' }),
        add('output', { id: 'badge', label: "You're checked in", placeholder: 'Your badge, and who knows you are here, show here.' }),
        add('button', { id: 'next', label: 'Done', go: 'start' }),
        add('screen', { id: 'notfound', label: 'Not found' }),
        add('output', { id: 'missing', label: "We couldn't find your visit", placeholder: 'Why shows here.' }),
        add('button', { id: 'retry', label: 'Try again', width: 'half', go: 'back' }),
        add('button', { id: 'desk', label: 'Call the front desk', width: 'half' }),
    ];
    const find = {
        ...newRule({ ...call('find_visit', { visitor: '{{visitor}}', host: '{{host}}' }), into: null }),
        when: [trigger('find', 'click'), trigger('visitor', 'enter'), trigger('host', 'enter')],
        then: [
            { if: 'ok', show: VISIT_SHOWN, into: 'visit', how: 'replace' },
            { if: 'ok', show: '', into: 'confirm', how: 'replace' },
            { if: 'error', show: '{{error}}', into: 'missing', how: 'replace' },
            { if: 'error', show: '', into: 'notfound', how: 'replace' },
        ],
    };
    const checkIn = {
        ...newRule({ element: 'yes', event: 'click', ...call('check_in', { visitor: '{{visitor}}', host: '{{host}}' }), into: null }),
        then: [
            { if: 'ok', show: '{{text}}', into: 'badge', how: 'replace' },
            { if: 'ok', show: '', into: 'done', how: 'replace' },
            { if: 'error', show: '{{error}}', into: 'visit', how: 'replace' },
        ],
    };
    const desk = {
        ...newRule({ element: 'desk', event: 'click', ...call('call_front_desk', { visitor: '{{visitor}}', reason: "The kiosk couldn't find their visit" }), into: null }),
        then: [
            { if: 'ok', show: '{{text}}', into: 'missing', how: 'replace' },
            { if: 'error', show: '{{error}}', into: 'missing', how: 'replace' },
        ],
    };
    return newApp({ name, screen: { kind: 'components', components }, flow: [find, checkIn, desk] });
}

// What create() starts from: the examples, and a blank app. Each with the name its app gets, what
// it is in a few words (`kind`) and in a sentence (`about`), the demo servers it calls
// (`servers`), and whether it calls the model (`model`), the demo model when there's no other.
export const EXAMPLES = {
    chat: { name: 'Chat', make: chatApp, kind: 'agent loop', model: true, about: "A conversation with a model, which can call your servers' tools" },
    dashboard: { name: 'Project pulse', make: dashboardApp, kind: 'dashboard', model: true, about: 'A dashboard whose boxes each ask the model for their piece of one answer' },
    frontdesk: { name: 'Front desk', make: frontDeskApp, kind: 'screens', servers: ['frontdesk'], about: "A visitor kiosk over four screens: it finds today's visit, asks if it's you and checks you in, on a demo server of its own" },
    blank: { name: 'New app', make: starterApp, kind: 'blank', about: 'A text box, a button and an output, wired to a tool' },
};

// The file in a downloaded folder that its index.html runs: the app, as DML.
export const APP_FILE = 'app.dml';
// The list of the client's own files (scripts/client-files.mjs), which a download ships.
const CLIENT_FILES = 'client-files.json';

async function fetchText(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`there's no ${url.pathname.split('/').pop()} beside it (HTTP ${response.status})`);
    return response.text();
}

// The app a downloaded folder's index.html names (`file`, beside it), with the files its DML
// names beside it in turn: its screen and its parts. `get(url)` reads one.
export async function appInFolder(file, { base = location.href, get = fetchText } = {}) {
    const at = new URL(file, base);
    const dml = await get(at);
    const files = {};
    for (const [, src] of dml.matchAll(/\bsrc="([^"]+)"/g)) {
        if (Object.hasOwn(files, src) || !/^\w[\w./-]*$/.test(src) || src.includes('..')) continue;
        files[src] = await get(new URL(src, at));
    }
    return fromDml(dml, { files });
}

// A download's index.html: the client's own page (`html`), naming the app beside it, which it
// runs when the folder is served. Opened as a file the page can't run, and says how to serve the
// folder, with `link`, which runs this version in the client at `root`, where it came from.
export function appIndexHtml(html, app, { link, root }) {
    if (!html.includes('<head>')) throw new Error("the client's index.html has no <head>");
    const name = escapeHtml(app.name || 'App');
    const meta = `<meta name="mcp-app" content="${APP_FILE}" data-name="${name}" data-run="${escapeHtml(link)}" data-root="${escapeHtml(root)}">`;
    return html.replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`).replace('<head>', `<head>\n    ${meta}`);
}

// The README that travels in an app's zip: what's in it, the flow in words, and how to run it:
// served as it is, or from a file through the client at `root`.
export function readmeFor(app, { serverName = url => url, root = APP_URL } = {}) {
    const elements = new Map(elementsOf(app.screen).map(element => [element.id, element]));
    const elementName = id => {
        const label = elements.get(id)?.label;
        return label && label.toLowerCase() !== id.toLowerCase() ? `${label} (\`${id}\`)` : `\`${id}\``;
    };
    const servers = serversOf(app);
    const isScreen = id => elements.get(id)?.kind === 'screen';
    const rules = (app.flow || []).map((rule, index) => `${index + 1}. ${describeRule(rule, { elementName, serverName, isScreen })}`);
    const screens = [...elements.values()].filter(element => element.kind === 'screen');
    const own = screen => [...elements.values()].filter(element => element.screen === screen && element.kind !== 'screen' && !element.part);
    const goes = element => (element.go === 'back' ? 'goes back to the screen before' : element.go === 'start' ? 'starts the app over' : `goes to ${elementName(element.go)}`);
    const screenLines = screens.map((screen, index) => {
        const on = own(screen.id);
        const clicks = on.filter(element => element.go).map(element => `clicking ${elementName(element.id)} ${goes(element)}`).join('; ');
        return `${index + 1}. ${elementName(screen.id)}${index ? '' : ', where the app opens'}: ${on.length ? listed(on.map(element => elementName(element.id))) : 'nothing yet'}.${clicks ? ` ${clicks[0].toUpperCase()}${clicks.slice(1)}.` : ''}`;
    });
    const shared = own(null);
    const parts = (app.screen?.components || []).filter(component => component.type === 'part');
    const made = part => (part.ask ? `made by a model asked for "${part.ask}"` : part.from ? `made by a call to \`${part.from.toolName}\` on ${serverName(part.from.serverUrl)}` : 'written as HTML');
    const boxes = [...elements.values()].filter(isBox).map(box => `- \`${box.id}\`, ${box.show === 'html' ? 'HTML' : box.show === 'text' ? 'text' : `a ${BOX_KINDS[box.show].noun}`}: ${box.about || box.label}`);
    const conversations = [...elements.values()].filter(isConversation).map(element => element.id);
    const agent = [
        ...conversations.map(id => `\`${id}\` keeps each message, answer and tool result as an entry, with who it's from; in a call, \`{{${id}}}\` is the list of them.`),
        (app.flow || []).some(rule => rule.tools) && "A rule that lets its model call your servers' tools tells it which there are, and runs the JSON-RPC calls in its answers, at most three in 10 seconds. Their results join the conversation, which the model gets with the next message.",
    ].filter(Boolean);
    return `# ${app.name}

An app built in MCP Browser Client${app.version ? `, version ${app.version}` : ''}.${app.description ? `\n\n${app.description}` : ''}

## What's here

- \`index.html\`: the app, running, once the folder is served (see Run it). It's MCP Browser Client's page, and the rest of the folder is the client that runs the app: its service worker, which makes the app's calls, the MCP client libraries, and the Workbench and builder.
- \`${SCREEN_FILE}\`: the screen, what people see. ${app.screen?.kind === 'html' ? (app.screen.from ? `A call to \`${app.screen.from.toolName}\` on ${serverName(app.screen.from.serverUrl)} made it.` : 'It was written as HTML.') : 'It was built from components, which app.dml lists.'}
- \`app.dml\`: the screen's components and the flow, what happens when people use it, as markup.${parts.map(part => `\n- \`${partFile(part.id)}\`: the part \`${part.id}\`, ${made(part)}. On the screen its ids start with \`${part.id}.\`.`).join('')}

${screens.length ? `## The screens

It has ${screens.length} screens, one showing at a time${shared.length ? `; ${listed(shared.map(element => elementName(element.id)))}, above the first, ${shared.length === 1 ? 'shows' : 'show'} on every one` : ''}. A button that goes somewhere takes people there when it's clicked, and a rule that goes to a screen does when its tool answers. What's typed on one screen is still there on the next.

${screenLines.join('\n')}

` : ''}## The flow

${rules.length ? rules.join('\n') : 'No rules yet.'}

In a call, \`{{name}}\` is what the screen's element with that id holds when the rule runs (or a variable from the environment). In what a rule puts on the screen, \`{{text}}\` is the text the tool returned, \`{{structured.…}}\` its structured content, \`{{json.…}}\` its text read as JSON, and \`{{error}}\` why it failed.
${boxes.length ? `
## The boxes

A rule that fills these asks its tool, in its prompt, for one JSON object with a key for each, saying what goes in it and in what shape; each box draws its piece:

${boxes.join('\n')}
` : ''}${agent.length ? `
## The conversation

${agent.join(' ')}
` : ''}

## Run it

Serve this folder and open its address. In the folder, run one of

    npx serve
    python3 -m http.server 8000

and open the address it prints. Any static host serves it as it is, too: GitHub Pages, Netlify, an S3 bucket. The app runs in your browser, which calls its servers for it, with your sign-ins.

Opened as a file, from a double-click, it won't run: browsers start its service worker, which makes the app's calls and keeps sign-ins and runs, only at a web address. The page says so then, with a link that runs ${app.version ? `version ${app.version}` : 'this version'} in MCP Browser Client at ${root}, where it was downloaded from.

It runs \`app.dml\` as it is in the folder, so a change to it shows on the next reload. \`?builder\` after the folder's address opens the builder, to change the app there and download it again; or import this zip in MCP Browser Client (Apps, then Import).

Served from a new address, the client starts with none of your servers or sign-ins: the bar above the app offers to add the servers it calls, and to sign in. A server that takes calls only from some web addresses (CORS) has to allow the one it's served from. ${servers.length ? `It calls ${servers.length === 1 ? 'this server' : 'these servers'}:\n\n${servers.map(url => `- ${serverName(url) === url ? url : `${serverName(url)}: ${url}`}${demoServerAt(url) ? ', a demo server built into MCP Browser Client, which running or importing the app adds for you' : ''}`).join('\n')}` : "It doesn't call any servers yet."}
`;
}

export class Apps {
    // `showMode` switches the page between the Workbench and Apps.
    constructor(shell, workbench, { showMode = () => {} } = {}) {
        this.shell = shell;
        this.workbench = workbench;
        this.showMode = showMode;
        this.events = new EventTarget();
        this.list = [];
        this.shownId = null;
        this.app = null;
        this.saveTimer = null;
        this.elementsCache = null;
        this.view = VIEWS[localStorage.getItem(VIEW_KEY)] ? localStorage.getItem(VIEW_KEY) : 'canvas';
        // The view Preview goes back to.
        this.editView = this.view;
        this.selection = null;
        // Each rule's last answer, while the page is open: Map<ruleId, answer>.
        this.answers = new Map();
        // The shown app opened without running what Start calls (startsOnOpen), and it hasn't run since.
        this.startHeld = false;
        // The page runs one app on its own (launch): { fromLink, problem }, or null for the builder.
        this.launched = null;
    }

    on(type, listener, signal) {
        this.events.addEventListener(type, event => listener(event.detail), { signal });
    }

    emit(type, detail = {}) {
        this.events.dispatchEvent(new CustomEvent(type, { detail }));
    }

    status(text, options) {
        this.workbench.status(text, options);
    }

    // With `launch` ({ id } or { run }, from index.html's address), the page runs that one app
    // on its own (launch); otherwise it shows the app shown last.
    async load({ launch = null } = {}) {
        this.list = (await store.listApps()).map(normalizeApp).sort((a, b) => a.createdAt - b.createdAt);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush();
        });
        if (launch) return this.launch(launch);
        const shown = localStorage.getItem(SHOWN_KEY);
        this.show(this.list.some(app => app.id === shown) ? shown : this.list[0]?.id ?? null);
    }

    // --- Launched: one app on its own, as people use it ---

    // Runs one app with nothing of the builder, the window its screen as in Preview: one of yours
    // (`id`, index.html?app=<id>, which Launch opens), one a link carries (`run`, the #run= of a
    // link from Copy a link or an embed), or the one beside a downloaded folder's index.html
    // (`file`). `embed` (?embed) is an iframe's, in another page. A link's or a folder's app isn't
    // added to Your apps until you say so; a link's waits to run what Start calls as an app
    // opening does, unless that only calls demo servers, while yours and a folder's (which is
    // there to run it) run it at once, as Preview does. `launched` says which, or why there's
    // nothing to run.
    async launch({ id = null, run = null, file = null, embed = false }) {
        let app = null;
        let problem = '';
        if (run || file) {
            try {
                const { app: carried, servers } = run ? fromDml(await unpackApp(run)) : await appInFolder(file);
                const now = Date.now();
                app = {
                    ...normalizeApp(carried),
                    id: carried.id || crypto.randomUUID(),
                    createdAt: now,
                    updatedAt: now,
                    downloadedAt: now,
                    serverNames: Object.fromEntries(servers.filter(server => server.name).map(server => [server.url, server.name])),
                };
            } catch (error) {
                problem = `The app in this ${run ? 'link' : 'folder'} can't run: ${error.message.replace(/\.$/, '')}.`;
            }
        } else {
            app = this.list.find(candidate => candidate.id === id) || null;
            if (!app) problem = "This browser has no app with this link's id: it may have been deleted, or made in another browser. An app's own link, which runs it anywhere, is Copy a link that runs it, in its ⋯ menu in the builder.";
        }
        this.launched = { fromLink: !!run, fromFile: !!file, embedded: !!embed, problem };
        this.view = PREVIEW;
        this.app = app;
        this.shownId = app?.id ?? null;
        this.elementsCache = null;
        this.selection = null;
        this.answers.clear();
        this.startHeld = !!app && !!run && !this.startsOnOpen() && !startCallsOnlyDemos(app);
        if (app) {
            document.title = app.name || 'App';
            // The demo servers it calls are built in, so they're added for it, once the worker can connect them.
            await workerReady();
            for (const url of serversOf(app)) {
                const demo = demoServerAt(url);
                if (demo) this.addDemoServer(demo.id);
            }
        }
        this.emit('shown', { id: this.shownId });
    }

    isYours(app = this.app) {
        return !!app && this.list.some(candidate => candidate.id === app.id);
    }

    // The app a link carried, or a folder's, added to Your apps, as Import adds one. A folder's
    // replaces the one with its id, since the folder's app.dml is the one that runs here.
    async keepLaunched() {
        const app = this.app;
        const { fromLink, fromFile } = this.launched || {};
        if (!app || !(fromFile || (fromLink && !this.isYours(app)))) return;
        await store.saveApp(app);
        this.list = [...this.list.filter(candidate => candidate.id !== app.id), app];
        this.emit('list');
        this.status(`Added ${app.name} to Your apps. Open it in the builder to change it.`);
    }

    // The builder, in this tab, showing the launched app if it's one of yours. A folder's
    // index.html runs its app unless the address asks for the builder (?builder).
    async openInBuilder() {
        if (this.launched?.fromFile) await this.keepLaunched();
        if (this.isYours()) localStorage.setItem(SHOWN_KEY, this.app.id);
        localStorage.setItem(MODE_KEY, 'apps');
        location.assign(`${clientRoot(location.href)}${this.launched?.fromFile ? '?builder' : ''}`);
    }

    // Where one of your apps runs on its own: index.html?app=<id>, in this browser.
    launchUrl(id = this.shownId) {
        return `${clientRoot(location.href)}?app=${encodeURIComponent(id)}`;
    }

    // Launch: one of your apps on its own, in a tab of its own, as it is now.
    launchInTab(id = this.shownId) {
        if (!this.list.some(app => app.id === id)) return;
        if (id === this.shownId) this.flush();
        window.open(this.launchUrl(id), '_blank', 'noopener');
    }

    // A link that runs the app as it is now, in the client at its address (clientAddress): the app
    // travels in the link, so whoever opens it runs it in their browser, on their own servers. With
    // `embed`, the client runs it in its embed mode, for an iframe.
    linkTo(app = this.app, { embed = false } = {}) {
        return runLink(toDml(app, { standalone: true, serverNames: this.serverNamesOf(app) }), `${this.clientAddress()}${embed ? '?embed' : ''}`);
    }

    // --- Where the client is, for others: embeds, links and a folder's way back ---

    // The address embeds and links run apps at: the one set (setClientAddress), or this page's.
    clientAddress() {
        return localStorage.getItem(CLIENT_ADDRESS_KEY) || clientRoot(location.href);
    }

    // Sets it (normalizeClientAddress, which throws for one that isn't an address); this page's own
    // address, or none, sets it back to that.
    setClientAddress(value) {
        const address = normalizeClientAddress(value);
        if (!address || address === clientRoot(location.href)) localStorage.removeItem(CLIENT_ADDRESS_KEY);
        else localStorage.setItem(CLIENT_ADDRESS_KEY, address);
        this.emit('clientAddress', { address: this.clientAddress() });
        return this.clientAddress();
    }

    // Whether MCP Browser Client answers at an address: { ok: true }, { ok: false, why }, or
    // { ok: null, why } when this page can't tell (it can't reach it, or may not read it).
    async checkClientAddress(address = this.clientAddress()) {
        try {
            const response = await fetch(new URL('index.html', address), { cache: 'no-store' });
            if (!response.ok) return { ok: false, why: `it answers HTTP ${response.status} for index.html` };
            // A downloaded folder's page has its app's title, and is a client too.
            return (await response.text()).includes('MCP Browser Client') ? { ok: true } : { ok: false, why: "the page there isn't MCP Browser Client" };
        } catch {
            return { ok: null, why: "this page can't reach it, or isn't let read it" };
        }
    }

    // The Share dialog: embed, run on its own, a link, and the client's address.
    share() {
        if (this.app) this.emit('share');
    }

    async copyEmbed({ height } = {}) {
        const app = this.app;
        if (!app) return;
        await this.flush();
        try {
            await navigator.clipboard.writeText(embedCode(await this.linkTo(app, { embed: true }), { name: app.name, height }));
            this.status(`Copied the embed code for ${app.name}: an iframe that runs it in MCP Browser Client at ${this.clientAddress()}.`);
        } catch (error) {
            this.status(`Couldn't copy the embed code: ${error.message}`, { error: true });
        }
    }

    // embed.html: the app on a page of its own, which runs it when it's opened, from a disk too.
    async downloadEmbed() {
        const app = this.app;
        if (!app) return;
        await this.flush();
        download(`${slug(app.name)}-embed.html`, embedPage(await this.linkTo(app, { embed: true }), { name: app.name }), 'text/html');
        this.status(`Downloaded ${slug(app.name)}-embed.html: open it, or put its iframe in a page, and ${app.name} runs in MCP Browser Client at ${this.clientAddress()}.`);
    }

    async copyLink() {
        const app = this.app;
        if (!app) return;
        await this.flush();
        try {
            await navigator.clipboard.writeText(await this.linkTo(app));
            this.status(`Copied a link that runs ${app.name} as it is now. Whoever opens it runs it in their browser, on their own servers, and can add it to their apps.`);
        } catch (error) {
            this.status(`Couldn't copy the link: ${error.message}`, { error: true });
        }
    }

    // Shows an app, or with null none: the page then offers the examples. A preview is of the app it
    // was opened for, so another app opens in the view Preview came from.
    show(id) {
        this.flush();
        if (this.view === PREVIEW) this.view = this.editView;
        this.app = this.list.find(app => app.id === id) || null;
        this.shownId = this.app?.id ?? null;
        this.elementsCache = null;
        this.selection = null;
        this.answers.clear();
        this.startHeld = !!this.app && !this.startsOnOpen();
        if (this.shownId) localStorage.setItem(SHOWN_KEY, this.shownId);
        else localStorage.removeItem(SHOWN_KEY);
        this.emit('shown', { id: this.shownId });
    }

    // --- What Start calls, as the app opens ---

    // Whether opening an app runs what Start calls: 'yes', 'no', or null when nobody has said.
    runOnOpen(id = this.shownId) {
        const choice = readChoices()[id];
        return choice === 'yes' || choice === 'no' ? choice : null;
    }

    // Keeps the answer for an app (null forgets it, so it asks again).
    setRunOnOpen(choice, id = this.shownId) {
        if (!id) return;
        const choices = readChoices();
        if (choice === 'yes' || choice === 'no') choices[id] = choice;
        else delete choices[id];
        localStorage.setItem(RUN_ON_OPEN_KEY, JSON.stringify(choices));
        this.emit('runOnOpen', { id, choice: this.runOnOpen(id) });
    }

    // Opening an app runs what Start calls when it calls nothing as it opens, or someone said yes.
    // Otherwise it waits: asking, when nobody has said, or until Restart.
    startsOnOpen(app = this.app) {
        return !openRules(app).length || this.runOnOpen(app?.id) === 'yes';
    }

    // What the app calls as it opens, in words: "chat on Glean and search on Glean".
    openCallsText(app = this.app) {
        return listed(openRules(app).map(rule => `${rule.call?.toolName || 'a tool'} on ${this.serverName(rule.call?.serverUrl, app)}`));
    }

    // What What happened says when the app opened without running what Start calls.
    heldStartNote() {
        if (!this.startHeld) return '';
        return this.runOnOpen() === 'no'
            ? `What Start calls (${this.openCallsText()}) didn't run as the app opened, as you chose for this app. Restart runs it.`
            : `What Start calls (${this.openCallsText()}) hasn't run: say above whether to run it when you open this app.`;
    }

    // The answer to the question the app asks as it opens; yes runs what Start calls now, if it hasn't run.
    answerRunOnOpen(choice) {
        this.setRunOnOpen(choice);
        if (choice === 'yes' && this.startHeld) this.emit('restart', { note: `Ran what Start calls, as it will each time you open ${this.app?.name || 'the app'}.` });
    }

    // Start's calls ran: the app was restarted, or started over.
    ranStart() {
        this.startHeld = false;
    }

    showView(view) {
        if ((!VIEWS[view] && view !== PREVIEW) || view === this.view) return;
        this.view = view;
        if (VIEWS[view]) {
            this.editView = view;
            localStorage.setItem(VIEW_KEY, view);
        }
        this.emit('view', { view });
    }

    // Preview, from the start, as when the app is launched; and back to the view it came from.
    preview() {
        if (this.app) this.showView(PREVIEW);
    }

    // A launched app has no builder to go back to.
    exitPreview() {
        if (this.view === PREVIEW && !this.launched) this.showView(this.editView);
    }

    // What's selected on the canvas: { kind: 'element', id }, { kind: 'rule', id },
    // { kind: 'wire', id, ruleId }, { kind: 'start' }, or null for the app itself.
    select(selection) {
        this.selection = selection || null;
        this.emit('select', { selection: this.selection });
    }

    setAnswer(ruleId, answer) {
        this.answers.set(ruleId, answer);
        this.emit('answer', { ruleId });
    }

    // --- Edits: applied at once, saved after a pause ---

    change(mutate, { part, by = null } = {}) {
        if (!this.app) return;
        mutate(this.app);
        this.app.updatedAt = Date.now();
        if (part === 'screen') this.elementsCache = null;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 300);
        this.emit('app', { part, by });
        if (part === 'name') this.emit('list');
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        // An app a link carried is yours only once it's added (keepLaunched).
        if (!this.app || !this.list.includes(this.app)) return Promise.resolve();
        return store.saveApp(structuredClone(this.app)).catch(error => this.status(`Couldn't save ${this.app?.name}: ${error.message}`, { error: true }));
    }

    // The shown app's elements with ids: { id, kind, label }.
    elements() {
        if (!this.app) return [];
        if (!this.elementsCache) this.elementsCache = elementsOf(this.app.screen);
        return this.elementsCache;
    }

    elementName(id) {
        const element = this.elements().find(candidate => candidate.id === id);
        return element && element.label !== id ? `${element.label} (${id})` : id;
    }

    // --- The model, and HTML from a tool or from a model: for an HTML screen, and for parts ---

    // The model the builder asks for HTML, and the examples call: the one chosen under Model, while
    // its server is one of yours, else the one found (foundModel). With `chosen` saying which, or
    // null when there's none.
    model() {
        let chosen = null;
        try {
            chosen = JSON.parse(localStorage.getItem(MODEL_KEY));
        } catch {
            // Unreadable, so not chosen.
        }
        if (chosen?.serverUrl && chosen.toolName && this.shell.servers[chosen.serverUrl]) return { ...chosen, chosen: true };
        const found = foundModel(this.shell.servers);
        return found && { ...found, chosen: false };
    }

    // Chooses the model ({ serverUrl, toolName, messageField, conversationField }), or with null
    // goes back to the one found.
    setModel(model) {
        if (model) {
            const { serverUrl, toolName, messageField = null, conversationField = null } = model;
            localStorage.setItem(MODEL_KEY, JSON.stringify({ serverUrl, toolName, messageField, conversationField }));
        } else {
            localStorage.removeItem(MODEL_KEY);
        }
        this.emit('model');
    }

    modelTool(model = this.model()) {
        return (this.shell.servers[model?.serverUrl]?.tools || []).find(tool => tool.name === model?.toolName) || null;
    }

    // Calls a tool for HTML: { html, call } with the HTML its answer holds (kept as a part keeps it,
    // with `part`), or { error }. The call is a run from the app.
    async htmlFrom(call, { part = false } = {}) {
        const server = this.shell.servers[call?.serverUrl];
        if (!call?.toolName || !server) return { error: 'Choose a server and the tool that makes the HTML first.' };
        const tool = (server.tools || []).find(candidate => candidate.name === call.toolName) || { name: call.toolName };
        let sentArgs;
        try {
            ({ sentArgs } = callArguments(call, { variables: this.workbench.variables, environmentName: this.workbench.environment?.name, schema: schemaOf(tool) }));
        } catch (error) {
            return { error: error.message };
        }
        const message = await this.shell.runTool({ url: server.url, tool, args: call.args || {}, sentArgs, show: false, source: 'app' });
        const answer = answerOf(message);
        if (!answer.ok) return { error: `${tool.name} failed: ${answer.values.error}` };
        const html = htmlFromResult(toolResult(message.result));
        if (!html) return { error: `${tool.name} answered, but not with HTML: “${answer.values.text.slice(0, 80)}”` };
        return { html: part ? sanitizePart(html) : html, call };
    }

    // Asks the model to make it, or with `current` to change that: { html, call } or { error }.
    async htmlFromModel(ask, { part = false, current = '' } = {}) {
        if (!String(ask ?? '').trim()) return { error: 'Say what to make first.' };
        let call;
        try {
            const model = this.model();
            call = modelCall(model, askPrompt(ask, { part, current }), { schema: schemaOf(this.modelTool(model)), goal: String(ask).trim() });
        } catch (error) {
            return { error: error.message };
        }
        return this.htmlFrom(call, { part });
    }

    // A screen of components, or of HTML. HTML starts as what the components make, so there's
    // something to change.
    setScreenKind(kind) {
        if (!this.app || kind === this.app.screen.kind) return;
        this.change(app => {
            const screen = app.screen;
            screen.kind = kind;
            if (kind === 'html' && !screen.html?.trim()) screen.html = componentsHtml(screen.components, { title: app.name, size: screen.size });
            if (kind === 'html' && !screen.from) screen.from = { serverUrl: '', toolName: '', args: {} };
            screen.components ??= [];
        }, { part: 'screen' });
    }

    // A narrow screen is one column; a wide one has room for boxes side by side, as a dashboard.
    setScreenSize(size) {
        if (!this.app || (size !== 'narrow' && size !== 'wide') || (this.app.screen.size || 'narrow') === size) return;
        this.change(app => { app.screen.size = size; }, { part: 'screen' });
    }

    // Takes a wire's part out of its rule (graph.js). Returns the wire, or null when there's none.
    removeWire(id) {
        const wire = wiresOf(this.app?.flow || [], this.elements().map(element => element.id)).find(candidate => candidate.id === id);
        if (!wire) return null;
        const rule = this.app.flow.find(candidate => candidate.id === wire.ruleId);
        const tool = (this.shell.servers[rule.call?.serverUrl]?.tools || []).find(candidate => candidate.name === rule.call?.toolName);
        this.change(app => { app.flow = disconnect(app.flow, wire, { required: schemaOf(tool)?.required || [] }); }, { part: 'flow' });
        this.select({ kind: 'rule', id: wire.ruleId });
        return wire;
    }

    // Every call the app makes to one server goes to another instead, such as your own server in
    // place of a demo one (servers.js).
    callInstead(from, to) {
        if (!this.app || !from || !to || from === to) return;
        const was = this.serverName(from);
        this.change(app => { Object.assign(app, withCallsTo(app, from, to)); }, { part: 'flow' });
        this.status(`${this.app.name} calls ${this.serverName(to)} now, instead of ${was}.`);
    }

    // A component a place up (-1) or down (1); a screen moves with what's on it (screen.js).
    moveComponent(id, step, { by = null } = {}) {
        this.change(app => { app.screen.components = movedComponents(app.screen.components, id, step); }, { part: 'screen', by });
    }

    // Deletes a component; a screen goes with what's on it, and buttons that went to it go nowhere.
    removeComponent(id, { by = null } = {}) {
        this.change(app => { app.screen.components = withoutComponent(app.screen.components, id); }, { part: 'screen', by });
    }

    // Adds a screen after the others (screen.js withNewScreen) and returns it.
    addScreen({ by = null } = {}) {
        let added = null;
        this.change(app => {
            const next = withNewScreen(app.screen.components);
            app.screen.components = next.components;
            added = next.added;
        }, { part: 'screen', by });
        return added;
    }

    // Changes a component's id, taking the flow's references with it, and the buttons that go to it
    // when it's a screen.
    renameElement(from, to) {
        this.change(app => {
            for (const component of app.screen.components) {
                if (component.id === from) component.id = to;
                else if (component.go === from) component.go = to;
            }
            app.flow = renameInFlow(app.flow, from, to);
        }, { part: 'screen' });
        this.emit('app', { part: 'flow' });
    }

    // --- The list ---

    // Adds one of the demo servers built in (DEMO_SERVERS) to your servers, where you are, and
    // connects to it; one already there connects again if it isn't connected.
    addDemoServer(id) {
        const { url, name } = DEMO_SERVERS[id];
        const server = this.shell.servers[url];
        if (!server) this.shell.addServer(url, name, { show: false });
        else if (server.status !== 'connected' && server.status !== 'connecting') this.shell.connectMcpServer(url);
    }

    // The app an example makes (EXAMPLES), with a name no app of yours has, without adding it:
    // what create() adds, and what asking first (offerExample) says it will be. An example's app
    // says which it came from (`example`).
    exampleApp(example = 'blank') {
        const { name: base, make, model: callsModel = false } = EXAMPLES[example] || EXAMPLES.blank;
        const taken = new Set(this.list.map(app => app.name));
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
        const model = this.model() || (callsModel ? demoModel() : null);
        const app = make({ shell: this.shell, workbench: this.workbench, model, name });
        return EXAMPLES[example] && example !== 'blank' ? { ...app, example } : app;
    }

    // A new app from an example: `chat`, `dashboard`, `frontdesk`, or `blank` (a text box, a
    // button and an output). Chat and the dashboard call the model, the demo model when you have
    // none; Front desk calls its demo server. Both are added for it. `runOnOpen` answers, for an
    // app that calls tools as it opens, whether opening it runs them.
    async create(example = 'blank', { runOnOpen = null } = {}) {
        const { servers = [], model: callsModel = false } = EXAMPLES[example] || EXAMPLES.blank;
        const app = this.exampleApp(example);
        servers.forEach(id => this.addDemoServer(id));
        if (callsModel && !this.model()) this.addDemoServer('model');
        if (runOnOpen) this.setRunOnOpen(runOnOpen, app.id);
        await store.saveApp(app);
        this.list.push(app);
        this.emit('list');
        this.show(app.id);
        return app;
    }

    // An example becomes one of your apps once you've said so (AppsAddDialog asks), so looking
    // at one doesn't add another copy each time. New app makes a blank one at once.
    offerExample(example) {
        if (!EXAMPLES[example] || example === 'blank') return this.create(example);
        this.emit('offer', { example });
    }

    // Your apps made from an example, the newest first.
    copiesOf(example) {
        return this.list.filter(app => app.example === example).sort((a, b) => b.createdAt - a.createdAt);
    }

    // The servers an app calls, in words: "Front desk (demo), built in".
    callsText(app = this.app) {
        return listed(serversOf(app).map(url => (demoServerAt(url) && !this.shell.servers[url] ? `${demoServerAt(url).name}, built in` : this.serverName(url, app))));
    }

    // A copy of one of your apps (the shown one, unless you say which), which opens as the
    // original does.
    async duplicate(id = this.shownId) {
        const source = this.list.find(app => app.id === id);
        if (!source) return null;
        if (id === this.shownId) await this.flush();
        const now = Date.now();
        const copy = { ...structuredClone(source), id: crypto.randomUUID(), name: `${source.name} (copy)`, version: 0, createdAt: now, updatedAt: now, downloadedAt: null };
        if (this.runOnOpen(id)) this.setRunOnOpen(this.runOnOpen(id), copy.id);
        await store.saveApp(copy);
        this.list.push(copy);
        this.emit('list');
        this.show(copy.id);
        this.status(`Made a copy of ${source.name}.`);
        return copy;
    }

    // Deletes one of your apps (the shown one, unless you say which), and what this browser kept
    // for it. Deleting the shown one shows the next, or the examples when it was the last.
    async remove(id = this.shownId) {
        const app = this.list.find(candidate => candidate.id === id);
        if (!app) return;
        const shown = id === this.shownId;
        if (shown) {
            clearTimeout(this.saveTimer);
            this.app = null;
        }
        await store.deleteApp(id);
        this.list = this.list.filter(candidate => candidate.id !== id);
        this.setRunOnOpen(null, id);
        this.emit('list', { removed: id });
        if (shown) this.show(this.list[0]?.id ?? null);
        this.status(`Deleted ${app.name}.`);
    }

    // --- Download and import ---

    serverName(url, app = this.app) {
        const server = this.shell.servers[url];
        return server ? serverLabel(server, url) : app?.serverNames?.[url] || demoServerAt(url)?.name || url;
    }

    // The names of the servers an app calls, which its DML keeps for whoever adds them next.
    serverNamesOf(app = this.app) {
        return Object.fromEntries(serversOf(app).map(url => [url, this.serverName(url, app)]).filter(([url, name]) => name !== url));
    }

    // The client's own files, as this page is served them (client-files.json lists them), which a
    // download ships with the app: [{ name, data }].
    async clientFiles(root = clientRoot(location.href)) {
        const get = async name => {
            const response = await fetch(new URL(name, root), { cache: 'no-cache' });
            if (!response.ok) throw new Error(`couldn't fetch the client's ${name} (HTTP ${response.status})`);
            return new Uint8Array(await response.arrayBuffer());
        };
        const { files } = JSON.parse(new TextDecoder().decode(await get(CLIENT_FILES)));
        const fetched = [];
        for (let at = 0; at < files.length; at += 8) fetched.push(...await Promise.all(files.slice(at, at + 8).map(async name => ({ name, data: await get(name) }))));
        return fetched;
    }

    // Each download is a version: the first is 1, and one after any change is the next number. It
    // is a folder that runs the app once it's served: the app's own files beside the client's,
    // whose index.html names the app (appIndexHtml).
    async download({ standalone = false } = {}) {
        const app = this.app;
        if (!app) return;
        if (!app.downloadedAt || app.updatedAt > app.downloadedAt) {
            app.version = (app.version || 0) + 1;
            app.downloadedAt = Date.now();
            this.emit('app', { part: 'version' });
        }
        await this.flush();
        const serverNames = this.serverNamesOf(app);
        const base = `${slug(app.name)}-v${app.version}`;
        if (standalone) {
            download(`${base}.dml`, toDml(app, { standalone: true, serverNames }), 'application/xml');
            this.status(`Downloaded ${app.name}, version ${app.version}, as DML.`);
            return;
        }
        this.status(`Packing ${app.name} with the client that runs it…`);
        try {
            const parts = app.screen?.kind === 'html' ? [] : (app.screen?.components || []).filter(component => component.type === 'part');
            // The folder ships the client served here; opened as a file, it links to the client at its address.
            const root = this.clientAddress();
            const own = [
                { name: APP_FILE, data: toDml(app, { serverNames }) },
                { name: SCREEN_FILE, data: screenHtml(app) },
                ...parts.map(part => ({ name: partFile(part.id), data: part.html || '' })),
                { name: 'README.md', data: readmeFor(app, { serverName: url => this.serverName(url), root }) },
            ];
            const client = await this.clientFiles(clientRoot(location.href));
            const page = client.find(file => file.name === 'index.html');
            page.data = appIndexHtml(new TextDecoder().decode(page.data), app, { link: await this.linkTo(app), root });
            const taken = new Set(own.map(file => file.name));
            const files = [...own, ...client.filter(file => !taken.has(file.name))].map(file => ({ ...file, name: `${base}/${file.name}` }));
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([await zip(files, { deflate: true })], { type: 'application/zip' }));
            link.download = `${base}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            this.status(`Downloaded ${app.name}, version ${app.version}: serve the folder in it, and it runs (its README says how).`);
        } catch (error) {
            this.status(`Couldn't download ${app.name}: ${error.message}`, { error: true });
        }
    }

    // A zip from Download, or a .dml file. An app with the same id is replaced, so importing a
    // download restores it.
    async importFile(file) {
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let dml;
            const files = {};
            if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
                const decoder = new TextDecoder();
                const entries = [...await unzip(bytes)];
                // A download has its folder in front of every name (one from before, only if it was
                // zipped again from its folder). A DML names only HTML files: its screen and parts.
                const folder = entries.some(([name]) => name === 'app.dml') ? '' : entries.find(([name]) => /^[^/]+\/app\.dml$/.test(name))?.[0].slice(0, -'app.dml'.length) || '';
                for (const [name, data] of entries) {
                    const local = name.startsWith(folder) ? name.slice(folder.length) : name;
                    if (/\.(dml|html)$/.test(local)) files[local] = decoder.decode(data);
                }
                dml = files['app.dml'] ?? Object.entries(files).find(([name]) => name.endsWith('.dml'))?.[1];
                if (dml === undefined) throw new Error("there's no app.dml in it");
            } else {
                dml = new TextDecoder().decode(bytes);
            }
            const { app: imported, servers } = fromDml(dml, { files });
            const now = Date.now();
            const existing = this.list.find(app => app.id === imported.id);
            const app = {
                ...normalizeApp(imported),
                id: imported.id || crypto.randomUUID(),
                createdAt: existing?.createdAt || now,
                updatedAt: now,
                downloadedAt: now,
                serverNames: Object.fromEntries(servers.filter(server => server.name).map(server => [server.url, server.name])),
            };
            await store.saveApp(app);
            this.list = existing ? this.list.map(candidate => (candidate.id === app.id ? app : candidate)) : [...this.list, app];
            this.emit('list');
            this.show(app.id);
            // The demo servers it calls are built in, so they're added for it.
            for (const url of serversOf(app)) {
                const demo = demoServerAt(url);
                if (demo) this.addDemoServer(demo.id);
            }
            const missing = serversOf(app).filter(url => !this.shell.servers[url]);
            this.status(`${existing ? 'Replaced' : 'Imported'} ${app.name}${app.version ? `, version ${app.version}` : ''}.${missing.length ? ` It calls ${missing.length === 1 ? 'a server' : `${missing.length} servers`} you haven't added; its rules say which.` : ''}`);
            return app;
        } catch (error) {
            this.status(`Couldn't import ${file.name}: ${error.message}`, { error: true });
            return null;
        }
    }

    // A run the app made, in the Workbench: its tool, arguments and result.
    openRun(id) {
        this.showMode('workbench');
        this.workbench.openRun(id);
    }
}
