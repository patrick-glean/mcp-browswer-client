// A Markdown renderer for the server guide and for the documents an app's screen shows: headings
// with the anchors GitHub gives them, paragraphs, lists (nested, numbered from where they start,
// with task boxes), tables, fenced code, block quotes, rules, and inline code, bold, italics,
// strikethrough, links and images. Anything else stays text, and HTML in the source is escaped
// rather than rendered, but for <br>. Tables split cells on every unescaped |, as GitHub does, so
// a table that renders here renders there too. An image is a link to it with its alt text, since
// an app's screen can't load anything from the network.

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
function anchor(href, html, link, className = '') {
    const target = link(href);
    const attributes = [`href="${escapeHtml(target.href)}"`];
    if (className) attributes.push(`class="${className}"`);
    if (target.external) attributes.push('target="_blank"', 'rel="noopener noreferrer"');
    if (target.file) attributes.push(`data-file="${escapeHtml(target.file)}"`);
    return `<a ${attributes.join(' ')}>${html}</a>`;
}

const LINKED = /^\[((?:`[^`]*`|[^\]])+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const IMAGE = /^!\[((?:`[^`]*`|[^\]])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
// A web address on its own, as GitHub links it: without the punctuation that ends a sentence.
const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_~]/;
const BREAK = /^<br\s*\/?>/i;
const isWord = char => /[\p{L}\p{N}_]/u.test(char || '');

// Where `marker` closes emphasis that opened at `from`: not after a space, not as half of a doubled
// marker (the * of **), and for _ not inside a word. -1 when it doesn't close.
function closing(source, marker, from) {
    for (let end = source.indexOf(marker, from); end >= from; end = source.indexOf(marker, end + 1)) {
        if (source[end - 1] === ' ') continue;
        if (marker.length === 1 && (source[end - 1] === marker || source[end + 1] === marker)) continue;
        if (marker[0] === '_' && isWord(source[end + marker.length])) continue;
        return end > from ? end : -1;
    }
    return -1;
}

// Inline Markdown as HTML. Text inside a link isn't linked again (`linkText`).
export function inline(source, link = href => ({ href }), { linkText = false } = {}) {
    let html = '';
    let i = 0;
    while (i < source.length) {
        const rest = source.slice(i);
        const before = source[i - 1];
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
        const image = rest[0] === '!' && IMAGE.exec(rest);
        if (image) {
            html += anchor(image[2], escapeHtml(image[1] || image[2]), link, 'md-image');
            i += image[0].length;
            continue;
        }
        const linked = rest[0] === '[' && !linkText && LINKED.exec(rest);
        if (linked) {
            html += anchor(linked[2], inline(linked[1], link, { linkText: true }), link);
            i += linked[0].length;
            continue;
        }
        const bare = rest[0] === 'h' && !linkText && !isWord(before) && before !== '/' && BARE_URL.exec(rest);
        if (bare) {
            html += anchor(bare[0], escapeHtml(bare[0]), link);
            i += bare[0].length;
            continue;
        }
        const lineBreak = rest[0] === '<' && BREAK.exec(rest);
        if (lineBreak) {
            html += '<br>';
            i += lineBreak[0].length;
            continue;
        }
        let emphasis = false;
        for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]) {
            if (!rest.startsWith(marker) || !/\S/.test(rest[marker.length] || '') || rest[marker.length] === marker[0]) continue;
            if (marker[0] === '_' && isWord(before)) continue;
            const end = closing(source, marker, i + marker.length);
            if (end < 0) continue;
            html += `<${tag}>${inline(source.slice(i + marker.length, end), link, { linkText })}</${tag}>`;
            i = end + marker.length;
            emphasis = true;
            break;
        }
        if (emphasis) continue;
        if (rest[0] === '\\' && /[\\`*_~[\]()#|!<>-]/.test(rest[1] || '')) {
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
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
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

const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || LIST_ITEM.test(lines[i]) || QUOTE.test(lines[i])
    || (TABLE_ROW.test(lines[i]) && TABLE_RULE.test(lines[i + 1] || ''));

// A list's items ({ indent, marker, text }) as HTML: an item indented further than the one before
// it starts a list inside that one. A numbered list starts at its first item's number.
function listHtml(items, link) {
    let i = 0;
    const level = () => {
        const { indent, marker } = items[i];
        const entries = [];
        while (i < items.length && items[i].indent >= indent) {
            if (items[i].indent > indent && entries.length) {
                entries.at(-1).push(level());
                continue;
            }
            const task = /^\[([ xX])\]\s+(.*)$/.exec(items[i].text);
            entries.push([task
                ? `<li class="md-task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], link)}`
                : `<li>${inline(items[i].text, link)}`]);
            i++;
        }
        const start = Number.parseInt(marker, 10);
        const open = Number.isNaN(start) ? '<ul>' : start === 1 ? '<ol>' : `<ol start="${start}">`;
        return `${open}${entries.map(parts => `${parts.join('')}</li>`).join('')}${open === '<ul>' ? '</ul>' : '</ol>'}`;
    };
    let html = '';
    while (i < items.length) html += level();
    return html;
}

// Renders Markdown. Returns {html, headings: [{level, text, id}]}. Without `anchors`, headings
// have no ids, so a document can sit in a page whose elements have ids of their own.
export function renderMarkdown(source, { link = href => ({ href }), used = new Map(), anchors = true } = {}) {
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
            out.push(anchors ? `<h${level} id="${escapeHtml(id)}">${html}</h${level}>` : `<h${level}>${html}</h${level}>`);
            i++;
            continue;
        }
        if (RULE.test(line)) {
            out.push('<hr>');
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
            const items = [];
            while (i < lines.length) {
                const item = !RULE.test(lines[i]) && LIST_ITEM.exec(lines[i]);
                if (item) {
                    items.push({ indent: item[1].replace(/\t/g, '    ').length, marker: item[2], text: item[3] });
                } else if (/^\s+\S/.test(lines[i])) {
                    items.at(-1).text += ` ${lines[i].trim()}`;
                } else if (!lines[i].trim()) {
                    // A blank line between items keeps the list going.
                    let next = i + 1;
                    while (next < lines.length && !lines[next].trim()) next++;
                    if (next >= lines.length || !(LIST_ITEM.test(lines[next]) && !RULE.test(lines[next])) && !/^\s+\S/.test(lines[next])) break;
                } else {
                    break;
                }
                i++;
            }
            out.push(listHtml(items, link));
            continue;
        }
        if (QUOTE.test(line)) {
            const quote = [];
            while (i < lines.length && QUOTE.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
            const inner = renderMarkdown(quote.join('\n'), { link, used, anchors });
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
