// Starts the Apps page: loads the apps you've built, defines the builder's components (which draw
// themselves where index.html places them) and shows the builder, or with no app to show, the
// examples to start from; or, launched, one app on its own.

import { app } from '../workbench/app.js';
import { Apps } from './apps.js';
import { AppsAddDialog } from './components/add-dialog.js';
import { AppCanvas } from './components/canvas.js';
import { AppFlow } from './components/flow.js';
import { AppHeader } from './components/header.js';
import { AppInspector } from './components/inspector.js';
import { AppOpenAsk } from './components/open-ask.js';
import { AppPreview } from './components/preview.js';
import { AppsRail, AppsStart } from './components/rail.js';
import { AppScreen } from './components/screen.js';
import { AppsSplitter } from './components/splitter.js';
import { AppTry } from './components/try.js';

const COMPONENTS = {
    'apps-rail': AppsRail,
    'apps-start': AppsStart,
    'apps-add-dialog': AppsAddDialog,
    'apps-splitter': AppsSplitter,
    'app-header': AppHeader,
    'app-open-ask': AppOpenAsk,
    'app-canvas': AppCanvas,
    'app-inspector': AppInspector,
    'app-screen': AppScreen,
    'app-flow': AppFlow,
    'app-try': AppTry,
    'app-preview': AppPreview,
};

// With `launch` ({ id } or { run }), the page runs that one app on its own (Apps.launch).
export async function installApps(shell, { showMode, launch = null } = {}) {
    const apps = new Apps(shell, app.workbench, { showMode });
    app.apps = apps;
    // First, so the builder and the view are on the page before their components draw the app.
    const showView = () => document.querySelectorAll('[data-app-view]').forEach(view => { view.hidden = view.dataset.appView !== apps.view; });
    showView();
    apps.on('view', showView);
    apps.on('shown', ({ id }) => {
        document.getElementById('appsStart').hidden = !!id;
        document.getElementById('appBuilder').hidden = !id;
        // Another app opens out of Preview, in the view Preview came from.
        showView();
    });
    for (const [name, component] of Object.entries(COMPONENTS)) {
        if (!customElements.get(name)) customElements.define(name, component);
    }
    await apps.load({ launch });
    return apps;
}
