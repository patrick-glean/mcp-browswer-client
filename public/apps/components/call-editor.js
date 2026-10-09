// A tool call to edit, { serverUrl, toolName, args }: which server, which tool, and its arguments
// as the tool's own fields (AppShell's, as in the Workbench), where {{id}} brings in a value from
// the screen. The flow's rules use one, and so does a screen that comes from a tool.

import { escapeHtml, plural, schemaOf, serverLabel } from '../../workbench/util.js';

export class CallEditor {
    // `getCall` and `setCall(call, { structural })` read and write the call; `screenIds()` lists the
    // elements whose values {{id}} can bring in.
    constructor({ shell, workbench, container, getCall, setCall, screenIds = () => [], signal }) {
        Object.assign(this, { shell, workbench, container, getCall, setCall, screenIds });
        this.lastField = null;
        container.addEventListener('focusin', event => {
            if (event.target.matches('input[type="text"], textarea')) this.lastField = event.target;
        }, { signal });
        container.addEventListener('change', event => {
            if (event.target.matches('[data-call-server]')) this.chooseServer(event.target.value);
            if (event.target.matches('[data-call-tool]')) this.chooseTool(event.target.value);
        }, { signal });
        container.addEventListener('input', event => {
            if (event.target.closest('[data-call-args]')) this.readArgs();
        }, { signal });
        container.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button || !container.contains(button)) return;
            if (button.dataset.insert) this.insert(button.dataset.insert);
            if (button.dataset.connectServer) this.shell.connectMcpServer(button.dataset.connectServer);
        }, { signal });
    }

    get call() {
        return this.getCall() || { serverUrl: '', toolName: '', args: {} };
    }

    get server() {
        return this.shell.servers[this.call.serverUrl] || null;
    }

    get tool() {
        return (this.server?.tools || []).find(tool => tool.name === this.call.toolName) || null;
    }

    render() {
        const { serverUrl, toolName } = this.call;
        const servers = Object.values(this.shell.servers);
        const serverOptions = servers.map(server => `<option value="${escapeHtml(server.url)}">${escapeHtml(serverLabel(server))}</option>`);
        if (serverUrl && !this.server) serverOptions.unshift(`<option value="${escapeHtml(serverUrl)}">${escapeHtml(serverUrl)} (not added)</option>`);
        if (!serverUrl) serverOptions.unshift(`<option value="">${servers.length ? 'Choose a server…' : 'No servers yet: add one in the Workbench'}</option>`);
        const tools = this.server?.tools || [];
        const toolOptions = tools.map(tool => `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</option>`);
        if (toolName && !this.tool) toolOptions.unshift(`<option value="${escapeHtml(toolName)}">${escapeHtml(toolName)}</option>`);
        if (!toolName) toolOptions.unshift(`<option value="">${tools.length ? 'Choose a tool…' : 'No tools listed'}</option>`);
        const connected = this.server?.status === 'connected';
        const description = this.tool?.description ? `<p class="app-call-help text-secondary">${escapeHtml(this.tool.description)}</p>` : '';
        const offline = this.server && !connected
            ? `<p class="app-call-help text-secondary">${escapeHtml(serverLabel(this.server))} isn't connected, so its tools may be out of date. <button type="button" class="link-button" data-connect-server="${escapeHtml(this.server.url)}">Connect</button></p>`
            : '';
        this.container.innerHTML = `
            <div class="app-call-pick">
                <label class="app-field"><span>Server</span><select data-call-server ${servers.length || serverUrl ? '' : 'disabled'}>${serverOptions.join('')}</select></label>
                <label class="app-field"><span>Tool</span><select data-call-tool ${toolOptions.length ? '' : 'disabled'}>${toolOptions.join('')}</select></label>
            </div>
            ${offline}${description}
            <form class="wb-form app-args" data-call-args novalidate autocomplete="off"></form>
            <div class="app-chips" data-call-chips></div>`;
        this.container.querySelector('[data-call-server]').value = serverUrl;
        this.container.querySelector('[data-call-tool]').value = toolName;
        this.renderArgs();
        this.renderChips();
    }

    // The tool's fields, required ones first; with several fields, the optional ones fold away
    // until one has a value. A tool whose schema isn't known yet takes its arguments as JSON.
    renderArgs() {
        const form = this.container.querySelector('[data-call-args]');
        const schema = schemaOf(this.tool);
        const args = this.call.args || {};
        if (!this.call.toolName) {
            form.innerHTML = '';
            return;
        }
        if (!schema) {
            form.innerHTML = `<label class="app-field"><span>Arguments, as JSON</span><textarea class="mono" rows="3" data-args-json spellcheck="false"></textarea></label>`;
            form.querySelector('[data-args-json]').value = JSON.stringify(args, null, 2);
            return;
        }
        const properties = Object.entries(schema.properties || {});
        if (!properties.length) {
            form.innerHTML = '<p class="text-secondary">This tool takes no arguments.</p>';
            return;
        }
        form.innerHTML = '';
        const required = new Set(schema.required || []);
        const requiredFields = properties.filter(([key]) => required.has(key));
        const optionalFields = properties.filter(([key]) => !required.has(key));
        for (const [key, prop] of requiredFields) form.appendChild(this.shell.renderInputField(key, prop, true));
        if (optionalFields.length && properties.length > 3) {
            const more = document.createElement('details');
            more.className = 'wb-optional';
            more.innerHTML = `<summary>${plural(optionalFields.length, 'optional field')}: ${escapeHtml(optionalFields.map(([key]) => key).join(', '))}</summary>`;
            for (const [key, prop] of optionalFields) more.appendChild(this.shell.renderInputField(key, prop, false));
            form.appendChild(more);
            more.open = optionalFields.some(([key]) => Object.hasOwn(args, key));
        } else {
            for (const [key, prop] of optionalFields) form.appendChild(this.shell.renderInputField(key, prop, false));
        }
        this.shell.fillToolForm(form, schema, args);
    }

    renderChips() {
        const chips = this.container.querySelector('[data-call-chips]');
        const ids = this.screenIds();
        chips.hidden = !ids.length || !this.call.toolName;
        chips.innerHTML = `<span class="app-chips-label">Values from the screen</span>${ids.map(id => `<button type="button" class="wb-chip mono" data-insert="{{${escapeHtml(id)}}}" title="Put {{${escapeHtml(id)}}} in the field you were in: what ${escapeHtml(id)} holds when the rule runs">${escapeHtml(id)}</button>`).join('')}`;
    }

    readArgs() {
        const form = this.container.querySelector('[data-call-args]');
        const json = form.querySelector('[data-args-json]');
        let args;
        try {
            args = json ? JSON.parse(json.value || '{}') : this.shell.serializeToolForm(form, schemaOf(this.tool));
            if (json) json.classList.remove('app-invalid');
        } catch {
            json?.classList.add('app-invalid');
            return;
        }
        this.setCall({ ...this.call, args }, { structural: false });
    }

    chooseServer(serverUrl) {
        const tools = this.shell.servers[serverUrl]?.tools || [];
        const keep = tools.some(tool => tool.name === this.call.toolName);
        this.setCall({ ...this.call, serverUrl, toolName: keep ? this.call.toolName : '' }, { structural: true });
        if (!keep && tools.length) return this.chooseTool(tools[0].name);
        this.render();
    }

    // A new tool starts with test data for its required fields, keeping what fields of the same
    // name held for the last one.
    chooseTool(toolName) {
        const tool = (this.server?.tools || []).find(candidate => candidate.name === toolName);
        const schema = schemaOf(tool);
        const kept = Object.fromEntries(Object.entries(this.call.args || {}).filter(([key]) => schema?.properties && Object.hasOwn(schema.properties, key)));
        const args = schema ? { ...this.workbench.testDataFor(schema).args, ...kept } : {};
        this.setCall({ ...this.call, toolName, args }, { structural: true });
        this.render();
    }

    // Puts {{id}} where the cursor was in the field last used, or in the first text field.
    insert(text) {
        const form = this.container.querySelector('[data-call-args]');
        const field = this.lastField?.isConnected && form.contains(this.lastField) ? this.lastField : form.querySelector('input[type="text"], textarea');
        if (!field) return;
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        field.setRangeText(text, start, end, 'end');
        field.focus();
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }
}
