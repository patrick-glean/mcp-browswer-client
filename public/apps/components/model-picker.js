// The model the builder asks for HTML and the examples call (Apps.model()): which it is, and the
// menus that choose another, a server's tool and the field the prompt goes in. On the start page
// and under Ask a model; whoever shows it renders it again on the Apps state's 'model' event.

import { escapeHtml, schemaOf, serverLabel } from '../../workbench/util.js';
import { modelName, modelOf } from '../apps.js';

export class ModelPicker {
    constructor({ shell, apps, container, signal }) {
        Object.assign(this, { shell, apps, container });
        this.open = false;
        container.addEventListener('change', event => this.changed(event.target), { signal });
        container.addEventListener('click', event => {
            if (event.target.closest('[data-model-found]')) this.apps.setModel(null);
        }, { signal });
        container.addEventListener('toggle', event => {
            if (event.target.matches('[data-model-details]')) this.open = event.target.open;
        }, { signal, capture: true });
    }

    // The tool lists changed: the menus follow them, unless someone is using one.
    refresh() {
        if (!this.container.contains(document.activeElement)) this.render();
    }

    render() {
        const focused = this.container.contains(document.activeElement)
            ? [...document.activeElement.attributes].find(attribute => attribute.name.startsWith('data-model-'))?.name
            : null;
        const model = this.apps.model();
        const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        const servers = Object.values(this.shell.servers).filter(server => server.tools?.length);
        const tools = this.shell.servers[model?.serverUrl]?.tools || [];
        const fields = Object.entries(schemaOf(this.apps.modelTool(model))?.properties || {}).filter(([, prop]) => prop?.type === 'string').map(([key]) => key);
        const name = model ? `${modelName(model, this.shell.servers)}${model.messageField ? `, asked in ${model.messageField}` : ''}` : 'none yet';
        this.container.innerHTML = `
            <details class="app-model" data-model-details${this.open ? ' open' : ''}>
                <summary>Model: <span class="app-model-name">${escapeHtml(name)}</span></summary>
                <div class="app-model-menus">
                    <label class="app-field"><span>Server</span><select data-model-server ${servers.length ? '' : 'disabled'}>${model ? '' : option('', servers.length ? 'Choose one' : 'None has tools yet', true)}${servers.map(server => option(server.url, serverLabel(server), server.url === model?.serverUrl)).join('')}</select></label>
                    <label class="app-field"><span>Tool</span><select data-model-tool ${tools.length ? '' : 'disabled'}>${tools.map(tool => option(tool.name, tool.name, tool.name === model?.toolName)).join('')}</select></label>
                    <label class="app-field"><span>The prompt goes in</span><select data-model-field ${fields.length ? '' : 'disabled'}>${model?.messageField ? '' : option('', 'Choose a field', true)}${fields.map(field => option(field, field, field === model?.messageField)).join('')}</select></label>
                </div>
                <p class="app-note text-secondary">${model?.chosen
                    ? `You chose it. <button type="button" class="link-button" data-model-found>Use the one found instead</button>`
                    : "Found among your servers: Glean's chat if you've added Glean, else a server's chat tool. Choose another here."}</p>
            </details>`;
        if (focused) this.container.querySelector(`[${focused}]`)?.focus();
    }

    changed(target) {
        const model = this.apps.model();
        if (target.matches('[data-model-server]') || target.matches('[data-model-tool]')) {
            const server = this.shell.servers[target.matches('[data-model-server]') ? target.value : model?.serverUrl];
            const tools = server?.tools || [];
            const tool = target.matches('[data-model-tool]')
                ? tools.find(candidate => candidate.name === target.value)
                : tools.find(candidate => candidate.name === 'chat') || tools[0];
            if (tool) this.apps.setModel(modelOf(server, tool));
        } else if (target.matches('[data-model-field]') && model) {
            this.apps.setModel({ ...model, messageField: target.value || null });
        }
    }
}
