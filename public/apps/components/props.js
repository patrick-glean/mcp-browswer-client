// A component's settings as form fields, for the Inspector and the Outline's Screen. Each is a
// COMPONENT_PROPS entry, [prop, label, kind, options], and `attribute` names the data attribute
// that says which prop a field sets.

import { escapeHtml } from '../../workbench/util.js';

export function propField(prop, kind, options, attribute, { rows = 3 } = {}) {
    if (kind === 'lines') return `<textarea rows="${rows}" ${attribute}="${prop}"></textarea>`;
    if (kind === 'select') return `<select ${attribute}="${prop}">${Object.entries(options || {}).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select>`;
    return `<input type="text" ${attribute}="${prop}" ${kind === 'number' ? 'inputmode="numeric"' : ''} autocomplete="off">`;
}

// What a field shows of a component: its value, or a menu's first choice when it has none.
export function propValue(component, field, prop) {
    const value = component[prop];
    if (field instanceof HTMLSelectElement) return [...field.options].some(option => option.value === value) ? value : field.options[0]?.value ?? '';
    return value ?? '';
}
