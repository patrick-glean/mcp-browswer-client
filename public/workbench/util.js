// Small helpers the Workbench's components share.

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const schemaOf = tool => tool?.inputSchema || tool?.input_schema || null;

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "a", "a and b", "a, b and c".
export const listOf = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function timeAgo(time) {
    const seconds = Math.round((Date.now() - time) / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(time).toLocaleDateString();
}

export function formatMs(ms) {
    if (typeof ms !== 'number') return '';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

export function download(filename, text, type = 'application/json') {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Alias, else the name the server gave, else its host.
export function serverLabel(server, url = server?.url) {
    if (server?.alias?.trim()) return server.alias.trim();
    if (server?.name?.trim()) return server.name.trim();
    try {
        return new URL(url).host;
    } catch {
        return url || '';
    }
}

// 'healthy', 'unhealthy', 'signin' or 'unknown', for a server's status dot.
export function serverState(server, authStatus) {
    if (server?.status === 'connected') return 'healthy';
    if (server?.needsSignIn && !authStatus?.signedIn) return 'signin';
    if (server?.status === 'failed') return 'unhealthy';
    return 'unknown';
}

// Where a run came from, as people see it: a reply is a tool call in a model's answer to an app.
// Runs saved before the rename say 'sandbox', and those from the Chat app the Chat example
// replaced say 'chat'.
export const SOURCE_LABELS = { workbench: 'Workbench', sandbox: 'Workbench', collection: 'Run all', app: 'App', chat: 'Chat', reply: 'From a reply' };

// A run's verdict: same, changed, first (nothing to compare with) or failed.
export function verdictOf(run) {
    if (!run?.id) return null;
    if (run.outcome === 'failed' || run.outcome === 'tool_error') return 'failed';
    if (run.changed === true) return 'changed';
    if (run.changed === false) return 'same';
    return 'first';
}

export const VERDICT_CHIPS = {
    same: '<span class="badge badge-success">same</span>',
    changed: '<span class="badge badge-warning">changed</span>',
    first: '<span class="badge">first run</span>',
    failed: '<span class="badge badge-error">failed</span>',
};

export const verdictChip = run => VERDICT_CHIPS[verdictOf(run)] || '';

// A tool's display title when it differs from its name (2025-06-18 added title; annotations.title is older).
export function toolTitle(tool) {
    const title = tool?.title || tool?.annotations?.title;
    return title && title !== tool.name ? title : '';
}

const hasAppUi = tool => {
    const meta = tool._meta || {};
    return !!(meta['io.modelcontextprotocol/ui'] || meta.ui?.resourceUri || meta['ui/resourceUri']);
};

// What a tool declares about itself, as badges. Annotations are hints from the server, not guarantees.
export function toolBadges(tool) {
    const hints = tool.annotations || {};
    const badges = [];
    if (hints.readOnlyHint === true) badges.push(['read-only', 'badge-info', "Doesn't change anything (readOnlyHint)"]);
    if (hints.destructiveHint === true && hints.readOnlyHint !== true) badges.push(['destructive', 'badge-error', 'May delete or overwrite things (destructiveHint)']);
    if (hints.idempotentHint === true) badges.push(['idempotent', '', 'Calling it again with the same arguments has no further effect (idempotentHint)']);
    if (hints.openWorldHint === true) badges.push(['open world', 'badge-warning', 'Reaches outside systems, such as the web (openWorldHint)']);
    if (hasAppUi(tool)) badges.push(['app', 'badge-success', 'Comes with an interactive UI (MCP Apps)']);
    if (tool.outputSchema) badges.push(['structured output', '', 'Declares an output schema']);
    if (!badges.length) return '';
    return `<span class="badge-row">${badges.map(([label, kind, help]) => `<span class="badge ${kind}" title="${escapeHtml(help)}">${label}</span>`).join('')}</span>`;
}

// The same hints, short enough for a one-line row. A tool without a read-only hint may change
// things, so it's marked "?" until it says otherwise.
export function toolHints(tool) {
    const hints = tool.annotations || {};
    const marks = [];
    if (hints.readOnlyHint === true) marks.push(['ro', '', 'Read-only (readOnlyHint)']);
    else if (hints.destructiveHint === true) marks.push(['del', 'hint-danger', 'May delete or overwrite things (destructiveHint)']);
    else if (hints.readOnlyHint === false) marks.push(['writes', 'hint-warning', 'Changes things (readOnlyHint is false)']);
    else marks.push(['?', 'hint-unknown', "Doesn't say whether it changes anything; assume it may"]);
    if (hints.openWorldHint === true) marks.push(['web', 'hint-info', 'Reaches outside systems, such as the web (openWorldHint)']);
    if (hasAppUi(tool)) marks.push(['app', 'hint-success', 'Comes with an interactive UI (MCP Apps)']);
    return marks.map(([label, kind, help]) => `<span class="hint ${kind}" title="${escapeHtml(help)}">${label}</span>`).join('');
}

// Which annotation filter a tool passes: read-only, writes (anything not read-only) or reaches out.
export function toolMatchesHint(tool, filter) {
    const hints = tool.annotations || {};
    if (filter === 'read') return hints.readOnlyHint === true;
    if (filter === 'writes') return hints.readOnlyHint !== true;
    if (filter === 'web') return hints.openWorldHint === true;
    return true;
}

// "Signed in with your-company-be.glean.com · mcp offline_access · expires in 59 min · renews automatically"
export function describeSignIn(status) {
    let host = status.issuer;
    try { host = new URL(status.issuer).host; } catch { /* show the issuer as is */ }
    const parts = [`Signed in with ${host}`];
    if (status.scope) parts.push(status.scope);
    if (status.expiresAt) {
        const minutes = Math.round((status.expiresAt - Date.now()) / 60_000);
        parts.push(minutes <= 0 ? 'access token expired'
            : minutes < 90 ? `expires in ${minutes} min`
            : `expires in ${Math.round(minutes / 60)} h`);
    }
    if (status.refreshable) parts.push('renews automatically');
    return parts.join(' · ');
}

// Destructive buttons ask for a second click within a few seconds.
export function confirmThen(button, action) {
    if (button.dataset.confirming) {
        delete button.dataset.confirming;
        button.textContent = button.dataset.label;
        action();
        return;
    }
    button.dataset.label = button.textContent;
    button.dataset.confirming = 'true';
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
        if (!button.dataset.confirming) return;
        delete button.dataset.confirming;
        button.textContent = button.dataset.label;
    }, 4000);
}

// Swaps a name for an input in place: Enter or leaving the field saves, Escape cancels. `done`
// runs either way, to draw the list again.
export function renameInPlace(element, current, save, done) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = current;
    element.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = async keep => {
        if (finished) return;
        finished = true;
        const name = input.value.trim();
        if (keep && name && name !== current) await save(name);
        done();
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', event => event.stopPropagation());
}

const shortJson = value => {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

// Fill, beside each field's name in a form of AppShell's fields: fills that field alone with
// Pre-fill's test data (see fillField). Drawing them again brings their tooltips up to date with
// the variables. Fields with no test data, such as optional pagination cursors, get none.
export function addFillButtons(form, schema, workbench) {
    form.querySelectorAll('.wb-fill-field').forEach(button => button.remove());
    for (const card of form.querySelectorAll('.tool-input-card[data-field]')) {
        const data = workbench.testDataForField(schema, card.dataset.field);
        if (!data) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-sm btn-tertiary wb-fill-field';
        button.dataset.fillField = card.dataset.field;
        button.title = `Fill in ${shortJson(data.value)} (${data.how})`;
        button.setAttribute('aria-label', `Fill ${card.dataset.field} with test data`);
        button.innerHTML = '<span class="icon icon-zap" aria-hidden="true"></span>Fill';
        card.querySelector(':scope > label').after(button);
    }
}

// Fills one field (`limit`, or `filter.owner` inside an object) with its test data and focuses
// it. Returns what it filled, to tell the person, or null.
export function fillField(form, schema, path, { shell, workbench }) {
    const data = workbench.testDataForField(schema, path);
    const keys = path.split('.');
    const key = keys.pop();
    const prop = keys.reduce((parent, part) => parent?.properties?.[part], schema)?.properties?.[key];
    if (!data || !prop) return null;
    const prefix = keys.join('.');
    shell.fillToolForm(form, { properties: { [key]: prop } }, { [key]: data.value }, prefix);
    if (prefix) form.dispatchEvent(new Event('input', { bubbles: true }));
    form.querySelector(`.tool-input-card[data-field="${CSS.escape(path)}"] [name]`)?.focus();
    return `Filled ${path} with ${shortJson(data.value)} (${data.how}).`;
}

// Closes open <details class="menu"> dropdowns when a click lands outside them.
export function closeMenusOutside(event) {
    document.querySelectorAll('details.menu[open]').forEach(menu => {
        if (!menu.contains(event.target)) menu.open = false;
    });
}
