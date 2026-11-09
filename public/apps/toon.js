// A decoder for TOON, Token-Oriented Object Notation (https://github.com/toon-format/spec), which
// Glean's MCP server writes the details of what it found in. It's JSON's data model with objects as
// indented `key: value` lines and each array's length declared: `key[2]: a,b` inline, `key[2]{a,b}:`
// with a row per line, or `key[2]:` with a `- ` line per item. Pure, for flow.js and the tests.
//
// It's strict where a slip would change the data: a count that doesn't match, an indent that isn't
// a whole number of levels, an escape TOON doesn't have or a key given twice throws a SyntaxError,
// as do the forms it doesn't read (keyed tables and nested field groups). Blank lines are skipped.

const INDENT = 2;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const LENGTH = /^\[(0|[1-9]\d*)([\t|]?)\]/;
const ESCAPES = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };

const fail = (line, problem) => {
    throw new SyntaxError(`TOON line ${line.number} ${problem}`);
};
const trimSpaces = text => text.replace(/^ +| +$/g, '');
const isItem = text => text === '-' || text.startsWith('- ');

// Where `char` first comes outside a quoted string, from `from` on; -1 when it doesn't. A quoted
// string runs from a " to the next one that isn't escaped, or to the end of the line.
function unquoted(text, char, from = 0) {
    let quoted = false;
    for (let i = from; i < text.length; i++) {
        if (quoted) {
            if (text[i] === '\\') i++;
            else if (text[i] === '"') quoted = false;
        } else if (text[i] === '"') {
            quoted = true;
        } else if (text[i] === char) {
            return i;
        }
    }
    return -1;
}

function split(text, delimiter) {
    const tokens = [];
    let start = 0;
    for (let at = unquoted(text, delimiter); at >= 0; at = unquoted(text, delimiter, start)) {
        tokens.push(trimSpaces(text.slice(start, at)));
        start = at + 1;
    }
    tokens.push(trimSpaces(text.slice(start)));
    return tokens;
}

function quoted(token, line) {
    let value = '';
    for (let i = 1; i < token.length; i++) {
        if (token[i] === '"') return i === token.length - 1 ? value : fail(line, 'has text after a closing quote');
        if (token[i] !== '\\') {
            value += token[i];
            continue;
        }
        const escape = token[++i];
        const hex = token.slice(i + 1, i + 5);
        if (Object.hasOwn(ESCAPES, escape ?? '')) {
            value += ESCAPES[escape];
        } else if (escape === 'u' && /^[0-9a-f]{4}$/i.test(hex) && !/^d[89a-f]/i.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
        } else {
            fail(line, `has an escape TOON doesn't have: \\${escape ?? ''}`);
        }
    }
    return fail(line, 'has a string without its closing quote');
}

function primitive(token, line) {
    if (token.startsWith('"')) return quoted(token, line);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return NUMBER.test(token) ? Number(token) : token;
}

function keyOf(token, line) {
    const text = trimSpaces(token);
    return text.startsWith('"') ? quoted(text, line) : text;
}

// An array's header, `key[N]{fields}: values` (with a tab or | after N when that's the delimiter),
// or null when the line isn't one: a line is when its first [ comes before its first colon.
function headerOf(text, line) {
    const bracket = unquoted(text, '[');
    const colon = unquoted(text, ':');
    if (bracket < 0 || colon < 0 || colon < bracket) return null;
    const name = text.slice(0, bracket);
    if (/[ \t]$/.test(name)) fail(line, 'has a space before its [');
    const length = LENGTH.exec(text.slice(bracket));
    if (!length) fail(line, "has an array header TOON doesn't have, or one this doesn't read");
    const delimiter = length[2] || ',';
    let at = bracket + length[0].length;
    let fields = null;
    if (text[at] === '{') {
        const close = unquoted(text, '}', at);
        if (close < 0) fail(line, 'has a table header without its }');
        const inner = text.slice(at + 1, close);
        if (unquoted(inner, '{') >= 0) fail(line, "has nested fields, which this doesn't read");
        fields = split(inner, delimiter).map(field => keyOf(field, line));
        if (fields.includes('')) fail(line, 'has a table header with an empty field');
        at = close + 1;
    }
    if (text[at] !== ':') fail(line, 'has an array header without its colon');
    const rest = trimSpaces(text.slice(at + 1));
    if (fields && rest) fail(line, 'has values after a table header');
    return { key: name ? keyOf(name, line) : null, length: Number(length[1]), delimiter, fields, rest };
}

// Whether a line at a table's row depth is a row: one is unless a colon comes before its first
// delimiter, which makes it a field of what the table is in.
function isRow(text, delimiter) {
    const colon = unquoted(text, ':');
    const at = unquoted(text, delimiter);
    return colon < 0 || (at >= 0 && at < colon);
}

function set(object, key, value, line) {
    if (Object.hasOwn(object, key)) fail(line, `has the key ${JSON.stringify(key)} again`);
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

// The lines that say something, each with its depth: comments (# lines) and blank lines go.
function linesOf(text) {
    const lines = [];
    String(text).replace(/^\uFEFF/, '').split('\n').forEach((raw, index) => {
        const content = raw.replace(/\r$/, '').replace(/ +$/, '');
        const indent = /^[ \t]*/.exec(content)[0];
        const line = { number: index + 1, text: content.slice(indent.length) };
        if (!line.text || (line.text.startsWith('#') && !indent.includes('\t'))) return;
        if (indent.includes('\t') || indent.length % INDENT) fail(line, `isn't indented by ${INDENT} spaces a level`);
        lines.push({ ...line, depth: indent.length / INDENT });
    });
    return lines;
}

class Reader {
    constructor(lines) {
        this.lines = lines;
        this.at = 0;
    }

    get line() {
        return this.lines[this.at];
    }

    // The fields at `depth`, from this line to the first that's indented less.
    object(depth, object = {}) {
        for (let line = this.line; line && line.depth >= depth; line = this.line) {
            if (line.depth > depth) fail(line, 'is indented under nothing');
            this.at++;
            this.field(line, line.text, depth, object);
        }
        return object;
    }

    // One field at `depth`, whose object or array is at `depth` + 1.
    field(line, text, depth, object) {
        if (isItem(text)) fail(line, 'is a list item outside a list');
        const header = headerOf(text, line);
        if (header) {
            if (header.key === null) fail(line, 'is an array without a key');
            set(object, header.key, this.array(header, depth + 1, line), line);
            return;
        }
        const colon = unquoted(text, ':');
        if (colon < 0) fail(line, 'is a value without a key');
        const rest = trimSpaces(text.slice(colon + 1));
        let value;
        if (rest === '[]') value = [];
        else if (rest) value = primitive(rest, line);
        else value = this.line?.depth > depth ? this.object(depth + 1) : {};
        set(object, keyOf(text.slice(0, colon), line), value, line);
    }

    // An array's items, at `depth` when they're on lines of their own.
    array({ length, delimiter, fields, rest }, depth, line) {
        let items;
        if (rest) items = split(rest, delimiter).map(token => primitive(token, line));
        else if (fields) items = this.rows(fields, delimiter, depth);
        else items = this.items(depth);
        if (items.length !== length) fail(line, `says ${length} item${length === 1 ? '' : 's'} and has ${items.length}`);
        return items;
    }

    rows(fields, delimiter, depth) {
        const rows = [];
        for (let line = this.line; line?.depth === depth && isRow(line.text, delimiter); line = this.line) {
            this.at++;
            const cells = split(line.text, delimiter);
            if (cells.length !== fields.length) fail(line, `has ${cells.length} cells for ${fields.length} fields`);
            const row = {};
            fields.forEach((field, index) => set(row, field, primitive(cells[index], line), line));
            rows.push(row);
        }
        return rows;
    }

    items(depth) {
        const items = [];
        for (let line = this.line; line?.depth === depth && isItem(line.text); line = this.line) {
            this.at++;
            items.push(this.item(line, line.text.replace(/^-(?: +|$)/, ''), depth));
        }
        return items;
    }

    // A list item at `depth`: an object, whose first field is on the item's line and whose others are
    // at `depth` + 1; an array; an empty object (a bare -) or array; or a value.
    item(line, text, depth) {
        if (!text) return {};
        if (text === '[]') return [];
        const header = headerOf(text, line);
        if (header?.key === null) {
            if (header.fields) fail(line, 'has a table without a key');
            return this.array(header, depth + 1, line);
        }
        if (!header && unquoted(text, ':') < 0) return primitive(text, line);
        const object = {};
        this.field(line, text, depth + 1, object);
        return this.object(depth + 1, object);
    }
}

// The value a TOON document holds. An empty one is an empty object, as the spec has it.
export function decodeToon(text) {
    const lines = linesOf(text);
    const [first] = lines;
    if (!first) return {};
    if (first.depth) fail(first, 'is indented under nothing');
    const reader = new Reader(lines);
    const header = isItem(first.text) ? null : headerOf(first.text, first);
    let value;
    if (first.text === '[]') {
        reader.at = 1;
        value = [];
    } else if (header?.key === null) {
        reader.at = 1;
        value = reader.array(header, 1, first);
    } else if (lines.length === 1 && !header && !isItem(first.text) && unquoted(first.text, ':') < 0) {
        reader.at = 1;
        value = primitive(first.text, first);
    } else {
        value = reader.object(0);
    }
    if (reader.line) fail(reader.line, 'comes after the end of the document');
    return value;
}
