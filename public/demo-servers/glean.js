// The Glean demo server: a stand-in for Glean's MCP server over the made-up team in
// glean-samples.js, for the Team artifacts example when you haven't added your Glean. Its tools
// take the fields Glean's take and answer in the shapes Glean's do, so an app made with it can
// call your Glean instead:
//   search         what it finds, in Markdown, each with its Library link;
//   read_document  what it reads, in three text blocks: a listing of the documents read, then each
//                  document (a paper's Markdown, a page's whole HTML), then the call's ID;
//   chat           what the demo model says, except that boxes asking for links get the links of
//                  the team's newest papers and pages, newest first, and a question about the
//                  team's artifacts gets a list of them.
// Like the demo model, it doesn't understand what it's asked: it looks for words.

import { BOX_LINE, BOXES_ASKED, chatReply, saidIn } from './demo-model.js';
import { SAMPLE_ARTIFACTS, SAMPLE_TEAM } from './glean-samples.js';
import { mcpServer } from './mcp.js';

export const LIBRARY = 'https://app.glean.com/library/';
export const linkOf = artifact => `${LIBRARY}${artifact.id}`;

const HOUR = 3_600_000;
const READS = { readOnlyHint: true, openWorldHint: false };
const USER_GOAL = { type: 'string', description: 'What the person asked that led to this call, in their words.' };
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

const text = value => ({ type: 'text', text: value });
const invocation = () => text(`glean_invocation_id: ${crypto.randomUUID()}`);
const hex = () => crypto.randomUUID().replaceAll('-', '');
// The artifacts read_document shows whole: papers and pages, newest first.
const documents = () => SAMPLE_ARTIFACTS.filter(artifact => artifact.type === 'paper' || artifact.type === 'html');
const fileOf = artifact => `${artifact.title}${{ paper: '.md', html: '.html' }[artifact.type] || ''}`;
const at = (now, hours) => new Date(now - hours * HOUR).toISOString().replace(/\.\d+Z$/, 'Z');
const artifactAt = url => SAMPLE_ARTIFACTS.find(artifact => String(url).trim().replace(/[?#].*$/, '').replace(/\/$/, '') === linkOf(artifact)) || null;

// Which of the newest a box asks for, from what it says (the second newest, the 3rd) or else the
// number its key ends in; else the newest.
function ordinalOf(key, about) {
    const words = about.toLowerCase();
    const named = ORDINALS.findIndex((word, index) => index > 0 && new RegExp(`\\b${word}\\b`).test(words));
    if (named > 0) return named + 1;
    const numbered = /\b(\d+)(?:st|nd|rd|th)\b/.exec(words) || /(\d+)$/.exec(key);
    return numbered ? Math.max(1, Number(numbered[1])) : 1;
}

// An app's boxes, answered as the demo model answers them, but with the links of the team's newest
// papers and pages in the text boxes that ask for a link. null when no box asks for one.
function linksReply(message) {
    if (!message.includes(BOXES_ASKED)) return null;
    const asked = [...message.matchAll(BOX_LINE)].filter(([, , kind, about]) => kind === 'text' && /\b(?:link|links|url|address)\b/i.test(about));
    if (!asked.length) return null;
    let answer = {};
    try {
        answer = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(chatReply(message))?.[1] ?? '{}') || {};
    } catch {
        // Only the links, then.
    }
    for (const [, key, , about] of asked) {
        const artifact = documents()[ordinalOf(key, about) - 1];
        answer[key] = artifact ? linkOf(artifact) : null;
    }
    return `\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``;
}

// A question about what the team made, answered with its newest papers and pages.
function artifactsReply(said) {
    if (!/\bartifacts?\b/i.test(said)) return null;
    const lines = documents().map(artifact => `- [${artifact.title}](${linkOf(artifact)}): ${artifact.summary} (${artifact.author}, ${artifact.type === 'html' ? 'a page' : 'a paper'})`);
    return `Here is what ${SAMPLE_TEAM}, the demo's made-up team, made most recently, newest first:\n\n${lines.join('\n')}`;
}

function searchResults(found, now) {
    if (!found.length) return "# Search results (0 found)\n\nNothing in the demo's made-up Glean matches that.";
    return [`# Search results (${found.length} found)`, ...found.map((artifact, index) => [
        `## ${index + 1}. ${fileOf(artifact)}`,
        `**Source:** artifacts • **Type:** ${artifact.type} • **Updated:** ${at(now, artifact.hoursAgo)} • **Created:** ${at(now, artifact.hoursAgo + artifact.ageDays * 24)} • **Owner:** ${artifact.author}`,
        `**Link:** ${linkOf(artifact)}`,
        '',
        `> ${artifact.summary}`,
    ].join('\n'))].join('\n\n---\n\n');
}

// What read_document read, in the shape of Glean's listing.
const listing = found => [`documents[${found.length}]:`, ...found.flatMap(artifact => [
    `  - artifactId: ${artifact.id}`,
    `    docType: ${artifact.type.toUpperCase()}`,
    `    glean_doc_id: ARTIFACTS_${artifact.type}_${artifact.id}`,
    `    snippets[1]: ${JSON.stringify(artifact.summary)}`,
    `    title: ${fileOf(artifact)}`,
    `    url: ${JSON.stringify(linkOf(artifact))}`,
])].join('\n');

export const GLEAN_TOOLS = [
    {
        name: 'search',
        title: 'Search (demo)',
        description: `Finds documents in the demo's made-up Glean, which has the artifacts of one team, ${SAMPLE_TEAM}. Answers in Markdown, as Glean's search does: each result with its type, when it changed, who made it and its Library link. Every word of the query has to match; * matches everything.`,
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The words to look for, or * for everything.' },
                app: { type: 'string', description: 'The app to look in: artifacts is where Glean keeps them.' },
                owner: { type: 'string', description: 'Whose: a name, me or myteam.' },
                from: { type: 'string', description: 'Made or changed by: a name, me or myteam.' },
                sort_by_recency: { type: 'boolean', description: 'Newest first. The demo always is.' },
                num_results: { type: 'integer', description: 'How many to give, at most.' },
                _user_goal: USER_GOAL,
            },
            required: ['query', '_user_goal'],
        },
        annotations: READS,
        call({ query, app, owner, from, num_results: count }) {
            const words = String(query ?? '').toLowerCase().split(/\s+/).filter(word => word && word !== '*');
            const person = String(owner || from || '').trim().toLowerCase();
            const found = SAMPLE_ARTIFACTS
                .filter(() => !app || /artifact/i.test(String(app)))
                .filter(artifact => !person || person === 'me' || person === 'myteam' || artifact.author.toLowerCase().includes(person))
                .filter(artifact => words.every(word => `${artifact.title} ${artifact.summary} ${artifact.type}`.toLowerCase().includes(word)))
                .slice(0, Math.max(1, Math.min(Number(count) || 10, 50)));
            return { content: [text(searchResults(found, Date.now())), invocation()] };
        },
    },
    {
        name: 'read_document',
        title: 'Read documents (demo)',
        description: "Reads documents in the demo's made-up Glean by their Library links, as Glean's read_document does: a listing of what it read, then each document (a paper's Markdown, a page's whole HTML), then the call's ID. Fails, saying so, for a link it doesn't have.",
        inputSchema: {
            type: 'object',
            properties: {
                urls: { type: 'array', items: { type: 'string' }, description: 'The links of the documents to read.' },
                _user_goal: USER_GOAL,
            },
            required: ['urls', '_user_goal'],
        },
        annotations: READS,
        call({ urls }) {
            const asked = (Array.isArray(urls) ? urls : [urls]).map(url => String(url ?? '').trim()).filter(Boolean);
            if (!asked.length) throw new Error('Give read_document the link of at least one document, in urls.');
            const missing = asked.filter(url => !artifactAt(url));
            if (missing.length) throw new Error(`The demo's made-up Glean has no document at ${missing.join(', ')}. Its documents are the ones search finds.`);
            const found = asked.map(artifactAt);
            return { content: [text(listing(found)), ...found.map(artifact => text(artifact.content)), invocation()] };
        },
    },
    {
        name: 'chat',
        title: 'Chat (demo)',
        description: "A stand-in for Glean's assistant, which answers as the demo model does: it repeats what you say and fills an app's boxes with made-up values. Boxes that ask for links get the links of the made-up team's newest papers and pages, newest first, and a question about the team's artifacts gets a list of them. Like Glean's chat, it puts the conversation's ID after its answer.",
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'What you say to it.' },
                context: { type: 'array', items: { type: 'string' }, description: 'The conversation so far, oldest first.' },
                _user_goal: USER_GOAL,
            },
            required: ['message', '_user_goal'],
        },
        annotations: READS,
        call({ message, context }) {
            const asked = String(message ?? '');
            const reply = linksReply(asked) ?? artifactsReply(saidIn(asked)) ?? chatReply(asked, Array.isArray(context) ? context : []);
            return { content: [text(`${reply}\n\n---\nchatId: ${hex()}`), invocation()] };
        },
    },
];

export const gleanServer = () => mcpServer({
    name: 'Glean (demo)',
    instructions: `A stand-in for Glean, built into MCP Browser Client: it runs in this page's service worker, over the artifacts of a made-up team (${SAMPLE_TEAM}, at Example Co). search finds them, read_document reads them and chat picks the newest, each answering in the shapes Glean's tools do. Add your own Glean from the Guide for your team's.`,
    tools: GLEAN_TOOLS,
});
