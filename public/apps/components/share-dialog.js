// Share: the ways to run an app somewhere else. Embed it in a page (an iframe of the client, or
// embed.html, a page that is the app and runs it when it's opened, from a disk too), run it on its
// own (a folder with the client that runs it, to serve), or send a link. Embeds and links run the
// app in the client at its address, which the dialog sets: this page's, or where it's published.

import { escapeHtml } from '../../workbench/util.js';
import { APP_URL, embedCode, isLocalAddress } from '../apps.js';
import { AppElement } from './base.js';

// An embed's height, by the screen's width: a narrow screen is a form, a wide one a dashboard.
const heightOf = app => (app?.screen?.size === 'wide' ? 800 : 640);

export class AppsShareDialog extends AppElement {
    setup(signal) {
        this.apps.on('share', () => this.open(), signal);
        this.apps.on('clientAddress', () => {
            if (this.dialog?.open) this.fill();
        }, signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
        this.addEventListener('change', event => {
            if (event.target.matches('[data-client-address]')) this.useAddress(event.target.value);
        }, { signal });
        this.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target.matches('[data-client-address]')) {
                event.preventDefault();
                this.useAddress(event.target.value);
            }
        }, { signal });
    }

    render() {
        this.innerHTML = '<dialog class="apps-dialog apps-share" aria-labelledby="appsShareTitle"></dialog>';
        this.dialog = this.$('dialog');
    }

    open() {
        const app = this.apps.app;
        if (!app || !this.dialog) return;
        const name = escapeHtml(app.name || 'the app');
        this.dialog.innerHTML = `
            <div class="apps-dialog-body">
                <h2 id="appsShareTitle">Share ${name}</h2>
                <section class="app-share-option" data-share="embed">
                    <h3><span class="icon icon-monitor" aria-hidden="true"></span>Embed it in a page</h3>
                    <p class="text-secondary">An iframe that runs it, in MCP Browser Client at <span class="mono" data-address></span>, inside any web page. Or embed.html, a page that is the app: open it, from a disk too, and it runs.</p>
                    <textarea class="mono app-share-code" data-embed-code rows="3" readonly aria-label="The embed code" spellcheck="false"></textarea>
                    <div class="button-row">
                        <button type="button" class="btn-sm btn-primary" data-copy-embed>Copy embed code</button>
                        <button type="button" class="btn-sm" data-download-embed><span class="icon icon-download" aria-hidden="true"></span>Download embed.html</button>
                    </div>
                    <p class="app-note text-secondary">Inside a page on another site, a browser gives the app storage of its own, so it has none of your servers or sign-ins there. It adds the demo servers it calls and offers to add the others. A server that needs you to sign in works with the app on its own, below.</p>
                </section>
                <section class="app-share-option" data-share="standalone">
                    <h3><span class="icon icon-download" aria-hidden="true"></span>Run it on its own</h3>
                    <p class="text-secondary">A folder with the app and the client that runs it, for your own server or any static host: serve it (<span class="mono">npx serve</span> in it) and open its address.</p>
                    <div class="button-row"><button type="button" class="btn-sm" data-download-standalone></button></div>
                </section>
                <section class="app-share-option" data-share="link">
                    <h3><span class="icon icon-external-link" aria-hidden="true"></span>Send a link</h3>
                    <p class="text-secondary">The app in a link: whoever opens it runs it in MCP Browser Client at <span class="mono" data-address></span>, in their browser, with their own servers.</p>
                    <div class="button-row"><button type="button" class="btn-sm" data-copy-link>Copy link</button></div>
                </section>
                <section class="app-share-address">
                    <label class="app-field"><span>The client's address, where embeds and links run it</span>
                        <input type="url" class="mono" data-client-address autocomplete="off" spellcheck="false" placeholder="${escapeHtml(APP_URL)}"></label>
                    <p class="app-note" data-address-note aria-live="polite"></p>
                    <div class="button-row" data-address-choices></div>
                </section>
                <div class="apps-dialog-actions">
                    <button type="button" class="btn-primary" data-close>Done</button>
                </div>
            </div>`;
        if (!this.dialog.open) this.dialog.showModal();
        this.dialog.querySelector('[data-copy-embed]').focus();
        this.fill();
    }

    // What depends on the client's address: the embed code, the addresses named, and a check that
    // the client answers there.
    async fill() {
        const app = this.apps.app;
        if (!app || !this.dialog?.open) return;
        const address = this.apps.clientAddress();
        const own = new URL('./', location.href).href;
        this.dialog.querySelectorAll('[data-address]').forEach(element => { element.textContent = address; });
        const field = this.dialog.querySelector('[data-client-address]');
        if (document.activeElement !== field) field.value = address;
        const changed = !app.downloadedAt || app.updatedAt > app.downloadedAt;
        this.dialog.querySelector('[data-download-standalone]').innerHTML = `<span class="icon icon-download" aria-hidden="true"></span>${escapeHtml(changed ? `Download v${(app.version || 0) + 1}` : `Download v${app.version}`)} (.zip)`;
        const choices = [
            address !== own && `<button type="button" class="btn-sm btn-tertiary" data-use-address="${escapeHtml(own)}">Use this page's address</button>`,
            address !== APP_URL && `<button type="button" class="btn-sm btn-tertiary" data-use-address="${escapeHtml(APP_URL)}">Use the public client</button>`,
        ].filter(Boolean);
        this.dialog.querySelector('[data-address-choices]').innerHTML = choices.join('');
        const note = this.dialog.querySelector('[data-address-note]');
        const local = isLocalAddress(address)
            ? ' That address is on this computer, so what you share runs only here; to share it, use one others reach, such as the public client.'
            : '';
        note.className = 'app-note text-secondary';
        note.textContent = `Checking the client there…${local}`;
        const code = embedCode(await this.apps.linkTo(app, { embed: true }), { name: app.name, height: heightOf(app) });
        if (this.apps.clientAddress() !== address) return;
        this.dialog.querySelector('[data-embed-code]').value = code;
        const answer = await this.apps.checkClientAddress(address);
        if (this.apps.clientAddress() !== address || !this.dialog.open) return;
        note.className = `app-note ${answer.ok === false ? 'text-error' : 'text-secondary'}`;
        note.textContent = answer.ok
            ? `MCP Browser Client answers there.${local}`
            : answer.ok === false
                ? `There's no MCP Browser Client there: ${answer.why}.${local}`
                : `Couldn't check it: ${answer.why}. Embeds and links will still use it.${local}`;
    }

    useAddress(value) {
        try {
            this.apps.setClientAddress(value);
        } catch (error) {
            const note = this.dialog.querySelector('[data-address-note]');
            note.className = 'app-note text-error';
            note.textContent = `${error.message[0].toUpperCase()}${error.message.slice(1)}. Embeds and links still use ${this.apps.clientAddress()}.`;
        }
    }

    // Says on the button what it did, for a moment.
    done(button, text) {
        const label = button.textContent;
        button.textContent = text;
        setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1600);
    }

    async clicked(event) {
        // A click on the backdrop is on the dialog itself, outside its body.
        if (event.target === this.dialog) return this.dialog.close();
        const button = event.target.closest('button');
        if (!button) return;
        const { dataset } = button;
        if (dataset.close !== undefined) return this.dialog.close();
        if (dataset.useAddress) return this.useAddress(dataset.useAddress);
        if (dataset.copyEmbed !== undefined) {
            await this.apps.copyEmbed({ height: heightOf(this.apps.app) });
            return this.done(button, 'Copied');
        }
        if (dataset.downloadEmbed !== undefined) return this.apps.downloadEmbed();
        if (dataset.copyLink !== undefined) {
            await this.apps.copyLink();
            return this.done(button, 'Copied');
        }
        if (dataset.downloadStandalone !== undefined) {
            await this.apps.download();
            this.fill();
        }
    }
}
