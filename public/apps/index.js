// Starts the Apps page: loads the apps you've built, defines the builder's components (which draw
// themselves where index.html places them) and switches between the Chat app and the builder.

import { app } from '../workbench/app.js';
import { Apps, CHAT } from './apps.js';
import { AppCanvas } from './components/canvas.js';
import { AppFlow } from './components/flow.js';
import { AppHeader } from './components/header.js';
import { AppInspector } from './components/inspector.js';
import { AppPreview } from './components/preview.js';
import { AppsRail } from './components/rail.js';
import { AppScreen } from './components/screen.js';

const COMPONENTS = {
    'apps-rail': AppsRail,
    'app-header': AppHeader,
    'app-canvas': AppCanvas,
    'app-inspector': AppInspector,
    'app-screen': AppScreen,
    'app-flow': AppFlow,
    'app-preview': AppPreview,
};

export async function installApps(shell, { showMode } = {}) {
    const apps = new Apps(shell, app.workbench, { showMode });
    app.apps = apps;
    // First, so the builder and the view are on the page before their components draw the app.
    const showView = () => document.querySelectorAll('[data-app-view]').forEach(view => { view.hidden = view.dataset.appView !== apps.view; });
    showView();
    apps.on('view', showView);
    apps.on('shown', ({ id }) => {
        document.getElementById('chatApp').hidden = id !== CHAT;
        document.getElementById('appBuilder').hidden = id === CHAT;
    });
    for (const [name, component] of Object.entries(COMPONENTS)) {
        if (!customElements.get(name)) customElements.define(name, component);
    }
    await apps.load();
    return apps;
}
