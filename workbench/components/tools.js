// What the selected server offers, a tab each. Tools: a filter, annotation filters, one line per
// tool, and the tools the client hides with the reason; servers with many tools get groups built
// from shared name words. Resources: its resources, then its resource templates. Prompts: its
// prompts with how many arguments they take. Picking one shows it in the request area.

import { escapeHtml, plural, serverLabel, toolHints, toolMatchesHint, toolTitle } from '../util.js';
import { itemKey } from '../workbench.js';
import { WbElement } from './base.js';

// Fewer tools than this are listed without groups.
const GROUP_FROM = 13;
const HINT_FILTERS = [['all', 'All'], ['read', 'Read-only'], ['writes', 'Writes'], ['web', 'Reaches out']];
const VIEWS = [['tools', 'Tools'], ['resources', 'Resources'], ['prompts', 'Prompts']];

// Verbs say what a tool does, not what it works on, so they don't name groups.
const VERBS = new Set(['get', 'list', 'create', 'update', 'delete', 'add', 'remove', 'set', 'run', 'read', 'write', 'find',
    'fetch', 'edit', 'upload', 'share', 'merge', 'push', 'fork', 'make', 'put', 'post', 'send', 'open', 'close']);

// What a tool name could be grouped by: its nouns and pairs of them in a row.
// list_pull_requests -> pull, request, pull request; getIssue -> issue.
function nameTerms(name) {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 1 && !VERBS.has(word))
        .map(word => {
            if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
            if (/(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
            return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
        });
    const pairs = words.slice(1).map((word, index) => `${words[index]} ${word}`);
    return [...new Set([...words, ...pairs])];
}

// Groups tools by the term their names share most; a pair wins a tie with its words. Tools that
// share nothing go under Other.
export function groupTools(tools) {
    const terms = tools.map(tool => nameTerms(tool.name));
    const counts = new Map();
    terms.flat().forEach(term => counts.set(term, (counts.get(term) || 0) + 1));
    const groups = new Map();
    tools.forEach((tool, index) => {
        const best = terms[index]
            .filter(term => counts.get(term) >= 2 && counts.get(term) < tools.length)
            .sort((a, b) => counts.get(b) - counts.get(a) || b.split(' ').length - a.split(' ').length || a.localeCompare(b))[0] || 'other';
        if (!groups.has(best)) groups.set(best, []);
        groups.get(best).push(tool);
    });
    // Groups of one join Other.
    const other = groups.get('other') || [];
    for (const [word, members] of [...groups]) {
        if (word !== 'other' && members.length < 2) {
            other.push(...members);
            groups.delete(word);
        }
    }
    groups.delete('other');
    const sorted = [...groups].sort(([a], [b]) => a.localeCompare(b));
    if (other.length) sorted.push(['other', other]);
    return sorted;
}

export class WbTools extends WbElement {
    setup(signal) {
        this.query = '';
        this.hintFilter = 'all';
        this.closedGroups = new Set();
        this.shell.on('select', () => {
            this.query = '';
            this.hintFilter = 'all';
            this.render();
        }, signal);
        const refresh = ({ url }) => {
            if (url && url !== this.shell.selectedServerUrl) return;
            // A server that lost its resources or prompts (or its connection) can't keep their tab open.
            if (!this.offers(this.workbench.view)) return this.workbench.showView('tools');
            this.renderTabs();
            this.renderList();
        };
        this.shell.on('tools', refresh, signal);
        this.shell.on('catalog', refresh, signal);
        this.shell.on('servers', refresh, signal);
        this.shell.on('auth', refresh, signal);
        this.workbench.on('tool', () => this.markSelected(), signal);
        this.workbench.on('item', () => this.markSelected(), signal);
        this.workbench.on('view', () => {
            this.query = '';
            this.render();
        }, signal);
        this.addEventListener('input', event => {
            if (event.target.id !== 'toolFilter') return;
            this.query = event.target.value.trim().toLowerCase();
            this.renderList();
        }, { signal });
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('keydown', event => this.keyed(event), { signal });
    }

    get server() {
        return this.shell.servers[this.shell.selectedServerUrl] || null;
    }

    // Whether a tab can open: tools always; resources and prompts when the connected server says
    // it has them, or listed some.
    offers(view) {
        if (view === 'tools') return true;
        const server = this.server;
        if (server?.status !== 'connected') return false;
        const items = view === 'resources' ? [...(server.resources || []), ...(server.resourceTemplates || [])] : server.prompts || [];
        return !!(server.capabilities?.[view] || items.length);
    }

    render() {
        const view = this.workbench.view;
        if (!this.offers(view)) return this.workbench.showView('tools');
        this.innerHTML = `
            <div class="wb-cap-tabs" role="tablist" aria-label="What the server offers"></div>
            <div class="wb-tool-filter" hidden>
                <input type="search" id="toolFilter" placeholder="Filter ${view}" aria-label="Filter ${view}" aria-keyshortcuts="/" autocomplete="off" spellcheck="false">
                <div class="wb-chips" role="group" aria-label="Show tools that" ${view === 'tools' ? '' : 'hidden'}>
                    ${HINT_FILTERS.map(([id, label]) => `<button type="button" class="wb-chip" data-hint-filter="${id}" aria-pressed="${id === this.hintFilter}">${label}</button>`).join('')}
                </div>
            </div>
            <div class="wb-scroll">
                <ul id="toolList" class="wb-list" aria-label="${VIEWS.find(([id]) => id === view)[1]}"></ul>
            </div>`;
        this.$('#toolFilter').value = this.query;
        this.renderTabs();
        this.renderList();
    }

    renderTabs() {
        const tabs = this.$('.wb-cap-tabs');
        if (!tabs) return;
        const server = this.server;
        const counts = {
            tools: server?.tools?.length || 0,
            resources: (server?.resources?.length || 0) + (server?.resourceTemplates?.length || 0),
            prompts: server?.prompts?.length || 0,
        };
        tabs.innerHTML = VIEWS.map(([id, label]) => {
            const available = this.offers(id);
            const why = available ? ''
                : server?.status === 'connected' ? `${serverLabel(server)} doesn't offer ${id}`
                    : `Connect to see what ${server ? serverLabel(server) : 'the server'} offers`;
            return `<button type="button" role="tab" class="wb-tab" data-view="${id}" aria-selected="${id === this.workbench.view}" ${available ? '' : 'disabled'} ${why ? `title="${escapeHtml(why)}"` : ''}>${label} <span ${id === 'tools' ? 'id="toolCount"' : ''} class="wb-meta">${counts[id] || ''}</span></button>`;
        }).join('');
    }

    emptyState(server) {
        if (!server) return 'Pick a server on the left to see its tools.';
        const auth = this.shell.authStatus[server.url];
        if (this.shell.signingIn?.url === server.url) return 'Signing in…';
        if (server.needsSignIn && !auth?.signedIn) return 'Sign in to see what this server offers.';
        if (server.status === 'connecting') return 'Connecting…';
        if (server.status === 'failed') return "Couldn't connect, so there's no tool list. The bar above says why.";
        if (server.status !== 'connected') return 'Connect to see what this server offers.';
        return 'This server offers no tools.';
    }

    matches(fields) {
        return !this.query || fields.filter(Boolean).join(' ').toLowerCase().includes(this.query);
    }

    renderList() {
        const list = this.$('#toolList');
        if (!list) return;
        const view = this.workbench.view;
        if (view === 'tools') return this.renderTools(list);
        const server = this.server;
        const total = view === 'resources'
            ? (server?.resources?.length || 0) + (server?.resourceTemplates?.length || 0)
            : server?.prompts?.length || 0;
        this.$('.wb-tool-filter').hidden = total < 2;
        list.innerHTML = view === 'resources' ? this.resourcesHtml(server) : this.promptsHtml(server);
        this.markSelected();
    }

    renderTools(list) {
        const server = this.server;
        const tools = server?.tools || [];
        const hidden = server?.rejectedTools || [];
        this.$('.wb-tool-filter').hidden = tools.length < 2;
        const matches = tools.filter(tool => this.matches([tool.name, tool.title, tool.annotations?.title, tool.description]) && toolMatchesHint(tool, this.hintFilter));
        const filtered = this.query || this.hintFilter !== 'all';
        this.$('#toolCount').textContent = !tools.length ? '' : filtered ? `${matches.length} of ${tools.length}` : String(tools.length);
        this.querySelectorAll('[data-hint-filter]').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.hintFilter === this.hintFilter)));

        if (!tools.length && !hidden.length) {
            list.innerHTML = `<li class="wb-list-note">${escapeHtml(this.emptyState(server))}</li>`;
            return;
        }
        const row = tool => {
            const title = toolTitle(tool);
            const help = [title, tool.description].filter(Boolean).join(': ');
            return `
                <li>
                    <button type="button" class="wb-row wb-tool wb-pick" data-tool="${escapeHtml(tool.name)}" title="${escapeHtml(help)}">
                        <span class="wb-row-label mono">${escapeHtml(tool.name)}</span>
                        <span class="wb-hints">${toolHints(tool)}</span>
                    </button>
                </li>`;
        };
        let html = '';
        if (tools.length >= GROUP_FROM && !filtered) {
            html = groupTools(matches).map(([word, members]) => {
                const open = !this.closedGroups.has(word);
                return `
                    <li class="wb-group">
                        <button type="button" class="wb-group-head" data-group="${escapeHtml(word)}" aria-expanded="${open}">
                            <span class="wb-caret" aria-hidden="true"></span>${escapeHtml(word)}<span class="wb-meta">${members.length}</span>
                        </button>
                        <ul class="wb-list" ${open ? '' : 'hidden'}>${members.map(row).join('')}</ul>
                    </li>`;
            }).join('');
        } else {
            html = matches.map(row).join('') || '<li class="wb-list-note">No tools match.</li>';
        }
        if (hidden.length) {
            html += `
                <li class="wb-group wb-hidden-tools" id="hiddenTools">
                    <p class="wb-hidden-head">${plural(hidden.length, 'hidden tool')}: the client won't call ${hidden.length === 1 ? 'it' : 'them'}</p>
                    <ul class="wb-list">${hidden.map(tool => `
                        <li class="wb-row wb-tool-hidden" title="${escapeHtml(tool.reason || '')}">
                            <span class="wb-row-label mono">${escapeHtml(tool.name ?? '(unnamed)')}</span>
                            <span class="wb-hidden-reason">${escapeHtml(tool.reason || 'no reason given')}</span>
                        </li>`).join('')}
                    </ul>
                </li>`;
        }
        list.innerHTML = html;
        this.markSelected();
    }

    resourcesHtml(server) {
        if (server.resourcesError) return `<li class="wb-list-note">${escapeHtml(`Couldn't list the resources: ${server.resourcesError}`)}</li>`;
        if (!server.resources && !server.resourceTemplates) return '<li class="wb-list-note">Listing resources…</li>';
        const resources = server.resources || [];
        const templates = server.resourceTemplates || [];
        if (!resources.length && !templates.length) return '<li class="wb-list-note">This server offers no resources.</li>';
        const shownResources = resources.filter(item => this.matches([item.name, item.title, item.uri, item.description]));
        const shownTemplates = templates.filter(item => this.matches([item.name, item.title, item.uriTemplate, item.description]));
        if (!shownResources.length && !shownTemplates.length) return '<li class="wb-list-note">No resources match.</li>';
        const row = (kind, item, address) => `
            <li>
                <button type="button" class="wb-row wb-pick wb-row-stack" data-${kind}="${escapeHtml(address)}" title="${escapeHtml([item.description, item.mimeType].filter(Boolean).join(' · '))}">
                    <span class="wb-row-label">${escapeHtml(item.title || item.name || address)}</span>
                    <span class="wb-row-sub mono">${escapeHtml(address)}</span>
                </button>
            </li>`;
        let html = shownResources.map(item => row('resource', item, item.uri)).join('');
        if (shownTemplates.length) {
            html += `
                <li class="wb-group">
                    <p class="wb-group-label">${plural(shownTemplates.length, 'template')}: fill in the URI, then read it</p>
                    <ul class="wb-list">${shownTemplates.map(item => row('template', item, item.uriTemplate)).join('')}</ul>
                </li>`;
        }
        return html;
    }

    promptsHtml(server) {
        if (server.promptsError) return `<li class="wb-list-note">${escapeHtml(`Couldn't list the prompts: ${server.promptsError}`)}</li>`;
        if (!server.prompts) return '<li class="wb-list-note">Listing prompts…</li>';
        if (!server.prompts.length) return '<li class="wb-list-note">This server offers no prompts.</li>';
        const prompts = server.prompts.filter(item => this.matches([item.name, item.title, item.description]));
        if (!prompts.length) return '<li class="wb-list-note">No prompts match.</li>';
        return prompts.map(prompt => {
            const count = Array.isArray(prompt.arguments) ? prompt.arguments.length : 0;
            return `
                <li>
                    <button type="button" class="wb-row wb-pick" data-prompt="${escapeHtml(prompt.name)}" title="${escapeHtml([prompt.title, prompt.description].filter(Boolean).join(': '))}">
                        <span class="wb-row-label mono">${escapeHtml(prompt.name)}</span>
                        <span class="wb-hints">${count ? `<span class="hint" title="${escapeHtml(plural(count, 'argument'))}">${plural(count, 'arg')}</span>` : ''}</span>
                    </button>
                </li>`;
        }).join('');
    }

    markSelected() {
        const tool = this.workbench.tool?.name;
        const picked = this.workbench.item;
        const key = picked ? itemKey(picked.kind, picked.item) : null;
        this.querySelectorAll('.wb-pick').forEach(row => {
            const current = row.dataset.tool !== undefined ? row.dataset.tool === tool : !!picked && row.dataset[picked.kind] === key;
            if (current) row.setAttribute('aria-current', 'true');
            else row.removeAttribute('aria-current');
        });
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const { dataset } = button;
        if (dataset.view) return this.workbench.showView(dataset.view);
        if (dataset.tool) return this.workbench.selectTool(dataset.tool);
        if (dataset.resource) return this.workbench.selectItem('resource', dataset.resource);
        if (dataset.template) return this.workbench.selectItem('template', dataset.template);
        if (dataset.prompt) return this.workbench.selectItem('prompt', dataset.prompt);
        if (dataset.hintFilter) {
            this.hintFilter = dataset.hintFilter;
            return this.renderList();
        }
        if (dataset.group) {
            const word = dataset.group;
            if (this.closedGroups.has(word)) this.closedGroups.delete(word);
            else this.closedGroups.add(word);
            this.renderList();
        }
    }

    // Arrow keys move along the list; Escape clears the filter.
    keyed(event) {
        if (event.target.id === 'toolFilter') {
            if (event.key === 'Escape' && event.target.value) {
                event.stopPropagation();
                event.target.value = '';
                this.query = '';
                this.renderList();
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.querySelector('.wb-pick')?.focus();
            }
            return;
        }
        if (!event.target.classList?.contains('wb-pick') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const items = [...this.querySelectorAll('.wb-pick')].filter(item => item.offsetParent);
        const next = items[items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
        else if (event.key === 'ArrowUp') this.$('#toolFilter')?.focus();
    }
}
