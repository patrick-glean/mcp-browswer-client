// The apps you build, and the state the Apps page's components share: which app is shown (or the
// Chat app), edits to it (saved as you go), downloads and imports. Components reach each other only
// through here, AppShell and the Workbench state, as the Workbench's do.
//
// Events, with what their detail holds:
//   list       apps were added, renamed or deleted
//   shown      the page shows another app, or the Chat app      { id }
//   app        the shown app changed       { part: 'screen' | 'flow' | 'name' | 'version', by }
//   restart    run the shown app again from the start
//   highlight  point these elements out on the screen           { elements }
//   trace      something the running app did                    { entry }

import { download, schemaOf, serverLabel } from '../workbench/util.js';
import { fromDml, serversOf, toDml } from './dml.js';
import { describeRule, newRule, renameInFlow } from './flow.js';
import { elementsOf, newComponent, screenHtml } from './screen.js';
import * as store from './store.js';
import { unzip, zip } from './zip.js';

export const CHAT = 'chat';
const SHOWN_KEY = 'appsShown';
const APP_URL = 'https://patrick-glean.github.io/mcp-browswer-client/';

export const slug = name => String(name || 'app').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'app';

// A tool's first text field, preferring a required one: where the starter app's text box goes.
function textField(tool) {
    const schema = schemaOf(tool) || {};
    const fields = Object.entries(schema.properties || {}).filter(([, prop]) => prop?.type === 'string' && !prop.enum);
    const required = new Set(schema.required || []);
    return (fields.find(([key]) => required.has(key)) || fields[0] || [])[0] || null;
}

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
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        name,
        description: '',
        version: 0,
        createdAt: now,
        updatedAt: now,
        downloadedAt: null,
        screen: { kind: 'components', components },
        flow: [newRule({ element: 'run', event: 'click', ...call, into: 'output' })],
    };
}

// The README that travels in an app's zip: what's in it, the flow in words, and how to run it.
export function readmeFor(app, { serverName = url => url } = {}) {
    const elements = new Map(elementsOf(app.screen).map(element => [element.id, element]));
    const elementName = id => {
        const label = elements.get(id)?.label;
        return label && label.toLowerCase() !== id.toLowerCase() ? `${label} (\`${id}\`)` : `\`${id}\``;
    };
    const servers = serversOf(app);
    const rules = (app.flow || []).map((rule, index) => `${index + 1}. ${describeRule(rule, { elementName, serverName })}`);
    return `# ${app.name}

An app built in MCP Browser Client${app.version ? `, version ${app.version}` : ''}.${app.description ? `\n\n${app.description}` : ''}

## What's here

- \`index.html\`: the screen, what people see. ${app.screen?.kind === 'html' ? (app.screen.from ? `A call to \`${app.screen.from.toolName}\` on ${serverName(app.screen.from.serverUrl)} made it.` : 'It was written as HTML.') : 'It was built from components, which app.dml lists.'}
- \`app.dml\`: the screen's components and the flow, what happens when people use it, as markup.

## The flow

${rules.length ? rules.join('\n') : 'No rules yet.'}

In a call, \`{{name}}\` is what the screen's element with that id holds when the rule runs (or a variable from the environment). In what a rule puts on the screen, \`{{text}}\` is the text the tool returned, \`{{structured.…}}\` its structured content, \`{{json.…}}\` its text read as JSON, and \`{{error}}\` why it failed.

## Run it

Open MCP Browser Client (${APP_URL}), choose Apps, then Import, and pick this zip. ${servers.length ? `It calls ${servers.length === 1 ? 'this server' : 'these servers'}, which you add under Servers in the Workbench:\n\n${servers.map(url => `- ${serverName(url) === url ? url : `${serverName(url)}: ${url}`}`).join('\n')}` : "It doesn't call any servers yet."}
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
        this.shownId = CHAT;
        this.app = null;
        this.saveTimer = null;
        this.elementsCache = null;
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

    async load() {
        this.list = (await store.listApps()).sort((a, b) => a.createdAt - b.createdAt);
        const shown = localStorage.getItem(SHOWN_KEY);
        this.show(this.list.some(app => app.id === shown) ? shown : CHAT);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush();
        });
    }

    show(id) {
        this.flush();
        this.app = id === CHAT ? null : this.list.find(app => app.id === id) || null;
        this.shownId = this.app ? this.app.id : CHAT;
        this.elementsCache = null;
        localStorage.setItem(SHOWN_KEY, this.shownId);
        this.emit('shown', { id: this.shownId });
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
        if (!this.app) return Promise.resolve();
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

    // Changes a component's id, taking the flow's references with it.
    renameElement(from, to) {
        this.change(app => {
            const component = app.screen.components.find(candidate => candidate.id === from);
            if (component) component.id = to;
            app.flow = renameInFlow(app.flow, from, to);
        }, { part: 'screen' });
        this.emit('app', { part: 'flow' });
    }

    // --- The list ---

    async create() {
        const taken = new Set(this.list.map(app => app.name));
        let name = 'New app';
        for (let n = 2; taken.has(name); n++) name = `New app ${n}`;
        const app = starterApp({ shell: this.shell, workbench: this.workbench, name });
        await store.saveApp(app);
        this.list.push(app);
        this.emit('list');
        this.show(app.id);
        return app;
    }

    async duplicate() {
        if (!this.app) return null;
        await this.flush();
        const now = Date.now();
        const copy = { ...structuredClone(this.app), id: crypto.randomUUID(), name: `${this.app.name} (copy)`, version: 0, createdAt: now, updatedAt: now, downloadedAt: null };
        await store.saveApp(copy);
        this.list.push(copy);
        this.emit('list');
        this.show(copy.id);
        this.status(`Made a copy of ${this.app.name}.`);
        return copy;
    }

    async remove() {
        if (!this.app) return;
        const { id, name } = this.app;
        clearTimeout(this.saveTimer);
        this.app = null;
        await store.deleteApp(id);
        this.list = this.list.filter(app => app.id !== id);
        this.emit('list');
        this.show(CHAT);
        this.status(`Deleted ${name}.`);
    }

    // --- Download and import ---

    serverName(url) {
        const server = this.shell.servers[url];
        return server ? serverLabel(server, url) : this.app?.serverNames?.[url] || url;
    }

    // Each download is a version: the first is 1, and one after any change is the next number.
    async download({ standalone = false } = {}) {
        const app = this.app;
        if (!app) return;
        if (!app.downloadedAt || app.updatedAt > app.downloadedAt) {
            app.version = (app.version || 0) + 1;
            app.downloadedAt = Date.now();
            this.emit('app', { part: 'version' });
        }
        await this.flush();
        const serverNames = Object.fromEntries(serversOf(app).map(url => [url, this.serverName(url)]).filter(([url, name]) => name !== url));
        const base = `${slug(app.name)}-v${app.version}`;
        if (standalone) {
            download(`${base}.dml`, toDml(app, { standalone: true, serverNames }), 'application/xml');
        } else {
            const files = [
                { name: 'app.dml', data: toDml(app, { serverNames }) },
                { name: 'index.html', data: screenHtml(app) },
                { name: 'README.md', data: readmeFor(app, { serverName: url => this.serverName(url) }) },
            ];
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([zip(files)], { type: 'application/zip' }));
            link.download = `${base}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }
        this.status(`Downloaded ${app.name}, version ${app.version}${standalone ? ', as DML' : ''}.`);
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
                for (const [name, data] of await unzip(bytes)) files[name.replace(/^[^/]+\/(?=[^/]+$)/, '')] = decoder.decode(data);
                dml = files['app.dml'] ?? Object.entries(files).find(([name]) => name.endsWith('.dml'))?.[1];
                if (dml === undefined) throw new Error("there's no app.dml in it");
            } else {
                dml = new TextDecoder().decode(bytes);
            }
            const { app: imported, servers } = fromDml(dml, { files });
            const now = Date.now();
            const existing = this.list.find(app => app.id === imported.id);
            const app = {
                ...imported,
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
