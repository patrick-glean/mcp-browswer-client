// The left rail: your servers with their status, saved requests grouped in collections (with Run
// all), and the most recent runs. Adding a server takes a URL, or a work email for Glean.

import * as store from '../store.js';
import { debounce, escapeHtml, renameInPlace, serverLabel, serverState, timeAgo, verdictChip, verdictOf } from '../util.js';
import { WbElement } from './base.js';

const RECENT_RUNS = 6;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

export class WbRail extends WbElement {
    setup(signal) {
        this.collapsed = new Set(JSON.parse(sessionStorage.getItem('railCollapsed') || '[]'));
        this.refreshSoon = debounce(() => {
            this.renderSaved();
            this.renderRecent();
        }, 200);
        const servers = () => this.renderServers();
        this.shell.on('servers', servers, signal);
        this.shell.on('select', servers, signal);
        this.shell.on('tools', servers, signal);
        this.shell.on('auth', servers, signal);
        this.shell.on('recorded', this.refreshSoon, signal);
        this.workbench.on('saved', () => this.renderSaved(), signal);
        this.workbench.on('request', () => this.markOpenRequest(), signal);
        this.workbench.on('runs', () => this.refreshSoon(), signal);
        this.workbench.on('report', ({ report }) => {
            if (report.done) this.refreshSoon();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('submit', event => {
            event.preventDefault();
            this.addServer();
        }, { signal });
        this.addEventListener('change', event => {
            if (event.target.id !== 'importSavedInput') return;
            const [file] = event.target.files;
            event.target.value = '';
            if (file) this.workbench.importFile(file);
        }, { signal });
    }

    render() {
        this.innerHTML = `
            <section class="wb-section" aria-labelledby="railServers">
                <header class="wb-section-head">
                    <h2 id="railServers">Servers</h2>
                    <button type="button" id="addServerToggle" class="btn-icon btn-sm btn-tertiary" title="Add a server" aria-label="Add a server" aria-expanded="false" aria-controls="addServerForm"><span class="icon icon-plus" aria-hidden="true"></span></button>
                </header>
                <form id="addServerForm" class="wb-add-server" hidden>
                    <input type="text" id="serverUrl" placeholder="Server URL, or your work email for Glean" spellcheck="false" autocomplete="off" aria-label="Server URL or work email">
                    <input type="text" id="serverAlias" placeholder="Name (optional)" autocomplete="off" aria-label="Name for the server">
                    <div class="button-row">
                        <button type="submit" id="addServerBtn" class="btn-primary btn-sm">Add</button>
                        <button type="button" class="btn-sm btn-tertiary" data-cancel-add>Cancel</button>
                        <button type="button" class="link-button wb-add-try" data-open-guide>Servers to try</button>
                    </div>
                    <p class="wb-add-note" data-add-note hidden></p>
                </form>
                <ul class="wb-list" id="serverList"></ul>
            </section>
            <section class="wb-section" aria-labelledby="railSaved">
                <header class="wb-section-head">
                    <h2 id="railSaved">Saved</h2>
                    <details class="menu">
                        <summary class="btn-icon btn-sm btn-tertiary" aria-label="Export or import saved requests"><span class="wb-more" aria-hidden="true">⋯</span></summary>
                        <div class="menu-list" role="menu">
                            <button type="button" class="menu-item" role="menuitem" id="exportSavedBtn" title="Saved requests, collections and environments as one JSON file">Export saved requests and environments</button>
                            <button type="button" class="menu-item" role="menuitem" id="importSavedBtn">Import from a file…</button>
                        </div>
                    </details>
                    <input type="file" id="importSavedInput" accept="application/json,.json" hidden>
                </header>
                <div id="savedList"></div>
            </section>
            <section class="wb-section" aria-labelledby="railHistory">
                <header class="wb-section-head">
                    <h2 id="railHistory">History</h2>
                    <button type="button" class="btn-sm btn-tertiary" data-show-runs title="Every run, in the dock">All</button>
                </header>
                <ul class="wb-list" id="recentRuns"></ul>
            </section>`;
        this.renderServers();
        this.renderSaved();
        this.renderRecent();
    }

    // --- Servers ---

    renderServers() {
        const list = this.$('#serverList');
        if (!list) return;
        const servers = Object.values(this.shell.servers);
        if (!servers.length) {
            list.innerHTML = '<li class="wb-list-note">No servers yet. Add one with +, or <button type="button" class="link-button" data-open-guide>try one from the guide</button>.</li>';
            return;
        }
        list.innerHTML = servers.map(server => {
            const auth = this.shell.authStatus[server.url];
            const state = serverState(server, auth);
            const signingIn = this.shell.signingIn?.url === server.url;
            const meta = signingIn ? '<span class="wb-meta">Signing in…</span>'
                : state === 'signin' ? '<span class="badge badge-warning">Sign in</span>'
                : server.status === 'connecting' ? '<span class="wb-meta">Connecting…</span>'
                : server.status === 'connected' ? `<span class="wb-meta">${(server.tools || []).length}</span>`
                : server.status === 'failed' ? '<span class="wb-meta text-error">Failed</span>'
                : '';
            const selected = server.url === this.shell.selectedServerUrl;
            return `
                <li>
                    <button type="button" class="wb-row wb-server" data-url="${escapeHtml(server.url)}" title="${escapeHtml(server.url)}" ${selected ? 'aria-current="true"' : ''}>
                        <span class="status-indicator ${state}" aria-hidden="true"></span>
                        <span class="wb-row-label">${escapeHtml(serverLabel(server))}</span>
                        ${meta}
                    </button>
                </li>`;
        }).join('');
    }

    toggleAddForm(open = this.$('#addServerForm').hidden) {
        const form = this.$('#addServerForm');
        form.hidden = !open;
        this.$('#addServerToggle').setAttribute('aria-expanded', String(open));
        this.note(null);
        if (open) form.querySelector('#serverUrl').focus();
    }

    note(text, { error = false } = {}) {
        const note = this.$('[data-add-note]');
        note.textContent = text || '';
        note.hidden = !text;
        note.classList.toggle('text-error', error);
    }

    // A URL is added and connected. A work email asks Glean where that company's Glean is; the
    // sign-in window opens now, during the click, so pop-up blockers allow it.
    async addServer() {
        const value = this.$('#serverUrl').value.trim();
        const alias = this.$('#serverAlias').value.trim();
        if (EMAIL.test(value)) {
            const popup = this.shell.openSignInWindow("Looking up your company's Glean…");
            this.note("Looking up your company's Glean…");
            try {
                const { url } = await this.shell.addGleanServer(value, popup);
                if (alias) this.shell.updateServerDetails(url, { alias });
            } catch (error) {
                this.note(error.message, { error: true });
                return;
            }
        } else if (/^https?:\/\/\S+$/i.test(value)) {
            this.shell.addServer(value, alias);
        } else {
            this.note('Enter the server\'s full address, starting with https:// or http://, or your work email to find your Glean.', { error: true });
            this.$('#serverUrl').focus();
            return;
        }
        this.$('#serverUrl').value = '';
        this.$('#serverAlias').value = '';
        this.toggleAddForm(false);
    }

    // --- Saved requests and collections ---

    async renderSaved() {
        const box = this.$('#savedList');
        if (!box) return;
        const [requests, collections] = await Promise.all([store.listRequests(), store.listCollections()]);
        if (!requests.length && !collections.length) {
            box.innerHTML = '<p class="wb-list-note">Nothing saved yet. Fill in a tool and choose Save to keep a request you want to run again.</p>';
            return;
        }
        const latest = new Map(await Promise.all(requests.map(async request => [request.id, await store.latestRun(`request:${request.id}`)])));
        const report = this.workbench.report?.done ? this.workbench.report : null;
        const groups = [
            ...collections.sort((a, b) => a.name.localeCompare(b.name)).map(collection => ({ collection, id: collection.id })),
            { collection: null, id: '' },
        ];
        box.innerHTML = groups.map(({ collection, id }) => {
            const members = requests.filter(request => (request.collectionId || '') === id).sort((a, b) => a.createdAt - b.createdAt);
            if (!collection && !members.length) return '';
            const name = collection ? collection.name : 'Not in a collection';
            const open = !this.collapsed.has(id);
            const changed = report && (report.collection.id || '') === id
                ? report.results.filter(({ message }) => verdictOf(message.run) === 'changed').length
                : 0;
            return `
                <section class="saved-group" data-collection="${escapeHtml(id)}">
                    <div class="saved-group-head">
                        <button type="button" class="wb-caret-btn" data-toggle-collection="${escapeHtml(id)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHtml(name)}"><span class="wb-caret" aria-hidden="true"></span></button>
                        <span class="saved-group-name" data-name>${escapeHtml(name)}</span>
                        <span class="wb-meta">${members.length}</span>
                        ${changed ? `<span class="badge badge-warning">${changed} changed</span>` : ''}
                        <span class="saved-group-actions">
                            <button type="button" class="btn-sm" data-run-collection="${escapeHtml(id)}" title="Run every request in ${escapeHtml(name)}" ${members.length ? '' : 'disabled'}><span class="icon icon-play" aria-hidden="true"></span>Run all</button>
                            ${collection ? `<details class="menu item-menu"><summary class="btn-icon btn-sm btn-tertiary" aria-label="More for ${escapeHtml(name)}"><span class="wb-more" aria-hidden="true">⋯</span></summary><div class="menu-list" role="menu">
                                <button type="button" class="menu-item" data-rename-collection="${escapeHtml(id)}">Rename</button>
                                <button type="button" class="menu-item" data-delete-collection="${escapeHtml(id)}">Delete the collection (keeps its requests)</button>
                            </div></details>` : ''}
                        </span>
                    </div>
                    <ul class="saved-items" ${open ? '' : 'hidden'}>${members.map(request => `
                        <li class="saved-item" data-request="${escapeHtml(request.id)}">
                            <button type="button" class="saved-open" data-open-request="${escapeHtml(request.id)}" title="${escapeHtml(`${request.toolName} on ${this.workbench.serverLabel(request.serverUrl)}`)}">
                                <span class="saved-name" data-name>${escapeHtml(request.name)}</span>
                            </button>
                            ${verdictChip(latest.get(request.id))}
                            <button type="button" class="btn-icon btn-sm btn-tertiary wb-row-action" data-run-request="${escapeHtml(request.id)}" title="Run" aria-label="Run ${escapeHtml(request.name)}"><span class="icon icon-play" aria-hidden="true"></span></button>
                            <details class="menu item-menu wb-row-action"><summary class="btn-icon btn-sm btn-tertiary" aria-label="More for ${escapeHtml(request.name)}"><span class="wb-more" aria-hidden="true">⋯</span></summary><div class="menu-list" role="menu">
                                <button type="button" class="menu-item" data-rename-request="${escapeHtml(request.id)}">Rename</button>
                                <button type="button" class="menu-item" data-delete-request="${escapeHtml(request.id)}">Delete</button>
                            </div></details>
                        </li>`).join('')}
                    </ul>
                </section>`;
        }).join('');
        this.markOpenRequest();
    }

    markOpenRequest() {
        const open = this.workbench.openRequest?.id;
        this.querySelectorAll('.saved-item').forEach(item => {
            if (item.dataset.request === open) item.setAttribute('aria-current', 'true');
            else item.removeAttribute('aria-current');
        });
    }

    // --- Recent runs ---

    async renderRecent() {
        const list = this.$('#recentRuns');
        if (!list) return;
        const runs = await store.listRuns({ limit: RECENT_RUNS });
        list.innerHTML = runs.length
            ? runs.map(run => `
                <li>
                    <button type="button" class="wb-row wb-recent" data-open-run="${escapeHtml(run.id)}" title="${escapeHtml(`${run.toolName} on ${this.workbench.serverLabel(run.serverUrl)}`)}">
                        <span class="wb-row-label mono">${escapeHtml(run.toolName)}</span>
                        ${verdictChip(run)}
                        <span class="wb-meta">${escapeHtml(timeAgo(run.startedAt))}</span>
                    </button>
                </li>`).join('')
            : '<li class="wb-list-note">No runs yet. Every tool call lands here, from the Workbench and the Chat app.</li>';
    }

    // --- Clicks ---

    async clicked(event) {
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        const { dataset } = target;
        target.closest('details.menu')?.removeAttribute('open');
        if (target.id === 'addServerToggle') return this.toggleAddForm();
        if (dataset.cancelAdd !== undefined) return this.toggleAddForm(false);
        if (target.id === 'exportSavedBtn') return this.workbench.exportData();
        if (target.id === 'importSavedBtn') return this.$('#importSavedInput').click();
        if (dataset.showRuns !== undefined) return this.workbench.setDock({ open: true, tab: 'runs' });
        if (dataset.url) return this.shell.selectServer(dataset.url);
        if (dataset.openRun) return this.workbench.openRun(dataset.openRun);
        if (dataset.openRequest) return this.workbench.openSaved(dataset.openRequest);
        if (dataset.runRequest) return this.workbench.runSaved(dataset.runRequest);
        if (dataset.runCollection !== undefined) return this.workbench.runCollection(dataset.runCollection);
        if (dataset.toggleCollection !== undefined) {
            const id = dataset.toggleCollection;
            if (this.collapsed.has(id)) this.collapsed.delete(id);
            else this.collapsed.add(id);
            sessionStorage.setItem('railCollapsed', JSON.stringify([...this.collapsed]));
            return this.renderSaved();
        }
        if (dataset.renameRequest) {
            const item = target.closest('.saved-item');
            const current = item.querySelector('[data-name]').textContent;
            return renameInPlace(item.querySelector('[data-name]'), current, name => this.workbench.renameRequest(dataset.renameRequest, name), () => this.renderSaved());
        }
        if (dataset.renameCollection) {
            const name = target.closest('.saved-group').querySelector('.saved-group-name');
            return renameInPlace(name, name.textContent, value => this.workbench.renameCollection(dataset.renameCollection, value), () => this.renderSaved());
        }
        if (dataset.deleteRequest) return this.workbench.deleteRequest(dataset.deleteRequest);
        if (dataset.deleteCollection) return this.workbench.deleteCollection(dataset.deleteCollection);
    }
}
