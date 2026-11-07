// The Glean artifacts bridge's tools: what a team made in Glean (its artifacts: pages, documents,
// messages and more), listed newest first and shown one at a time, as data and as HTML an app can
// put on its screen. The same tools run in two places: here in the worker, as a demo server over a
// made-up team's artifacts (artifact-samples.js), and in glean-bridge/, a Node server that gets a
// real team's from Glean's own MCP server. Where the artifacts come from is a source:
//
//   { name: 'demo' | 'glean', label,
//     async list({ count }) -> { team, artifacts: [artifact] }, newest first,
//     async read(artifact) -> { format: 'html' | 'markdown' | 'text', text } or null }
//
// An artifact: { id, title, type, kind?, author, department?, createdAt?, updatedAt?, version?,
// url, summary }. Its HTML goes on a screen that runs no scripts and loads nothing from the
// network, so what's drawn here is inline styles and SVG, and a page's own styles are kept inside
// its preview.

import { SAMPLE_ARTIFACTS, SAMPLE_TEAM } from './artifact-samples.js';
import { mcpServer } from './mcp.js';

// Each type an artifact can be, with the word people know it by and its icon.
export const TYPES = {
    html: { kind: 'Page', icon: 'page', colors: ['#3730a3', '#7c3aed'] },
    paper: { kind: 'Document', icon: 'doc', colors: ['#1d4ed8', '#0ea5e9'] },
    message: { kind: 'Message', icon: 'message', colors: ['#0f766e', '#14b8a6'] },
    email: { kind: 'Email', icon: 'email', colors: ['#0369a1', '#38bdf8'] },
    spreadsheet: { kind: 'Spreadsheet', icon: 'sheet', colors: ['#15803d', '#4ade80'] },
    slides: { kind: 'Slides', icon: 'slides', colors: ['#c2410c', '#fbbf24'] },
    image: { kind: 'Image', icon: 'image', colors: ['#be185d', '#f472b6'] },
    podcast: { kind: 'Podcast', icon: 'podcast', colors: ['#6d28d9', '#db2777'] },
    video: { kind: 'Video', icon: 'video', colors: ['#b91c1c', '#f97316'] },
    other: { kind: 'Artifact', icon: 'spark', colors: ['#334155', '#64748b'] },
};

// Glean's names for them, as its search's type filter and read_document's docType say them.
const GLEAN_TYPES = {
    html: 'html', html_code: 'html', inline_html: 'html', paper: 'paper', message: 'message', email: 'email', spreadsheet: 'spreadsheet',
    slide: 'slides', slides: 'slides', image: 'image', podcast: 'podcast', video: 'video',
};
export const typeOf = name => GLEAN_TYPES[String(name ?? '').trim().toLowerCase()] || 'other';

// How many of the team's newest artifacts the tools go through.
export const LIMIT = { min: 1, max: 24, default: 12 };

const ICONS = {
    page: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    message: '<path d="M4 5h16v11H9l-5 4z"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    sheet: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>',
    podcast: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

const icon = (name, size = 16) => `<svg class="ga-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.spark}</svg>`;

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// When something changed, as people say it: "2 hours ago", "yesterday", "on Oct 3".
export function ago(iso, now = Date.now()) {
    const time = Date.parse(iso ?? '');
    if (!Number.isFinite(time)) return '';
    const minutes = Math.max(0, Math.floor((now - time) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 14) return 'last week';
    if (days < 30) return `${Math.round(days / 7)} weeks ago`;
    const date = new Date(time);
    const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
    return `on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' })}`;
}

const initials = name => String(name ?? '').split(/\s+/).filter(Boolean).map(word => word[0]).slice(0, 2).join('').toUpperCase() || '?';
const hueOf = text => [...String(text ?? '')].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) % 360, 7);
const avatar = (name, extra = '') => `<span class="ga-avatar${extra}" style="--ga-hue: ${hueOf(name)}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;

// Markdown as HTML, for a document's preview: headings, paragraphs, lists, quotes, code, tables,
// rules and links, with everything else escaped. Links go only to web addresses.
export function markdownHtml(markdown) {
    const inline = text => escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const isRow = line => /^\s*\|.*\|\s*$/.test(line ?? '');
    const isRule = line => /^\s*\|?\s*:?-{3,}/.test(line ?? '');
    const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    const startsBlock = (line, next) => /^(#{1,6}\s|\s*```|\s*>)/.test(line) || bullet.test(line) || numbered.test(line) || (isRow(line) && isRule(next));
    const out = [];
    let at = 0;
    while (at < lines.length) {
        const line = lines[at];
        if (!line.trim()) {
            at++;
        } else if (/^\s*```/.test(line)) {
            const code = [];
            for (at++; at < lines.length && !/^\s*```/.test(lines[at]); at++) code.push(lines[at]);
            at++;
            out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        } else if (/^#{1,6}\s/.test(line)) {
            const [, hashes, text] = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
            out.push(`<h${hashes.length}>${inline(text)}</h${hashes.length}>`);
            at++;
        } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push('<hr>');
            at++;
        } else if (isRow(line) && isRule(lines[at + 1])) {
            const head = cells(line);
            const rows = [];
            for (at += 2; at < lines.length && isRow(lines[at]); at++) rows.push(cells(lines[at]));
            const row = (values, tag) => `<tr>${values.map(value => `<${tag}>${inline(value)}</${tag}>`).join('')}</tr>`;
            out.push(`<table><thead>${row(head, 'th')}</thead><tbody>${rows.map(values => row(values, 'td')).join('')}</tbody></table>`);
        } else if (/^\s*>/.test(line)) {
            const quote = [];
            while (at < lines.length && /^\s*>/.test(lines[at])) quote.push(lines[at++].replace(/^\s*>\s?/, ''));
            out.push(`<blockquote>${markdownHtml(quote.join('\n'))}</blockquote>`);
        } else if (bullet.test(line) || numbered.test(line)) {
            const marker = numbered.test(line) ? numbered : bullet;
            const items = [];
            while (at < lines.length && marker.test(lines[at])) items.push(lines[at++].replace(marker, ''));
            const tag = marker === numbered ? 'ol' : 'ul';
            out.push(`<${tag}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
        } else {
            const paragraph = [lines[at++].trim()];
            while (at < lines.length && lines[at].trim() && !startsBlock(lines[at], lines[at + 1])) paragraph.push(lines[at++].trim());
            out.push(`<p>${inline(paragraph.join(' '))}</p>`);
        }
    }
    return out.join('\n');
}

// The most of a page's HTML a preview takes; a bigger one shows as a poster.
const MAX_PAGE = 400_000;

// What of an artifact's HTML its preview shows: the body without anything that runs, loads or
// navigates, and its styles, reaching only inside the element with class `scope` (its html, body
// and :root rules apply to that element). The screen sanitizes HTML again as it shows it; this
// keeps a page's look from reaching the carousel around it. `live` is a page that draws itself
// with scripts, which leaves nothing to see without them.
export function htmlPreview(html, scope = 'ga-page') {
    const source = String(html ?? '');
    if (source.length > MAX_PAGE) return { html: '', css: '', live: false, tooBig: true };
    const css = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => match[1]).join('\n');
    const body = (source.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? source.replace(/<head\b[\s\S]*?<\/head\s*>/i, ''))
        .replace(/<(script|style|noscript|template|iframe|object|title|head|frameset)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?(html|body|form)\b[^>]*>/gi, '')
        .replace(/<(script|link|meta|base|embed|iframe|frame|object)\b[^>]*>/gi, '')
        .replace(/<img\b(?![^>]*\bsrc\s*=\s*["']?data:)[^>]*>/gi, '')
        .replace(/\s(?:on[a-z]+|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s(?:href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
        .trim();
    const text = body.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    const rules = css.replace(/@import[^;]*;/gi, '').replace(/(^|[\s,{}>+~])(?:html|body|:root)(?=[\s,{.:#[>+~]|$)/g, '$1:scope').trim();
    return {
        html: body,
        css: rules ? `@scope (.${scope}) {\n${rules}\n}` : '',
        live: /<script\b/i.test(source) && text.length < 80,
        tooBig: false,
    };
}

// A string's own pseudo-random numbers, the same each time: a podcast's waveform.
function* numbersFrom(text) {
    let seed = [...String(text)].reduce((hash, char) => (hash * 33 + char.codePointAt(0)) >>> 0, 5381) || 1;
    for (;;) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        yield (seed >>> 8) / 0xffffff;
    }
}

function waveform(id) {
    const numbers = numbersFrom(id);
    const bars = Array.from({ length: 36 }, (_, at) => {
        const height = 10 + Math.round(numbers.next().value * 46);
        return `<rect x="${at * 7}" y="${(60 - height) / 2}" width="4" height="${height}" rx="2"/>`;
    });
    return `<svg class="ga-wave" viewBox="0 0 250 60" fill="currentColor" aria-hidden="true">${bars.join('')}</svg>`;
}

const poster = (artifact, type, note = '') => `<div class="ga-poster" style="--ga-from: ${TYPES[type].colors[0]}; --ga-to: ${TYPES[type].colors[1]}">
      ${icon(TYPES[type].icon, 54)}${type === 'podcast' || type === 'video' ? waveform(artifact.id) : ''}
      <p class="ga-poster-title">${escapeHtml(artifact.title)}</p>${note ? `\n      <p class="ga-poster-note">${escapeHtml(note)}</p>` : ''}
    </div>`;

// What a slide shows of an artifact, by its type and what read() gave: the page, small; the
// document as a page; the message as a message; and a poster for the rest. With the CSS that
// goes with it, and a note on what's left out.
function previewOf(artifact, type, content) {
    const text = typeof content?.text === 'string' ? content.text : '';
    const format = content?.format;
    if (type === 'html' && format === 'html' && text.trim()) {
        const page = htmlPreview(text);
        if (page.tooBig) return { html: poster(artifact, type), note: "It's too big to preview here: open it in Glean to see it." };
        if (page.live || !page.html) return { html: poster(artifact, type), note: "It draws itself with scripts, which don't run outside Glean: open it there to see it live." };
        return {
            css: page.css,
            html: `<div class="ga-window">
      <div class="ga-chrome"><i></i><i></i><i></i><span>${escapeHtml(artifact.title)}</span></div>
      <div class="ga-viewport"><div class="ga-zoom"><div class="ga-page">${page.html}</div></div></div>
    </div>`,
            note: /<script\b/i.test(text) ? 'Its scripts and live data run only in Glean.' : '',
        };
    }
    if ((type === 'message' || type === 'email') && text.trim()) {
        return {
            html: `<div class="ga-chat">
      <div class="ga-bubble">
        <div class="ga-bubble-from">${avatar(artifact.author)}<strong>${escapeHtml(artifact.author || 'Someone on your team')}</strong><span>${escapeHtml(TYPES[type].kind)}</span></div>
        <div class="ga-bubble-text">${markdownHtml(text.slice(0, 4000))}</div>
      </div>
    </div>`,
        };
    }
    if (text.trim() && (format === 'markdown' || format === 'text')) {
        const sheet = type === 'spreadsheet';
        return {
            html: `<div class="ga-window${sheet ? ' ga-grid' : ''}">
      <div class="ga-chrome"><i></i><i></i><i></i><span>${escapeHtml(artifact.title)}</span></div>
      <div class="ga-viewport"><div class="ga-zoom"><div class="ga-page ga-doc">${format === 'markdown' ? markdownHtml(text.slice(0, 20_000)) : `<p>${escapeHtml(text.slice(0, 6000))}</p>`}</div></div></div>
    </div>`,
        };
    }
    return { html: poster(artifact, type), note: type === 'podcast' || type === 'video' ? `Play it in Glean.` : '' };
}

// What every slide and strip need: the accent, and the people's initials.
const BASE_CSS = `
.ga-slide, .ga-strip { --ga-accent: #343ced; --ga-on-accent: #ffffff; white-space: normal; }
@media (prefers-color-scheme: dark) { .ga-slide, .ga-strip { --ga-accent: #a9aeff; --ga-on-accent: #14163a; } }
.ga-icon { flex: none; }
.ga-avatar { display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%; background: hsl(var(--ga-hue) 62% 42%); color: #fff; font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.02em; }
.ga-avatar-sm { width: 20px; height: 20px; font-size: 0.5625rem; }`;

const SLIDE_CSS = `${BASE_CSS}
.ga-slide { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; align-items: center; box-sizing: border-box; height: 100%; padding: 22px 26px; }
@media (max-width: 700px) { .ga-slide { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px; } }
.ga-preview { position: relative; height: 316px; min-width: 0; }
.ga-window, .ga-chat, .ga-poster { position: absolute; inset: 0; overflow: hidden; border-radius: 14px; }
.ga-window { display: flex; flex-direction: column; border: 1px solid var(--line, #dedede); background: #ffffff; box-shadow: 0 14px 34px -18px rgba(16, 24, 64, 0.45); }
.ga-chrome { display: flex; flex: none; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-bottom: 1px solid #e6e7ee; background: #f3f4f8; color: #646a7c; font: 12px/1 system-ui, sans-serif; }
.ga-chrome i { width: 9px; height: 9px; border-radius: 50%; background: #d3d5de; }
.ga-chrome span { overflow: hidden; margin-left: 8px; text-overflow: ellipsis; white-space: nowrap; }
.ga-viewport { position: relative; flex: 1; overflow: hidden; background: #ffffff; }
.ga-zoom { width: calc(100% / 0.6); transform: scale(0.6); transform-origin: 0 0; pointer-events: none; user-select: none; }
.ga-page { min-height: 100%; white-space: normal; }
.ga-doc { box-sizing: border-box; padding: 34px 44px; color: #1f2328; font: 16px/1.6 system-ui, sans-serif; }
.ga-doc h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.2; letter-spacing: -0.02em; }
.ga-doc h2 { margin: 22px 0 8px; font-size: 20px; }
.ga-doc h3 { margin: 18px 0 6px; font-size: 17px; }
.ga-doc p, .ga-doc ul, .ga-doc ol { margin: 0 0 12px; }
.ga-doc ul, .ga-doc ol { padding-left: 24px; }
.ga-doc table { width: 100%; margin: 0 0 14px; border-collapse: collapse; font-size: 15px; }
.ga-doc th, .ga-doc td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }
.ga-doc th { color: #59606e; font-weight: 600; }
.ga-doc code { padding: 1px 5px; border-radius: 5px; background: #eef0f4; font: 0.9em ui-monospace, Menlo, monospace; }
.ga-doc blockquote { margin: 0 0 12px; padding-left: 14px; border-left: 4px solid #d5d8e0; color: #59606e; }
.ga-grid .ga-doc { padding: 0; }
.ga-grid .ga-doc table { margin: 0; font-size: 15px; }
.ga-grid .ga-doc th, .ga-grid .ga-doc td { padding: 9px 12px; border: 1px solid #dfe3e8; }
.ga-grid .ga-doc th { background: #eef6f0; color: #1f5133; }
.ga-chat { display: grid; align-content: center; padding: 26px; background: linear-gradient(160deg, #e7f6f3, #f5fbfa); }
.ga-bubble { overflow: hidden; max-height: 100%; padding: 16px 18px; border-radius: 4px 16px 16px 16px; background: #ffffff; color: #1f2328; box-shadow: 0 10px 26px -16px rgba(15, 76, 70, 0.5); font: 14px/1.5 system-ui, sans-serif; }
.ga-bubble-from { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ga-bubble-from span:last-child { color: #6b7280; font-size: 12px; }
.ga-bubble-text p, .ga-bubble-text ul { margin: 0 0 8px; }
.ga-bubble-text ul { padding-left: 20px; }
.ga-poster { display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 28px 32px; background: linear-gradient(135deg, var(--ga-from), var(--ga-to)); color: #ffffff; }
.ga-poster .ga-icon { opacity: 0.92; }
.ga-wave { width: 100%; height: 60px; opacity: 0.85; }
.ga-poster-title { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; }
.ga-poster-note { margin: 0; opacity: 0.85; font-size: 0.875rem; }
.ga-about { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ga-kind { display: flex; align-items: center; gap: 7px; margin: 0; color: var(--ga-accent); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.ga-title { margin: 0; font-size: 1.6rem; line-height: 1.2; letter-spacing: -0.02em; }
.ga-summary { display: -webkit-box; overflow: hidden; margin: 0; color: var(--muted, #727272); -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.ga-byline { display: flex; align-items: center; gap: 10px; margin-top: 2px; font-size: 0.875rem; line-height: 1.35; }
.ga-byline strong, .ga-byline small { display: block; }
.ga-byline small { color: var(--muted, #727272); font-size: inherit; }
.ga-open { display: inline-flex; align-items: center; align-self: flex-start; gap: 7px; margin-top: 6px; padding: 9px 18px; border-radius: 999px; background: var(--ga-accent); color: var(--ga-on-accent); font-weight: 600; text-decoration: none; }
.ga-open:hover { filter: brightness(1.08); }
.ga-note { margin: 0; color: var(--muted, #727272); font-size: 0.8125rem; }`;

const STRIP_CSS = `${BASE_CSS}
.ga-strip { display: flex; gap: 10px; margin: 0; padding: 3px 3px 8px; overflow-x: auto; overflow-anchor: none; list-style: none; scrollbar-width: thin; }
.ga-strip li { flex: 0 0 172px; }
.ga-strip a { display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; height: 100%; padding: 10px 12px; border: 1px solid var(--line, #dedede); border-radius: 12px; background: var(--bg, #ffffff); color: inherit; text-decoration: none; transition: border-color 0.15s, box-shadow 0.15s; }
.ga-strip a:hover { border-color: var(--ga-accent); }
.ga-strip-kind { display: flex; align-items: center; gap: 5px; color: var(--ga-accent); font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.ga-strip-title { display: -webkit-box; overflow: hidden; font-size: 0.8125rem; font-weight: 600; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.ga-strip-by { display: flex; align-items: center; gap: 6px; margin-top: auto; color: var(--muted, #727272); font-size: 0.75rem; }`;

// One artifact as a slide: its preview beside what it is, who made it and when, with a link that
// opens it in Glean. `at` and `of` say where it is in the team's list; when the strip of all of
// them (stripHtml) is beside it, its styles point it out there and start the strip with it, the
// ones after it following as Next goes, so it's in view without scripts to scroll to it. `note`
// says why the preview isn't all of it, when the preview doesn't.
export function slideHtml(artifact, content, { at = 1, of = 1, now = Date.now(), note = '' } = {}) {
    const type = TYPES[artifact.type] ? artifact.type : 'other';
    const preview = previewOf(artifact, type, content);
    if (note) preview.note = note;
    const kind = [artifact.kind || TYPES[type].kind, artifact.version ? `v${artifact.version}` : ''].filter(Boolean).join(' · ');
    const when = ago(artifact.updatedAt, now);
    const byline = [artifact.department, when && `updated ${when}`].filter(Boolean).map(line => `<small>${escapeHtml(line)}</small>`).join('');
    const after = Array.from({ length: Math.max(0, of - at + 1) }, (_, index) => `[data-at="${at + index}"]`);
    const current = `.ga-strip [data-at="${at}"] a { border-color: var(--ga-accent); box-shadow: inset 0 0 0 1px var(--ga-accent); }${at > 1
        ? `\n.ga-strip li { order: 1; }\n.ga-strip li:is(${after.join(', ')}) { order: 0; }`
        : ''}`;
    return `<style>${SLIDE_CSS}
${current}${preview.css ? `\n${preview.css}` : ''}
</style>
<article class="ga-slide ga-${type}" aria-label="${escapeHtml(`${at} of ${of}: ${artifact.title}`)}">
  <div class="ga-preview" aria-hidden="true">
    ${preview.html}
  </div>
  <div class="ga-about">
    <p class="ga-kind">${icon(TYPES[type].icon)}<span>${escapeHtml(kind)}</span></p>
    <h3 class="ga-title">${escapeHtml(artifact.title)}</h3>${artifact.summary ? `\n    <p class="ga-summary">${escapeHtml(artifact.summary)}</p>` : ''}
    <div class="ga-byline">${avatar(artifact.author)}<span><strong>${escapeHtml(artifact.author || 'Someone on your team')}</strong>${byline}</span></div>
    <a class="ga-open" href="${escapeHtml(artifact.url)}">Open in Glean ${icon('external', 14)}</a>${preview.note ? `\n    <p class="ga-note">${escapeHtml(preview.note)}</p>` : ''}
  </div>
</article>`;
}

// Every artifact in the list, newest first, as a strip of cards that each open it in Glean.
export function stripHtml(artifacts, { now = Date.now() } = {}) {
    const cards = artifacts.map((artifact, index) => {
        const type = TYPES[artifact.type] ? artifact.type : 'other';
        return `  <li data-at="${index + 1}"><a href="${escapeHtml(artifact.url)}" title="${escapeHtml(`Open “${artifact.title}” in Glean`)}">
    <span class="ga-strip-kind">${icon(TYPES[type].icon, 13)}${escapeHtml(artifact.kind || TYPES[type].kind)}</span>
    <span class="ga-strip-title">${escapeHtml(artifact.title)}</span>
    <span class="ga-strip-by">${avatar(artifact.author, ' ga-avatar-sm')}${escapeHtml(ago(artifact.updatedAt, now) || artifact.author || '')}</span>
  </a></li>`;
    });
    return `<style>${STRIP_CSS}
</style>
<ol class="ga-strip" aria-label="Every artifact, newest first">
${cards.join('\n')}
</ol>`;
}

// --- The tools ---

const ARTIFACT = {
    type: 'object',
    properties: {
        id: { type: 'string', description: "The artifact's ID in Glean." },
        title: { type: 'string', description: 'Its name, as Glean shows it.' },
        type: { type: 'string', enum: Object.keys(TYPES), description: 'What it is: html for a page or dashboard, paper for a document, message, email, spreadsheet, slides, image, podcast or video, and other for the rest.' },
        kind: { type: 'string', description: 'What it is in a word for people: Dashboard, Document, Message.' },
        author: { type: 'string', description: 'Who made it.' },
        department: { type: 'string', description: 'Their department, when Glean says.' },
        createdAt: { type: 'string', format: 'date-time', description: 'When it was made, when Glean says.' },
        updatedAt: { type: 'string', format: 'date-time', description: 'When it last changed, when Glean says.' },
        version: { type: 'integer', minimum: 1, description: 'How many versions it has had, when Glean says.' },
        url: { type: 'string', format: 'uri', description: 'Where it opens in Glean, for people who may see it.' },
        summary: { type: 'string', description: 'What it is, in a sentence or two from its start.' },
    },
    required: ['id', 'title', 'type', 'kind', 'author', 'url', 'summary'],
};

const SOURCE = { type: 'string', enum: ['glean', 'demo'], description: 'Where the artifacts came from: Glean, or the made-up team of the demo.' };

const LIMIT_ARG = {
    type: 'integer', minimum: LIMIT.min, maximum: LIMIT.max, default: LIMIT.default,
    description: "How many of the team's newest artifacts to go through.",
};

const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const text = value => ({ type: 'text', text: value });
const failed = why => ({ content: [text(why)], isError: true });
const htmlResource = (uri, html) => ({ type: 'resource', resource: { uri, mimeType: 'text/html', text: html } });

const count = (value, { min, max, fallback }) => {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

// An artifact's ID, from the ID or its address in Glean.
export const artifactId = value => String(value ?? '').trim().match(/\/library\/([\w-]+)/)?.[1] || String(value ?? '').trim();

// An artifact as the tools give it: what it says, without empty values, and its kind.
function described(artifact) {
    const type = TYPES[artifact.type] ? artifact.type : 'other';
    const kept = Object.fromEntries(Object.entries(artifact).filter(([key, value]) => key in ARTIFACT.properties && value !== undefined && value !== null && value !== ''));
    return { ...kept, type, kind: artifact.kind || TYPES[type].kind, author: artifact.author || 'Someone on your team', summary: artifact.summary || '' };
}

const listedLine = (total, source) => (total
    ? `${total} artifact${total === 1 ? '' : 's'}${total > 1 ? ', newest first' : ''} · ${source.label}`
    : `No artifacts yet · ${source.label}`);

// The tools, over a source. `now` is the time relative dates are from.
export function artifactTools(source, { now = () => Date.now() } = {}) {
    const team = async limit => {
        const found = await source.list({ count: limit });
        return { team: found.team || 'your team', artifacts: (found.artifacts || []).slice(0, limit).map(described) };
    };
    return [
        {
            name: 'list_team_artifacts',
            title: "List your team's artifacts",
            description: "Lists the Glean artifacts your team made, newest first: pages and dashboards, documents, messages and the rest, each with its ID, title, type, author, when it last changed and its address in Glean. Use it to see what the team has made, then get_artifact to show one. It lists only the team this server is set up for. Its HTML is a strip of cards, one for each, that open them in Glean.",
            annotations: READS,
            inputSchema: { type: 'object', properties: { limit: LIMIT_ARG }, additionalProperties: false },
            outputSchema: {
                type: 'object',
                properties: {
                    team: { type: 'string', description: "The team's name, or “your team” when the server doesn't know it." },
                    heading: { type: 'string', description: 'A heading for the list: “Built by” and the team.' },
                    summary: { type: 'string', description: 'The list in a line: how many there are, and where they came from.' },
                    total: { type: 'integer', minimum: 0, description: 'How many artifacts are listed.' },
                    artifacts: { type: 'array', items: ARTIFACT, description: 'The artifacts, newest first.' },
                    source: SOURCE,
                },
                required: ['team', 'heading', 'summary', 'total', 'artifacts', 'source'],
            },
            async call({ limit } = {}) {
                const listed = await team(count(limit, { min: LIMIT.min, max: LIMIT.max, fallback: LIMIT.default }));
                const found = {
                    team: listed.team,
                    heading: `Built by ${listed.team}`,
                    summary: listedLine(listed.artifacts.length, source),
                    total: listed.artifacts.length,
                    artifacts: listed.artifacts,
                    source: source.name,
                };
                return {
                    content: [text(JSON.stringify(found)), htmlResource('glean-artifacts://team/strip', stripHtml(listed.artifacts, { now: now() }))],
                    structuredContent: found,
                };
            },
        },
        {
            name: 'get_artifact',
            title: 'Get an artifact',
            description: "Gets one of your team's artifacts to show: what list_team_artifacts says of it, its content (a page's HTML, a document's Markdown or a message's text, as Glean gives it) and a slide that shows it, as HTML. Name it by its ID, or by its place in the team's list (at, from 1) and a step from there (-1 for the one before, 1 for the one after), which wraps around at the ends: a carousel's Next sends the place it shows and step 1. It gets only artifacts in the team's list. The slide's preview leaves out scripts and anything from the network, so a page that draws itself with scripts shows as a poster; its url opens it in full in Glean.",
            annotations: READS,
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: "The artifact's ID, from list_team_artifacts, or its address in Glean. Leave it out to name it by its place instead.", examples: [SAMPLE_ARTIFACTS[0].id] },
                    at: { type: 'integer', minimum: 1, default: 1, description: "Its place in the team's list, newest first, from 1. Used when there's no id." },
                    step: { type: 'integer', minimum: -1, maximum: 1, default: 0, description: 'Where to go from at: -1 for the one before, 1 for the one after, 0 for that one. The list wraps around.' },
                    limit: LIMIT_ARG,
                },
                additionalProperties: false,
            },
            outputSchema: {
                type: 'object',
                properties: {
                    position: { type: 'integer', minimum: 1, description: "Its place in the team's list, from 1: what a carousel sends as at for its next step." },
                    total: { type: 'integer', minimum: 1, description: 'How many artifacts are in the list.' },
                    artifact: ARTIFACT,
                    content: {
                        type: 'object',
                        description: "What's in it, as Glean gives it. Absent for one with nothing to read, such as a podcast.",
                        properties: {
                            format: { type: 'string', enum: ['html', 'markdown', 'text'], description: 'html for a page, markdown for a document, text for a message.' },
                            text: { type: 'string', description: 'The content itself.' },
                        },
                        required: ['format', 'text'],
                    },
                    source: SOURCE,
                },
                required: ['position', 'total', 'artifact', 'source'],
            },
            async call({ id, at, step, limit } = {}) {
                const { artifacts } = await team(count(limit, { min: LIMIT.min, max: LIMIT.max, fallback: LIMIT.default }));
                const total = artifacts.length;
                if (!total) return failed("Your team hasn't made any artifacts this server can show yet.");
                let index;
                if (id !== undefined && String(id).trim()) {
                    index = artifacts.findIndex(artifact => artifact.id === artifactId(id));
                    if (index < 0) return failed(`${String(id).trim()} isn't one of your team's ${total} newest artifacts. list_team_artifacts lists them, with their IDs.`);
                } else {
                    const from = count(at, { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 }) - 1;
                    index = (((from + count(step, { min: -1, max: 1, fallback: 0 })) % total) + total) % total;
                }
                const artifact = artifacts[index];
                let read = null;
                let note = '';
                try {
                    read = await source.read(artifact);
                } catch {
                    note = "Glean didn't send what's in it just now, so this is a stand-in: open it in Glean to see it.";
                }
                const content = typeof read?.text === 'string' && ['html', 'markdown', 'text'].includes(read.format) ? { format: read.format, text: read.text } : null;
                const found = { position: index + 1, total, artifact, ...(content ? { content } : {}), source: source.name };
                return {
                    content: [text(JSON.stringify(found)), htmlResource(`glean-artifacts://slides/${encodeURIComponent(artifact.id)}`, slideHtml(artifact, content, { at: index + 1, of: total, now: now(), note }))],
                    structuredContent: found,
                };
            },
        },
    ];
}

export const ARTIFACT_INSTRUCTIONS = `Shows the artifacts a team made in Glean: pages and dashboards, documents, messages and more.

- list_team_artifacts lists the team's newest, with each one's ID, title, type, author and address in Glean.
- get_artifact gets one, by its ID or its place in that list, with its content and a slide that shows it as HTML. A carousel steps through the list with at (the place it shows) and step.
- Both answer only for the team this server is set up for, with the artifacts that team made.
- The previews leave out scripts and anything from the network. To see an artifact in full, with its live data, open its url in Glean.`;

// The artifacts' icon, for serverInfo: a card on a stack of cards.
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#343ced" stroke-width="2" stroke-linejoin="round"><rect x="6" y="5" width="12" height="14" rx="2"/><path d="M3 8v8M21 8v8"/></svg>';
export const ARTIFACT_ICON = `data:image/svg+xml;base64,${btoa(ICON_SVG)}`;

// The demo's source: the made-up team (artifact-samples.js), each artifact changed `hoursAgo`
// before `now`. Their addresses are made up too, so they open nothing.
export function demoSource({ now = () => Date.now() } = {}) {
    return {
        name: 'demo',
        label: 'a made-up team, for the demo',
        async list({ count: wanted = LIMIT.default } = {}) {
            const at = now();
            const when = hours => new Date(at - hours * 3_600_000).toISOString();
            return {
                team: SAMPLE_TEAM,
                artifacts: SAMPLE_ARTIFACTS.slice(0, wanted).map(({ content, hoursAgo, ageDays, ...artifact }) => ({
                    ...artifact,
                    department: SAMPLE_TEAM,
                    createdAt: when(hoursAgo + ageDays * 24),
                    updatedAt: when(hoursAgo),
                    url: `https://glean.demo.invalid/library/${artifact.id}`,
                })),
            };
        },
        async read(artifact) {
            return SAMPLE_ARTIFACTS.find(sample => sample.id === artifact.id)?.content ?? null;
        },
    };
}

// A server of these tools over a source: the demo server, or the bridge with Glean behind it.
export function artifactsServer(source, { name = 'glean-artifacts', version = '0.1.0', about = {}, now } = {}) {
    return mcpServer({
        name,
        version,
        about: {
            title: 'Glean artifacts',
            description: 'The artifacts a team made in Glean, listed and shown one at a time, as data and as HTML for an app to put on its screen.',
            icons: [{ src: ARTIFACT_ICON, mimeType: 'image/svg+xml', sizes: ['any'] }],
            ...about,
        },
        instructions: ARTIFACT_INSTRUCTIONS,
        tools: artifactTools(source, { now }),
    });
}
