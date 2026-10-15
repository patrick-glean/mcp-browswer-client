// The servers an app calls, each with the tools it calls there, and a menu of your servers that
// could take those calls instead: your own visitor system's in place of the Front desk demo
// server, say, once it's connected and has the same tools. In the Inspector when nothing is
// picked, and in the Outline's Flow.

import { demoServerAt } from '../../demo-servers/index.js';
import { escapeHtml, serverLabel } from '../../workbench/util.js';
import { serverCalls, whyNotInstead } from '../servers.js';

export class ServerSwitch {
    constructor({ shell, apps, container, signal }) {
        Object.assign(this, { shell, apps, container });
        container.addEventListener('change', event => {
            const select = event.target.closest('[data-call-instead]');
            if (!select?.value) return;
            this.apps.callInstead(select.dataset.callInstead, select.value);
            this.render();
        }, { signal });
        container.addEventListener('click', event => {
            const add = event.target.closest('[data-add-demo]');
            if (add) this.apps.addDemoServer(add.dataset.addDemo);
        }, { signal });
    }

    // Your servers or their tools changed: the menus follow, unless one is being used.
    refresh() {
        if (!this.container.contains(document.activeElement)) this.render();
    }

    render() {
        const uses = this.apps.app ? serverCalls(this.apps.app) : [];
        if (!uses.length) {
            this.container.innerHTML = '<p class="text-secondary">It calls no servers yet.</p>';
            return;
        }
        this.container.innerHTML = `<ul class="app-servers">${uses.map(({ url, tools }) => {
            const demo = demoServerAt(url);
            const added = !!this.shell.servers[url];
            const others = Object.values(this.shell.servers).filter(server => server.url !== url).map(server => ({ server, why: whyNotInstead(tools, server) }));
            const can = others.filter(({ why }) => !why.length).length;
            const options = others.map(({ server, why }) => `<option value="${escapeHtml(server.url)}"${why.length ? ' disabled' : ''}>${escapeHtml(why.length ? `${serverLabel(server)}: ${why[0]}` : serverLabel(server))}</option>`).join('');
            return `
                <li class="app-server-use" data-server-use="${escapeHtml(url)}">
                    <div class="app-server-use-head">
                        <span class="app-server-use-name" title="${escapeHtml(url)}">${escapeHtml(this.apps.serverName(url))}</span>
                        ${demo ? '<span class="badge badge-info" title="It runs in this page, with made-up data">Demo, built in</span>' : ''}
                        ${added ? '' : '<span class="badge badge-warning">Not added</span>'}
                    </div>
                    <p class="app-server-use-tools mono">${escapeHtml(tools.map(tool => tool.name).join(', ') || 'No tool chosen yet')}</p>
                    ${!added && demo ? `<button type="button" class="btn-sm" data-add-demo="${escapeHtml(demo.id)}">Add it</button>` : ''}
                    <label class="app-field"><span>Call instead</span><select data-call-instead="${escapeHtml(url)}" ${others.length ? '' : 'disabled'}><option value="">${others.length ? (can ? 'Choose a server…' : 'None has these tools') : 'No other servers yet'}</option>${options}</select></label>
                </li>`;
        }).join('')}</ul>`;
    }
}
