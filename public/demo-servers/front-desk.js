// The Front desk example's own server: a front desk's visitor system over four made-up visits
// today. Its tools answer as the mock server's (test_mcp_server.py) do, so an app can move from
// one to the other, or to your own visitor system's server, which takes the same calls.

import { mcpServer } from './mcp.js';

export const VISITS = [
    { visitor: 'Ada Lovelace', company: 'Analytical Engines', host: 'Grace Hopper', time: '10:00', room: 'Babbage, 3rd floor' },
    { visitor: 'Alan Turing', company: 'Bletchley Labs', host: 'Dana Lee', time: '11:30', room: 'Enigma, 2nd floor' },
    { visitor: 'Katherine Johnson', company: 'Langley Research', host: 'Dana Lee', time: '14:00', room: 'Orbit, 5th floor' },
    { visitor: 'Alan Kay', company: 'Learning Research', host: 'Grace Hopper', time: '15:30', room: 'Dynabook, 4th floor' },
];

const words = text => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
const tidy = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ');

// Whether what someone typed names this person: each word starts one of the name's words.
const nameMatches = (typed, name) => words(typed).every(part => words(name).some(word => word.startsWith(part)));

// Today's visit for a visitor: { visit } or { why } there's none.
export function findVisit(visitor, host = '') {
    const typed = tidy(visitor);
    const seeing = tidy(host);
    if (!typed) return { why: 'Type your name first, as it is on your invitation.' };
    const found = VISITS.filter(visit => nameMatches(typed, visit.visitor) && (!seeing || nameMatches(seeing, visit.host)));
    if (found.length > 1) return { why: `More than one visit today is for “${typed}”. Type your full name, or who you're here to see.` };
    if (!found.length) return { why: `There's no visit today for “${typed}”${seeing ? ` to see “${seeing}”` : ''}. Check the spelling, or call the front desk and someone will come and help.` };
    return { visit: found[0] };
}

const text = value => ({ type: 'text', text: value });
const failed = why => ({ content: [text(why)], isError: true });

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const VISITOR_ARGS = {
    type: 'object',
    properties: {
        visitor: { type: 'string', description: "The visitor's name, or part of it, as they typed it.", examples: ['Ada Lovelace'] },
        host: { type: 'string', description: "Who they're here to see, if they said." },
    },
    required: ['visitor'],
};

export const FRONT_DESK_TOOLS = [
    {
        name: 'find_visit',
        title: 'Find a visit',
        description: "Finds today's visit for someone at the front desk, by their name and, if they say, who they're here to see. Fails, saying why, when there's no visit or more than one.",
        inputSchema: VISITOR_ARGS,
        outputSchema: {
            type: 'object',
            properties: {
                visitor: { type: 'string', description: "The visitor's full name." },
                company: { type: 'string', description: "Where they're from." },
                host: { type: 'string', description: "Who they're here to see." },
                time: { type: 'string', description: 'When, as HH:MM.' },
                room: { type: 'string', description: "Where they'll meet." },
            },
            required: ['visitor', 'company', 'host', 'time', 'room'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        call({ visitor, host }) {
            const { visit, why } = findVisit(visitor, host);
            if (!visit) return failed(why);
            return { content: [text(`${visit.visitor} of ${visit.company} is here to see ${visit.host} at ${visit.time}, in ${visit.room}.`)], structuredContent: { ...visit } };
        },
    },
    {
        name: 'check_in',
        title: 'Check in',
        description: "Checks a visitor in for today's visit, found as find_visit finds it: prints their badge and tells their host they're here.",
        inputSchema: { ...VISITOR_ARGS, properties: { ...VISITOR_ARGS.properties, visitor: { ...VISITOR_ARGS.properties.visitor, description: "The visitor's name, as they typed it for find_visit." } } },
        outputSchema: {
            type: 'object',
            properties: {
                badge: { type: 'string', description: 'The badge printed for them.' },
                visitor: { type: 'string', description: "The visitor's full name." },
                host: { type: 'string', description: "Who was told they're here." },
                room: { type: 'string', description: "Where they'll meet." },
            },
            required: ['badge', 'visitor', 'host', 'room'],
        },
        annotations: WRITES,
        call({ visitor, host }, state) {
            const { visit, why } = findVisit(visitor, host);
            if (!visit) return failed(why);
            state.badges = (state.badges ?? 1000) + 1;
            const badge = `V-${state.badges}`;
            const first = visit.visitor.split(' ')[0];
            return {
                content: [text(`Welcome, ${first}. Your badge is ${badge}. ${visit.host} knows you're here and will meet you in the lobby, then take you to ${visit.room}.`)],
                structuredContent: { badge, visitor: visit.visitor, host: visit.host, room: visit.room },
            };
        },
    },
    {
        name: 'call_front_desk',
        title: 'Call the front desk',
        description: 'Asks someone at the front desk to come and help a visitor.',
        inputSchema: {
            type: 'object',
            properties: {
                visitor: { type: 'string', description: 'Who needs help, if they said.' },
                reason: { type: 'string', description: 'What they need, in a few words.' },
            },
        },
        annotations: WRITES,
        call({ visitor }) {
            const who = tidy(visitor);
            return { content: [text(`Someone from the front desk is on the way${who ? `, ${who}` : ''}. Please take a seat.`)] };
        },
    },
];

export const frontDeskServer = () => mcpServer({
    name: 'Front desk demo server',
    instructions: "A front desk's visitor system, with four made-up visits today, built into MCP Browser Client: it runs in this page's service worker, so there's nothing to install.",
    tools: FRONT_DESK_TOOLS,
});
