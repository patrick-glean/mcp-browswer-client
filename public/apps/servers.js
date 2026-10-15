// The servers an app calls, and moving its calls from one to another that answers the same way:
// from a built-in demo server to your own, say. Another server can take an app's calls to one when
// it has each tool the app calls there, and each tool takes what the app sends (its required
// fields are ones the app fills). Pure functions, for the builder and the tests.

// Every call an app makes: its rules', its parts', and its screen's when a tool made it.
function callsOf(app) {
    const screen = app?.screen;
    const made = screen?.kind === 'html' ? [screen.from] : (screen?.components || []).filter(component => component.type === 'part').map(part => part.from);
    return [...(app?.flow || []).map(rule => rule.call), ...made].filter(call => call?.serverUrl);
}

// The servers an app calls, in the order it first calls them, each with the tools it calls there:
// [{ url, tools: [{ name, sends: [argument] }] }]. A tool the app calls several times sends what
// all those calls do.
export function serverCalls(app) {
    const servers = new Map();
    for (const { serverUrl, toolName, args } of callsOf(app)) {
        if (!servers.has(serverUrl)) servers.set(serverUrl, new Map());
        if (!toolName) continue;
        const sends = servers.get(serverUrl).get(toolName) || new Set(Object.keys(args || {}));
        for (const key of sends) if (!Object.hasOwn(args || {}, key)) sends.delete(key);
        servers.get(serverUrl).set(toolName, sends);
    }
    return [...servers].map(([url, tools]) => ({ url, tools: [...tools].map(([name, sends]) => ({ name, sends: [...sends] })) }));
}

// Why `server` (one of yours, with the tools it listed) can't take these calls: the tools it
// doesn't have, and the fields a tool requires that the app doesn't send. [] when it can.
export function whyNotInstead(tools, server) {
    const listed = new Map((server?.tools || []).map(tool => [tool.name, tool]));
    return tools.flatMap(({ name, sends }) => {
        const tool = listed.get(name);
        if (!tool) return [`it has no ${name}`];
        const required = (tool.inputSchema || tool.input_schema)?.required || [];
        const unsent = required.filter(field => !sends.includes(field));
        return unsent.length ? [`its ${name} needs ${unsent.join(', ')}`] : [];
    });
}

// The app with every call to `from` going to `to` instead.
export function withCallsTo(app, from, to) {
    const moved = call => (call?.serverUrl === from ? { ...call, serverUrl: to } : call);
    const screen = app.screen?.kind === 'html'
        ? { ...app.screen, from: moved(app.screen.from) }
        : { ...app.screen, components: (app.screen?.components || []).map(component => (component.type === 'part' ? { ...component, from: moved(component.from) } : component)) };
    return { ...app, screen, flow: (app.flow || []).map(rule => ({ ...rule, call: moved(rule.call) })) };
}
