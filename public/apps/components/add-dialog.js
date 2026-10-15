// Asks before an example becomes one of your apps: what it is, what it calls, for one that calls
// tools as it opens whether to run them then, and, when you've added it before, to open that one
// instead. The rail's Examples and the start page offer examples through it (Apps.offerExample).

import { escapeHtml, timeAgo } from '../../workbench/util.js';
import { EXAMPLES, openRules } from '../apps.js';
import { AppElement } from './base.js';

export class AppsAddDialog extends AppElement {
    setup(signal) {
        this.apps.on('offer', ({ example }) => this.open(example), signal);
        this.addEventListener('click', event => this.clicked(event), { signal });
    }

    render() {
        this.innerHTML = '<dialog class="apps-dialog" aria-labelledby="appsAddTitle" aria-describedby="appsAddAbout"></dialog>';
        this.dialog = this.$('dialog');
    }

    open(example) {
        if (!EXAMPLES[example] || !this.dialog) return;
        this.example = example;
        const draft = this.apps.exampleApp(example);
        const { name, about } = EXAMPLES[example];
        const copies = this.apps.copiesOf(example);
        const latest = copies[0];
        const calls = this.apps.callsText(draft);
        const opens = openRules(draft).length ? this.apps.openCallsText(draft) : '';
        this.dialog.innerHTML = `
            <div class="apps-dialog-body">
                <h2 id="appsAddTitle">Add a copy of ${escapeHtml(name)}?</h2>
                <p id="appsAddAbout">${escapeHtml(about)}.</p>
                <p class="text-secondary">It goes under Your apps as ${escapeHtml(draft.name)}, yours to look at, run and change${calls ? `. It calls ${escapeHtml(calls)}` : ''}. Delete it whenever you like: ⋯ beside it under Your apps, then Delete.</p>
                ${opens ? `<label class="apps-dialog-check"><input type="checkbox" data-run-on-open checked> Run what it calls as it opens (${escapeHtml(opens)}) each time you open it</label>` : ''}
                ${latest ? `<p class="apps-dialog-have">You have ${copies.length === 1 ? 'a copy' : `${copies.length} copies`} already: ${escapeHtml(latest.name)}${copies.length > 1 ? ' is the newest' : ''}, added ${escapeHtml(timeAgo(latest.createdAt))}.</p>` : ''}
                <div class="apps-dialog-actions">
                    <button type="button" class="btn-tertiary" data-cancel>Cancel</button>
                    <button type="button" class="${latest ? '' : 'btn-primary'}" data-add-copy>${latest ? 'Add another copy' : 'Add a copy'}</button>
                    ${latest ? `<button type="button" class="btn-primary" data-open-copy="${escapeHtml(latest.id)}">Open ${escapeHtml(latest.name)}</button>` : ''}
                </div>
            </div>`;
        if (!this.dialog.open) this.dialog.showModal();
        this.dialog.querySelector('.btn-primary')?.focus();
    }

    clicked(event) {
        // A click on the backdrop is on the dialog itself, outside its body.
        if (event.target === this.dialog) return this.dialog.close();
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.cancel !== undefined) return this.dialog.close();
        if (button.dataset.openCopy) {
            this.dialog.close();
            return this.apps.show(button.dataset.openCopy);
        }
        if (button.dataset.addCopy !== undefined) {
            const check = this.dialog.querySelector('[data-run-on-open]');
            this.dialog.close();
            this.apps.create(this.example, { runOnOpen: check ? (check.checked ? 'yes' : 'no') : null });
        }
    }
}
