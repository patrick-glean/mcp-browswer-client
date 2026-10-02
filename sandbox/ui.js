// The sandbox around the tool card: environments of variables, Pre-fill, saved requests and their
// collections, the history of runs with what changed, and export and import. index.html loads
// this module and calls installSandbox; ChatShell then calls back through `shell.sandbox`.

import { lineDiff, hunks } from './diff.js';
import { fromSchema } from './prefill.js';
import { comparedValue, normalize } from './runs.js';
import * as store from './store.js';
import { resolveArguments, VARIABLE_NAME, variablesIn } from './template.js';

const ACTIVE_ENVIRONMENT_KEY = 'sandboxEnvironmentId';
const NEW_COLLECTION = '__new';
const SOURCE_LABELS = { sandbox: 'Sandbox', collection: 'Run all', chat: 'Chat', reply: 'From a reply' };

const $ = id => document.getElementById(id);
const schemaOf = tool => tool?.inputSchema || tool?.input_schema || null;
const toolCardForm = () => document.querySelector('#toolCard form');

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function timeAgo(time) {
    const seconds = Math.round((Date.now() - time) / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(time).toLocaleDateString();
}

function formatMs(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function download(filename, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// A run's verdict in a collection run: same, changed, first (nothing to compare with) or failed.
function verdict(message) {
    const run = message.run;
    if (!run?.id || run.outcome === 'failed' || run.outcome === 'tool_error') return 'failed';
    if (run.changed === true) return 'changed';
    if (run.changed === false) return 'same';
    return 'first';
}

const VERDICT_BADGES = {
    same: '<span class="badge badge-success">same</span>',
    changed: '<span class="badge badge-warning">changed</span>',
    first: '<span class="badge">first run</span>',
    failed: '<span class="badge badge-error">failed</span>',
};

export async function installSandbox(shell) {
    const sandbox = new Sandbox(shell);
    await sandbox.load();
    shell.sandbox = sandbox;
    // A tool card drawn before this module loaded has no Pre-fill or Save yet.
    if (shell.currentTool) shell.renderToolCard(shell.currentTool);
    return sandbox;
}

class Sandbox {
    constructor(shell) {
        this.shell = shell;
        this.environments = [];
        this.environment = null;
        // The saved request the tool card shows; calls from it count as runs of that request.
        this.openRequest = null;
        this.view = 'tools';
        // Run all progress per collection ('' for requests outside collections).
        this.collectionRuns = new Map();
        this.saveEnvironmentSoon = debounce(environment => store.saveEnvironment(environment), 250);
        this.refreshHistorySoon = debounce(() => this.renderHistory(), 200);
    }

    async load() {
        this.environments = await store.listEnvironments();
        if (!this.environments.length) this.environments = [await store.saveEnvironment({ name: 'Default', variables: {} })];
        this.environments.sort((a, b) => a.createdAt - b.createdAt);
        const active = localStorage.getItem(ACTIVE_ENVIRONMENT_KEY);
        this.environment = this.environments.find(environment => environment.id === active) || this.environments[0];
        this.renderEnvironmentSelect();
        this.wire();
    }

    wire() {
        $('envSelect').addEventListener('change', event => this.selectEnvironment(event.target.value));
        $('editEnvBtn').addEventListener('click', () => this.toggleEnvironmentEditor());
        $('closeEnvEditor').addEventListener('click', () => this.toggleEnvironmentEditor(false));
        $('newEnvBtn').addEventListener('click', () => this.newEnvironment());
        $('deleteEnvBtn').addEventListener('click', event => this.confirmThen(event.currentTarget, () => this.deleteEnvironment()));
        $('addVariableBtn').addEventListener('click', () => {
            $('envVariables').insertAdjacentHTML('beforeend', variableRow('', ''));
            $('envVariables').lastElementChild.querySelector('input').focus();
        });
        $('envVariables').addEventListener('input', () => this.variablesEdited());
        $('envVariables').addEventListener('click', event => {
            const remove = event.target.closest('[data-remove-variable]');
            if (!remove) return;
            remove.closest('.env-variable').remove();
            this.variablesEdited();
        });
        $('envName').addEventListener('input', () => this.variablesEdited());

        document.querySelectorAll('.view-switch-btn').forEach(button => {
            button.addEventListener('click', () => this.showView(button.dataset.view));
        });
        $('savedList').addEventListener('click', event => this.savedClicked(event));
        $('historyList').addEventListener('click', event => {
            const open = event.target.closest('[data-open-run]');
            if (open) this.openRun(open.dataset.openRun);
        });
        $('historyThisServer').addEventListener('change', () => this.renderHistory());
        $('clearHistoryBtn').addEventListener('click', event => this.confirmThen(event.currentTarget, async () => {
            await store.clearRuns();
            this.status('Cleared the history.');
            this.renderHistory();
        }));
        $('exportSandboxBtn').addEventListener('click', () => this.exportData());
        $('importSandboxBtn').addEventListener('click', () => $('importSandboxInput').click());
        $('importSandboxInput').addEventListener('change', event => {
            const [file] = event.target.files;
            event.target.value = '';
            if (file) this.importFile(file);
        });
        $('toolResultCard').addEventListener('click', event => {
            const button = event.target.closest('[data-show-changes]');
            if (button) this.toggleChanges(button.dataset.showChanges, button);
        });
        navigator.serviceWorker?.addEventListener('message', event => {
            if (event.data?.type === 'run_recorded' && this.view === 'history') this.refreshHistorySoon();
        });
        // Menus close when you click elsewhere.
        document.addEventListener('click', event => {
            document.querySelectorAll('details.menu[open]').forEach(menu => {
                if (!menu.contains(event.target)) menu.open = false;
            });
        });
    }

    // --- Hooks ChatShell calls ---

    // Fills in {{variables}} from the active environment before a call goes out.
    prepare(tool, args) {
        const variables = this.environment?.variables || {};
        const sentArgs = resolveArguments(args, variables, schemaOf(tool));
        return { sentArgs, environmentName: variablesIn(args).size ? this.environment?.name || null : null };
    }

    openRequestId(serverUrl, toolName) {
        const request = this.openRequest;
        return request && request.serverUrl === serverUrl && request.toolName === toolName ? request.id : null;
    }

    toolCardCleared() {
        this.openRequest = null;
    }

    serverSelected() {
        if (this.view === 'history' && $('historyThisServer').checked) this.renderHistory();
    }

    // Adds Pre-fill, Save and the Sends preview to a freshly drawn tool card.
    decorateToolCard(tool, form) {
        this.openRequest = null;
        const toolbar = document.createElement('div');
        toolbar.className = 'tool-toolbar';
        toolbar.innerHTML = `
            <div class="split-button">
                <button type="button" class="btn-sm" data-prefill-best title="Fill the fields from what you last sent, a saved request or the schema">Pre-fill</button>
                <details class="menu prefill-menu">
                    <summary class="btn-sm" aria-label="Choose what to pre-fill from">▾</summary>
                    <div class="menu-list" role="menu"></div>
                </details>
            </div>
            <button type="button" class="btn-sm" data-save-request>Save</button>
            <span class="tool-toolbar-note text-secondary" aria-live="polite"></span>`;
        form.querySelector('.tool-description').after(toolbar);
        const savePanel = document.createElement('div');
        savePanel.className = 'save-request';
        savePanel.hidden = true;
        toolbar.after(savePanel);
        const preview = document.createElement('details');
        preview.className = 'sends-preview';
        preview.innerHTML = '<summary>Sends</summary><pre></pre><p class="sends-error text-error" hidden></p>';
        form.querySelector('.call-tool-btn').before(preview);

        toolbar.querySelector('[data-prefill-best]').addEventListener('click', () => this.prefillBest(tool, form));
        const menu = toolbar.querySelector('.prefill-menu');
        menu.addEventListener('toggle', () => {
            if (menu.open) this.renderPrefillMenu(tool, form, menu);
        });
        toolbar.querySelector('[data-save-request]').addEventListener('click', () => this.openSavePanel(tool, form));
        const updatePreview = debounce(() => this.updatePreview(tool, form), 150);
        form.addEventListener('input', event => {
            if (!event.target.closest?.('.save-request')) updatePreview();
        });
        this.updatePreview(tool, form);
    }

    // --- Environments ---

    renderEnvironmentSelect() {
        $('envSelect').innerHTML = this.environments
            .map(environment => `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)}</option>`)
            .join('');
        $('envSelect').value = this.environment.id;
    }

    selectEnvironment(id) {
        this.environment = this.environments.find(environment => environment.id === id) || this.environments[0];
        localStorage.setItem(ACTIVE_ENVIRONMENT_KEY, this.environment.id);
        if (!$('envEditor').hidden) this.renderEnvironmentEditor();
        this.refreshPreview();
    }

    toggleEnvironmentEditor(open = $('envEditor').hidden) {
        $('envEditor').hidden = !open;
        $('editEnvBtn').setAttribute('aria-expanded', String(open));
        if (open) this.renderEnvironmentEditor();
    }

    renderEnvironmentEditor() {
        $('envName').value = this.environment.name;
        const rows = Object.entries(this.environment.variables || {}).map(([name, value]) => variableRow(name, value));
        $('envVariables').innerHTML = rows.join('') || variableRow('', '');
        $('envEditorNote').hidden = true;
        $('deleteEnvBtn').disabled = false;
    }

    // Edits apply at once; saving to IndexedDB waits for a pause in typing.
    variablesEdited() {
        const variables = {};
        const problems = [];
        for (const row of $('envVariables').querySelectorAll('.env-variable')) {
            const name = row.querySelector('.env-variable-name').value.trim();
            const value = row.querySelector('.env-variable-value').value;
            if (!name) continue;
            if (!VARIABLE_NAME.test(name)) {
                problems.push(`"${name}" isn't a usable name: start with a letter or _, then use letters, digits, _, - or .`);
            } else if (Object.hasOwn(variables, name)) {
                problems.push(`${name} is defined twice; the last one wins.`);
            }
            if (VARIABLE_NAME.test(name)) variables[name] = value;
        }
        const name = $('envName').value.trim() || 'Untitled';
        Object.assign(this.environment, { name, variables });
        $('envSelect').querySelector(`option[value="${CSS.escape(this.environment.id)}"]`).textContent = name;
        $('envEditorNote').textContent = problems.join(' ');
        $('envEditorNote').hidden = !problems.length;
        this.saveEnvironmentSoon({ ...this.environment });
        this.refreshPreview();
    }

    async newEnvironment() {
        const environment = await store.saveEnvironment({ name: `Environment ${this.environments.length + 1}`, variables: {} });
        this.environments.push(environment);
        this.renderEnvironmentSelect();
        this.selectEnvironment(environment.id);
        this.renderEnvironmentSelect();
        this.toggleEnvironmentEditor(true);
        $('envName').select();
    }

    async deleteEnvironment() {
        await store.deleteEnvironment(this.environment.id);
        this.environments = this.environments.filter(environment => environment.id !== this.environment.id);
        if (!this.environments.length) this.environments = [await store.saveEnvironment({ name: 'Default', variables: {} })];
        this.environment = this.environments[0];
        localStorage.setItem(ACTIVE_ENVIRONMENT_KEY, this.environment.id);
        this.renderEnvironmentSelect();
        this.renderEnvironmentEditor();
        this.refreshPreview();
    }

    // --- The tool card: Sends preview, Pre-fill, Save ---

    refreshPreview() {
        const form = toolCardForm();
        if (form && this.shell.currentTool) this.updatePreview(this.shell.currentTool, form);
    }

    updatePreview(tool, form) {
        const preview = form.querySelector('.sends-preview');
        if (!preview) return;
        const [summary, pre, error] = [preview.querySelector('summary'), preview.querySelector('pre'), preview.querySelector('.sends-error')];
        const show = (text, problem) => {
            pre.textContent = text || '';
            pre.hidden = !!problem;
            error.textContent = problem || '';
            error.hidden = !problem;
        };
        let args;
        try {
            args = this.shell.serializeToolForm(form, schemaOf(tool));
        } catch (problem) {
            summary.textContent = 'Sends (check the fields)';
            return show('', problem.message);
        }
        const used = variablesIn(args).size;
        try {
            show(JSON.stringify(this.prepare(tool, args).sentArgs, null, 2));
            summary.textContent = used ? `Sends (${used} ${used === 1 ? 'variable' : 'variables'} from ${this.environment.name})` : 'Sends';
        } catch (problem) {
            summary.textContent = 'Sends (a variable needs attention)';
            show('', problem.message);
        }
    }

    note(form, text, unknownArguments = []) {
        const note = form.querySelector('.tool-toolbar-note');
        if (!note) return;
        const extra = unknownArguments.length
            ? ` Not in this tool's schema, so not sent: ${unknownArguments.join(', ')}.`
            : '';
        note.textContent = `${text}${extra}`;
    }

    async renderPrefillMenu(tool, form, menu) {
        const list = menu.querySelector('.menu-list');
        list.innerHTML = '<span class="menu-note">Loading…</span>';
        const url = this.shell.selectedServerUrl;
        const [last, saved] = await Promise.all([store.lastSent(url, tool.name), store.requestsForTool(url, tool.name)]);
        saved.sort((a, b) => b.updatedAt - a.updatedAt);
        const item = (source, label, disabled = false) =>
            `<button type="button" role="menuitem" class="menu-item" data-prefill-source="${escapeHtml(source)}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
        list.innerHTML = [
            item('last', last?.args ? `What you last sent, ${timeAgo(last.startedAt)}` : 'What you last sent (nothing yet)', !last?.args),
            ...saved.map(request => item(`saved:${request.id}`, `Saved: ${request.name}`)),
            saved.length ? '' : '<span class="menu-note">No saved requests for this tool yet</span>',
            item('schema', 'From the schema'),
            item('clear', 'Clear the fields'),
        ].join('');
        list.onclick = event => {
            const choice = event.target.closest('[data-prefill-source]');
            if (!choice || choice.disabled) return;
            menu.open = false;
            this.prefill(tool, form, choice.dataset.prefillSource, { last, saved });
        };
    }

    // One click: what you last sent, else the newest saved request, else the schema.
    async prefillBest(tool, form) {
        const url = this.shell.selectedServerUrl;
        const last = await store.lastSent(url, tool.name);
        if (last?.args) return this.prefill(tool, form, 'last', { last });
        const saved = (await store.requestsForTool(url, tool.name)).sort((a, b) => b.updatedAt - a.updatedAt);
        if (saved.length) return this.prefill(tool, form, `saved:${saved[0].id}`, { saved });
        return this.prefill(tool, form, 'schema');
    }

    prefill(tool, form, source, { last = null, saved = [] } = {}) {
        const schema = schemaOf(tool);
        let args = {};
        let text = 'Cleared the fields.';
        if (source === 'last') {
            args = last.args;
            text = `Filled from what you last sent, ${timeAgo(last.startedAt)}.`;
        } else if (source.startsWith('saved:')) {
            const request = saved.find(candidate => `saved:${candidate.id}` === source);
            args = request.args;
            text = `Filled from ${request.name}; calls count as runs of it, and Save updates it.`;
        } else if (source === 'schema') {
            args = fromSchema(schema, this.environment?.variables);
            text = Object.keys(args).length ? 'Filled from the schema.' : 'The schema has no defaults or examples to fill in.';
        }
        const unknown = this.shell.fillToolForm(form, schema, args);
        this.openRequest = source.startsWith('saved:') ? saved.find(candidate => `saved:${candidate.id}` === source) : null;
        this.note(form, text, unknown);
    }

    async openSavePanel(tool, form) {
        const panel = form.querySelector('.save-request');
        if (!panel.hidden) {
            panel.hidden = true;
            return;
        }
        const collections = (await store.listCollections()).sort((a, b) => a.name.localeCompare(b.name));
        const editing = this.openRequest;
        panel.innerHTML = `
            <label class="field"><span class="field-label">Name</span><input type="text" data-save-name autocomplete="off"></label>
            <label class="field"><span class="field-label">Collection</span>
                <select data-save-collection>
                    <option value="">No collection</option>
                    ${collections.map(collection => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join('')}
                    <option value="${NEW_COLLECTION}">New collection…</option>
                </select>
            </label>
            <label class="field" data-new-collection hidden><span class="field-label">New collection name</span><input type="text" data-save-new-collection autocomplete="off"></label>
            <div class="button-row">
                <button type="button" class="btn-primary btn-sm" data-save-confirm>${editing ? 'Save changes' : 'Save'}</button>
                ${editing ? '<button type="button" class="btn-sm" data-save-as-new>Save as new</button>' : ''}
                <button type="button" class="btn-sm btn-tertiary" data-save-cancel>Cancel</button>
            </div>
            <p class="text-error" data-save-error hidden></p>`;
        const nameInput = panel.querySelector('[data-save-name]');
        const collectionSelect = panel.querySelector('[data-save-collection]');
        nameInput.value = editing?.name || this.defaultRequestName(tool, form);
        collectionSelect.value = editing?.collectionId || (collections.length === 1 ? collections[0].id : '');
        collectionSelect.addEventListener('change', () => {
            panel.querySelector('[data-new-collection]').hidden = collectionSelect.value !== NEW_COLLECTION;
            if (collectionSelect.value === NEW_COLLECTION) panel.querySelector('[data-save-new-collection]').focus();
        });
        // Enter saves here instead of calling the tool.
        panel.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
            event.preventDefault();
            this.saveFromCard(tool, form, { asNew: false });
        });
        panel.querySelector('[data-save-confirm]').addEventListener('click', () => this.saveFromCard(tool, form, { asNew: false }));
        panel.querySelector('[data-save-as-new]')?.addEventListener('click', () => this.saveFromCard(tool, form, { asNew: true }));
        panel.querySelector('[data-save-cancel]').addEventListener('click', () => {
            panel.hidden = true;
        });
        panel.hidden = false;
        nameInput.select();
    }

    defaultRequestName(tool, form) {
        let args = {};
        try {
            args = this.shell.serializeToolForm(form, schemaOf(tool));
        } catch { /* named after the tool alone */ }
        const first = Object.values(args).find(value => typeof value === 'string' && value.trim());
        const name = first ? `${tool.name}: ${first.trim()}` : tool.name;
        return name.length > 60 ? `${name.slice(0, 57)}…` : name;
    }

    async saveFromCard(tool, form, { asNew }) {
        const panel = form.querySelector('.save-request');
        const fail = text => {
            const error = panel.querySelector('[data-save-error]');
            error.textContent = text;
            error.hidden = false;
        };
        let args;
        try {
            args = this.shell.serializeToolForm(form, schemaOf(tool));
        } catch (error) {
            return fail(error.message);
        }
        const name = panel.querySelector('[data-save-name]').value.trim() || this.defaultRequestName(tool, form);
        let collectionId = panel.querySelector('[data-save-collection]').value || null;
        if (collectionId === NEW_COLLECTION) {
            const collectionName = panel.querySelector('[data-save-new-collection]').value.trim();
            if (!collectionName) return fail('Name the new collection.');
            collectionId = (await store.saveCollection({ name: collectionName })).id;
        }
        const base = !asNew && this.openRequest ? this.openRequest : { id: undefined, createdAt: undefined };
        const saved = await store.saveRequest({
            ...base,
            name,
            serverUrl: this.shell.selectedServerUrl,
            toolName: tool.name,
            args,
            collectionId,
        });
        this.openRequest = saved;
        panel.hidden = true;
        this.note(form, `Saved as ${saved.name}.`);
        if (this.view === 'saved') this.renderSaved();
    }

    // --- Views ---

    showView(view) {
        this.view = view;
        document.querySelectorAll('.view-switch-btn').forEach(button => {
            const active = button.dataset.view === view;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        $('toolsView').hidden = view !== 'tools';
        $('savedView').hidden = view !== 'saved';
        $('historyView').hidden = view !== 'history';
        this.status(null);
        if (view === 'saved') this.renderSaved();
        if (view === 'history') this.renderHistory();
    }

    status(text, { error = false } = {}) {
        const line = $('sandboxStatus');
        line.textContent = text || '';
        line.hidden = !text;
        line.classList.toggle('text-error', error);
    }

    serverLabel(url) {
        const server = this.shell.servers[url];
        if (server?.alias) return server.alias;
        if (server?.name) return server.name;
        try {
            return new URL(url).host;
        } catch {
            return url;
        }
    }

    // Selects the server and draws the tool card for one of its tools.
    showTool(serverUrl, toolName) {
        const server = this.shell.servers[serverUrl];
        if (!server) {
            this.status(`${serverUrl} isn't in your server list anymore. Add it again to use this.`, { error: true });
            return null;
        }
        if (this.shell.selectedServerUrl !== serverUrl) this.shell.selectServer(serverUrl);
        const tool = (server.tools || []).find(candidate => candidate.name === toolName);
        if (!tool) {
            this.status(`${this.serverLabel(serverUrl)} doesn't list ${toolName}. Connect to it, or the tool may be gone.`, { error: true });
            return null;
        }
        document.querySelectorAll('#toolsList .tool-item').forEach(item => item.classList.toggle('selected', item.dataset.tool === toolName));
        this.shell.renderToolCard(tool);
        return tool;
    }

    // --- Saved requests and collections ---

    async renderSaved() {
        const [requests, collections] = await Promise.all([store.listRequests(), store.listCollections()]);
        if (!requests.length && !collections.length) {
            $('savedList').innerHTML = '<div class="empty-state">Nothing saved yet. Open a tool, fill it in and choose Save.</div>';
            return;
        }
        const groups = [
            ...collections.sort((a, b) => a.name.localeCompare(b.name)).map(collection => ({ collection, id: collection.id })),
            { collection: null, id: '' },
        ];
        $('savedList').innerHTML = groups.map(({ collection, id }) => {
            const members = requests.filter(request => (request.collectionId || '') === id).sort((a, b) => a.createdAt - b.createdAt);
            if (!collection && !members.length) return '';
            const name = collection ? collection.name : 'Not in a collection';
            return `
                <section class="saved-group" data-collection="${escapeHtml(id)}">
                    <div class="saved-group-head">
                        <span class="saved-group-name" data-name>${escapeHtml(name)}</span>
                        <span class="text-secondary">${members.length}</span>
                        <span class="saved-group-actions">
                            <button type="button" class="btn-sm" data-run-collection="${escapeHtml(id)}" ${members.length ? '' : 'disabled'}>Run all</button>
                            ${collection ? `<details class="menu item-menu"><summary class="btn-sm btn-tertiary" aria-label="More for ${escapeHtml(name)}">…</summary><div class="menu-list" role="menu">
                                <button type="button" class="menu-item" data-rename-collection="${escapeHtml(id)}">Rename</button>
                                <button type="button" class="menu-item" data-delete-collection="${escapeHtml(id)}">Delete the collection (keeps its requests)</button>
                            </div></details>` : ''}
                        </span>
                    </div>
                    <div class="collection-run" hidden></div>
                    <ul class="saved-items">${members.map(request => `
                        <li class="saved-item" data-request="${escapeHtml(request.id)}">
                            <button type="button" class="saved-open" data-open-request="${escapeHtml(request.id)}">
                                <span class="saved-name" data-name>${escapeHtml(request.name)}</span>
                                <span class="saved-tool">${escapeHtml(request.toolName)} · ${escapeHtml(this.serverLabel(request.serverUrl))}</span>
                            </button>
                            <button type="button" class="btn-icon btn-tertiary btn-sm" data-run-request="${escapeHtml(request.id)}" title="Run" aria-label="Run ${escapeHtml(request.name)}"><span class="icon icon-play" aria-hidden="true"></span></button>
                            <details class="menu item-menu"><summary class="btn-sm btn-tertiary" aria-label="More for ${escapeHtml(request.name)}">…</summary><div class="menu-list" role="menu">
                                <button type="button" class="menu-item" data-rename-request="${escapeHtml(request.id)}">Rename</button>
                                <button type="button" class="menu-item" data-delete-request="${escapeHtml(request.id)}">Delete</button>
                            </div></details>
                        </li>`).join('')}
                    </ul>
                </section>`;
        }).join('');
        for (const id of this.collectionRuns.keys()) this.renderCollectionRun(id);
    }

    async savedClicked(event) {
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        const { dataset } = target;
        target.closest('details.menu')?.removeAttribute('open');
        if (dataset.openRequest) return this.openSavedRequest(dataset.openRequest);
        if (dataset.runRequest) return this.runSavedRequest(dataset.runRequest);
        if (dataset.runCollection !== undefined) return this.runCollection(dataset.runCollection);
        if (dataset.openRun) return this.openRun(dataset.openRun);
        if (dataset.renameRequest) {
            const request = await store.getRequest(dataset.renameRequest);
            return this.rename(target.closest('.saved-item').querySelector('[data-name]'), request.name, name => store.saveRequest({ ...request, name }));
        }
        if (dataset.renameCollection) {
            const collection = (await store.listCollections()).find(candidate => candidate.id === dataset.renameCollection);
            return this.rename(target.closest('.saved-group').querySelector('.saved-group-name'), collection.name, name => store.saveCollection({ ...collection, name }));
        }
        if (dataset.deleteRequest) {
            await store.deleteRequest(dataset.deleteRequest);
            if (this.openRequest?.id === dataset.deleteRequest) this.openRequest = null;
            this.status('Deleted the request.');
            return this.renderSaved();
        }
        if (dataset.deleteCollection) {
            await store.deleteCollection(dataset.deleteCollection);
            this.collectionRuns.delete(dataset.deleteCollection);
            this.status('Deleted the collection; its requests are under Not in a collection.');
            return this.renderSaved();
        }
    }

    // Swaps a name for an input in place: Enter or leaving the field saves, Escape cancels.
    rename(element, current, save) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = current;
        element.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = async keep => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            if (keep && name && name !== current) await save(name);
            this.renderSaved();
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') finish(true);
            if (event.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', event => event.stopPropagation());
    }

    async openSavedRequest(id) {
        const request = await store.getRequest(id);
        if (!request) return this.renderSaved();
        const tool = this.showTool(request.serverUrl, request.toolName);
        if (!tool) return null;
        const form = toolCardForm();
        const unknown = this.shell.fillToolForm(form, schemaOf(tool), request.args);
        this.openRequest = request;
        this.note(form, `Opened ${request.name}; calls count as runs of it, and Save updates it.`, unknown);
        this.shell.renderToolResultCard(null);
        return { request, tool };
    }

    async runSavedRequest(id) {
        const opened = await this.openSavedRequest(id);
        if (!opened) return;
        const { request, tool } = opened;
        return this.shell.runTool({ url: request.serverUrl, tool, args: request.args, requestId: request.id });
    }

    // Runs a collection's requests one after another, in the order they were saved.
    async runCollection(collectionId) {
        const requests = (await store.listRequests())
            .filter(request => (request.collectionId || '') === collectionId)
            .sort((a, b) => a.createdAt - b.createdAt);
        if (!requests.length) return;
        const state = { total: requests.length, results: [], done: false };
        this.collectionRuns.set(collectionId, state);
        this.renderCollectionRun(collectionId);
        const collectionRunId = crypto.randomUUID();
        for (const request of requests) {
            const tool = (this.shell.servers[request.serverUrl]?.tools || []).find(candidate => candidate.name === request.toolName)
                || { name: request.toolName };
            const message = await this.shell.runTool({ url: request.serverUrl, tool, args: request.args, requestId: request.id, collectionRunId, show: false });
            state.results.push({ request, message });
            this.renderCollectionRun(collectionId);
        }
        state.done = true;
        this.renderCollectionRun(collectionId);
    }

    renderCollectionRun(collectionId) {
        const state = this.collectionRuns.get(collectionId);
        const box = $('savedList').querySelector(`.saved-group[data-collection="${CSS.escape(collectionId)}"] .collection-run`);
        if (!state || !box) return;
        const counts = { same: 0, changed: 0, first: 0, failed: 0 };
        state.results.forEach(({ message }) => counts[verdict(message)]++);
        const parts = [`${counts.same} same`, `${counts.changed} changed`, `${counts.failed} failed`];
        if (counts.first) parts.push(`${counts.first} first ${counts.first === 1 ? 'run' : 'runs'}`);
        const heading = state.done
            ? `Ran ${state.total}: ${parts.join(', ')}`
            : `Running ${state.results.length + 1} of ${state.total}…`;
        box.innerHTML = `
            <div class="collection-run-summary" data-summary>${escapeHtml(heading)}</div>
            <ul class="collection-run-items">${state.results.map(({ request, message }) => {
                const kind = verdict(message);
                const detail = message.run?.durationMs !== undefined ? formatMs(message.run.durationMs) : escapeHtml(message.error || '');
                const label = `${VERDICT_BADGES[kind]}<span class="collection-run-name">${escapeHtml(request.name)}</span><span class="text-secondary">${detail}</span>`;
                return `<li>${message.run?.id ? `<button type="button" class="collection-run-item" data-open-run="${escapeHtml(message.run.id)}">${label}</button>` : `<span class="collection-run-item">${label}</span>`}</li>`;
            }).join('')}</ul>`;
        box.hidden = false;
    }

    // --- History ---

    async renderHistory() {
        const onlySelected = $('historyThisServer').checked;
        const runs = await store.listRuns({ limit: 200, serverUrl: onlySelected ? this.shell.selectedServerUrl : null });
        if (!runs.length) {
            $('historyList').innerHTML = '<div class="empty-state">No calls yet. Every tool call shows up here: from this tab, the chat, and tool calls found in replies.</div>';
            return;
        }
        $('historyList').innerHTML = `<ul class="history-items">${runs.map(run => {
            const outcome = run.outcome === 'failed'
                ? `<span class="badge badge-error">${escapeHtml(run.errorKind || 'failed')}</span>`
                : run.outcome === 'tool_error' ? '<span class="badge badge-error">tool error</span>' : '';
            const changed = run.changed === true ? '<span class="badge badge-warning">changed</span>'
                : run.changed === false ? '<span class="badge badge-success">same</span>' : '';
            const where = onlySelected ? '' : ` · ${escapeHtml(this.serverLabel(run.serverUrl))}`;
            return `
                <li>
                    <button type="button" class="history-item" data-open-run="${escapeHtml(run.id)}" data-source="${escapeHtml(run.source)}">
                        <span class="history-head"><span class="history-tool">${escapeHtml(run.toolName)}</span>${outcome}${changed}</span>
                        <span class="history-meta">${escapeHtml(timeAgo(run.startedAt))} · ${escapeHtml(SOURCE_LABELS[run.source] || run.source)} · ${escapeHtml(formatMs(run.durationMs))}${where}</span>
                    </button>
                </li>`;
        }).join('')}</ul>`;
    }

    // Shows a stored run: its tool card filled with the arguments as written, and its result.
    async openRun(id) {
        const run = await store.getRun(id);
        if (!run) {
            this.status('That run is no longer in history.', { error: true });
            return;
        }
        const tool = this.showTool(run.serverUrl, run.toolName);
        if (tool) {
            const form = toolCardForm();
            this.openRequest = run.requestId ? (await store.getRequest(run.requestId)) || null : null;
            if (run.args) {
                const unknown = this.shell.fillToolForm(form, schemaOf(tool), run.args);
                this.note(form, `Opened the ${SOURCE_LABELS[run.source] || run.source} run from ${timeAgo(run.startedAt)}.`, unknown);
            } else {
                this.note(form, 'The arguments were too big to keep, so the fields are empty.');
            }
            form.querySelector('.call-tool-btn').textContent = 'Run again';
        }
        this.shell.shownRunId = run.id;
        this.shell.renderToolResultCard({
            fromHistory: true,
            run: { id: run.id, startedAt: run.startedAt, durationMs: run.durationMs, outcome: run.outcome, changed: run.changed, previousRunId: run.previousRunId },
            result: run.result,
            resultText: run.resultText,
            error: run.error,
            errorKind: run.errorKind,
        });
    }

    // Draws, or hides again, the line diff between a run and the previous run of the same request.
    async toggleChanges(runId, button) {
        const box = button.closest('.tool-result-card-inner')?.querySelector('.run-diff');
        if (!box) return;
        if (!box.hidden) {
            box.hidden = true;
            button.textContent = 'Show changes';
            return;
        }
        const run = await store.getRun(runId);
        const previous = run?.previousRunId ? await store.getRun(run.previousRunId) : null;
        if (!run || !previous) {
            box.innerHTML = '<p class="text-secondary">The earlier run is no longer in history, so there is nothing to compare with.</p>';
        } else {
            const text = record => record.resultText ?? JSON.stringify(normalize(comparedValue(record)), null, 2);
            const lines = lineDiff(text(previous), text(run));
            const cut = run.truncated || previous.truncated ? ' One of the results was too big to keep in full, so only their starts are compared.' : '';
            const head = `<p class="diff-head text-secondary">Compared with the run from ${escapeHtml(new Date(previous.startedAt).toLocaleString())}, ignoring _meta.${cut}</p>`;
            if (!lines) {
                box.innerHTML = `${head}<p class="text-secondary">The results differ too much to compare line by line; open both from History to see them.</p>`;
            } else {
                const shown = hunks(lines).map(line => {
                    if (line.kind === 'gap') return `<span class="diff-gap">… ${line.count} unchanged ${line.count === 1 ? 'line' : 'lines'}</span>`;
                    const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
                    return `<span class="diff-line diff-${line.kind}">${mark} ${escapeHtml(line.text)}</span>`;
                }).join('');
                box.innerHTML = `${head}<pre class="diff">${shown}</pre>`;
            }
        }
        box.hidden = false;
        button.textContent = 'Hide changes';
    }

    // --- Export and import ---

    async exportData() {
        const data = await store.exportAll();
        download(`mcp-sandbox-${data.exportedAt.slice(0, 10)}.json`, JSON.stringify(data, null, 2));
        this.status(`Exported ${data.requests.length} saved ${data.requests.length === 1 ? 'request' : 'requests'}, ${data.collections.length} ${data.collections.length === 1 ? 'collection' : 'collections'} and ${data.environments.length} ${data.environments.length === 1 ? 'environment' : 'environments'}.`);
    }

    async importFile(file) {
        try {
            const counts = await store.importAll(JSON.parse(await file.text()));
            this.environments = (await store.listEnvironments()).sort((a, b) => a.createdAt - b.createdAt);
            this.environment = this.environments.find(environment => environment.id === this.environment?.id) || this.environments[0];
            this.renderEnvironmentSelect();
            this.refreshPreview();
            this.status(`Imported ${counts.requests} saved ${counts.requests === 1 ? 'request' : 'requests'}, ${counts.collections} ${counts.collections === 1 ? 'collection' : 'collections'} and ${counts.environments} ${counts.environments === 1 ? 'environment' : 'environments'}.`);
            this.renderSaved();
        } catch (error) {
            this.status(`Couldn't import ${file.name}: ${error.message}`, { error: true });
        }
    }

    // Destructive buttons ask for a second click within a few seconds.
    confirmThen(button, action) {
        if (button.dataset.confirming) {
            delete button.dataset.confirming;
            button.textContent = button.dataset.label;
            action();
            return;
        }
        button.dataset.label = button.textContent;
        button.dataset.confirming = 'true';
        button.textContent = 'Click again to confirm';
        setTimeout(() => {
            if (!button.dataset.confirming) return;
            delete button.dataset.confirming;
            button.textContent = button.dataset.label;
        }, 4000);
    }
}

function variableRow(name, value) {
    return `
        <div class="env-variable">
            <input type="text" class="env-variable-name" value="${escapeHtml(name)}" placeholder="name" spellcheck="false" autocomplete="off" aria-label="Variable name">
            <input type="text" class="env-variable-value" value="${escapeHtml(value)}" placeholder="value" spellcheck="false" autocomplete="off" aria-label="Value">
            <button type="button" class="btn-icon btn-tertiary btn-sm" data-remove-variable aria-label="Remove variable"><span class="icon icon-x" aria-hidden="true"></span></button>
        </div>`;
}
