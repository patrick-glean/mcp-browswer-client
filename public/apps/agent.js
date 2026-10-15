// A model that can call tools: the agent loop, as an app's rule runs it. A rule whose call is a
// model (its prompt field, rule.prompt) can let it use your servers' tools (rule.tools): the
// prompt then says how to ask for a tool call and which tools there are, never with a server's
// credentials, and the tool calls in the answer, JSON-RPC requests in code blocks, run as runs
// from a reply. Their results join the conversation, which the model gets with the next message.
// Pure, for the runner, the builder and the tests.

export const TOOLS_INSTRUCTIONS = `You can call the tools listed below. To call one, put a JSON-RPC request in a \`\`\`json block in your answer, with the tool's name as its method and its arguments as its params:

\`\`\`json
{"jsonrpc": "2.0", "method": "tool_name", "params": {"argument": "value"}, "id": 1}
\`\`\`

Call a tool when it would help you answer, and only the tools listed here; don't make up tools, calls or results. Each call runs, and its result joins the conversation, as a message from Tool, which you get with the next message.`;

// A model's answer without the details Glean's chat puts after it: a line of three dashes, then
// the conversation's metadata from chatId on. A conversation shows the answer alone, and the
// model gets it back alone.
export const answerText = text => String(text ?? '').replace(/\n+---\nchatId: [\s\S]*$/, '').trimEnd();

// The field of a model's tool the conversation so far goes in: a list of text named like one
// (Glean's chat calls it context).
const CONVERSATION_NAMES = ['history', 'context', 'conversation', 'messages', 'chat_history'];

export function conversationFieldOf(schema) {
    const lists = Object.entries(schema?.properties || {})
        .filter(([, prop]) => prop?.type === 'array' && (!prop.items || prop.items.type === 'string'))
        .map(([key]) => key);
    return CONVERSATION_NAMES.find(name => lists.includes(name)) || null;
}

// The servers and tools a model is told about: names, descriptions and input schemas, and never
// what a server signs in with.
export function toolsForModel(servers) {
    return Object.values(servers || {}).filter(server => server?.tools?.length).map(server => ({
        server: server.alias || server.name || server.url,
        url: server.url,
        tools: server.tools.map(tool => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema || tool.input_schema || { type: 'object' },
        })),
    }));
}

// What a rule that lets its model call tools adds to the prompt.
export function toolsRequest(servers) {
    return `${TOOLS_INSTRUCTIONS}\n\nThe tools, by server:\n\n\`\`\`json\n${JSON.stringify(toolsForModel(servers))}\n\`\`\``;
}

// The prompt a rule sends in its prompt field: its instructions, the tools its model may call
// (`servers`, when it may), the field's own text (the question), then the request of the boxes
// it fills.
export function composePrompt(text, { instructions = '', servers = null, request = '' } = {}) {
    const asked = typeof text === 'string' ? text.trim() : text === undefined || text === null ? '' : String(text);
    return [String(instructions ?? '').trim(), servers ? toolsRequest(servers) : '', asked, request].filter(Boolean).join('\n\n');
}

// The tool calls in a model's answer: JSON-RPC requests in its code blocks, read as written or
// with the escaped quotes some models write.
export function toolCallsIn(text) {
    const calls = [];
    for (const match of String(text ?? '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
        const code = match[1].trim();
        for (const candidate of [code, code.replace(/\\"/g, '"')]) {
            let call;
            try {
                call = JSON.parse(candidate);
            } catch {
                continue;
            }
            if (call?.jsonrpc === '2.0' && typeof call.method === 'string') calls.push(call);
            break;
        }
    }
    return calls;
}

// The server that has a tool by that name: one that's connected first.
export function serverWithTool(servers, name) {
    const offering = Object.values(servers || {}).filter(server => (server?.tools || []).some(tool => tool.name === name));
    const server = offering.find(candidate => candidate.status === 'connected') || offering[0];
    return server ? { server, tool: server.tools.find(tool => tool.name === name) } : null;
}

// At most three tool calls from a rule's answers every 10 seconds, so a model can't loop on them.
export const REPLY_CALLS = { most: 3, withinMs: 10_000 };

export function allowedCall(times, now = Date.now()) {
    const recent = (times || []).filter(time => now - time < REPLY_CALLS.withinMs);
    return { allowed: recent.length < REPLY_CALLS.most, times: recent.length < REPLY_CALLS.most ? [...recent, now] : recent };
}
