// Starts the Workbench: loads its state, defines its components (which draw themselves wherever
// index.html places them), and wires the top bar and the keyboard shortcuts.
//
// The layout lives in index.html and workbench.css: each component is one custom element placed
// in a named grid area, so another arrangement is new grid areas, not new components.

import { app } from './app.js';
import { WbDock } from './components/dock.js';
import { WbPalette } from './components/palette.js';
import { WbRail } from './components/rail.js';
import { WbRequest } from './components/request.js';
import { WbResponse } from './components/response.js';
import { WbServerBar } from './components/server-bar.js';
import { WbSheet } from './components/sheet.js';
import { WbTools } from './components/tools.js';
import { closeMenusOutside, escapeHtml } from './util.js';
import { Workbench } from './workbench.js';

const COMPONENTS = {
    'wb-rail': WbRail,
    'wb-server-bar': WbServerBar,
    'wb-tools': WbTools,
    'wb-request': WbRequest,
    'wb-response': WbResponse,
    'wb-dock': WbDock,
    'wb-sheet': WbSheet,
    'wb-palette': WbPalette,
};

export async function installWorkbench(shell) {
    const workbench = new Workbench(shell);
    await workbench.load();
    app.shell = shell;
    app.workbench = workbench;
    shell.workbench = workbench;
    for (const [name, component] of Object.entries(COMPONENTS)) {
        if (!customElements.get(name)) customElements.define(name, component);
    }
    wireTopBar(workbench);
    wireStatus(workbench);
    wireShortcuts(workbench);
    document.addEventListener('click', closeMenusOutside);
    return workbench;
}

function wireTopBar(workbench) {
    const select = document.getElementById('envSelect');
    const renderEnvironments = () => {
        select.innerHTML = workbench.environments
            .map(environment => `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)}</option>`)
            .join('');
        select.value = workbench.environment.id;
    };
    renderEnvironments();
    select.addEventListener('change', () => workbench.selectEnvironment(select.value));
    workbench.on('environment', renderEnvironments);
    const variables = document.getElementById('editEnvBtn');
    variables.addEventListener('click', () => (workbench.sheet === 'variables' ? workbench.closeSheet() : workbench.openSheet('variables')));
    workbench.on('sheet', ({ kind }) => variables.setAttribute('aria-expanded', String(kind === 'variables')));
    document.getElementById('gotoBtn').addEventListener('click', () => workbench.emit('palette'));
}

// One line at a time, for things that happen away from where you clicked (imports, deletions).
function wireStatus(workbench) {
    const toast = document.getElementById('wbStatus');
    let timer;
    workbench.on('status', ({ text, error }) => {
        toast.textContent = text || '';
        toast.classList.toggle('wb-status-error', !!error);
        toast.hidden = !text;
        clearTimeout(timer);
        timer = setTimeout(() => { toast.hidden = true; }, error ? 10_000 : 5000);
    });
}

const typing = target => target?.closest?.('input, textarea, select, [contenteditable="true"]');

function wireShortcuts(workbench) {
    document.addEventListener('keydown', event => {
        const inWorkbench = document.body.dataset.mode !== 'apps';
        const command = event.metaKey || event.ctrlKey;
        if (command && event.key === 'Enter' && inWorkbench && workbench.tool) {
            event.preventDefault();
            workbench.emit('run-request');
        } else if (command && event.key.toLowerCase() === 's' && inWorkbench && workbench.tool) {
            event.preventDefault();
            workbench.emit('save-request');
        } else if (command && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            workbench.emit('palette');
        } else if (event.key === '/' && !command && !typing(event.target) && inWorkbench) {
            const filter = document.getElementById('toolFilter');
            if (filter && filter.offsetParent) {
                event.preventDefault();
                filter.focus();
                filter.select();
            }
        } else if (event.key === 'Escape') {
            const menu = document.querySelector('details.menu[open]');
            if (menu) {
                menu.open = false;
                menu.querySelector('summary')?.focus();
            } else if (workbench.sheet && !document.getElementById('guide')?.contains(event.target)) {
                workbench.closeSheet();
            }
        }
    });
}
