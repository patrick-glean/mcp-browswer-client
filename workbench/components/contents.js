// The response area while the tool list shows resources or prompts: what the last read returned
// (text, with JSON indented; images and audio shown; other binary data to download) or the
// messages the last prompt came back with, and the raw JSON. Each list keeps its own last answer.

import { escapeHtml, formatMs, plural } from '../util.js';
import { WbElement } from './base.js';
import { contentHtml } from './response.js';

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

function textHtml(text, mime) {
    const trimmed = text.trim();
    if (/json/i.test(mime) || /^[[{]/.test(trimmed)) {
        try {
            return `<pre class="wb-content-json">${escapeHtml(JSON.stringify(JSON.parse(trimmed), null, 2))}</pre>`;
        } catch { /* not JSON after all */ }
    }
    return `<div class="wb-content-text">${escapeHtml(text)}</div>`;
}

const fileName = uri => String(uri || 'resource').split(/[/:]/).filter(Boolean).pop() || 'resource';

// One item a resource read returned: its URI and type, then the text or the binary data.
function resourceItemHtml(item) {
    const mime = String(item?.mimeType || '');
    const head = `<div class="wb-content-head"><span class="mono">${escapeHtml(item?.uri || '')}</span>${mime ? `<span class="badge">${escapeHtml(mime)}</span>` : ''}</div>`;
    let body;
    if (typeof item?.text === 'string') {
        body = textHtml(item.text, mime);
    } else if (typeof item?.blob === 'string' && BASE64.test(item.blob)) {
        const data = item.blob.replace(/\s+/g, '');
        const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        const src = `data:${mime || 'application/octet-stream'};base64,${data}`;
        const preview = mime.startsWith('image/')
            ? `<img class="wb-content-image" src="${escapeHtml(src)}" alt="${escapeHtml(item.uri || 'Image')}">`
            : mime.startsWith('audio/') ? `<audio class="wb-content-audio" controls src="${escapeHtml(src)}"></audio>` : '';
        body = `${preview}<p class="text-secondary">${plural(bytes, 'byte')} of ${escapeHtml(mime || 'binary data')} · <a href="${escapeHtml(src)}" download="${escapeHtml(fileName(item.uri))}">Download</a></p>`;
    } else {
        body = `<pre class="wb-content-json">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
    }
    return `<div class="wb-content">${head}${body}</div>`;
}

function messageHtml(message) {
    return `<div class="wb-content wb-message"><div class="wb-content-head"><span class="badge">${escapeHtml(message?.role || 'message')}</span></div>${contentHtml(message?.content)}</div>`;
}

export class WbContents extends WbElement {
    setup(signal) {
        // The last read and the last prompt: { phase: 'pending' | 'done', label, reply }.
        this.shown = { resources: null, prompts: null };
        this.tab = 'contents';
        this.workbench.on('view', () => this.render(), signal);
        this.workbench.on('contents', detail => {
            this.shown[detail.view] = detail;
            if (detail.phase === 'pending') this.tab = 'contents';
            this.render();
        }, signal);
        this.shell.on('select', () => {
            this.shown = { resources: null, prompts: null };
            this.render();
        }, signal);
        this.addEventListener('click', event => {
            const tab = event.target.closest('[data-contents-tab]');
            if (!tab) return;
            this.tab = tab.dataset.contentsTab;
            this.render();
        }, { signal });
    }

    render() {
        const view = this.workbench.view;
        this.hidden = view === 'tools';
        if (this.hidden) return;
        const reading = view === 'resources';
        const shown = this.shown[view];
        if (!shown) {
            this.innerHTML = `<div class="wb-empty"><span>${reading ? 'Read a resource to see what it holds here.' : 'Get a prompt to see its messages here.'}</span><span class="text-secondary">⌘↵ or Ctrl+Enter ${reading ? 'reads' : 'gets'} it from anywhere on the page.</span></div>`;
            return;
        }
        if (shown.phase === 'pending') {
            this.innerHTML = `<div class="wb-empty" data-pending><span class="wb-spinner" aria-hidden="true"></span><span>${reading ? 'Reading' : 'Getting'} ${escapeHtml(shown.label)}…</span></div>`;
            return;
        }
        const { result, error, durationMs } = shown.reply;
        const outcome = error
            ? `<span class="badge badge-error">${error.kind === 'not_sent' ? 'Not sent' : `Failed${error.kind ? ` · ${escapeHtml(error.kind)}` : ''}`}</span>`
            : '<span class="badge badge-success">OK</span>';
        const took = typeof durationMs === 'number' ? `<span>${error ? 'Failed after' : 'Took'} ${formatMs(durationMs)}</span>` : '';
        const tabs = [['contents', reading ? 'Contents' : 'Messages'], ['json', 'JSON']];
        this.innerHTML = `
            <header class="wb-pane-head">
                <div class="run-summary">${outcome}${took}<span class="wb-spacer"></span><span class="text-secondary mono">${escapeHtml(shown.label)}</span></div>
                <div class="wb-tabs" role="tablist" aria-label="${reading ? 'What the resource holds' : 'What the prompt says'}">
                    ${tabs.map(([id, label]) => `<button type="button" role="tab" class="wb-tab" data-contents-tab="${id}" aria-selected="${id === this.tab}">${label}</button>`).join('')}
                </div>
            </header>
            <div class="wb-pane-body" data-contents-body>${this.bodyHtml(reading, result, error)}</div>`;
    }

    bodyHtml(reading, result, error) {
        if (this.tab === 'json') return `<pre class="wb-json">${escapeHtml(JSON.stringify(error ? { error } : result, null, 2))}</pre>`;
        if (error) return `<div class="wb-callout wb-callout-error" role="alert">${escapeHtml(error.message || 'Unknown error')}</div>`;
        if (reading) {
            const items = Array.isArray(result?.contents) ? result.contents : [];
            return items.map(resourceItemHtml).join('') || '<p class="text-secondary">The resource came back empty.</p>';
        }
        const messages = Array.isArray(result?.messages) ? result.messages : [];
        const description = result?.description ? `<p class="text-secondary">${escapeHtml(result.description)}</p>` : '';
        return description + (messages.map(messageHtml).join('') || '<p class="text-secondary">The prompt came back with no messages.</p>');
    }
}
