// A handle on an edge of the Apps page that sizes what's beside it: data-pane="rail" (the list of
// apps, left of it), "inspector" (the canvas's Inspector, right of it) or "canvas" (how tall the
// canvas is, above it). Drag it, or focus it and use the arrow keys; double-click goes back to the
// page's own size. Sizes stay in this browser, as CSS variables on the Apps page that its layout
// reads.

import { AppElement } from './base.js';

const PANES = {
    rail: { label: 'Resize the list of apps', variable: '--apps-rail-width', of: 'apps-rail', min: 160, max: 420, step: 16 },
    inspector: { label: 'Resize the Inspector', variable: '--inspector-width', of: 'app-inspector', min: 260, max: 640, step: 16, fromRight: true },
    canvas: { label: 'Resize the canvas', variable: '--canvas-height', of: '[data-canvas-scroll]', min: 320, max: 2400, step: 40, across: true },
};
const SIZES_KEY = 'appsPanes';

const sizes = () => {
    try {
        const found = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}');
        return found && typeof found === 'object' ? found : {};
    } catch {
        return {};
    }
};

export class AppsSplitter extends AppElement {
    setup(signal) {
        this.setAttribute('role', 'separator');
        this.setAttribute('aria-label', this.pane.label);
        this.setAttribute('aria-orientation', this.pane.across ? 'horizontal' : 'vertical');
        this.setAttribute('aria-valuemin', String(this.pane.min));
        this.setAttribute('aria-valuemax', String(this.pane.max));
        this.tabIndex = 0;
        this.addEventListener('pointerdown', event => this.startDrag(event), { signal });
        this.addEventListener('keydown', event => this.keyed(event), { signal });
        this.addEventListener('dblclick', () => this.resize(null), { signal });
    }

    get pane() {
        return PANES[this.dataset.pane];
    }

    get target() {
        return document.querySelector(this.pane.of);
    }

    render() {
        this.apply();
    }

    apply() {
        const size = sizes()[this.dataset.pane];
        const page = document.getElementById('appsPage');
        if (size === undefined) page?.style.removeProperty(this.pane.variable);
        else page?.style.setProperty(this.pane.variable, `${size}px`);
        const current = this.current();
        if (current !== null) this.setAttribute('aria-valuenow', String(Math.round(current)));
    }

    // A size in pixels, or null for the page's own.
    resize(size) {
        const kept = sizes();
        if (size === null) delete kept[this.dataset.pane];
        else kept[this.dataset.pane] = Math.round(Math.min(this.pane.max, Math.max(this.pane.min, size)));
        localStorage.setItem(SIZES_KEY, JSON.stringify(kept));
        this.apply();
    }

    current() {
        const box = this.target?.getBoundingClientRect();
        if (!box) return null;
        return this.pane.across ? box.height : box.width;
    }

    // The size the pointer asks for, measured from the far edge of what's being sized.
    sizeAt(event) {
        const box = this.target.getBoundingClientRect();
        if (this.pane.across) return event.clientY - box.top;
        return this.pane.fromRight ? box.right - event.clientX : event.clientX - box.left;
    }

    startDrag(event) {
        if (event.button !== 0 || !this.target) return;
        event.preventDefault();
        this.setPointerCapture(event.pointerId);
        this.dataset.dragging = '';
        document.body.classList.add(this.pane.across ? 'wb-resizing-rows' : 'wb-resizing-columns');
        const move = moved => this.resize(this.sizeAt(moved));
        const stop = () => {
            this.removeEventListener('pointermove', move);
            delete this.dataset.dragging;
            document.body.classList.remove('wb-resizing-rows', 'wb-resizing-columns');
        };
        this.addEventListener('pointermove', move);
        this.addEventListener('pointerup', stop, { once: true });
        this.addEventListener('pointercancel', stop, { once: true });
    }

    keyed(event) {
        const smaller = this.pane.across ? 'ArrowUp' : this.pane.fromRight ? 'ArrowRight' : 'ArrowLeft';
        const bigger = this.pane.across ? 'ArrowDown' : this.pane.fromRight ? 'ArrowLeft' : 'ArrowRight';
        if (![smaller, bigger, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const { min, max, step } = this.pane;
        const current = this.current() ?? min;
        this.resize({ [smaller]: current - step, [bigger]: current + step, Home: min, End: max }[event.key]);
    }
}
