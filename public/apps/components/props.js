// A component's settings as form fields, for the Inspector and the Outline's Screen. Each is a
// COMPONENT_PROPS entry, [prop, label, kind, options], and `attribute` names the data attribute
// that says which prop a field sets. A menu whose options depend on the app (where a button goes)
// makes them from its `components`.

import { escapeHtml } from '../../workbench/util.js';

const optionsHtml = (options, components) => Object.entries((typeof options === 'function' ? options(components) : options) || {})
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');

export function propField(prop, kind, options, attribute, { rows = 3, components = [] } = {}) {
    if (kind === 'lines') return `<textarea rows="${rows}" ${attribute}="${prop}"></textarea>`;
    if (kind === 'select') return `<select ${attribute}="${prop}">${optionsHtml(options, components)}</select>`;
    return `<input type="text" ${attribute}="${prop}" ${kind === 'number' ? 'inputmode="numeric"' : ''} autocomplete="off">`;
}

// A menu's options made again for the app's components as they are now, keeping what's chosen.
export function refreshMenu(select, options, components) {
    const value = select.value;
    select.innerHTML = optionsHtml(options, components);
    select.value = value;
}

// What a field shows of a component: its value, or a menu's first choice when it has none.
export function propValue(component, field, prop) {
    const value = component[prop];
    if (field instanceof HTMLSelectElement) return [...field.options].some(option => option.value === value) ? value : field.options[0]?.value ?? '';
    return value ?? '';
}

// Sets a prop to what its field says: lines are 1 to 20, and a button that goes nowhere has no `go`.
export function setProp(component, prop, value) {
    if (prop === 'go' && !value) delete component.go;
    else component[prop] = prop === 'lines' ? Math.max(1, Math.min(20, Number(value) || 1)) : value;
}
