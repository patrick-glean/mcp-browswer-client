// Side sheets over the right edge: the selected server's details (its address and name,
// everything it said about itself, the connection, sign-in or a static token, its report,
// Delete) and the active environment's variables.

import { VARIABLE_NAME } from '../template.js';
import { confirmThen, debounce, describeSignIn, escapeHtml, iconSource, serverIcon, serverLabel, serverState } from '../util.js';
import { WbElement } from './base.js';

const shortSrc = src => (src.length > 72 ? `${src.slice(0, 69)}…` : src);

// Each icon the server listed: drawn when it's one this client shows, else why it isn't.
function iconsHtml(icons, serverUrl) {
    return `<div class="wb-icons">${icons.map(icon => {
        const { src, reason } = iconSource(icon, serverUrl);
        const about = [icon?.mimeType, Array.isArray(icon?.sizes) ? icon.sizes.join(' ') : '', icon?.theme ? `for ${icon.theme} backgrounds` : '']
            .filter(Boolean).map(escapeHtml).join(' · ');
        if (src) {
            return `<figure class="wb-icon"><img src="${escapeHtml(src)}" alt="" width="32" height="32" referrerpolicy="no-referrer" loading="lazy" decoding="async"><figcaption>${about || 'An icon'}</figcaption></figure>`;
        }
        return `<figure class="wb-icon wb-icon-skipped"><span class="wb-icon-none" aria-hidden="true"></span><figcaption>${about ? `${about}. ` : ''}Not shown: ${escapeHtml(reason)}. <span class="mono">${escapeHtml(shortSrc(String(icon?.src ?? '')))}</span></figcaption></figure>`;
    }).join('')}</div>`;
}

function variableRow(name, value) {
    return `
        <div class="env-variable">
            <input type="text" class="env-variable-name" value="${escapeHtml(name)}" placeholder="name" spellcheck="false" autocomplete="off" aria-label="Variable name">
            <input type="text" class="env-variable-value" value="${escapeHtml(value)}" placeholder="value" spellcheck="false" autocomplete="off" aria-label="Value">
            <button type="button" class="btn-icon btn-tertiary btn-sm" data-remove-variable aria-label="Remove variable"><span class="icon icon-x" aria-hidden="true"></span></button>
        </div>`;
}

const closeButton = '<button type="button" class="btn-icon btn-sm btn-tertiary" data-close-sheet aria-label="Close"><span class="icon icon-x" aria-hidden="true"></span></button>';

export class WbSheet extends WbElement {
    setup(signal) {
        this.saveServerSoon = debounce(() => this.saveServerFields(), 600);
        this.workbench.on('sheet', () => this.render(), signal);
        this.shell.on('select', () => {
            if (this.workbench.sheet === 'server') this.render();
        }, signal);
        const serverChanged = ({ url }) => {
            if (this.workbench.sheet === 'server' && (!url || url === this.shell.selectedServerUrl)) this.updateServerInfo();
        };
        this.shell.on('servers', serverChanged, signal);
        this.shell.on('auth', serverChanged, signal);
        this.workbench.on('environment', ({ edited }) => {
            if (this.workbench.sheet === 'variables' && !edited) this.render();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('input', event => this.edited(event), { signal });
        this.addEventListener('change', event => {
            if (event.target.id === 'sheetEnvSelect') this.workbench.selectEnvironment(event.target.value);
        }, { signal });
    }

    render() {
        const kind = this.workbench.sheet;
        this.hidden = !kind;
        if (!kind) {
            this.innerHTML = '';
            return;
        }
        this.setAttribute('role', 'dialog');
        this.setAttribute('aria-labelledby', 'sheetTitle');
        if (kind === 'server') this.renderServer();
        else this.renderVariables();
    }

    // --- Server details ---

    renderServer() {
        const server = this.shell.servers[this.shell.selectedServerUrl];
        if (!server) {
            this.workbench.closeSheet();
            return;
        }
        this.shownUrl = server.url;
        this.shownAbout = null;
        this.innerHTML = `
            <header class="wb-sheet-head">
                <span class="status-indicator" data-dot aria-hidden="true"></span>
                <img class="wb-server-icon" data-icon alt="" width="20" height="20" referrerpolicy="no-referrer" hidden>
                <h2 id="sheetTitle" data-title></h2>
                <span class="wb-spacer"></span>
                ${closeButton}
            </header>
            <div class="wb-sheet-body">
                <section class="wb-sheet-section">
                    <label class="field"><span class="field-label">Address</span><input type="text" id="serverUrlField" spellcheck="false" autocomplete="off"></label>
                    <label class="field"><span class="field-label">Name in this client</span><input type="text" id="serverAliasField" autocomplete="off"></label>
                    <p class="field-help" data-saved aria-live="polite">Changes save as you type.</p>
                </section>
                <section class="wb-sheet-section">
                    <h3 class="subsection-title">What the server says about itself</h3>
                    <dl class="info-list" id="serverAbout"></dl>
                    <div data-instructions></div>
                    <div data-sent></div>
                </section>
                <section class="wb-sheet-section">
                    <h3 class="subsection-title">Connection</h3>
                    <dl class="info-list" id="serverConnection"></dl>
                </section>
                <section class="wb-sheet-section">
                    <h3 class="subsection-title">Sign-in</h3>
                    <p class="text-secondary" data-auth></p>
                    <div class="button-row">
                        <button type="button" class="btn-primary btn-sm" data-sheet-sign-in hidden>Sign in</button>
                        <button type="button" class="btn-outline btn-sm" data-sheet-sign-out hidden>Sign out</button>
                    </div>
                    <details class="static-token" id="staticToken">
                        <summary>Use a static token instead of signing in</summary>
                        <label class="field"><span class="field-label">Bearer token</span><input type="password" id="serverTokenField" autocomplete="off" placeholder="Sent as Authorization: Bearer"></label>
                        <p class="field-help">Kept in this browser and sent only to this server. A static token takes precedence over signing in.</p>
                    </details>
                </section>
                <section class="wb-sheet-actions button-row">
                    <button type="button" class="btn-sm" data-sheet-connect>Connect</button>
                    <button type="button" class="btn-sm" data-sheet-report title="The server's details and tool list as JSON"><span class="icon icon-download" aria-hidden="true"></span>Server report</button>
                    <span class="wb-spacer"></span>
                    <button type="button" class="btn-sm btn-outline btn-danger" data-sheet-delete>Delete server</button>
                </section>
            </div>`;
        this.$('#serverUrlField').value = server.url;
        this.$('#serverAliasField').value = server.alias || '';
        this.$('#serverAliasField').placeholder = server.serverInfo?.title || server.name || "The server's own name";
        this.$('#serverTokenField').value = server.bearerToken || '';
        this.$('#staticToken').open = !!server.bearerToken;
        this.updateServerInfo();
        this.$('#sheetTitle').focus?.();
    }

    // Everything the server said about itself when it last connected, the connection, and how
    // this client signs in to it.
    updateServerInfo() {
        const server = this.shell.servers[this.shownUrl];
        if (!server || !this.$('#serverConnection')) return;
        const auth = this.shell.authStatus[server.url];
        const signedIn = !!auth?.signedIn;
        const rowsHtml = rows => rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('');
        this.$('[data-dot]').className = `status-indicator ${serverState(server, auth)}`;
        this.$('[data-title]').textContent = serverLabel(server);
        const icon = this.$('[data-icon]');
        const iconSrc = serverIcon(server);
        if (iconSrc && icon.getAttribute('src') !== iconSrc) icon.src = iconSrc;
        icon.hidden = !iconSrc;

        const info = server.serverInfo || {};
        const about = [];
        for (const [term, key] of [['Title', 'title'], ['Name', 'name'], ['Version', 'version']]) {
            if (typeof info[key] === 'string' && info[key]) about.push([term, escapeHtml(info[key])]);
        }
        if (typeof info.description === 'string' && info.description) about.push(['Description', `<span class="wb-preline">${escapeHtml(info.description)}</span>`]);
        if (typeof info.websiteUrl === 'string' && info.websiteUrl) {
            about.push(['Website', /^https?:\/\//i.test(info.websiteUrl)
                ? `<a href="${escapeHtml(info.websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.websiteUrl)}</a>`
                : `${escapeHtml(info.websiteUrl)} <span class="text-secondary">(not a link: only http and https addresses are)</span>`]);
        }
        if (Array.isArray(info.icons) && info.icons.length) about.push(['Icons', iconsHtml(info.icons, server.url)]);
        if (server.capabilities) {
            const capabilities = Object.entries(server.capabilities).map(([name, details]) => {
                const flags = details && typeof details === 'object' ? Object.keys(details).filter(flag => details[flag] === true) : [];
                return `<span class="badge">${escapeHtml(name)}${flags.length ? ` <span class="text-secondary">${escapeHtml(flags.join(', '))}</span>` : ''}</span>`;
            });
            about.push(['Capabilities', capabilities.length ? `<span class="badge-row">${capabilities.join('')}</span>` : '<span class="text-secondary">None declared</span>']);
        }
        // Drawn again only when it changes, so icons don't flicker and open sections stay open.
        const aboutHtml = about.length ? rowsHtml(about) : '<dd class="text-secondary">Connect to see what the server says about itself.</dd>';
        const sent = server.serverInfo
            ? { protocolVersion: server.protocolVersion, serverInfo: server.serverInfo, capabilities: server.capabilities, instructions: server.instructions || undefined }
            : null;
        const shown = JSON.stringify([aboutHtml, server.instructions, sent]);
        if (shown !== this.shownAbout) {
            this.shownAbout = shown;
            const aboutList = this.$('#serverAbout');
            aboutList.innerHTML = aboutHtml;
            aboutList.querySelectorAll('.wb-icon img').forEach(image => image.addEventListener('error', () => {
                const figure = image.closest('.wb-icon');
                figure.classList.add('wb-icon-skipped');
                image.replaceWith(Object.assign(document.createElement('span'), { className: 'wb-icon-none' }));
                figure.querySelector('figcaption').append(" Couldn't load it.");
            }, { once: true }));
            this.$('[data-instructions]').innerHTML = server.instructions
                ? `<details class="instructions" open><summary>Instructions from the server</summary><p>${escapeHtml(server.instructions)}</p></details>`
                : '';
            this.$('[data-sent]').innerHTML = sent
                ? `<details class="instructions"><summary>All of it, as JSON</summary><pre class="wb-json">${escapeHtml(JSON.stringify(sent, null, 2))}</pre></details>`
                : '';
        }

        const rows = [['Status', escapeHtml({ connected: 'Connected', connecting: 'Connecting…', failed: 'Not connected' }[server.status] || 'Not connected yet')]];
        if (server.protocolVersion) rows.push(['Protocol', escapeHtml(`${server.protocolVersion} (${server.era})`)]);
        if (server.bearerToken) rows.push(['Credentials', 'Static token']);
        else if (signedIn) rows.push(['Credentials', 'Signed in (OAuth)']);
        if (server.date_added) rows.push(['Added', escapeHtml(new Date(server.date_added).toLocaleString())]);
        if (server.lastError) rows.push(['Last error', `<span class="text-error">${escapeHtml(server.lastError)}</span>`]);
        this.$('#serverConnection').innerHTML = rowsHtml(rows);
        const signing = this.shell.signingIn?.url === server.url;
        this.$('[data-auth]').textContent = signing ? 'Signing in… finish it from the bar above.'
            : signedIn ? describeSignIn(auth)
            : server.bearerToken ? 'Using the static token below.'
            : server.needsSignIn ? 'This server needs you to sign in.'
            : "This server hasn't asked for sign-in.";
        this.$('[data-sheet-sign-in]').hidden = signing || signedIn || !server.needsSignIn;
        this.$('[data-sheet-sign-out]').hidden = signing || !signedIn;
        this.$('[data-sheet-connect]').textContent = server.status === 'connected' ? 'Reconnect' : 'Connect';
    }

    // Saves the address, name and token; a new address is a new server to connect to.
    saveServerFields() {
        if (!this.shell.servers[this.shownUrl] || !this.$('#serverUrlField')) return;
        const address = this.$('#serverUrlField').value.trim();
        this.shownUrl = this.shell.updateServerDetails(this.shownUrl, {
            url: /^https?:\/\/\S+$/i.test(address) ? address : this.shownUrl,
            alias: this.$('#serverAliasField').value.trim(),
            bearerToken: this.$('#serverTokenField').value.trim(),
        });
        const saved = this.$('[data-saved]');
        if (!saved) return;
        saved.textContent = /^https?:\/\/\S+$/i.test(address) ? 'Saved.' : 'Saved, except the address, which needs to start with https:// or http://.';
        clearTimeout(this.savedTimer);
        this.savedTimer = setTimeout(() => { saved.textContent = 'Changes save as you type.'; }, 2500);
    }

    // --- Variables ---

    renderVariables() {
        const environment = this.workbench.environment;
        this.innerHTML = `
            <header class="wb-sheet-head">
                <h2 id="sheetTitle">Variables</h2>
                <span class="wb-spacer"></span>
                ${closeButton}
            </header>
            <div class="wb-sheet-body">
                <p class="text-secondary">Use a variable in any field as <code>{{name}}</code>. Values are text; number, true/false and JSON fields convert them when the call goes out. They stay in this browser.</p>
                <label class="field"><span class="field-label">Environment</span>
                    <select id="sheetEnvSelect">${this.workbench.environments.map(candidate => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === environment.id ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('')}</select>
                </label>
                <label class="field"><span class="field-label">Name</span><input type="text" id="envName" autocomplete="off" spellcheck="false"></label>
                <div id="envVariables" class="env-variables">
                    ${Object.entries(environment.variables || {}).map(([name, value]) => variableRow(name, value)).join('') || variableRow('', '')}
                </div>
                <div class="button-row">
                    <button type="button" id="addVariableBtn" class="btn-sm"><span class="icon icon-plus" aria-hidden="true"></span>Add variable</button>
                </div>
                <p id="envEditorNote" class="text-error" hidden></p>
                <section class="wb-sheet-actions button-row">
                    <button type="button" id="newEnvBtn" class="btn-sm"><span class="icon icon-plus" aria-hidden="true"></span>New environment</button>
                    <span class="wb-spacer"></span>
                    <button type="button" id="deleteEnvBtn" class="btn-sm btn-outline btn-danger">Delete environment</button>
                </section>
            </div>`;
        this.$('#envName').value = environment.name;
    }

    variablesEdited() {
        const variables = {};
        const problems = [];
        for (const row of this.querySelectorAll('#envVariables .env-variable')) {
            const name = row.querySelector('.env-variable-name').value.trim();
            const value = row.querySelector('.env-variable-value').value;
            if (!name) continue;
            if (!VARIABLE_NAME.test(name)) {
                problems.push(`"${name}" isn't a usable name: start with a letter or _, then use letters, digits, _, - or .`);
            } else if (Object.hasOwn(variables, name)) {
                problems.push(`${name} is defined twice; the last one wins.`);
            }
            if (VARIABLE_NAME.test(name)) variables[name] = value;
        }
        this.workbench.editEnvironment({ name: this.$('#envName').value.trim(), variables });
        const option = this.$(`#sheetEnvSelect option[value="${CSS.escape(this.workbench.environment.id)}"]`);
        if (option) option.textContent = this.workbench.environment.name;
        const note = this.$('#envEditorNote');
        note.textContent = problems.join(' ');
        note.hidden = !problems.length;
    }

    edited(event) {
        if (event.target.closest('#envVariables') || event.target.id === 'envName') return this.variablesEdited();
        if (['serverUrlField', 'serverAliasField', 'serverTokenField'].includes(event.target.id)) this.saveServerSoon();
    }

    async clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const url = this.shownUrl;
        if (button.dataset.closeSheet !== undefined) return this.workbench.closeSheet();
        if (button.dataset.sheetConnect !== undefined) return this.shell.connectMcpServer(url);
        if (button.dataset.sheetReport !== undefined) return this.shell.exportToolList(url);
        if (button.dataset.sheetSignIn !== undefined) return this.shell.signIn(url);
        if (button.dataset.sheetSignOut !== undefined) return this.shell.signOut(url, { forgetClient: event.shiftKey });
        if (button.dataset.sheetDelete !== undefined) {
            return confirmThen(button, () => {
                this.workbench.closeSheet();
                this.shell.deleteServer(url);
            });
        }
        if (button.id === 'addVariableBtn') {
            const rows = this.$('#envVariables');
            rows.insertAdjacentHTML('beforeend', variableRow('', ''));
            rows.lastElementChild.querySelector('input').focus();
            return;
        }
        if (button.dataset.removeVariable !== undefined) {
            button.closest('.env-variable').remove();
            return this.variablesEdited();
        }
        if (button.id === 'newEnvBtn') {
            await this.workbench.newEnvironment();
            this.$('#envName')?.select();
            return;
        }
        if (button.id === 'deleteEnvBtn') return confirmThen(button, () => this.workbench.deleteEnvironment());
    }
}
