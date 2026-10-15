# Testing Rule

- After changing a library, the service worker or the page, run the smoke test on every MCP client library: `npm run test:browser -- --reference` (the default, TypeScript SDK) and `npm run test:browser:wasm -- --reference`. Run `npm run test:rust` after changing the Rust library.
- After changing a library's request path, also run `npm run bench -- --quick`.
- After changing Pre-fill (`public/workbench/prefill.js`), resource template URIs (`public/workbench/uri-template.js`) or the server template (`public/server-template/example.json`), run `npm run test:unit`.
- After changing what the Workbench shows of a server, its tools, resources, prompts or results, update the tables in `public/server-template/README.md`.
- Do not ask for permission to run the tests; just run them and report the results.
