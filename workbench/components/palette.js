// Go to (Cmd/Ctrl+K): jump to any server, any tool of any server, or a saved request.

import * as store from '../store.js';
import { escapeHtml, serverLabel } from '../util.js';
import { WbElement } from './base.js';

const MAX_RESULTS = 40;

export class WbPalette extends WbElement {
    setup(signal) {
        this.hidden = true;
        this.workbench.on('palette', () => this.open(), signal);
        this.addEventListener('input', () => this.renderResults(), { signal });
        this.addEventListener('keydown', event => this.keyed(event), { signal });
        this.addEventListener('click', event => {
            if (event.target === this) return this.close();
            const item = event.target.closest('[data-index]');
            if (item) this.choose(Number(item.dataset.index));
        }, { signal });
    }

    render() {
        this.innerHTML = `
            <div class="wb-palette" role="dialog" aria-modal="true" aria-label="Go to">
                <input type="text" id="paletteInput" placeholder="Go to a server, tool or saved request" autocomplete="off" spellcheck="false" aria-label="Go to" aria-controls="paletteResults">
                <ul id="paletteResults" class="wb-palette-results" role="listbox"></ul>
            </div>`;
    }

    async open() {
        this.returnFocus = document.activeElement;
        const servers = Object.values(this.shell.servers);
        const saved = await store.listRequests().catch(() => []);
        this.items = [
            ...servers.map(server => ({ label: serverLabel(server), detail: 'Server', go: () => this.shell.selectServer(server.url) })),
            ...saved.map(request => ({ label: request.name, detail: `Saved · ${request.toolName}`, go: () => this.workbench.openSaved(request.id) })),
            ...servers.flatMap(server => (server.tools || []).map(tool => ({
                label: tool.name,
                detail: `Tool · ${serverLabel(server)}`,
                go: () => this.workbench.showTool(server.url, tool.name),
            }))),
        ];
        this.hidden = false;
        const input = this.$('#paletteInput');
        input.value = '';
        this.renderResults();
        input.focus();
    }

    close() {
        if (this.hidden) return;
        this.hidden = true;
        this.returnFocus?.focus?.();
    }

    renderResults() {
        const query = this.$('#paletteInput').value.trim().toLowerCase();
        this.shown = (this.items || [])
            .filter(item => !query || `${item.label} ${item.detail}`.toLowerCase().includes(query))
            .slice(0, MAX_RESULTS);
        this.active = 0;
        this.$('#paletteResults').innerHTML = this.shown.length
            ? this.shown.map((item, index) => `
                <li role="option" class="wb-palette-item" data-index="${index}" aria-selected="${index === 0}">
                    <span class="wb-row-label">${escapeHtml(item.label)}</span>
                    <span class="wb-meta">${escapeHtml(item.detail)}</span>
                </li>`).join('')
            : '<li class="wb-list-note">Nothing matches.</li>';
    }

    highlight(index) {
        const items = this.querySelectorAll('.wb-palette-item');
        if (!items.length) return;
        this.active = (index + items.length) % items.length;
        items.forEach((item, position) => item.setAttribute('aria-selected', String(position === this.active)));
        items[this.active].scrollIntoView({ block: 'nearest' });
    }

    choose(index) {
        const item = this.shown?.[index];
        this.close();
        item?.go();
    }

    keyed(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            return this.close();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            return this.highlight(this.active + (event.key === 'ArrowDown' ? 1 : -1));
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            this.choose(this.active);
        }
    }
}
