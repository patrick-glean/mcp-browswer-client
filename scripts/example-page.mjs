#!/usr/bin/env node
// The example page with an app in it, public/examples/team-home.html: a made-up team's home page,
// with the Team artifacts example embedded as its embed code (Share › Copy embed code) puts it,
// an iframe of the client with the app in its address. The client is the one beside the page
// (../), so the page works wherever public/ is served. This writes the iframe, between the page's
// <!-- app --> and <!-- /app --> markers, from the example as it is now.
//
//   node scripts/example-page.mjs    (npm run build:example)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactsApp, embedCode, EXAMPLES } from '../public/apps/apps.js';
import { toDml } from '../public/apps/dml.js';
import { runLink } from '../public/apps/link.js';
import { DEMO_SERVERS } from '../public/demo-servers/index.js';

export const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'examples', 'team-home.html');
export const EMBED_HEIGHT = 720;
const MARKED = /(<!-- app -->\n)([ \t]*)[^\n]*(\n[ \t]*<!-- \/app -->)/;

// The example, with an ID of its own so the page is the same each time it's written.
export const exampleApp = () => ({ ...artifactsApp({ name: EXAMPLES.artifacts.name }), id: 'team-artifacts-example' });

// The iframe that runs the app in the client beside the page.
export async function embedOf(app = exampleApp()) {
    const dml = toDml(app, { standalone: true, serverNames: { [DEMO_SERVERS.artifacts.url]: DEMO_SERVERS.artifacts.name } });
    return embedCode(await runLink(dml, '../?embed'), { name: app.name, height: EMBED_HEIGHT });
}

// The page with `iframe` between its markers.
export function pageWith(html, iframe) {
    if (!MARKED.test(html)) throw new Error("The page has no <!-- app --> and <!-- /app --> markers, with the iframe's line between them.");
    return html.replace(MARKED, (match, open, indent, close) => `${open}${indent}${iframe}${close}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    writeFileSync(PAGE, pageWith(readFileSync(PAGE, 'utf8'), await embedOf()));
    console.log('Wrote public/examples/team-home.html, with the Team artifacts example as it is now.');
}
