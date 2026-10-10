# Testing Rule

- After changing a library, the service worker or the page, run the smoke test on every MCP client library: `npm run test:browser -- --reference` (the default, TypeScript SDK) and `npm run test:browser:wasm -- --reference`. Run `npm run test:rust` after changing the Rust library.
- After changing a library's request path, also run `npm run bench -- --quick`.
- After changing Pre-fill (`public/workbench/prefill.js`), resource template URIs (`public/workbench/uri-template.js`) or the app builder's pure modules (`public/apps/flow.js`, `graph.js`, `boxes.js`, `agent.js`, `screen.js`, `ask.js`, `dml.js`, `zip.js`) or its examples (`chatApp`, `dashboardApp` in `apps.js`), run `npm run test:unit`.
- Do not ask for permission to run the tests; just run them and report the results.
