// A Markdown renderer for the server guide: headings with the anchors GitHub gives them,
// paragraphs, lists with task boxes, tables, fenced code, block quotes, and inline code, bold,
// italics and links. That's the Markdown the guide uses. Anything else stays text, and HTML in
// the source is escaped rather than rendered. Tables split cells on every unescaped |, as GitHub
// does, so a table that renders here renders there too.

export const escapeHtml = text => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as hyphens.
export function slug(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

// The text an HTML fragment shows.
export function textOf(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// `link(href)` decides where a link goes: {href, external?, file?}. `file` marks a file of the
// guide's own that the page can show in place.
function anchor(href, html, link) {
    const target = link(href);
    const attributes = [`href="${escapeHtml(target.href)}"`];
    if (target.external) attributes.push('target="_blank"', 'rel="noopener noreferrer"');
    if (target.file) attributes.push(`data-file="${escapeHtml(target.file)}"`);
    return `<a ${attributes.join(' ')}>${html}</a>`;
}

export function inline(source, link = href => ({ href })) {
    let html = '';
    let i = 0;
    while (i < source.length) {
        const rest = source.slice(i);
        if (rest[0] === '`') {
            const run = /^`+/.exec(rest)[0];
            const end = source.indexOf(run, i + run.length);
            if (end > 0) {
                const code = source.slice(i + run.length, end);
                html += `<code>${escapeHtml(/^ .* $/.test(code) ? code.slice(1, -1) : code)}</code>`;
                i = end + run.length;
                continue;
            }
        }
        const linked = rest[0] === '[' && /^\[((?:`[^`]*`|[^\]])+)\]\(([^)\s]+)\)/.exec(rest);
        if (linked) {
            html += anchor(linked[2], inline(linked[1], link), link);
            i += linked[0].length;
            continue;
        }
        if (rest.startsWith('**')) {
            const end = source.indexOf('**', i + 2);
            if (end > i + 2) {
                html += `<strong>${inline(source.slice(i + 2, end), link)}</strong>`;
                i = end + 2;
                continue;
            }
        }
        if (rest[0] === '*' && /\S/.test(rest[1] || '') && rest[1] !== '*') {
            const end = source.indexOf('*', i + 1);
            if (end > i + 1 && source[end - 1] !== ' ') {
                html += `<em>${inline(source.slice(i + 1, end), link)}</em>`;
                i = end + 1;
                continue;
            }
        }
        if (rest[0] === '\\' && /[\\`*_[\]()#|!<>-]/.test(rest[1] || '')) {
            html += escapeHtml(rest[1]);
            i += 2;
            continue;
        }
        html += escapeHtml(rest[0]);
        i += 1;
    }
    return html;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>/;

export function tableCells(row) {
    const cells = [''];
    const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '\\' && inner[i + 1] === '|') {
            cells[cells.length - 1] += '\\|';
            i++;
        } else if (inner[i] === '|') {
            cells.push('');
        } else {
            cells[cells.length - 1] += inner[i];
        }
    }
    return cells.map(cell => cell.trim());
}

const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || LIST_ITEM.test(lines[i]) || QUOTE.test(lines[i])
    || (TABLE_ROW.test(lines[i]) && TABLE_RULE.test(lines[i + 1] || ''));

// Renders Markdown. Returns {html, headings: [{level, text, id}]}.
export function renderMarkdown(source, { link = href => ({ href }), used = new Map() } = {}) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const headings = [];
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence) {
            const body = [];
            for (i++; i < lines.length && !lines[i].trim().startsWith(fence[2]); i++) body.push(lines[i].slice(fence[1].length));
            i++;
            const language = fence[3] ? ` data-language="${escapeHtml(fence[3])}"` : '';
            out.push(`<pre class="md-code"${language}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            const level = heading[1].length;
            const html = inline(heading[2], link);
            const text = textOf(html);
            let id = slug(text);
            const seen = used.get(id) || 0;
            used.set(id, seen + 1);
            if (seen) id = `${id}-${seen}`;
            headings.push({ level, text, id });
            out.push(`<h${level} id="${escapeHtml(id)}">${html}</h${level}>`);
            i++;
            continue;
        }
        if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] || '')) {
            const header = tableCells(line);
            const rows = [];
            for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(tableCells(lines[i]));
            const row = (cells, tag) => `<tr>${header.map((_, column) => `<${tag}>${inline(cells[column] ?? '', link)}</${tag}>`).join('')}</tr>`;
            out.push(`<div class="md-table"><table><thead>${row(header, 'th')}</thead><tbody>${rows.map(cells => row(cells, 'td')).join('')}</tbody></table></div>`);
            continue;
        }
        if (LIST_ITEM.test(line)) {
            const ordered = /\d/.test(LIST_ITEM.exec(line)[2]);
            const items = [];
            while (i < lines.length) {
                const item = LIST_ITEM.exec(lines[i]);
                if (item) {
                    items.push(item[3]);
                } else if (items.length && /^\s+\S/.test(lines[i])) {
                    items[items.length - 1] += ` ${lines[i].trim()}`;
                } else {
                    break;
                }
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>${items.map(item => {
                const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
                return task
                    ? `<li class="md-task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], link)}</li>`
                    : `<li>${inline(item, link)}</li>`;
            }).join('')}</${tag}>`);
            continue;
        }
        if (QUOTE.test(line)) {
            const quote = [];
            while (i < lines.length && QUOTE.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
            const inner = renderMarkdown(quote.join('\n'), { link, used });
            headings.push(...inner.headings);
            out.push(`<blockquote>${inner.html}</blockquote>`);
            continue;
        }
        const paragraph = [];
        while (i < lines.length && lines[i].trim() && (!paragraph.length || !startsBlock(lines, i))) paragraph.push(lines[i++].trim());
        out.push(`<p>${inline(paragraph.join(' '), link)}</p>`);
    }
    return { html: out.join('\n'), headings };
}
