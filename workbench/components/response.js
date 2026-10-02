// The response pane: a run's outcome, how long it took and whether its result changed since the
// last run of the same request, with the result, the lines that changed, the raw JSON and the
// request's other runs. It also shows the report of a Run all as it fills in.

import { hunks, lineDiff } from '../diff.js';
import { comparedValue, normalize } from '../runs.js';
import * as store from '../store.js';
import { escapeHtml, formatMs, plural, SOURCE_LABELS, timeAgo, verdictChip, verdictOf } from '../util.js';
import { WbElement } from './base.js';

const TABS = [['result', 'Result'], ['changes', 'Changes'], ['json', 'JSON'], ['runs', 'Runs']];
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

// The CallToolResult inside a tool_result message (older workers wrapped it once more).
function toolResultOf(message) {
    const result = message.result;
    if (!result || typeof result !== 'object') return null;
    if (Array.isArray(result.content) || 'structuredContent' in result || 'isError' in result) return result;
    return result.result && typeof result.result === 'object' ? result.result : result;
}

function dataUri(item, kind) {
    const mime = String(item.mimeType || '');
    if (!mime.startsWith(`${kind}/`) || typeof item.data !== 'string' || !BASE64.test(item.data)) return null;
    return `data:${mime};base64,${item.data.replace(/\s+/g, '')}`;
}

const safeLink = uri => (/^https?:\/\//i.test(uri || '') ? uri : null);

// One content block of a tool result. Text that is JSON is shown indented.
function contentHtml(item) {
    if (item?.type === 'text' && typeof item.text === 'string') {
        const trimmed = item.text.trim();
        if (/^[[{]/.test(trimmed)) {
            try {
                return `<pre class="wb-content-json">${escapeHtml(JSON.stringify(JSON.parse(trimmed), null, 2))}</pre>`;
            } catch { /* not JSON after all */ }
        }
        return `<div class="wb-content-text">${escapeHtml(item.text)}</div>`;
    }
    if (item?.type === 'image') {
        const src = dataUri(item, 'image');
        if (src) return `<img class="wb-content-image" src="${src}" alt="Image from the tool">`;
    }
    if (item?.type === 'audio') {
        const src = dataUri(item, 'audio');
        if (src) return `<audio class="wb-content-audio" controls src="${src}"></audio>`;
    }
    if (item?.type === 'resource_link') {
        const href = safeLink(item.uri);
        const label = escapeHtml(item.title || item.name || item.uri);
        return `<div class="wb-content-link"><span class="badge">link</span> ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="mono">${label}</span>`}${item.description ? ` <span class="text-secondary">${escapeHtml(item.description)}</span>` : ''}</div>`;
    }
    if (item?.type === 'resource' && item.resource) {
        const resource = item.resource;
        const body = typeof resource.text === 'string'
            ? `<pre class="wb-content-json">${escapeHtml(resource.text)}</pre>`
            : `<p class="text-secondary">${escapeHtml(resource.mimeType || 'Binary')} content, not shown.</p>`;
        return `<div class="wb-content-resource"><span class="badge">resource</span> <span class="mono">${escapeHtml(resource.uri || '')}</span>${body}</div>`;
    }
    return `<div class="tool-content-unknown"><span class="text-secondary">Content this client doesn't show yet:</span><pre class="wb-content-json">${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`;
}

export class WbResponse extends WbElement {
    setup(signal) {
        this.view = { kind: 'empty' };
        this.tab = 'result';
        this.shell.on('run', detail => this.runUpdate(detail), signal);
        this.workbench.on('show', ({ message }) => this.show(message ? { kind: 'message', message } : { kind: 'empty' }), signal);
        this.workbench.on('tool', ({ refreshed }) => {
            if (!refreshed && this.view.kind !== 'report') this.show({ kind: 'empty' });
        }, signal);
        this.workbench.on('report', ({ report }) => {
            // Once you've opened something else, the rest of the Run all fills in quietly.
            if (report.results.length && (this.view.kind !== 'report' || this.view.report !== report)) return;
            this.show({ kind: 'report', report });
        }, signal);
        this.shell.on('recorded', () => {
            if (this.view.kind === 'message' && this.tab === 'runs') this.renderTab();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('keydown', event => {
            const row = event.target.closest?.('tr[data-open-run]');
            if (row && event.key === 'Enter') this.workbench.openRun(row.dataset.openRun);
        }, { signal });
    }

    runUpdate({ phase, runId, toolName, message, error }) {
        if (phase === 'pending') {
            this.pendingRunId = runId;
            return this.show({ kind: 'pending', toolName });
        }
        if (phase === 'not-sent') {
            this.pendingRunId = null;
            return this.show({ kind: 'not-sent', error });
        }
        if (runId && this.pendingRunId && runId !== this.pendingRunId) return;
        this.pendingRunId = null;
        this.show({ kind: 'message', message });
    }

    show(view) {
        this.view = view;
        if (view.kind === 'message') this.tab = 'result';
        this.render();
    }

    render() {
        const view = this.view;
        if (view.kind === 'empty') {
            this.innerHTML = '<div class="wb-empty"><span>Run a tool to see its result here.</span><span class="text-secondary">⌘↵ or Ctrl+Enter runs it from anywhere on the page.</span></div>';
        } else if (view.kind === 'pending') {
            this.innerHTML = `<div class="wb-empty" data-pending><span class="wb-spinner" aria-hidden="true"></span><span>Running ${escapeHtml(view.toolName)}…</span></div>`;
        } else if (view.kind === 'not-sent') {
            this.innerHTML = `<div class="wb-pane-body"><div class="wb-callout wb-callout-error" role="alert"><strong>Not sent.</strong> ${escapeHtml(view.error)}</div></div>`;
        } else if (view.kind === 'report') {
            this.renderReport(view.report);
        } else {
            this.renderMessage(view.message);
        }
    }

    // --- One run ---

    renderMessage(message) {
        const run = message.run?.id ? message.run : null;
        const toolResult = toolResultOf(message);
        let outcome;
        if (message.error) outcome = `<span class="badge badge-error">${run ? 'Failed' : 'Not sent'}${message.errorKind && message.errorKind !== 'not_sent' ? ` · ${escapeHtml(message.errorKind)}` : ''}</span>`;
        else if (toolResult?.isError) outcome = '<span class="badge badge-error">Tool error</span>';
        else if (toolResult?.resultType === 'input_required') outcome = '<span class="badge badge-warning">Needs input</span>';
        else outcome = '<span class="badge badge-success">OK</span>';
        const parts = [outcome];
        if (typeof run?.durationMs === 'number') parts.push(`<span>${run.outcome === 'failed' ? 'Failed after' : 'Took'} ${formatMs(run.durationMs)}</span>`);
        const verdict = verdictOf(run);
        if (run?.changed === true) parts.push('<button type="button" class="link-button" data-show-changes>Changed since the last run</button>');
        else if (run?.changed === false) parts.push('<span class="badge badge-success">Same as the last run</span>');
        else if (run && verdict === 'first') parts.push('<span class="text-secondary">First run of this request</span>');
        parts.push('<span class="wb-spacer"></span>');
        if (message.fromHistory) {
            const source = SOURCE_LABELS[run.source] || run.source;
            parts.push(`<span class="text-secondary">From history · ${escapeHtml(source)} · ${escapeHtml(timeAgo(run.startedAt))}</span>`);
        }
        const report = this.workbench.report;
        if (run && report?.results.some(({ message: reported }) => reported.run?.id === run.id)) {
            parts.push('<button type="button" class="link-button" data-back-to-report>Back to the Run all report</button>');
        }
        this.innerHTML = `
            <header class="wb-pane-head">
                <div class="run-summary" ${run ? `data-run-id="${escapeHtml(run.id)}"` : ''}>${parts.join('')}</div>
                <div class="wb-tabs" role="tablist" aria-label="Response">
                    ${TABS.map(([id, label]) => {
                        const disabled = (id === 'changes' && !run?.previousRunId) || (id === 'runs' && !run);
                        return `<button type="button" role="tab" class="wb-tab" data-response-tab="${id}" aria-selected="${id === this.tab}" ${disabled ? 'disabled' : ''}>${label}</button>`;
                    }).join('')}
                </div>
            </header>
            <div class="wb-pane-body" data-response-body></div>`;
        this.renderTab();
        if (run) this.countRuns(run);
    }

    async countRuns(run) {
        const record = await store.getRun(run.id);
        if (!record?.compareKey || this.view.message?.run?.id !== run.id) return;
        const runs = await store.listRuns({ compareKey: record.compareKey, limit: 100 });
        const tab = this.$('[data-response-tab="runs"]');
        if (tab && this.view.message?.run?.id === run.id) tab.textContent = `Runs ${runs.length >= 100 ? '100+' : runs.length}`;
    }

    showTab(tab) {
        this.tab = tab;
        this.querySelectorAll('[data-response-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.responseTab === tab)));
        this.renderTab();
    }

    renderTab() {
        const body = this.$('[data-response-body]');
        const message = this.view.message;
        if (!body || !message) return;
        const run = message.run?.id ? message.run : null;
        if (this.tab === 'changes' && run) return this.renderChanges(body, run);
        if (this.tab === 'runs' && run) return this.renderRuns(body, run);
        if (this.tab === 'json') {
            const raw = message.result ?? message.resultText ?? { error: message.error, errorKind: message.errorKind };
            body.innerHTML = `<pre class="wb-json">${escapeHtml(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))}</pre>`;
            return;
        }
        body.innerHTML = this.resultHtml(message);
    }

    resultHtml(message) {
        if (message.error) return `<div class="wb-callout wb-callout-error">${escapeHtml(message.error)}</div>`;
        if (message.resultText) {
            return `<p class="tool-notice">The result was too big to keep in full, so history has its first 256 KB.</p><pre class="tool-truncated">${escapeHtml(message.resultText)}</pre>`;
        }
        const toolResult = toolResultOf(message);
        const notice = toolResult?.resultType === 'input_required'
            ? '<p class="tool-notice">The tool asked for more input (for example a form to fill in), which this client doesn\'t support yet.</p>'
            : toolResult?.isError ? '<p class="tool-notice text-error">The tool reported an error.</p>' : '';
        const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
        const structured = toolResult && 'structuredContent' in toolResult
            ? `<details class="tool-raw-json wb-structured" ${content.length ? '' : 'open'}><summary>Structured content</summary><pre>${escapeHtml(JSON.stringify(toolResult.structuredContent, null, 2))}</pre></details>`
            : '';
        const items = content.map(item => `<div class="wb-content">${contentHtml(item)}</div>`).join('');
        return `${notice}${items || (structured ? '' : '<p class="text-secondary">No content to show.</p>')}${structured}`;
    }

    // The lines that differ between this run and the previous run of the same request.
    async renderChanges(body, run) {
        body.innerHTML = '<p class="text-secondary">Comparing…</p>';
        const [record, previous] = await Promise.all([store.getRun(run.id), run.previousRunId ? store.getRun(run.previousRunId) : null]);
        if (this.view.message?.run?.id !== run.id || this.tab !== 'changes') return;
        if (!record || !previous) {
            body.innerHTML = '<p class="text-secondary">The earlier run is no longer in history, so there is nothing to compare with.</p>';
            return;
        }
        const text = stored => stored.resultText ?? JSON.stringify(normalize(comparedValue(stored)), null, 2);
        const lines = lineDiff(text(previous), text(record));
        const cut = record.truncated || previous.truncated ? ' One of the results was too big to keep in full, so only their starts are compared.' : '';
        const head = `<p class="diff-head text-secondary">Compared with the run from ${escapeHtml(new Date(previous.startedAt).toLocaleString())}, ignoring _meta.${cut} <button type="button" class="link-button" data-open-run="${escapeHtml(previous.id)}">Open that run</button></p>`;
        if (!lines) {
            body.innerHTML = `${head}<p class="text-secondary">The results differ too much to compare line by line; open both from History to see them.</p>`;
        } else if (!lines.some(line => line.kind !== 'same')) {
            body.innerHTML = `${head}<p class="text-secondary">No differences.</p>`;
        } else {
            const shown = hunks(lines).map(line => {
                if (line.kind === 'gap') return `<span class="diff-gap">… ${plural(line.count, 'unchanged line')}</span>`;
                const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
                return `<span class="diff-line diff-${line.kind}">${mark} ${escapeHtml(line.text)}</span>`;
            }).join('');
            body.innerHTML = `${head}<pre class="diff">${shown}</pre>`;
        }
    }

    // Every stored run of the same request, newest first.
    async renderRuns(body, run) {
        const record = await store.getRun(run.id);
        const runs = record?.compareKey ? await store.listRuns({ compareKey: record.compareKey, limit: 100 }) : [];
        if (this.view.message?.run?.id !== run.id || this.tab !== 'runs') return;
        if (!runs.length) {
            body.innerHTML = '<p class="text-secondary">This run is no longer in history.</p>';
            return;
        }
        body.innerHTML = `
            <table class="wb-table">
                <thead><tr><th>When</th><th>From</th><th>Result</th><th>Took</th></tr></thead>
                <tbody>${runs.map(other => `
                    <tr data-open-run="${escapeHtml(other.id)}" tabindex="0" ${other.id === run.id ? 'aria-current="true"' : ''}>
                        <td>${escapeHtml(timeAgo(other.startedAt))}</td>
                        <td>${escapeHtml(SOURCE_LABELS[other.source] || other.source)}</td>
                        <td>${verdictChip(other)}</td>
                        <td>${escapeHtml(formatMs(other.durationMs))}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
    }

    // --- Run all ---

    renderReport(report) {
        const counts = { same: 0, changed: 0, first: 0, failed: 0 };
        report.results.forEach(({ message }) => counts[verdictOf(message.run) || 'failed']++);
        const parts = [`${counts.same} same`, `${counts.changed} changed`, `${counts.failed} failed`];
        if (counts.first) parts.push(`${counts.first} first ${counts.first === 1 ? 'run' : 'runs'}`);
        const heading = report.done ? `Ran ${report.total}: ${parts.join(', ')}` : `Running ${report.results.length + 1} of ${report.total}…`;
        this.innerHTML = `
            <header class="wb-pane-head">
                <nav class="wb-crumb" aria-label="This report">Run all</nav>
                <div class="wb-title-row">
                    <h2 class="wb-request-title">${escapeHtml(report.collection.name)}</h2>
                    <span class="wb-spacer"></span>
                    <button type="button" class="btn-sm" data-run-collection="${escapeHtml(report.collection.id || '')}" ${report.done ? '' : 'disabled'}><span class="icon icon-play" aria-hidden="true"></span>Run again</button>
                    <button type="button" class="btn-sm btn-tertiary" data-close-report>Close</button>
                </div>
                <p class="collection-run-summary" aria-live="polite">${escapeHtml(heading)}</p>
            </header>
            <div class="wb-pane-body">
                <table class="wb-table">
                    <thead><tr><th>Result</th><th>Request</th><th>Tool</th><th>Took</th></tr></thead>
                    <tbody>${report.results.map(({ request, message }) => {
                        const id = message.run?.id;
                        return `
                            <tr ${id ? `data-open-run="${escapeHtml(id)}" tabindex="0"` : ''}>
                                <td>${verdictChip(message.run) || '<span class="badge badge-error">not sent</span>'}</td>
                                <td>${escapeHtml(request.name)}</td>
                                <td class="mono">${escapeHtml(request.toolName)}</td>
                                <td>${id ? escapeHtml(formatMs(message.run.durationMs)) : escapeHtml(message.error || '')}</td>
                            </tr>`;
                    }).join('')}
                    </tbody>
                </table>
                ${report.results.length ? '<p class="text-secondary wb-table-note">Open a row to see its result and what changed.</p>' : ''}
            </div>`;
    }

    clicked(event) {
        const target = event.target.closest('button, tr[data-open-run]');
        if (!target || target.disabled) return;
        const { dataset } = target;
        if (dataset.responseTab) return this.showTab(dataset.responseTab);
        if (dataset.showChanges !== undefined) return this.showTab('changes');
        if (dataset.openRun) return this.workbench.openRun(dataset.openRun);
        if (dataset.runCollection !== undefined) return this.workbench.runCollection(dataset.runCollection);
        if (dataset.closeReport !== undefined) return this.show({ kind: 'empty' });
        if (dataset.backToReport !== undefined && this.workbench.report) return this.show({ kind: 'report', report: this.workbench.report });
    }
}
