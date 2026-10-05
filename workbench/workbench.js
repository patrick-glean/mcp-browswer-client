// The Workbench's state and the actions its components share. Components only reach each other
// through here and through AppShell (which owns servers, sign-in and tool calls), so any of them
// can be moved, swapped or left out of a layout without the others noticing.
//
// Events, with what their detail holds:
//   tool          the selected tool changed, or its definition did   { tool, refreshed }
//   view          the tool list switched to tools, resources or prompts   { view }
//   item          the picked resource, template or prompt changed    { item, refreshed }
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
//   panes         a splitter resized a pane                          { rail, tools, request }
//   sheet         a side sheet opened or closed                      { kind: 'server' | 'variables' | null }
//   palette       open Go to

import { matchingVariable, testData } from './prefill.js';
import * as store from './store.js';
import { resolveArguments, VARIABLE_NAME, variablesIn } from './template.js';
import { debounce, download, listOf, plural, schemaOf, serverLabel, SOURCE_LABELS, timeAgo } from './util.js';

const ENVIRONMENT_KEY = 'workbenchEnvironmentId';
const DOCK_KEY = 'workbenchDock';
const PANES_KEY = 'workbenchPanes';
export const NEW_COLLECTION = '__new';

// What identifies a resource, a resource template or a prompt in its list.
export const itemKey = (kind, item) => (kind === 'resource' ? item.uri : kind === 'template' ? item.uriTemplate : item.name);

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
        // What the tool list shows, 'tools', 'resources' or 'prompts', and the resource, resource
        // template or prompt picked there: { kind: 'resource' | 'template' | 'prompt', item }.
        this.view = 'tools';
        this.item = null;
        // The saved request the request pane shows; its runs count as runs of it.
        this.openRequest = null;
        // The latest Run all: { id, collection, total, results: [{ request, message }], done }.
        this.report = null;
        this.sheet = null;
        let dock = {};
        try { dock = JSON.parse(localStorage.getItem(DOCK_KEY) || '{}'); } catch { /* start with the defaults */ }
        this.dock = { open: true, tab: 'log', height: 220, ...dock };
        this.panes = {};
        try { this.panes = JSON.parse(localStorage.getItem(PANES_KEY) || '{}'); } catch { /* the layout's own sizes */ }
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
        this.shell.on('select', () => {
            this.selectTool(null);
            this.selectItem(null);
        });
        const toolsMayHaveChanged = ({ url }) => {
            if (url === this.shell.selectedServerUrl) this.toolsChanged();
        };
        this.shell.on('tools', toolsMayHaveChanged);
        this.shell.on('servers', toolsMayHaveChanged);
        this.shell.on('catalog', ({ url }) => {
            if (url === this.shell.selectedServerUrl) this.itemsChanged();
        });
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

    // Fills in {{variables}} from the active environment before a call goes out. AppShell calls
    // this for every run; it throws a TemplateError for unknown variables.
    prepare(tool, args) {
        const sentArgs = resolveArguments(args, this.variables, schemaOf(tool));
        return { sentArgs, environmentName: variablesIn(args).size ? this.environment?.name || null : null };
    }

    // --- Selection ---

    selectTool(name) {
        this.tool = name ? (this.server?.tools || []).find(tool => tool.name === name) || null : null;
        this.openRequest = null;
        if (this.tool) this.showView('tools');
        this.emit('tool', { tool: this.tool });
    }

    // Which list the tool list shows: the request and response areas show what goes with it.
    showView(view) {
        if (view === this.view) return;
        this.view = view;
        this.emit('view', { view });
    }

    // A resource (by URI), resource template (by URI template) or prompt (by name), or null.
    selectItem(kind, key) {
        const found = kind ? (this.itemsOf(kind) || []).find(item => itemKey(kind, item) === key) : null;
        this.item = found ? { kind, item: found } : null;
        if (this.item) this.showView(kind === 'prompt' ? 'prompts' : 'resources');
        this.emit('item', { item: this.item });
    }

    itemsOf(kind) {
        return { resource: this.server?.resources, template: this.server?.resourceTemplates, prompt: this.server?.prompts }[kind];
    }

    // A new list keeps the selection when the item is still there.
    itemsChanged() {
        if (!this.item) return;
        const { kind, item } = this.item;
        const fresh = (this.itemsOf(kind) || []).find(candidate => itemKey(kind, candidate) === itemKey(kind, item));
        if (!fresh) return this.selectItem(null);
        if (JSON.stringify(fresh) === JSON.stringify(item)) return;
        this.item = { kind, item: fresh };
        this.emit('item', { item: this.item, refreshed: true });
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

    // One click: what you last sent, else the newest saved request, else test data.
    async prefillBest() {
        const { last, saved } = await this.prefillChoices();
        if (last?.args) return this.prefill('last', { last });
        if (saved.length) return this.prefill(`saved:${saved[0].id}`, { saved });
        return this.prefill('schema');
    }

    // Sources: 'last', 'saved:<id>', 'schema' (test data for the required fields and the ones the
    // schema suggests a value for), 'every' (test data for every field) and 'clear'.
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
        } else if (source === 'schema' || source === 'every') {
            const schema = schemaOf(this.tool);
            const { values, sources } = testData(schema, { variables: this.variables, every: source === 'every' });
            args = values;
            text = this.describeTestData(schema, sources, source === 'every');
        }
        this.setOpenRequest(request);
        this.emit('fill', { args, text });
    }

    describeTestData(schema, sources, every) {
        const kinds = Object.values(sources);
        if (!Object.keys(schema?.properties || {}).length) return 'This tool takes no arguments.';
        if (!kinds.length) {
            return every
                ? "Couldn't make test data for these fields; fill them in by hand."
                : 'Nothing to fill: every field is optional and the schema suggests no values. Test data for every field fills them anyway.';
        }
        const count = kind => kinds.filter(candidate => kind.includes(candidate)).length;
        const parts = [
            [count(['const', 'default', 'example', 'description']), 'from the schema'],
            [count(['variable']), `staged in ${this.environment?.name || 'this environment'}`],
            [count(['generated']), 'with generated test data'],
        ].filter(([number]) => number).map(([number, how]) => `${number} ${how}`);
        return `Filled ${plural(kinds.length, 'field')}: ${listOf(parts)}.`;
    }

    // Stages the request pane's values as test data: each becomes a variable in the active
    // environment named like its field (or updates the one named alike), which Pre-fill then
    // uses for any tool with that field. Returns what to tell the person.
    stageValues(args) {
        const staged = {};
        for (const [field, value] of Object.entries(args || {})) {
            if (value === undefined || value === null || value === '' || variablesIn(value).size) continue;
            const name = matchingVariable(field, this.variables) || field;
            if (!VARIABLE_NAME.test(name)) continue;
            staged[name] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        const names = Object.keys(staged);
        if (!names.length) return 'Nothing to stage: fill in a field first. Fields that already use {{variables}} are left as they are.';
        this.editEnvironment({ name: this.environment.name, variables: { ...this.variables, ...staged } });
        const them = names.length === 1 ? 'it' : 'them';
        return `Staged ${listOf(names)} in ${this.environment.name}: Pre-fill uses ${them} for any tool with ${names.length === 1 ? 'a field' : 'fields'} of that name.`;
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

    // Pane sizes the splitters set: the rail's and the tool list's widths in pixels, and the
    // request pane's share of the space it splits with the response pane. A size of null goes
    // back to the layout's own.
    setPanes(changes) {
        for (const [pane, size] of Object.entries(changes)) {
            if (size === null || size === undefined) delete this.panes[pane];
            else this.panes[pane] = size;
        }
        localStorage.setItem(PANES_KEY, JSON.stringify(this.panes));
        this.emit('panes', { ...this.panes });
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
