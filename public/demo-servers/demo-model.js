// The demo model: a stand-in for a model, for the examples that call one when you haven't added
// Glean or another server with a chat tool. It makes up its answers, as the mock server's chat
// (test_mcp_server.py) does: it repeats what you say, writes the tool call you ask for ("call
// find_visit with Ada") from the tools an app lists, answers an app's boxes with one JSON object
// of made-up values in their shapes, and writes a page when asked for HTML.

import { mcpServer } from './mcp.js';

// What an app adds around what the person said, as agent.js and boxes.js write it: the tools its
// model may call, and what its boxes need.
const TOOLS_LISTED = 'The tools, by server:';
const BOXES_ASKED = "This answer fills the boxes on an app's screen.";
// A box's line in that request: - "key" (kind): what goes in it. As its shape.
const BOX_LINE = /^- "([^"]+)" \(([^)]+)\): (.*)$/gm;
const CALL_ASKED = /^call\s+([\w.-]+)(?:\s+with\s+([\s\S]+))?$/i;
// The fields a tool's one value goes in, by name, before its first required text field.
const VALUE_FIELDS = ['text', 'query', 'message', 'input', 'q'];
const WEEKS = ['Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Sep 28', 'Oct 5'];

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// What the person said: after the tools an app lists, or else its last paragraph (after the app's
// instructions), and before what its boxes ask for.
export function saidIn(message) {
    const text = message.split(BOXES_ASKED)[0];
    const at = text.indexOf(TOOLS_LISTED);
    if (at >= 0) {
        const listed = text.slice(at + TOOLS_LISTED.length);
        // The block's fence closes at the start of a line; descriptions may have ``` in them.
        const close = listed.indexOf('\n```', listed.indexOf('```') + 3);
        return close >= 0 ? listed.slice(close + 4).trim() : '';
    }
    return text.trim().split('\n\n').at(-1).trim();
}

// The tools an app says its model may call, from its JSON list of servers.
export function toolsIn(message) {
    const at = message.indexOf(TOOLS_LISTED);
    if (at < 0) return [];
    const found = /```json\n([\s\S]*?)\n```/.exec(message.slice(at + TOOLS_LISTED.length));
    try {
        return (JSON.parse(found?.[1] ?? '[]') || []).flatMap(server => server.tools || []);
    } catch {
        return [];
    }
}

// Asks for a tool call, as a model an app lets use its tools does: a JSON-RPC request in a ```json
// block, its one value in the tool's text field and the other required ones filled.
function toolCallReply(name, value, tools) {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) return `I can't call ${name}: it isn't one of the tools I was given.`;
    const schema = tool.inputSchema || {};
    const props = schema.properties || {};
    const texts = Object.keys(props).filter(key => props[key]?.type === 'string');
    const required = (schema.required || []).filter(key => texts.includes(key));
    const params = {};
    for (const key of required) params[key] = (props[key].default !== undefined ? props[key].default : props[key].examples?.[0]) || key;
    const target = VALUE_FIELDS.find(key => texts.includes(key)) ?? required[0] ?? texts[0];
    if (target && value.trim()) params[target] = value.trim();
    return `I'll ask ${name}.\n\n\`\`\`json\n${JSON.stringify({ jsonrpc: '2.0', method: name, params, id: 1 })}\n\`\`\``;
}

// A made-up piece of an answer for one box, in the shape its kind asks for, about `subject` (what
// the question asks about) when there is one.
function boxValue(key, kind, about, subject) {
    const words = `${key} ${about}`.toLowerCase();
    if (kind === 'number') {
        return /health|track/.test(words) ? { value: 'On track', note: 'Two open risks, neither blocking' } : { value: 12, note: 'Up 3 since last week' };
    }
    if (kind === 'bar chart' || kind === 'line chart') {
        const found = /(\d+)\s+(?:weeks|months|days)/.exec(about);
        const count = Math.max(2, Math.min(found ? Number(found[1]) : 6, 12));
        const values = [4, 7, 5, 9, 12, 8, 10, 6, 11, 13, 9, 14];
        return { labels: count === 6 ? WEEKS : Array.from({ length: count }, (_, n) => `Week ${n + 1}`), values: values.slice(0, count) };
    }
    if (kind === 'list') {
        if (/risk|block/.test(words)) {
            return [
                { title: 'The beta date depends on the API review', detail: 'Raised by the platform team' },
                { title: "Two pilot customers haven't signed off", detail: 'Raised by sales' },
                { title: "On-call isn't staffed for launch week", detail: 'Raised by support' },
            ];
        }
        if (/who|people/.test(words)) return [{ title: 'Ada Lovelace', detail: 'Leads it' }, { title: 'Grace Hopper', detail: 'Runs the beta' }];
        return [
            { title: 'Design doc', url: 'https://example.com/docs/design', detail: 'What it is, and the choices made so far' },
            { title: 'Launch plan', url: 'https://example.com/docs/launch', detail: 'Dates, owners and the go/no-go list' },
            { title: 'Weekly notes', url: 'https://example.com/docs/weekly', detail: 'Decisions from the last three meetings' },
        ];
    }
    if (kind === 'table') return { columns: ['Item', 'Owner', 'Status'], rows: [['Design review', 'Ada', 'Done'], ['Beta', 'Grace', 'In progress'], ['Launch', 'Alan', 'Not started']] };
    if (kind === 'html') return '<div class="banner" style="padding:12px 14px;border-radius:10px;background:#e7f6ec;color:#14532d"><strong>On track.</strong> The beta starts once the API review is done.</div>';
    return `On track: ${subject ? `${subject} closed its design review last week` : 'the design review closed last week'}, and the beta starts once the API review is done. Two risks are open, neither blocking.`;
}

// Answers a prompt an app's boxes added to: one JSON object, with a key for each box.
function boxesReply(message) {
    const subject = /\blatest on (.+?)\?/.exec(message)?.[1].trim();
    const answer = Object.fromEntries([...message.matchAll(BOX_LINE)].map(([, key, kind, about]) => [key, boxValue(key, kind.toLowerCase(), about, subject)]));
    return `\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``;
}

const screenPage = title => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    main { display: grid; gap: 12px; max-width: 560px; font: 15px/1.5 system-ui, sans-serif; }
    input { padding: 8px 10px; font: inherit; }
    button { justify-self: start; padding: 8px 18px; font: inherit; }
    #answer { min-height: 40px; padding: 10px; border-radius: 8px; background: #f3f3f3; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <label for="question">Question</label>
    <input id="question" placeholder="Ask something">
    <button id="ask" type="button">Ask</button>
    <div id="answer" aria-live="polite"></div>
  </main>
</body>
</html>
`;

const dashboardPage = title => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    .dash { display: grid; gap: 12px; font: 14px/1.4 system-ui, sans-serif; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .card { padding: 10px 12px; border-radius: 10px; background: #eef2ff; color: #1e2a5a; }
    .card b { display: block; font-size: 1.5rem; }
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; padding: 8px 10px; font: inherit; }
    #tickets { margin: 0; padding-left: 18px; }
    #details { min-height: 36px; padding: 8px 10px; border-radius: 8px; background: #f4f4f5; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main class="dash">
    <h2>${escapeHtml(title)}</h2>
    <div class="cards">
      <div class="card">Open <b id="open">12</b></div>
      <div class="card">Today <b id="today">3</b></div>
      <div class="card">Waiting <b id="waiting">5</b></div>
    </div>
    <div class="row">
      <label for="search" hidden>Find a ticket</label>
      <input id="search" placeholder="Find a ticket">
      <button id="refresh" type="button">Refresh</button>
    </div>
    <ul id="tickets"><li>T-1 The printer jams</li><li>T-2 The VPN drops</li></ul>
    <div id="details" aria-live="polite"></div>
  </main>
</body>
</html>
`;

// What the demo model says to a message, with the conversation so far.
export function chatReply(message, history = []) {
    if (message.includes('one JSON object') && new RegExp(BOX_LINE.source, 'm').test(message)) return boxesReply(message);
    const said = saidIn(message);
    const asked = CALL_ASKED.exec(said);
    if (asked) return toolCallReply(asked[1], asked[2] || '', toolsIn(message));
    if (!/html/i.test(said)) {
        if (!history.length) return `You said: ${said}\n\nI'm the demo model, a stand-in that runs in this page: I don't understand what you say, I only repeat it. Ask me to call one of your tools, as in "call find_visit with Ada", and I'll write the call. For real answers, add a model such as Glean.`;
        return `You said: ${said} (${history.length} earlier message${history.length === 1 ? '' : 's'} came with it.)`;
    }
    const first = message.split('\n').find(line => line.startsWith('Write ')) ?? said.split('\n')[0];
    const request = (first.includes(': ') ? first.slice(first.indexOf(': ') + 2) : first).trim();
    const page = /dashboard/i.test(request) ? dashboardPage(request.slice(0, 1).toUpperCase() + request.slice(1, 60)) : screenPage(request.slice(0, 60) || 'Ask the demo model');
    return `Here is a page for that.\n\n\`\`\`html\n${page}\`\`\`\n\nIts buttons and fields have ids, so an app can wire them up.`;
}

export const DEMO_CHAT = {
    name: 'chat',
    title: 'Chat (the demo model)',
    description: 'A stand-in for a model that runs in this page: it repeats what you say; asked to call one of the tools an app lists ("call find_visit with Ada"), it writes the JSON-RPC request; asked for an app\'s boxes, it answers with one JSON object of made-up values in their shapes; and asked for HTML, it writes a page in an ```html block.',
    inputSchema: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'What you say to it.' },
            history: { type: 'array', items: { type: 'string' }, description: 'The conversation so far.' },
        },
        required: ['message'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    call({ message, history }) {
        return { content: [{ type: 'text', text: chatReply(String(message ?? ''), Array.isArray(history) ? history : []) }] };
    },
};

export const demoModelServer = () => mcpServer({
    name: 'Demo model',
    instructions: "A stand-in for a model, built into MCP Browser Client: it runs in this page's service worker and makes up its answers. It repeats what you say, writes the tool call you ask for, fills an app's boxes with made-up data and writes pages when asked for HTML. Add a real model, such as Glean's chat, for real answers.",
    tools: [DEMO_CHAT],
});
