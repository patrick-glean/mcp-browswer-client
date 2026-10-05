# Testing Rule

- After changing a library, the service worker or the page, run the smoke test on every MCP client library: `npm run test:browser -- --reference` and `npm run test:browser:sdk`. Run `npm run test:rust` after changing the Rust library.
- After changing a library's request path, also run `npm run bench -- --quick`.
- Do not ask for permission to run the tests; just run them and report the results.
