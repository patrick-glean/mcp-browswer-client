// A handle on the edge between two Workbench panes, sizing the one before it: data-pane="rail"
// or "tools" for their widths, or "request" for the request pane's share of the space it splits
// with the response pane (side by side, or stacked on narrower screens). Drag it, or focus it
// and use the arrow keys; double-click goes back to the layout's size. Each splitter keeps its
// pane's size in a CSS variable on #workbench, which the layout's grid reads.

import { WbElement } from './base.js';

const PANES = {
    rail: { label: 'Resize the server list', min: 160, max: 480, step: 16 },
    tools: { label: 'Resize the tool list', min: 180, max: 560, step: 16 },
    request: { label: 'Resize the request and response panes', min: 0.2, max: 0.8, step: 0.05 },
};

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

export class WbSplitter extends WbElement {
    setup(signal) {
        this.setAttribute('role', 'separator');
        this.setAttribute('aria-label', this.limits.label);
        this.tabIndex = 0;
        this.workbench.on('panes', () => this.apply(), signal);
        // A narrower window can stack the request and response panes, turning this handle.
        window.addEventListener('resize', () => this.apply(), { signal });
        this.addEventListener('pointerdown', event => this.startDrag(event), { signal });
        this.addEventListener('keydown', event => this.keyed(event), { signal });
        this.addEventListener('dblclick', () => this.workbench.setPanes({ [this.pane]: null }), { signal });
    }

    get pane() {
        return this.dataset.pane;
    }

    get limits() {
        return PANES[this.pane];
    }

    get container() {
        return this.closest('.wb-workbench');
    }

    area(name) {
        return this.container.querySelector(`.wb-area-${name}:not([hidden])`);
    }

    // Stacked request and response panes put this handle on its side.
    get across() {
        return this.offsetWidth > this.offsetHeight;
    }

    render() {
        this.apply();
    }

    apply() {
        const size = this.workbench.panes[this.pane];
        const style = this.container.style;
        if (this.pane === 'request') {
            if (size === undefined) {
                style.removeProperty('--request-fr');
                style.removeProperty('--response-fr');
            } else {
                style.setProperty('--request-fr', `${size}fr`);
                style.setProperty('--response-fr', `${1 - size}fr`);
            }
        } else if (size === undefined) {
            style.removeProperty(`--${this.pane}-width`);
        } else {
            style.setProperty(`--${this.pane}-width`, `${size}px`);
        }
        this.setAttribute('aria-orientation', this.across ? 'horizontal' : 'vertical');
        const current = this.current();
        if (current !== null) {
            const { min, max } = this.limits;
            const percent = value => Math.round(value * 100);
            this.setAttribute('aria-valuenow', String(this.pane === 'request' ? percent(current) : Math.round(current)));
            this.setAttribute('aria-valuemin', String(this.pane === 'request' ? percent(min) : min));
            this.setAttribute('aria-valuemax', String(this.pane === 'request' ? percent(max) : max));
        }
    }

    // The pane's size as laid out now, in the units setPanes takes.
    current() {
        if (this.pane === 'request') {
            const request = this.area('request')?.getBoundingClientRect();
            const response = this.area('response')?.getBoundingClientRect();
            if (!request || !response) return null;
            const [first, second] = this.across ? [request.height, response.height] : [request.width, response.width];
            return first + second ? first / (first + second) : null;
        }
        return this.area(this.pane)?.getBoundingClientRect().width ?? null;
    }

    // The size the pointer asks for.
    sizeAt(event) {
        if (this.pane === 'request') {
            const request = this.area('request').getBoundingClientRect();
            const response = this.area('response').getBoundingClientRect();
            return this.across
                ? (event.clientY - request.top) / (response.bottom - request.top)
                : (event.clientX - request.left) / (response.right - request.left);
        }
        return event.clientX - this.area(this.pane).getBoundingClientRect().left;
    }

    startDrag(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        this.setPointerCapture(event.pointerId);
        this.dataset.dragging = '';
        document.body.classList.add(this.across ? 'wb-resizing-rows' : 'wb-resizing-columns');
        const move = moved => this.workbench.setPanes({ [this.pane]: clamp(this.sizeAt(moved), this.limits) });
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
        const back = this.across ? 'ArrowUp' : 'ArrowLeft';
        const forward = this.across ? 'ArrowDown' : 'ArrowRight';
        if (![back, forward, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const { min, max, step } = this.limits;
        const current = this.current() ?? min;
        const next = { [back]: current - step, [forward]: current + step, Home: min, End: max }[event.key];
        this.workbench.setPanes({ [this.pane]: clamp(next, this.limits) });
    }
}
