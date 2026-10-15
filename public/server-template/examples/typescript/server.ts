// Example Helpdesk on the official TypeScript SDK: the server whose replies are in
// ../../example.json, described as fully as MCP allows and served over Streamable HTTP, so a
// browser client such as MCP Browser Client can connect to it.
//
//   npm install && npm start    # http://127.0.0.1:8090/mcp; PORT picks another port
//
// What a client shows comes from what's declared here: the server's identity and instructions,
// each tool's title, description, annotations and schemas, and the resources and prompts. The
// tickets are canned; a real server would look them up.

import { createServer, type IncomingMessage } from 'node:http';
import { createMcpHandler, McpServer, ResourceNotFoundError, ResourceTemplate, type ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const port = Number(process.env.PORT || 8090);

const instructions = `Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

- To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
- update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
- delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
- For questions about workload or trends, use ticket_volume_chart.
- helpdesk://guides/getting-started explains what each status and priority means.`;

// Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy and
// reaches the outside world.
const hints = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolAnnotations =>
    ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

// Zod describes types, enums, patterns, lengths, ranges and defaults; .meta() adds the JSON
// Schema keywords it has no method for (examples, a format without its own pattern, uniqueItems).
const status = z.enum(['open', 'pending', 'solved', 'closed']);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const email = (description: string) => z.string().describe(description).meta({ format: 'email', examples: ['grace@example.com'] });
const ticketId = z.string().regex(/^T-[0-9]+$/).describe("The ticket's ID: T- and a number.").meta({ examples: ['T-1042'] });

const ticketSummary = z.object({
    id: z.string(),
    subject: z.string(),
    status,
    priority,
    updatedAt: z.string().meta({ format: 'date-time' }),
});

const ticketOutput = z.object({
    id: z.string().describe("The ticket's ID."),
    subject: z.string().describe("One line on what's wrong."),
    status,
    priority,
    requester: z.object({ name: z.string(), email: z.string().meta({ format: 'email' }) }),
    assignee: z.string().meta({ format: 'email' }).optional().describe("Who's working on it. Absent while it's unassigned."),
    tags: z.array(z.string()),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    url: z.string().meta({ format: 'uri' }).describe("The ticket in the helpdesk's web app."),
});

type Summary = z.infer<typeof ticketSummary>;

// A link to read a ticket as a resource, labelled for people.
const ticketLink = (ticket: Summary) => ({
    type: 'resource_link' as const,
    uri: `helpdesk://tickets/${ticket.id}`,
    name: ticket.id,
    title: `${ticket.id}: ${ticket.subject}`,
    description: `${ticket.status}, ${ticket.priority} priority, updated ${ticket.updatedAt.slice(0, 10)}`,
    mimeType: 'application/json',
});

// The same JSON as text: clients and models that only read text get the data too.
const asText = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) });

function newServer(): McpServer {
    const server = new McpServer({
        name: 'example-helpdesk',
        title: 'Example Helpdesk',
        version: '1.4.0',
        description: 'Search, read and update the support tickets in Example Helpdesk, and chart how many come in.',
        websiteUrl: 'https://helpdesk.example.com/docs/mcp',
        icons: [
            { src: lightIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'light' },
            { src: darkIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' },
            { src: 'https://helpdesk.example.com/icons/helpdesk-48.png', mimeType: 'image/png', sizes: ['48x48'] },
        ],
    }, {
        instructions,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        // How long clients may reuse server/discover and the lists, and that they're the same
        // for everyone. Resource reads set their own, with each resource.
        cacheHints: {
            'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
            'tools/list': { ttlMs: 600_000, cacheScope: 'public' },
            'resources/list': { ttlMs: 600_000, cacheScope: 'public' },
            'resources/templates/list': { ttlMs: 600_000, cacheScope: 'public' },
            'prompts/list': { ttlMs: 600_000, cacheScope: 'public' },
        },
    });

    // --- Tools ---

    server.registerTool('search_tickets', {
        title: 'Search tickets',
        description: "Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
        annotations: hints(true, false, true, false),
        inputSchema: z.strictObject({
            query: z.string().min(1).describe('Words to look for in the subject and messages.').meta({ examples: ['printer offline'] }),
            status: status.optional().describe('Only tickets with this status.'),
            priority: priority.optional().describe('Only tickets with this priority.'),
            assignee: email('Only tickets assigned to this person, by email address.').optional(),
            updated_after: z.string().describe('Only tickets updated on or after this day (UTC), as YYYY-MM-DD.').meta({ format: 'date', examples: ['2026-10-01'] }).optional(),
            limit: z.int().min(1).max(50).default(10).describe('How many tickets to return at most.'),
            cursor: z.string().optional().describe('nextCursor from an earlier response, for the next page.'),
        }),
        outputSchema: z.object({
            tickets: z.array(ticketSummary).describe('The tickets found, most recently updated first.'),
            total: z.int().describe('How many tickets match, on every page.'),
            nextCursor: z.string().optional().describe('Send as cursor for the next page. Absent on the last page.'),
        }),
    }, async () => {
        const found = { tickets: matches, total: matches.length };
        return { content: [asText(found), ...matches.map(ticketLink)], structuredContent: found };
    });

    server.registerTool('get_ticket', {
        title: 'Get a ticket',
        description: "Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
        annotations: hints(true, false, true, false),
        inputSchema: z.strictObject({ id: ticketId }),
        outputSchema: ticketOutput,
    }, async ({ id }) => {
        if (id !== ticket1042.id) {
            // A failure the caller can fix comes back as an isError result that says what to change.
            return { content: [{ type: 'text', text: `There's no ticket ${id}; search_tickets finds tickets by their words.` }], isError: true };
        }
        return {
            content: [
                asText(ticket1042),
                { type: 'resource_link', uri: ticket1042.url, name: ticket1042.id, title: 'Open T-1042 in Example Helpdesk', mimeType: 'text/html' },
            ],
            structuredContent: ticket1042,
        };
    });

    server.registerTool('update_ticket', {
        title: 'Update a ticket',
        description: "Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
        annotations: hints(false, false, true, false),
        inputSchema: z.strictObject({
            id: ticketId,
            status: status.optional().describe('The new status.'),
            priority: priority.optional().describe('The new priority.'),
            assignee: email('Who to assign it to, by email address.').optional(),
            tags: z.array(z.string().regex(/^[a-z0-9-]+$/))
                .describe("The ticket's tags, replacing the ones it has: lowercase words and dashes.")
                .meta({ uniqueItems: true, examples: [['hardware', 'printing']] })
                .optional(),
        }),
    }, async () => ({
        content: [
            { type: 'text', text: 'Updated T-1042: its status is now solved.' },
            ticketLink({ ...matches[0], status: 'solved', updatedAt: '2026-10-15T09:30:00Z' }),
        ],
    }));

    server.registerTool('delete_ticket', {
        title: 'Delete a ticket',
        description: 'Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.',
        annotations: hints(false, true, true, false),
        inputSchema: z.strictObject({
            id: ticketId,
            reason: z.string().max(500).optional().describe("Why it's being deleted, kept in the audit log.").meta({ examples: ['Duplicate of T-1038'] }),
        }),
    }, async () => ({ content: [{ type: 'text', text: 'Deleted T-1042 and its 4 messages.' }] }));

    server.registerTool('ticket_volume_chart', {
        title: 'Chart ticket volume',
        description: 'Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.',
        annotations: hints(true, false, true, false),
        inputSchema: z.strictObject({
            days: z.int().min(7).max(90).default(30).describe('How many days to chart, ending today.'),
            group_by: z.enum(['status', 'priority']).default('status').describe('What each bar counts.'),
        }),
    }, async () => ({
        content: [
            // For people to look at; the text says the same for models.
            { type: 'image', data: volumePng, mimeType: 'image/png', annotations: { audience: ['user'] } },
            { type: 'text', text: 'Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed.' },
        ],
    }));

    server.registerTool('fetch_help_article', {
        title: 'Fetch a help center article',
        description: 'Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.',
        annotations: hints(true, false, true, true),
        inputSchema: z.strictObject({
            url: z.string().regex(/^https:\/\/help\.example\.com\//).describe("The article's address on help.example.com.")
                .meta({ format: 'uri', examples: ['https://help.example.com/articles/printer-offline'] }),
        }),
    }, async () => ({
        content: [
            { type: 'text', text: printerOffline },
            { type: 'resource_link', uri: 'https://help.example.com/articles/printer-offline', name: 'printer-offline', title: 'When a printer shows offline, in the help center', mimeType: 'text/html' },
        ],
    }));

    // --- Resources ---

    server.registerResource('getting-started', 'helpdesk://guides/getting-started', {
        title: 'Getting started',
        description: 'What each ticket status and priority means. Read it before changing tickets.',
        mimeType: 'text/markdown',
        size: Buffer.byteLength(gettingStarted),
        annotations: { audience: ['user', 'assistant'], priority: 0.9, lastModified: '2026-09-30T12:00:00Z' },
        cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: gettingStarted }] }));

    server.registerResource('ticket-schema', 'helpdesk://schemas/ticket', {
        title: 'Ticket schema',
        description: 'The JSON Schema every ticket follows, with what each field means.',
        mimeType: 'application/schema+json',
        size: Buffer.byteLength(ticketSchemaJson),
        annotations: { audience: ['assistant'], priority: 0.5, lastModified: '2026-08-14T08:00:00Z' },
        cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: ticketSchemaJson }] }));

    server.registerResource('volume-chart', 'helpdesk://reports/volume.png', {
        title: 'Ticket volume, last 30 days',
        description: 'New tickets over the last 30 days, one bar per status. Updated every hour.',
        mimeType: 'image/png',
        size: Buffer.from(volumePng, 'base64').length,
        annotations: { audience: ['user'], priority: 0.3, lastModified: '2026-10-15T09:00:00Z' },
        // This organization's own figures: clients mustn't share them across sign-ins.
        cacheHint: { ttlMs: 3_600_000, cacheScope: 'private' },
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: volumePng }] }));

    server.registerResource('ticket', new ResourceTemplate('helpdesk://tickets/{id}', { list: undefined }), {
        title: 'Ticket by ID',
        // A template's variables have no schema, so the description says what id looks like.
        description: "One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.",
        mimeType: 'application/json',
        cacheHint: { ttlMs: 0, cacheScope: 'private' },
    }, async uri => {
        if (uri.href !== `helpdesk://tickets/${ticket1042.id}`) throw new ResourceNotFoundError(uri.href);
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ticket1042) }] };
    });

    // --- Prompts ---

    server.registerPrompt('summarize_ticket', {
        title: 'Summarize a ticket',
        description: "Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester.",
        // Prompt arguments are text without a schema: an example in each description is what a
        // client can fill in.
        argsSchema: z.object({
            id: z.string().describe('The ticket to summarize, such as T-1042.'),
            audience: z.string().optional().describe('Who reads the summary: either "agent" or "requester". Defaults to "agent".'),
        }),
    }, () => ({
        description: 'A summary of T-1042 for the support team',
        messages: [
            { role: 'user', content: { type: 'text', text: "Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can." } },
            { role: 'user', content: { type: 'resource', resource: { uri: 'helpdesk://tickets/T-1042', mimeType: 'application/json', text: JSON.stringify(ticket1042) } } },
        ],
    }));

    server.registerPrompt('triage_open_tickets', {
        title: 'Triage the open tickets',
        description: 'Asks for the open tickets in order of urgency, with who should take each one.',
    }, () => ({
        description: 'Triage of the open tickets',
        messages: [
            { role: 'user', content: { type: 'text', text: "List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets." } },
            { role: 'assistant', content: { type: 'text', text: "I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them." } },
        ],
    }));

    return server;
}

// --- Serving it to browsers ---

// One fresh server per request, with plain JSON replies; it also answers 2025 clients.
const handler = createMcpHandler(() => newServer(), { responseMode: 'json' });

const allowedOrigin = /^(http:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https:\/\/patrick-glean\.github\.io)$/;

async function toRequest(req: IncomingMessage): Promise<Request> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
}

// A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
// Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS and
// lets the page read Mcp-Session-Id.
createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
        if (!allowedOrigin.test(origin)) return res.writeHead(403).end('origin not allowed');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.writeHead(204).end();
    }
    if (new URL(req.url || '/', 'http://localhost').pathname !== '/mcp') return res.writeHead(404).end('not found');
    const response = await handler.fetch(await toRequest(req));
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`Example Helpdesk (TypeScript SDK) on http://127.0.0.1:${port}/mcp`));

// --- Canned data ---

const matches: Summary[] = [
    { id: 'T-1042', subject: 'Printer on floor 3 shows offline', status: 'open', priority: 'high', updatedAt: '2026-10-14T16:02:00Z' },
    { id: 'T-1038', subject: "Printer driver won't install on macOS 16", status: 'pending', priority: 'normal', updatedAt: '2026-10-13T11:40:00Z' },
    { id: 'T-1017', subject: 'Badge printer jams on the first card', status: 'solved', priority: 'low', updatedAt: '2026-10-09T08:05:00Z' },
];

const ticket1042 = {
    id: 'T-1042',
    subject: 'Printer on floor 3 shows offline',
    status: 'open',
    priority: 'high',
    requester: { name: 'Ada Lovelace', email: 'ada@example.com' },
    assignee: 'grace@example.com',
    tags: ['hardware', 'printing'],
    createdAt: '2026-10-12T09:14:00Z',
    updatedAt: '2026-10-14T16:02:00Z',
    url: 'https://helpdesk.example.com/tickets/T-1042',
} as const;

const gettingStarted = `# Getting started with Example Helpdesk

Every ticket has an ID like T-1042, a subject, a status and a priority.

## Statuses

- **open**: someone needs to act on it.
- **pending**: waiting for the requester to answer.
- **solved**: fixed. It closes by itself after 7 days.
- **closed**: done for good. A closed ticket can't be reopened; open a new one instead.

## Priorities

low, normal, high and urgent. An urgent ticket pages whoever is on call, so only raise a ticket to urgent when the requester can't work at all.
`;

const printerOffline = `# When a printer shows offline

1. Check that the printer is on and its screen shows no error.
2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
3. On your computer, remove the printer and add it again from Settings, then Printers.

Still offline? Open a ticket and include the configuration page.
`;

// The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource.
const ticketSchemaJson = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Ticket",
  "description": "A support request in Example Helpdesk.",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^T-[0-9]+$",
      "description": "T- and a number, such as T-1042. Never reused."
    },
    "subject": {
      "type": "string",
      "description": "One line on what's wrong, in the requester's words."
    },
    "status": {
      "enum": [
        "open",
        "pending",
        "solved",
        "closed"
      ],
      "description": "open: someone needs to act. pending: waiting for the requester. solved: fixed, and closes after 7 days. closed: done for good."
    },
    "priority": {
      "enum": [
        "low",
        "normal",
        "high",
        "urgent"
      ],
      "description": "urgent pages whoever is on call."
    },
    "requester": {
      "type": "object",
      "description": "Who asked for help.",
      "properties": {
        "name": {
          "type": "string"
        },
        "email": {
          "type": "string",
          "format": "email"
        }
      },
      "required": [
        "name",
        "email"
      ]
    },
    "assignee": {
      "type": "string",
      "format": "email",
      "description": "Who's working on it. Absent while it's unassigned."
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Lowercase words and dashes."
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    },
    "url": {
      "type": "string",
      "format": "uri",
      "description": "The ticket in the helpdesk's web app."
    }
  },
  "required": [
    "id",
    "subject",
    "status",
    "priority",
    "requester",
    "tags",
    "createdAt",
    "updatedAt",
    "url"
  ]
}`;

// Icons for light and dark backgrounds, as data: URIs so they need no host of their own.
const lightIcon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=';
const darkIcon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=';

// New tickets by status over the last 30 days, as a 160×80 PNG.
const volumePng = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII=';
