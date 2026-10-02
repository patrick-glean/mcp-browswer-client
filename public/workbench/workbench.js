// The Workbench's state and the actions its components share. Components only reach each other
// through here and through ChatShell (which owns servers, sign-in and tool calls), so any of them
// can be moved, swapped or left out of a layout without the others noticing.
//
// Events, with what their detail holds:
//   tool          the selected tool changed, or its definition did   { tool, refreshed }
//   request       the saved request the request pane shows changed   { request }
//   fill          the request pane should show these arguments       { args, text }
//   run-request   run the request pane's tool (Cmd/Ctrl+Enter)
//   save-request  open the request pane's Save (Cmd/Ctrl+S)
//   environment   the active environment or its variables changed    { edited }
//   saved         saved requests or collections changed
//   runs          the run history was cleared
//   report        a Run all started, moved on or finished            { report }
//   show          the response pane should show this message         { message }
//   status        something to tell the person                       { text, error }
//   dock          the dock opened, closed, resized or changed tab    { open, tab, height }
//   sheet         a side sheet opened or closed                      { kind: 'server' | 'variables' | null }
//   palette       open Go to

import { fromSchema } from './prefill.js';
import * as store from './store.js';
import { resolveArguments, variablesIn } from './template.js';
import { debounce, download, plural, schemaOf, serverLabel, SOURCE_LABELS, timeAgo } from './util.js';

const ENVIRONMENT_KEY = 'workbenchEnvironmentId';
const DOCK_KEY = 'workbenchDock';
export const NEW_COLLECTION = '__new';

// A stored run in the shape of the worker's tool_result, for the response pane.
export function messageFromRun(run) {
    return {
        fromHistory: true,
        run: {
            id: run.id,
            startedAt: run.startedAt,
            durationMs: run.durationMs,
            outcome: run.outcome,
            changed: run.changed,
            previousRunId: run.previousRunId,
            source: run.source,
        },
        result: run.result,
        resultText: run.resultText,
        error: run.error,
        errorKind: run.errorKind,
    };
}

export class Workbench {
    constructor(shell) {
        this.shell = shell;
        this.events = new EventTarget();
        this.environments = [];
        this.environment = null;
        // The selected server's tool the request pane shows.
        this.tool = null;
        // The saved request the request pane shows; its runs count as runs of it.
        this.openRequest = null;
        // The latest Run all: { id, collection, total, results: [{ request, message }], done }.
        this.report = null;
        this.sheet = null;
        let dock = {};
        try { dock = JSON.parse(localStorage.getItem(DOCK_KEY) || '{}'); } catch { /* start with the defaults */ }
        this.dock = { open: true, tab: 'log', height: 220, ...dock };
        this.saveEnvironmentSoon = debounce(environment => store.saveEnvironment(environment), 250);
    }

    on(type, listener, signal) {
        this.events.addEventListener(type, event => listener(event.detail), { signal });
    }

    emit(type, detail = {}) {
        this.events.dispatchEvent(new CustomEvent(type, { detail }));
    }

    async load() {
        this.environments = (await store.listEnvironments()).sort((a, b) => a.createdAt - b.createdAt);
        if (!this.environments.length) this.environments = [await store.saveEnvironment({ name: 'Default', variables: {} })];
        const active = localStorage.getItem(ENVIRONMENT_KEY) || localStorage.getItem('sandboxEnvironmentId');
        this.environment = this.environments.find(environment => environment.id === active) || this.environments[0];
        this.shell.on('select', () => this.selectTool(null));
        const toolsMayHaveChanged = ({ url }) => {
            if (url === this.shell.selectedServerUrl) this.toolsChanged();
        };
        this.shell.on('tools', toolsMayHaveChanged);
        this.shell.on('servers', toolsMayHaveChanged);
    }

    get server() {
        return this.shell.servers[this.shell.selectedServerUrl] || null;
    }

    get variables() {
        return this.environment?.variables || {};
    }

    serverLabel(url) {
        return serverLabel(this.shell.servers[url], url);
    }

    status(text, { error = false } = {}) {
        this.emit('status', { text, error });
    }

    // --- Environments ---

    selectEnvironment(id) {
        this.environment = this.environments.find(environment => environment.id === id) || this.environments[0];
        localStorage.setItem(ENVIRONMENT_KEY, this.environment.id);
        this.emit('environment');
    }

    // Edits apply at once; saving to IndexedDB waits for a pause in typing.
    editEnvironment({ name, variables }) {
        Object.assign(this.environment, { name: name || 'Untitled', variables });
        this.saveEnvironmentSoon({ ...this.environment });
        this.emit('environment', { edited: true });
    }

    async newEnvironment() {
        const environment = await store.saveEnvironment({ name: `Environment ${this.environments.length + 1}`, variables: {} });
        this.environments.push(environment);
        this.selectEnvironment(environment.id);
        return environment;
    }

    async deleteEnvironment() {
        await store.deleteEnvironment(this.environment.id);
        this.environments = this.environments.filter(environment => environment.id !== this.environment.id);
        if (!this.environments.length) this.environments = [await store.saveEnvironment({ name: 'Default', variables: {} })];
        this.selectEnvironment(this.environments[0].id);
    }

    // Fills in {{variables}} from the active environment before a call goes out. ChatShell calls
    // this for every run; it throws a TemplateError for unknown variables.
    prepare(tool, args) {
        const sentArgs = resolveArguments(args, this.variables, schemaOf(tool));
        return { sentArgs, environmentName: variablesIn(args).size ? this.environment?.name || null : null };
    }

    // --- Selection ---

    selectTool(name) {
        this.tool = name ? (this.server?.tools || []).find(tool => tool.name === name) || null : null;
        this.openRequest = null;
        this.emit('tool', { tool: this.tool });
    }

    // A new tool list keeps the selection when the tool is still there.
    toolsChanged() {
        if (!this.tool) return;
        const fresh = (this.server?.tools || []).find(tool => tool.name === this.tool.name);
        if (!fresh) return this.selectTool(null);
        const refreshed = JSON.stringify(fresh) !== JSON.stringify(this.tool);
        this.tool = fresh;
        if (refreshed) this.emit('tool', { tool: fresh, refreshed: true });
    }

    // Selects a server and one of its tools, or says why it can't.
    showTool(serverUrl, toolName) {
        if (!this.shell.servers[serverUrl]) {
            this.status(`${serverUrl} isn't in your server list anymore. Add it again to use this.`, { error: true });
            return null;
        }
        if (this.shell.selectedServerUrl !== serverUrl) this.shell.selectServer(serverUrl);
        const tool = (this.server?.tools || []).find(candidate => candidate.name === toolName);
        if (!tool) {
            this.status(`${this.serverLabel(serverUrl)} doesn't list ${toolName}. Connect to it, or the tool may be gone.`, { error: true });
            return null;
        }
        this.selectTool(toolName);
        return tool;
    }

    setOpenRequest(request) {
        this.openRequest = request || null;
        this.emit('request', { request: this.openRequest });
    }

    // --- Running ---

    // Runs the selected tool with the arguments as written in the request pane.
    run(args) {
        const url = this.shell.selectedServerUrl;
        const tool = this.tool;
        if (!url || !tool) return null;
        const request = this.openRequest;
        const requestId = request && request.serverUrl === url && request.toolName === tool.name ? request.id : null;
        return this.shell.runTool({ url, tool, args, requestId });
    }

    // A call the request pane couldn't make, such as a field with invalid JSON.
    notSent(error) {
        this.shell.emit('run', { phase: 'not-sent', error });
    }

    // --- Pre-fill ---

    async prefillChoices() {
        const url = this.shell.selectedServerUrl;
        const [last, saved] = await Promise.all([store.lastSent(url, this.tool.name), store.requestsForTool(url, this.tool.name)]);
        saved.sort((a, b) => b.updatedAt - a.updatedAt);
        return { last, saved };
    }

    // One click: what you last sent, else the newest saved request, else the schema.
    async prefillBest() {
        const { last, saved } = await this.prefillChoices();
        if (last?.args) return this.prefill('last', { last });
        if (saved.length) return this.prefill(`saved:${saved[0].id}`, { saved });
        return this.prefill('schema');
    }

    prefill(source, { last = null, saved = [] } = {}) {
        let args = {};
        let text = 'Cleared the fields.';
        let request = null;
        if (source === 'last') {
            args = last.args;
            text = `Filled from what you last sent, ${timeAgo(last.startedAt)}.`;
        } else if (source.startsWith('saved:')) {
            request = saved.find(candidate => `saved:${candidate.id}` === source);
            args = request.args;
            text = `Filled from ${request.name}. Runs count as runs of it, and Save updates it.`;
        } else if (source === 'schema') {
            args = fromSchema(schemaOf(this.tool), this.variables);
            text = Object.keys(args).length ? 'Filled from the schema.' : 'The schema has no defaults or examples to fill in.';
        }
        this.setOpenRequest(request);
        this.emit('fill', { args, text });
    }

    // --- Saved requests and collections ---

    async collections() {
        return (await store.listCollections()).sort((a, b) => a.name.localeCompare(b.name));
    }

    // Saves the request pane's arguments as a new request, or over the open one.
    async saveRequest({ name, collectionId, newCollectionName, args, asNew = false }) {
        if (collectionId === NEW_COLLECTION) {
            if (!newCollectionName) throw new Error('Name the new collection.');
            collectionId = (await store.saveCollection({ name: newCollectionName })).id;
        }
        const base = !asNew && this.openRequest ? this.openRequest : { id: undefined, createdAt: undefined };
        const saved = await store.saveRequest({
            ...base,
            name,
            serverUrl: this.shell.selectedServerUrl,
            toolName: this.tool.name,
            args,
            collectionId: collectionId || null,
        });
        this.setOpenRequest(saved);
        this.emit('saved');
        return saved;
    }

    async openSaved(id) {
        const request = await store.getRequest(id);
        if (!request) {
            this.emit('saved');
            return null;
        }
        const tool = this.showTool(request.serverUrl, request.toolName);
        if (!tool) return null;
        this.setOpenRequest(request);
        this.emit('fill', { args: request.args, text: `Opened ${request.name}. Runs count as runs of it, and Save updates it.` });
        return { request, tool };
    }

    async runSaved(id) {
        const opened = await this.openSaved(id);
        if (!opened) return null;
        const { request, tool } = opened;
        return this.shell.runTool({ url: request.serverUrl, tool, args: request.args, requestId: request.id });
    }

    // Runs a collection's requests one after another, in the order they were saved. The response
    // pane shows the report as it fills in.
    async runCollection(collectionId) {
        const [requests, collections] = await Promise.all([store.listRequests(), store.listCollections()]);
        const members = requests.filter(request => (request.collectionId || '') === collectionId).sort((a, b) => a.createdAt - b.createdAt);
        if (!members.length) return;
        const collection = collections.find(candidate => candidate.id === collectionId) || { id: '', name: 'Not in a collection' };
        const report = { id: crypto.randomUUID(), collection, total: members.length, results: [], done: false };
        this.report = report;
        this.emit('report', { report });
        for (const request of members) {
            const tool = (this.shell.servers[request.serverUrl]?.tools || []).find(candidate => candidate.name === request.toolName)
                || { name: request.toolName };
            const message = await this.shell.runTool({
                url: request.serverUrl, tool, args: request.args, requestId: request.id, collectionRunId: report.id, show: false,
            });
            report.results.push({ request, message });
            this.emit('report', { report });
        }
        report.done = true;
        this.emit('report', { report });
    }

    async renameRequest(id, name) {
        const request = await store.getRequest(id);
        if (!request) return;
        const saved = await store.saveRequest({ ...request, name });
        if (this.openRequest?.id === id) this.setOpenRequest(saved);
        this.emit('saved');
    }

    async deleteRequest(id) {
        await store.deleteRequest(id);
        if (this.openRequest?.id === id) this.setOpenRequest(null);
        this.status('Deleted the request.');
        this.emit('saved');
    }

    async renameCollection(id, name) {
        const collection = (await store.listCollections()).find(candidate => candidate.id === id);
        if (collection) await store.saveCollection({ ...collection, name });
        this.emit('saved');
    }

    async deleteCollection(id) {
        await store.deleteCollection(id);
        this.status('Deleted the collection; its requests are under Not in a collection.');
        this.emit('saved');
    }

    // --- Runs ---

    // Shows a stored run: its tool with the arguments as written, and its result.
    async openRun(id) {
        const run = await store.getRun(id);
        if (!run) {
            this.status('That run is no longer in history.', { error: true });
            return;
        }
        const tool = this.showTool(run.serverUrl, run.toolName);
        if (tool) {
            this.setOpenRequest(run.requestId ? (await store.getRequest(run.requestId)) || null : null);
            this.emit('fill', run.args
                ? { args: run.args, text: `Opened the ${SOURCE_LABELS[run.source] || run.source} run from ${timeAgo(run.startedAt)}.` }
                : { args: {}, text: 'The arguments were too big to keep, so the fields are empty.' });
        }
        this.emit('show', { message: messageFromRun(run) });
    }

    async clearRuns() {
        await store.clearRuns();
        this.status('Cleared the history.');
        this.emit('runs');
    }

    // --- Export and import ---

    async exportData() {
        const data = await store.exportAll();
        download(`mcp-workbench-${data.exportedAt.slice(0, 10)}.json`, JSON.stringify(data, null, 2));
        this.status(`Exported ${plural(data.requests.length, 'saved request')}, ${plural(data.collections.length, 'collection')} and ${plural(data.environments.length, 'environment')}.`);
    }

    async importFile(file) {
        try {
            const counts = await store.importAll(JSON.parse(await file.text()));
            this.environments = (await store.listEnvironments()).sort((a, b) => a.createdAt - b.createdAt);
            this.environment = this.environments.find(environment => environment.id === this.environment?.id) || this.environments[0];
            this.emit('environment');
            this.emit('saved');
            this.status(`Imported ${plural(counts.requests, 'saved request')}, ${plural(counts.collections, 'collection')} and ${plural(counts.environments, 'environment')}.`);
        } catch (error) {
            this.status(`Couldn't import ${file.name}: ${error.message}`, { error: true });
        }
    }

    // --- The frame: dock, side sheets, Go to ---

    setDock(changes) {
        Object.assign(this.dock, changes);
        localStorage.setItem(DOCK_KEY, JSON.stringify(this.dock));
        this.emit('dock', { ...this.dock });
    }

    openSheet(kind) {
        this.sheet = kind;
        this.emit('sheet', { kind });
    }

    closeSheet() {
        if (!this.sheet) return;
        this.sheet = null;
        this.emit('sheet', { kind: null });
    }
}
