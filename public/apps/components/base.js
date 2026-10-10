// What the Apps page's components share: the Workbench components' base (AppShell, the Workbench
// state, a lifetime for listeners), plus the Apps state.

import { app } from '../../workbench/app.js';
import { WbElement } from '../../workbench/components/base.js';

export class AppElement extends WbElement {
    get apps() {
        return app.apps;
    }
}
