// The client's files that an app's download ships (public/client-files.json): the list matches
// public/, and has everything the client loads, from index.html and sw.js on.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';

import { clientFiles, MANIFEST, manifestText, PUBLIC } from '../scripts/client-files.mjs';

const listed = JSON.parse(readFileSync(join(PUBLIC, MANIFEST), 'utf8')).files;

// What a file loads by a path written in it: imports, scripts, styles, CSS urls, files fetched
// or linked by name. The MCP libraries are loaded by name in mcp-clients.js.
function loads(file) {
    const text = readFileSync(join(PUBLIC, file), 'utf8');
    const found = new Set();
    const patterns = [
        /\bimport\s+(?:[^'"()]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
        /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
        /\bexport\s+[^'"]*?\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
        /\b(?:src|href)=["'](?!https?:|data:|#|mailto:)([^"'#?]+\.(?:js|css|html|svg|woff2?|json|wasm))["']/g,
        /url\(\s*['"]?(?!data:|https?:|#)([^'")]+)['"]?\s*\)/g,
        /['"]([\w-]+\.(?:wasm|js))['"],\s*['"][^'"]+['"]\)/g,
    ];
    for (const pattern of patterns) {
        for (const [, target] of text.matchAll(pattern)) {
            const path = normalize(join(dirname(file), target)).split('\\').join('/');
            if (!path.startsWith('..')) found.add(path);
        }
    }
    return found;
}

test('the list of the client a download ships is the site in public/, up to date (npm run build:files writes it)', () => {
    assert.equal(readFileSync(join(PUBLIC, MANIFEST), 'utf8'), manifestText(clientFiles()), 'run npm run build:files');
    for (const file of listed) assert.ok(existsSync(join(PUBLIC, file)), `${file} is listed but not in public/`);
});

test('it has the page, the worker, both MCP libraries, the sign-in page, the fonts and icons with their licenses, and itself', () => {
    for (const file of ['index.html', 'sw.js', 'oauth-callback.html', 'sdk_client.js', 'mcp_browser_client.js', 'mcp_browser_client_bg.wasm', 'build.js', 'build-sdk.js',
        'fonts/Inter/OFL.txt', 'fonts/DM-Sans/OFL.txt', 'icons/LICENSE', 'icons/tool.svg', MANIFEST]) {
        assert.ok(listed.includes(file), `${file} is missing`);
    }
    for (const file of listed) assert.doesNotMatch(file, /^bench\/|\.map$|\.d\.ts$|^mcp_spec_schema\.ts$/, `${file} is only for developing the client`);
});

test('everything the client loads, from index.html and the worker on, is in it', () => {
    const queue = ['index.html', 'sw.js', 'mcp-clients.js'];
    const reached = new Set();
    while (queue.length) {
        const file = queue.shift();
        if (reached.has(file) || !existsSync(join(PUBLIC, file))) continue;
        reached.add(file);
        if (/\.(js|html|css)$/.test(file)) queue.push(...loads(file));
    }
    assert.ok(reached.size > 80, `only ${reached.size} files reached`);
    for (const file of reached) assert.ok(listed.includes(file), `the client loads ${file}, which the list leaves out`);
});
