// What every Workbench component shares. Components render into their own element (light DOM, so
// the app's styles apply), listen with this.lifetime so moving or removing one cleans up after
// it, and reach the rest of the app only through ChatShell and the Workbench state.

import { app } from '../app.js';

export class WbElement extends HTMLElement {
    get shell() {
        return app.shell;
    }

    get workbench() {
        return app.workbench;
    }

    connectedCallback() {
        this.lifetime = new AbortController();
        this.setup(this.lifetime.signal);
        this.render();
    }

    disconnectedCallback() {
        this.lifetime?.abort();
    }

    // Subscribes to ChatShell and Workbench events, and adds listeners on the element itself.
    setup() {}

    render() {}

    $(selector) {
        return this.querySelector(selector);
    }
}
