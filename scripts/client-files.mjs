// The client's files, the site in public/, as an app's download ships them with the app: every
// file but the benchmark page, source maps, type declarations and the spec's TypeScript, which
// it doesn't load. The page can't list a folder over HTTP, so the list is written down in
// public/client-files.json, which the download reads (and ships too, so a downloaded folder can
// be downloaded from again).
//
//   node scripts/client-files.mjs    (npm run build:files) writes public/client-files.json

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const MANIFEST = 'client-files.json';

const LEFT_OUT = [/^bench\//, /\.map$/, /\.d\.ts$/, /^mcp_spec_schema\.ts$/, /(^|\/)\./];

export function clientFiles(root = PUBLIC) {
    const files = [];
    const walk = dir => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else files.push(relative(root, path).split(sep).join('/'));
        }
    };
    walk(root);
    return [...new Set([...files, MANIFEST])].filter(file => !LEFT_OUT.some(pattern => pattern.test(file))).sort();
}

export const manifestText = files => `${JSON.stringify({ files }, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const files = clientFiles();
    writeFileSync(join(PUBLIC, MANIFEST), manifestText(files));
    console.log(`Wrote public/${MANIFEST}: ${files.length} files.`);
}
