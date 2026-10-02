// The bar across the top of the Workbench: the selected server, its status and protocol, sign-in
// (with the ways to finish it in browsers without pop-up windows), and its actions. Its parts are
// updated in place, so a half-pasted sign-in address survives the server's status changing.

import { describeSignIn, escapeHtml, serverLabel, serverState } from '../util.js';
import { WbElement } from './base.js';

export class WbServerBar extends WbElement {
    setup(signal) {
        this.shell.on('select', () => this.render(), signal);
        this.shell.on('servers', ({ url }) => {
            if (!url || url === this.shell.selectedServerUrl) this.update();
        }, signal);
        this.shell.on('auth', ({ url, pasteError }) => {
            if (url && url !== this.shell.selectedServerUrl) return;
            this.update();
            if (pasteError) this.pasteError(pasteError);
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target.id === 'authCallbackUrl') {
                event.preventDefault();
                this.finishFromPaste();
            }
        }, { signal });
    }

    render() {
        const url = this.shell.selectedServerUrl;
        this.shownUrl = url;
        if (!url || !this.shell.servers[url]) {
            this.innerHTML = `<div class="wb-bar"><span class="text-secondary">No server selected. Pick one on the left, add one with +, or <button type="button" class="link-button" data-open-guide>try one from the guide</button>.</span></div>`;
            return;
        }
        const callback = new URL('oauth-callback.html', location.href).href;
        this.innerHTML = `
            <div class="wb-bar">
                <span class="status-indicator" data-dot aria-hidden="true"></span>
                <h2 class="wb-bar-name" data-name></h2>
                <span class="wb-bar-detail" data-detail></span>
                <span class="wb-spacer"></span>
                <div class="wb-bar-actions">
                    <button type="button" id="initProtocol" class="btn-sm">Connect</button>
                    <button type="button" id="listTools" class="btn-sm" title="Ask the server for its tools again"><span class="icon icon-refresh" aria-hidden="true"></span>Refresh tools</button>
                    <button type="button" id="serverInfoBtn" class="btn-sm" aria-haspopup="dialog">Info</button>
                    <details class="menu">
                        <summary class="btn-icon btn-sm btn-tertiary" aria-label="More for this server"><span class="wb-more" aria-hidden="true">⋯</span></summary>
                        <div class="menu-list" role="menu">
                            <button type="button" class="menu-item" role="menuitem" id="downloadToolsBtn" title="The server's details and tool list as JSON">Download the server report</button>
                            <button type="button" class="menu-item btn-danger" role="menuitem" id="deleteServerBtn">Delete this server</button>
                        </div>
                    </details>
                </div>
            </div>
            <div class="auth-block wb-auth" id="authPanel" hidden>
                <span id="authStatus" class="auth-text"></span>
                <div class="button-row">
                    <button type="button" id="signInBtn" class="btn-primary btn-sm">Sign in</button>
                    <button type="button" id="continueHereBtn" class="btn-sm" hidden>Continue in this tab</button>
                    <button type="button" id="copyAuthLinkBtn" class="btn-sm" hidden><span class="icon icon-copy" aria-hidden="true"></span><span class="btn-label">Copy link</span></button>
                    <button type="button" id="cancelSignInBtn" class="btn-outline btn-sm" hidden>Cancel</button>
                    <button type="button" id="signOutBtn" class="btn-outline btn-sm" hidden title="Shift-click to also forget this client's registration">Sign out</button>
                </div>
                <div class="auth-elsewhere" id="authElsewhere" hidden>
                    <input type="text" id="authLink" class="auth-link" readonly aria-label="Sign-in link" hidden>
                    <p id="authLinkHint" class="text-secondary" hidden>Press ⌘C or Ctrl+C to copy the link, then open it in another tab.</p>
                    <details class="auth-paste">
                        <summary>Signing in from another browser?</summary>
                        <p class="text-secondary">Open the link there and sign in. You'll land on a page that says it isn't where you started; copy its address and paste it here.</p>
                        <div class="auth-paste-row">
                            <input type="text" id="authCallbackUrl" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(callback)}?code=…" aria-label="The address sign-in sent you to">
                            <button type="button" id="finishSignInBtn" class="btn-primary btn-sm">Finish signing in</button>
                        </div>
                        <p id="authPasteError" class="text-error" hidden></p>
                    </details>
                </div>
            </div>
            <p id="serverError" class="wb-bar-error text-error" hidden></p>`;
        this.update();
    }

    // Brings the bar's text and buttons up to date with the server and its sign-in.
    update() {
        const url = this.shell.selectedServerUrl;
        const server = this.shell.servers[url];
        if (url !== this.shownUrl || !server || !this.$('[data-name]')) return this.render();
        const auth = this.shell.authStatus[url];
        const signedIn = !!auth?.signedIn;
        const signing = this.shell.signingIn?.url === url ? this.shell.signingIn : null;
        const linkReady = !!signing?.authorizationUrl;

        this.$('[data-dot]').className = `status-indicator ${serverState(server, auth)}`;
        this.$('[data-name]').textContent = serverLabel(server);
        this.$('[data-name]').title = url;
        const parts = [{ connected: 'Connected', connecting: 'Connecting…', failed: 'Not connected' }[server.status] || 'Not connected yet'];
        if (server.protocolVersion) parts.push(`MCP ${server.protocolVersion} (${server.era})`);
        const info = server.serverInfo;
        if (server.status === 'connected' && (info?.title || info?.name)) parts.push([info.title || info.name, info.version].filter(Boolean).join(' '));
        if (server.bearerToken) parts.push('static token');
        this.$('[data-detail]').textContent = parts.join(' · ');

        const connect = this.$('#initProtocol');
        connect.textContent = server.status === 'connected' ? 'Reconnect' : 'Connect';
        connect.classList.toggle('btn-primary', server.status !== 'connected' && server.status !== 'connecting' && !(server.needsSignIn && !signedIn));
        connect.disabled = server.status === 'connecting';
        this.$('#listTools').hidden = server.status !== 'connected';

        const error = this.$('#serverError');
        error.textContent = server.lastError || '';
        error.hidden = !server.lastError;

        this.$('#authPanel').hidden = !(server.needsSignIn || signedIn || signing);
        this.$('#authStatus').textContent = !signing
            ? (signedIn ? describeSignIn(auth) : 'This server needs you to sign in.')
            : !linkReady ? 'Finding where to sign in…'
            : signing.popup ? "Finish signing in in the pop-up window. If it didn't open, continue in this tab or copy the link."
            : "This browser didn't open a pop-up window. Continue in this tab, or copy the link to sign in in another tab or browser.";
        this.$('#signInBtn').hidden = !!signing || signedIn;
        this.$('#continueHereBtn').hidden = !linkReady;
        this.$('#copyAuthLinkBtn').hidden = !linkReady;
        this.$('#cancelSignInBtn').hidden = !signing;
        this.$('#signOutBtn').hidden = !!signing || !signedIn;
        // Reset the other-browser fields only when they appear or go away.
        const elsewhere = this.$('#authElsewhere');
        if (elsewhere.hidden !== !linkReady) {
            elsewhere.hidden = !linkReady;
            this.$('#authLink').hidden = true;
            this.$('#authLinkHint').hidden = true;
            this.$('#authPasteError').hidden = true;
            this.$('#authCallbackUrl').value = '';
        }
    }

    pasteError(text) {
        const error = this.$('#authPasteError');
        if (!error) return;
        error.textContent = text || '';
        error.hidden = !text;
    }

    finishFromPaste() {
        this.pasteError(this.shell.finishSignInFromPaste(this.$('#authCallbackUrl').value));
    }

    async copyLink(button) {
        const { copied, link } = await this.shell.copySignInLink();
        if (!link) return;
        if (copied) {
            const label = button.querySelector('.btn-label');
            label.textContent = 'Copied';
            setTimeout(() => { label.textContent = 'Copy link'; }, 1500);
            return;
        }
        // Some embedded browsers refuse clipboard access; leave the link selected instead.
        const input = this.$('#authLink');
        input.value = link;
        input.hidden = false;
        this.$('#authLinkHint').hidden = false;
        input.focus();
        input.select();
    }

    clicked(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const url = this.shell.selectedServerUrl;
        button.closest('details.menu')?.removeAttribute('open');
        switch (button.id) {
            case 'initProtocol': return this.shell.connectMcpServer(url);
            case 'listTools': return this.shell.requestTools(url, { refresh: true });
            case 'serverInfoBtn': return this.workbench.openSheet('server');
            case 'downloadToolsBtn': return this.shell.exportToolList(url);
            case 'deleteServerBtn': return this.shell.deleteServer(url);
            // The sign-in window opens straight from the click, so pop-up blockers allow it.
            case 'signInBtn': return this.shell.signIn(url);
            case 'cancelSignInBtn': return this.shell.cancelSignIn();
            case 'signOutBtn': return this.shell.signOut(url, { forgetClient: event.shiftKey });
            case 'continueHereBtn': return this.shell.continueSignInHere();
            case 'copyAuthLinkBtn': return this.copyLink(button);
            case 'finishSignInBtn': return this.finishFromPaste();
        }
    }
}
