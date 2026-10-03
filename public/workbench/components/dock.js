// The dock along the bottom: Log (the log panel index.html builds, with its level, filter, copy
// and download), Trace (each HTTP request and response the WASM client made) and Runs (every
// stored run). It collapses to its tab row and can be dragged taller or shorter.

import * as store from '../store.js';
import { confirmThen, debounce, escapeHtml, formatMs, SOURCE_LABELS, timeAgo, verdictChip } from '../util.js';
import { WbElement } from './base.js';

const MIN_HEIGHT = 120;
const MAX_TRACE = 400;

export class WbDock extends WbElement {
    setup(signal) {
        this.refreshRunsSoon = debounce(() => this.renderRuns(), 250);
        this.traceDirty = true;
        this.workbench.on('dock', () => this.apply(), signal);
        this.workbench.on('runs', () => this.renderRuns(), signal);
        this.shell.on('recorded', () => {
            if (this.workbench.dock.tab === 'runs') this.refreshRunsSoon();
        }, signal);
        this.shell.on('select', () => {
            if (this.$('#runsThisServer')?.checked) this.renderRuns();
        }, signal);
        this.shell.logPanel.onAdd(entry => {
            if (!isTrace(entry)) return;
            if (this.workbench.dock.open && this.workbench.dock.tab === 'trace') this.appendTrace(entry);
            else this.traceDirty = true;
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('keydown', event => {
            const row = event.target.closest?.('tr[data-open-run]');
            if (row && event.key === 'Enter') this.workbench.openRun(row.dataset.openRun);
        }, { signal });
        this.addEventListener('change', event => {
            if (event.target.id === 'runsThisServer') this.renderRuns();
        }, { signal });
        this.addEventListener('pointerdown', event => this.startResize(event), { signal });
    }

    // The Log tab's contents are already in the page; this adds the other tabs around them.
    render() {
        if (!this.$('[data-dock-panel="trace"]')) {
            this.$('.wb-dock-body').insertAdjacentHTML('beforeend', `
                <div class="wb-dock-panel" data-dock-panel="trace" hidden>
                    <p class="wb-dock-note text-secondary">Every HTTP request and response the WASM client made, newest last. Bearer tokens and sign-in secrets are redacted.</p>
                    <div class="log-container wb-trace" id="traceList" role="log"></div>
                </div>
                <div class="wb-dock-panel" data-dock-panel="runs" hidden>
                    <div class="wb-dock-toolbar">
                        <label class="history-filter"><input type="checkbox" id="runsThisServer"> Only the selected server</label>
                        <span class="wb-spacer"></span>
                        <button type="button" id="clearHistoryBtn" class="btn-sm btn-tertiary btn-danger">Clear history</button>
                    </div>
                    <div id="runsList"></div>
                </div>`);
        }
        this.apply();
    }

    // Shows the open tab at the saved height, or only the tab row when collapsed.
    apply() {
        const { open, tab, height } = this.workbench.dock;
        this.dataset.open = String(open);
        this.style.setProperty('--dock-height', `${Math.max(MIN_HEIGHT, height)}px`);
        this.querySelectorAll('[data-dock-tab]').forEach(button => button.setAttribute('aria-selected', String(open && button.dataset.dockTab === tab)));
        this.querySelectorAll('[data-dock-panel]').forEach(panel => { panel.hidden = panel.dataset.dockPanel !== tab; });
        this.querySelectorAll('[data-dock-tools]').forEach(tools => { tools.hidden = !open || tools.dataset.dockTools !== tab; });
        const toggle = this.$('#dockToggle');
        toggle.textContent = open ? 'Collapse' : 'Expand';
        toggle.setAttribute('aria-expanded', String(open));
        if (!open) return;
        if (tab === 'log') this.shell.logPanel.markSeen();
        if (tab === 'trace' && this.traceDirty) this.renderTrace();
        if (tab === 'runs') this.renderRuns();
    }

    // --- Trace ---

    traceRow(entry) {
        const row = document.createElement('div');
        row.className = 'log-entry level-debug';
        const time = document.createElement('time');
        time.className = 'log-time';
        time.textContent = entry.time.slice(11, 23);
        const body = document.createElement('div');
        body.className = 'log-body';
        const message = document.createElement('span');
        message.className = 'log-message';
        message.textContent = entry.message;
        body.append(message);
        if (entry.server) {
            const server = document.createElement('span');
            server.className = 'log-server';
            server.textContent = ` ${entry.server}`;
            body.append(server);
        }
        if (entry.detail !== undefined) {
            const details = document.createElement('details');
            details.className = 'log-detail';
            details.innerHTML = '<summary>Details</summary><pre></pre>';
            details.addEventListener('toggle', () => {
                const pre = details.querySelector('pre');
                if (details.open && !pre.textContent) pre.textContent = JSON.stringify(entry.detail, null, 2);
            });
            body.append(details);
        }
        row.append(time, body);
        return row;
    }

    renderTrace() {
        const list = this.$('#traceList');
        const entries = this.shell.logPanel.entries.filter(isTrace).slice(-MAX_TRACE);
        list.replaceChildren(...entries.map(entry => this.traceRow(entry)));
        list.dataset.empty = 'No HTTP requests yet. Connect to a server or run a tool.';
        list.scrollTop = list.scrollHeight;
        this.traceDirty = false;
    }

    appendTrace(entry) {
        const list = this.$('#traceList');
        const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        list.append(this.traceRow(entry));
        while (list.childElementCount > MAX_TRACE) list.firstElementChild.remove();
        if (stick) list.scrollTop = list.scrollHeight;
    }

    // --- Runs ---

    async renderRuns() {
        const box = this.$('#runsList');
        if (!box) return;
        const onlySelected = this.$('#runsThisServer').checked;
        const runs = await store.listRuns({ limit: 200, serverUrl: onlySelected ? this.shell.selectedServerUrl : null });
        if (!runs.length) {
            box.innerHTML = '<p class="wb-list-note">No calls yet. Every tool call shows up here: from the Workbench, Run all, the Chat app, and tool calls found in replies.</p>';
            return;
        }
        box.innerHTML = `
            <table class="wb-table">
                <thead><tr><th>When</th><th>Tool</th><th>Server</th><th>From</th><th>Result</th><th>Took</th></tr></thead>
                <tbody>${runs.map(run => {
                    const outcome = run.outcome === 'failed'
                        ? `<span class="badge badge-error">${escapeHtml(run.errorKind || 'failed')}</span>`
                        : run.outcome === 'tool_error' ? '<span class="badge badge-error">tool error</span>' : verdictChip(run);
                    return `
                        <tr class="wb-run-row" data-open-run="${escapeHtml(run.id)}" data-source="${escapeHtml(run.source)}" tabindex="0">
                            <td>${escapeHtml(timeAgo(run.startedAt))}</td>
                            <td class="mono">${escapeHtml(run.toolName)}</td>
                            <td>${escapeHtml(this.workbench.serverLabel(run.serverUrl))}</td>
                            <td>${escapeHtml(SOURCE_LABELS[run.source] || run.source)}</td>
                            <td>${outcome}</td>
                            <td>${escapeHtml(formatMs(run.durationMs))}</td>
                        </tr>`;
                }).join('')}
                </tbody>
            </table>`;
    }

    // --- Resizing: drag the top edge ---

    startResize(event) {
        if (!event.target.closest('.wb-dock-grip') || !this.workbench.dock.open) return;
        event.preventDefault();
        const grip = event.target.closest('.wb-dock-grip');
        grip.setPointerCapture(event.pointerId);
        const max = () => Math.round(window.innerHeight * 0.7);
        const move = moved => {
            const height = Math.min(max(), Math.max(MIN_HEIGHT, window.innerHeight - moved.clientY));
            this.style.setProperty('--dock-height', `${height}px`);
            this.dragHeight = height;
        };
        const stop = () => {
            grip.removeEventListener('pointermove', move);
            if (this.dragHeight) this.workbench.setDock({ height: this.dragHeight });
            this.dragHeight = null;
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', stop, { once: true });
        grip.addEventListener('pointercancel', stop, { once: true });
    }

    clicked(event) {
        const target = event.target.closest('button, tr[data-open-run]');
        if (!target) return;
        if (target.dataset.dockTab) {
            const { open, tab } = this.workbench.dock;
            const chosen = target.dataset.dockTab;
            return this.workbench.setDock(open && tab === chosen ? { open: false } : { open: true, tab: chosen });
        }
        if (target.id === 'dockToggle') return this.workbench.setDock({ open: !this.workbench.dock.open });
        if (target.id === 'clearHistoryBtn') return confirmThen(target, () => this.workbench.clearRuns());
        if (target.dataset.openRun) return this.workbench.openRun(target.dataset.openRun);
    }
}

function isTrace(entry) {
    return entry.source === 'wasm' && entry.level === 'debug';
}
