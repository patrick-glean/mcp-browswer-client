// RFC 6570 URI templates, as MCP resource templates use them: the variables a template has, and
// the URI it makes from string values (levels 1 to 3, plus prefixes like {name:3}). A variable
// with no value is left out, as the RFC says for undefined ones.

const OPERATORS = {
    '': { first: '', separator: ',', named: false, reserved: false },
    '+': { first: '', separator: ',', named: false, reserved: true },
    '#': { first: '#', separator: ',', named: false, reserved: true },
    '.': { first: '.', separator: '.', named: false, reserved: false },
    '/': { first: '/', separator: '/', named: false, reserved: false },
    ';': { first: ';', separator: ';', named: true, reserved: false, bare: true },
    '?': { first: '?', separator: '&', named: true, reserved: false },
    '&': { first: '&', separator: '&', named: true, reserved: false },
};
const EXPRESSION = /\{([+#./;?&]?)([^}]*)\}/g;

const specs = body => body.split(',').map(spec => {
    const [, name = spec, prefix] = spec.trim().match(/^([^:*]+)(?::(\d+))?\*?$/) || [];
    return { name, prefix: prefix ? Number(prefix) : null };
}).filter(({ name }) => name);

export function templateVariables(template) {
    const names = [];
    for (const [, , body] of String(template).matchAll(EXPRESSION)) {
        for (const { name } of specs(body)) if (!names.includes(name)) names.push(name);
    }
    return names;
}

// Reserved expansion (+ and #) keeps characters like / and ? as they are.
const encode = (text, reserved) => (reserved
    ? encodeURI(text)
    : encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`));

export function expandTemplate(template, values = {}) {
    return String(template).replace(EXPRESSION, (expression, symbol, body) => {
        const operator = OPERATORS[symbol];
        const parts = [];
        for (const { name, prefix } of specs(body)) {
            const value = values[name];
            if (value === undefined || value === null || value === '') continue;
            const text = String(value);
            const encoded = encode(prefix ? [...text].slice(0, prefix).join('') : text, operator.reserved);
            parts.push(operator.named ? `${name}=${encoded}` : encoded);
        }
        return parts.length ? operator.first + parts.join(operator.separator) : '';
    });
}
