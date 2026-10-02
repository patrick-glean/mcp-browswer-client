// Values for a tool's fields from its input schema, for Pre-fill's "From the schema".

import { schemaType } from './template.js';

// Each field gets its `const`; else {{name}} when an environment variable has the field's name
// (in any case); else its `default` or first example. Required fields with none of those get
// the first enum choice, the minimum (or 1) for numbers, and false for booleans; strings stay empty.
export function fromSchema(schema, variables = {}) {
    const values = {};
    const required = new Set(schema?.required || []);
    for (const [key, prop] of Object.entries(schema?.properties || {})) {
        const value = valueFor(key, prop || {}, required.has(key), variables);
        if (value !== undefined) values[key] = value;
    }
    return values;
}

function valueFor(key, prop, required, variables) {
    if (Object.hasOwn(prop, 'const')) return prop.const;
    const variable = Object.keys(variables).find(name => name.toLowerCase() === key.toLowerCase());
    if (variable) return `{{${variable}}}`;
    if (Object.hasOwn(prop, 'default')) return prop.default;
    if (Array.isArray(prop.examples) && prop.examples.length) return prop.examples[0];
    const type = schemaType(prop);
    if (type === 'object' && prop.properties) {
        const nested = fromSchema(prop, variables);
        return Object.keys(nested).length ? nested : undefined;
    }
    if (!required) return undefined;
    if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0];
    if (type === 'integer' || type === 'number') {
        if (typeof prop.minimum === 'number') return prop.minimum;
        if (typeof prop.exclusiveMinimum === 'number') return prop.exclusiveMinimum + 1;
        return 1;
    }
    if (type === 'boolean') return false;
    return undefined;
}
