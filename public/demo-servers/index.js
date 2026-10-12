// The demo servers built into MCP Browser Client: MCP servers that answer in the page's service
// worker, so the examples work with nothing to install or run. Each has an address no network
// answers (.invalid never resolves). In the worker, installDemoServers answers the requests to
// those addresses from the fetch() the MCP client library makes, so the library talks to them the
// way it talks to any server. You add one as you'd add any server, and an app that calls one can
// call your own server instead, if it has the same tools.

import { DEMO_CHAT, demoModelServer } from './demo-model.js';
import { FRONT_DESK_TOOLS, frontDeskServer } from './front-desk.js';

const definition = ({ call, ...tool }) => tool;

// Each with what it is in a sentence (`about`), the tools it lists, and `make`, which starts it.
export const DEMO_SERVERS = {
    frontdesk: {
        id: 'frontdesk',
        url: 'https://frontdesk.demo.invalid/mcp',
        name: 'Front desk (demo)',
        about: "A front desk's visitor system: today's made-up visits, check-ins that print a badge, and a call for help",
        tools: FRONT_DESK_TOOLS.map(definition),
        make: frontDeskServer,
    },
    model: {
        id: 'model',
        url: 'https://model.demo.invalid/mcp',
        name: 'Demo model',
        about: 'A stand-in for a model: it repeats what you say, writes the tool calls you ask for, and makes up what boxes and pages need',
        tools: [definition(DEMO_CHAT)],
        make: demoModelServer,
    },
};

export const demoServerAt = url => Object.values(DEMO_SERVERS).find(server => server.url === url) || null;

// In the worker: requests to a demo server's host are answered here, by one instance of it for as
// long as the worker runs; everything else goes to the network as before.
export function installDemoServers(scope = self) {
    if (scope.fetch.demoServers) return;
    const networkFetch = scope.fetch;
    const running = new Map();
    const serverAt = url => {
        const demo = Object.values(DEMO_SERVERS).find(candidate => new URL(candidate.url).host === url.host);
        if (!demo) return null;
        if (!running.has(demo.id)) running.set(demo.id, demo.make());
        return running.get(demo.id);
    };
    const fetch = async (input, init) => {
        let url = null;
        try {
            url = new URL(input instanceof Request ? input.url : String(input));
        } catch {
            // Not an address of ours.
        }
        const server = url?.protocol === 'https:' ? serverAt(url) : null;
        if (!server) return networkFetch.call(scope, input, init);
        const request = new Request(input, init);
        return server.answer({ method: request.method, headers: request.headers, body: await request.text() });
    };
    fetch.demoServers = true;
    scope.fetch = fetch;
}
