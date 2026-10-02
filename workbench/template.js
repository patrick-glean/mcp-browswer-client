// {{name}} placeholders in tool arguments, filled from the active environment's variables.
// Names may hold dots, which milestone 2's steps use for earlier results ({{steps.search.text}}).

const NAME = '[A-Za-z_][\\w.-]*';
const PLACEHOLDERS = new RegExp(`\\{\\{\\s*(${NAME})\\s*\\}\\}`, 'g');
const WHOLE = new RegExp(`^\\s*\\{\\{\\s*(${NAME})\\s*\\}\\}\\s*$`);
export const VARIABLE_NAME = new RegExp(`^${NAME}$`);

export class TemplateError extends Error {}

// A schema's type; a list like ["string", "null"] counts as its first non-null type.
export function schemaType(prop) {
    return Array.isArray(prop?.type) ? prop.type.find(type => type !== 'null') : prop?.type;
}

// The variable names used anywhere in a value.
export function variablesIn(value, names = new Set()) {
    if (typeof value === 'string') {
        for (const match of value.matchAll(PLACEHOLDERS)) names.add(match[1]);
    } else if (Array.isArray(value)) {
        value.forEach(item => variablesIn(item, names));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(item => variablesIn(item, names));
    }
    return names;
}

// Fills in every placeholder. A value that is exactly one placeholder becomes the variable's
// value in the schema's type there (a number, true or false, or parsed JSON for objects and
// arrays); text around placeholders stays text. Throws a TemplateError naming unknown variables.
export function resolveArguments(args, variables = {}, schema = null) {
    const missing = [...variablesIn(args)].filter(name => !Object.hasOwn(variables, name));
    if (missing.length) {
        const list = missing.map(name => `{{${name}}}`).join(', ');
        throw new TemplateError(`${list} ${missing.length === 1 ? "isn't a variable" : "aren't variables"} in this environment. Add ${missing.length === 1 ? 'it' : 'them'} under Variables, or change the field.`);
    }
    return resolveValue(args, schema, variables, '');
}

// One field's text with the variables it uses filled in, for showing under the field. Unknown
// variables stay as written and are listed in `missing`.
export function previewText(text, variables = {}) {
    const missing = [];
    const value = String(text).replace(PLACEHOLDERS, (match, name) => {
        if (Object.hasOwn(variables, name)) return String(variables[name]);
        missing.push(name);
        return match;
    });
    return { value, missing };
}

function resolveValue(value, prop, variables, path) {
    if (typeof value === 'string') {
        const whole = value.match(WHOLE);
        if (whole) return convert(String(variables[whole[1]]), whole[1], prop, path);
        return value.replace(PLACEHOLDERS, (match, name) => String(variables[name]));
    }
    if (Array.isArray(value)) {
        const items = prop?.items && !Array.isArray(prop.items) ? prop.items : null;
        return value.map((item, index) => resolveValue(item, items, variables, `${path}[${index}]`));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, resolveValue(item, prop?.properties?.[key], variables, path ? `${path}.${key}` : key)]));
    }
    return value;
}

function convert(text, name, prop, path) {
    const type = schemaType(prop);
    const fail = expected => {
        throw new TemplateError(`{{${name}}} is "${text}", which isn't ${expected}, so it can't fill ${path || 'this field'}.`);
    };
    if (Array.isArray(prop?.enum)) {
        const option = prop.enum.find(value => String(value) === text);
        return option === undefined ? text : option;
    }
    if (type === 'integer' || type === 'number') {
        const number = Number(text.trim());
        if (text.trim() === '' || Number.isNaN(number)) fail('a number');
        if (type === 'integer' && !Number.isInteger(number)) fail('a whole number');
        return number;
    }
    if (type === 'boolean') {
        if (text === 'true') return true;
        if (text === 'false') return false;
        fail('true or false');
    }
    if (type === 'object' || type === 'array') {
        try {
            return JSON.parse(text);
        } catch {
            fail('JSON');
        }
    }
    return text;
}
