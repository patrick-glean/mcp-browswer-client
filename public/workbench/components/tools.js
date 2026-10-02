// The selected server's capabilities: Tools (Resources and Prompts have their tabs, waiting for
// the client to support them), a filter, annotation filters, one line per tool, and the tools the
// client hides with the reason. Servers with many tools get groups built from shared name words.

import { escapeHtml, plural, serverLabel, toolHints, toolMatchesHint, toolTitle } from '../util.js';
import { WbElement } from './base.js';

// Fewer tools than this are listed without groups.
const GROUP_FROM = 13;
const HINT_FILTERS = [['all', 'All'], ['read', 'Read-only'], ['writes', 'Writes'], ['web', 'Reaches out']];

// Words from a tool name: list_issues -> list, issue; getPullRequest -> get, pull, request.
function nameWords(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 1)
        .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

// Groups tools by the most common word their names share; tools that share nothing go under Other.
export function groupTools(tools) {
    const words = tools.map(tool => [...new Set(nameWords(tool.name))]);
    const counts = new Map();
    words.flat().forEach(word => counts.set(word, (counts.get(word) || 0) + 1));
    const groups = new Map();
    tools.forEach((tool, index) => {
        const best = words[index]
            .filter(word => counts.get(word) >= 2 && counts.get(word) < tools.length)
            .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b))[0] || 'other';
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
            if (!url || url === this.shell.selectedServerUrl) this.renderList();
        };
        this.shell.on('tools', refresh, signal);
        this.shell.on('servers', refresh, signal);
        this.shell.on('auth', refresh, signal);
        this.workbench.on('tool', () => this.markSelected(), signal);
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

    render() {
        const server = this.server;
        const capabilities = server?.capabilities || {};
        const later = name => `${server ? serverLabel(server) : 'This server'} ${capabilities[name] ? `offers ${name}` : `doesn't declare ${name}`}; this client doesn't list them yet.`;
        this.innerHTML = `
            <div class="wb-cap-tabs" role="tablist" aria-label="What the server offers">
                <button type="button" role="tab" class="wb-tab" aria-selected="true">Tools <span id="toolCount" class="wb-meta"></span></button>
                <button type="button" role="tab" class="wb-tab" aria-selected="false" disabled title="${escapeHtml(later('resources'))}">Resources</button>
                <button type="button" role="tab" class="wb-tab" aria-selected="false" disabled title="${escapeHtml(later('prompts'))}">Prompts</button>
            </div>
            <div class="wb-tool-filter" hidden>
                <input type="search" id="toolFilter" placeholder="Filter tools" aria-label="Filter tools" aria-keyshortcuts="/" autocomplete="off" spellcheck="false">
                <div class="wb-chips" role="group" aria-label="Show tools that">
                    ${HINT_FILTERS.map(([id, label]) => `<button type="button" class="wb-chip" data-hint-filter="${id}" aria-pressed="${id === this.hintFilter}">${label}</button>`).join('')}
                </div>
            </div>
            <div class="wb-scroll">
                <ul id="toolList" class="wb-list" aria-label="Tools"></ul>
            </div>`;
        this.$('#toolFilter').value = this.query;
        this.renderList();
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

    renderList() {
        const list = this.$('#toolList');
        if (!list) return;
        const server = this.server;
        const tools = server?.tools || [];
        const hidden = server?.rejectedTools || [];
        this.$('.wb-tool-filter').hidden = tools.length < 2;
        const matches = tools.filter(tool => {
            const text = [tool.name, tool.title, tool.annotations?.title, tool.description].filter(Boolean).join(' ').toLowerCase();
            return (!this.query || text.includes(this.query)) && toolMatchesHint(tool, this.hintFilter);
        });
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
                    <button type="button" class="wb-row wb-tool" data-tool="${escapeHtml(tool.name)}" title="${escapeHtml(help)}">
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

    markSelected() {
        const name = this.workbench.tool?.name;
        this.querySelectorAll('.wb-tool').forEach(item => {
            if (item.dataset.tool === name) item.setAttribute('aria-current', 'true');
            else item.removeAttribute('aria-current');
        });
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.tool) return this.workbench.selectTool(button.dataset.tool);
        if (button.dataset.hintFilter) {
            this.hintFilter = button.dataset.hintFilter;
            return this.renderList();
        }
        if (button.dataset.group) {
            const word = button.dataset.group;
            if (this.closedGroups.has(word)) this.closedGroups.delete(word);
            else this.closedGroups.add(word);
            this.renderList();
        }
    }

    // Arrow keys move between tools; Escape clears the filter.
    keyed(event) {
        if (event.target.id === 'toolFilter') {
            if (event.key === 'Escape' && event.target.value) {
                event.stopPropagation();
                event.target.value = '';
                this.query = '';
                this.renderList();
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.querySelector('.wb-tool')?.focus();
            }
            return;
        }
        if (!event.target.classList?.contains('wb-tool') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const items = [...this.querySelectorAll('.wb-tool')].filter(item => item.offsetParent);
        const next = items[items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
        else if (event.key === 'ArrowUp') this.$('#toolFilter')?.focus();
    }
}
