// The demo's made-up team and what it made in Glean: Example Co's Developer Experience team, its
// people borrowed from computing history as the front desk's visitors are. Each artifact is what
// Glean's search says of it, and its content is what Glean's read_document gives: a page's HTML,
// a document's Markdown, a message's text, or nothing for a podcast. `hoursAgo` says when it last
// changed, so the list always looks recent; it was made `ageDays` before that.

export const SAMPLE_TEAM = 'Developer Experience';

const BUILD_HEALTH = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Build health</title>
<style>
  body { margin: 0; background: #f4f5fa; color: #17181c; font: 16px/1.45 system-ui, sans-serif; }
  .wrap { padding: 30px 34px; }
  h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 24px; color: #687083; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
  .card { padding: 18px 20px; border-radius: 16px; background: #fff; box-shadow: 0 1px 3px rgba(20, 24, 40, 0.08); }
  .kpi span { color: #687083; font-size: 14px; }
  .kpi b { display: block; margin: 2px 0; font-size: 34px; letter-spacing: -0.03em; }
  .kpi i { font-size: 14px; font-style: normal; font-weight: 600; }
  .good { color: #138a4a; } .bad { color: #c2410c; }
  .row { display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; }
  h2 { margin: 0 0 14px; font-size: 17px; }
  .bars { display: flex; align-items: flex-end; gap: 12px; height: 160px; }
  .bars div { flex: 1; border-radius: 8px 8px 0 0; background: linear-gradient(#5b5ff0, #9da3ff); }
  .days { display: flex; gap: 12px; margin-top: 8px; color: #687083; font-size: 13px; }
  .days span { flex: 1; text-align: center; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { padding: 8px 4px; border-bottom: 1px solid #eceef4; text-align: left; }
  th { color: #687083; font-weight: 600; }
  td:last-child, th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Build health, week 45</h1>
  <p class="sub">Every pipeline in the monorepo, Monday to Sunday. Refreshed each morning at 7.</p>
  <div class="kpis">
    <div class="card kpi"><span>Pass rate</span><b>96.8%</b><i class="good">▲ 0.9 points</i></div>
    <div class="card kpi"><span>Median build</span><b>7m 12s</b><i class="good">▼ 38s</i></div>
    <div class="card kpi"><span>Flaky tests</span><b>14</b><i class="good">▼ 6 this week</i></div>
    <div class="card kpi"><span>Queue wait</span><b>41s</b><i class="bad">▲ 9s</i></div>
  </div>
  <div class="row">
    <div class="card">
      <h2>Builds per day</h2>
      <div class="bars"><div style="height: 72%"></div><div style="height: 88%"></div><div style="height: 95%"></div><div style="height: 81%"></div><div style="height: 64%"></div><div style="height: 18%"></div><div style="height: 12%"></div></div>
      <div class="days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
    </div>
    <div class="card">
      <h2>Slowest pipelines</h2>
      <table>
        <tr><th>Pipeline</th><th>Median</th></tr>
        <tr><td>web-e2e</td><td>18m 40s</td></tr>
        <tr><td>payments-integration</td><td>14m 05s</td></tr>
        <tr><td>mobile-release</td><td>12m 51s</td></tr>
        <tr><td>search-indexer</td><td>9m 22s</td></tr>
      </table>
    </div>
  </div>
</div>
</body>
</html>`;

const ROADMAP = `# Q1 platform roadmap

Where Developer Experience is putting its time from January to March, and what we're leaving for later.

## Goals

- **A preview environment for every pull request**, ready in under 5 minutes.
- **Half the flaky failures** on the main branch: from 2.1% of runs to 1%.
- **One golden path per language**, from \`ex new\` to production in a day.

## Milestones

| Milestone | Owner | Due | Status |
| --- | --- | --- | --- |
| Preview environments beta | Grace Hopper | Jan 24 | On track |
| Flaky test quarantine | Alan Kay | Feb 7 | On track |
| Go and Rust golden paths | Ken Thompson | Mar 14 | At risk |

## Not this quarter

- Replacing the build system. We'll look again in Q3, with the remote cache numbers in hand.
- A second CI provider. One that works well beats two that half work.
`;

const RELEASE_NOTES = `CLI 3.2 is out for everyone at Example Co.

What's new:
- ex deploy --preview gives your branch its own environment, and posts its link on the pull request
- ex logs follows the logs of several services at once, each in its own color
- Commands start 40% faster: they load only the plugins they use

Upgrade with ex upgrade. Questions go to #devex-help, and thanks to everyone who tried the beta.`;

const ON_CALL = `<!DOCTYPE html>
<html lang="en">
<head>
<title>On-call handbook</title>
<style>
  :root { --ink: #1c1917; --muted: #6b645c; --accent: #c2410c; }
  body { margin: 0; background: #fffaf5; color: var(--ink); font: 16px/1.55 Georgia, 'Times New Roman', serif; }
  header { padding: 34px 40px 26px; background: linear-gradient(120deg, #7c2d12, #c2410c); color: #fff; }
  header p { margin: 0 0 6px; font: 600 13px/1 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.8; }
  h1 { margin: 0; font-size: 36px; line-height: 1.1; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; padding: 28px 40px; }
  h2 { margin: 0 0 10px; color: var(--accent); font: 700 18px/1.2 system-ui, sans-serif; }
  ol { margin: 0; padding-left: 22px; }
  li { margin-bottom: 8px; }
  .callout { grid-column: 1 / -1; padding: 16px 20px; border-left: 5px solid var(--accent); border-radius: 10px; background: #fde9dc; font-family: system-ui, sans-serif; }
  table { width: 100%; border-collapse: collapse; font: 15px/1.4 system-ui, sans-serif; }
  td { padding: 7px 0; border-bottom: 1px solid #f0e2d6; }
  td:first-child { color: var(--muted); width: 42%; }
</style>
</head>
<body>
<header><p>Developer Experience</p><h1>On-call handbook</h1></header>
<main>
  <section>
    <h2>Before your shift</h2>
    <ol>
      <li>Check the pager app shows you as on call from 9:00.</li>
      <li>Read last week's handover note and the open incidents.</li>
      <li>Make sure you can reach the build cluster from your laptop.</li>
    </ol>
  </section>
  <section>
    <h2>When you're paged</h2>
    <ol>
      <li>Acknowledge within 5 minutes, even if you can't look yet.</li>
      <li>Post in #devex-oncall what broke and who's affected.</li>
      <li>Roll back first, then debug. A green main branch comes first.</li>
    </ol>
  </section>
  <p class="callout"><strong>Sev 1?</strong> Page the incident commander before anything else, then open the incident channel from the pager app.</p>
  <section>
    <h2>Who to call</h2>
    <table>
      <tr><td>Build cluster</td><td>Ken Thompson</td></tr>
      <tr><td>Remote cache</td><td>Frances Allen</td></tr>
      <tr><td>CLI and plugins</td><td>Barbara Liskov</td></tr>
    </table>
  </section>
  <section>
    <h2>Handing over</h2>
    <ol>
      <li>Write what's still open and what you tried.</li>
      <li>Hand over in person, or on a call, never only in writing.</li>
    </ol>
  </section>
</main>
</body>
</html>`;

const INCIDENT_REVIEW = `# Incident review: remote cache outage, October 21

**Severity 2** · 47 minutes · Written by Frances Allen

## What happened

A certificate on the remote build cache expired at 09:12. Builds fell back to building everything from scratch, queues grew to 30 minutes, and merges to main stopped until 09:59.

## Timeline

| Time | What happened |
| --- | --- |
| 09:12 | The cache's certificate expires; cache hits drop to 0% |
| 09:20 | The build queue alert pages Ken Thompson |
| 09:41 | The expired certificate is found and renewed by hand |
| 09:59 | Cache hits back above 90%, queues drained |

## What went well

- The fallback worked: no build failed, they were only slow.
- The page reached the right person in 8 minutes.

## What we'll change

1. Renew certificates automatically, 30 days before they expire.
2. Alert on the cache hit rate, not only on the queue.
3. Add the cache to the on-call handbook's checks.
`;

const FLAKY_TESTS = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Flaky test leaderboard</title>
<style>
  body { margin: 0; background: #0f172a; color: #e2e8f0; font: 16px/1.45 system-ui, sans-serif; }
  .wrap { padding: 30px 34px; }
  h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 22px; color: #94a3b8; }
  table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
  th { padding: 0 14px; color: #94a3b8; font-size: 13px; font-weight: 600; text-align: left; text-transform: uppercase; letter-spacing: 0.06em; }
  td { padding: 12px 14px; background: #1e293b; }
  td:first-child { border-radius: 12px 0 0 12px; font-weight: 700; color: #fbbf24; width: 40px; }
  td:last-child { border-radius: 0 12px 12px 0; }
  .name { font-family: ui-monospace, Menlo, monospace; font-size: 15px; }
  .rate { display: flex; align-items: center; gap: 10px; }
  .rate i { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #f97316, #ef4444); }
  .rate b { min-width: 48px; font-variant-numeric: tabular-nums; }
  .owner { color: #94a3b8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Flaky test leaderboard</h1>
  <p class="sub">The tests that failed and then passed on a retry most often in the last 14 days.</p>
  <table>
    <tr><th>#</th><th>Test</th><th>Fails on retry</th><th>Owner</th></tr>
    <tr><td>1</td><td class="name">checkout/applies_coupon_twice</td><td><div class="rate"><b>8.4%</b><i style="width: 210px"></i></div></td><td class="owner">Payments</td></tr>
    <tr><td>2</td><td class="name">search/suggests_while_typing</td><td><div class="rate"><b>6.1%</b><i style="width: 152px"></i></div></td><td class="owner">Search</td></tr>
    <tr><td>3</td><td class="name">auth/refreshes_expired_session</td><td><div class="rate"><b>4.7%</b><i style="width: 118px"></i></div></td><td class="owner">Identity</td></tr>
    <tr><td>4</td><td class="name">web/renders_dashboard_offline</td><td><div class="rate"><b>3.2%</b><i style="width: 80px"></i></div></td><td class="owner">Web platform</td></tr>
    <tr><td>5</td><td class="name">cli/upgrade_keeps_plugins</td><td><div class="rate"><b>2.9%</b><i style="width: 72px"></i></div></td><td class="owner">Developer Experience</td></tr>
  </table>
</div>
</body>
</html>`;

const RUNNER_FORECAST = `| Month | Builds per day | Runners needed | Runners today | Gap |
| --- | --- | --- | --- | --- |
| November | 4,200 | 180 | 190 | +10 |
| December | 3,600 | 155 | 190 | +35 |
| January | 4,900 | 210 | 190 | −20 |
| February | 5,300 | 228 | 190 | −38 |
| March | 5,800 | 249 | 190 | −59 |
`;

const GOLDEN_PATH = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Golden path: start a new service</title>
<style>
  body { margin: 0; background: #f0fdf9; color: #0f2e27; font: 16px/1.5 system-ui, sans-serif; }
  .wrap { padding: 30px 36px; }
  .tag { display: inline-block; margin-bottom: 8px; padding: 4px 10px; border-radius: 999px; background: #ccfbef; color: #0f766e; font-size: 13px; font-weight: 700; }
  h1 { margin: 0 0 6px; font-size: 32px; letter-spacing: -0.02em; }
  .sub { margin: 0 0 24px; color: #3f6b61; }
  .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .step { padding: 18px; border: 1px solid #b8eadc; border-radius: 16px; background: #fff; }
  .step b { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 10px; border-radius: 50%; background: #0f766e; color: #fff; }
  .step h2 { margin: 0 0 6px; font-size: 17px; }
  .step p { margin: 0 0 10px; color: #3f6b61; font-size: 14px; }
  code { display: block; padding: 8px 10px; border-radius: 8px; background: #0f2e27; color: #a7f3d0; font: 13px/1.4 ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <span class="tag">Golden path</span>
  <h1>Start a new service</h1>
  <p class="sub">From an empty folder to production in a day, with tests, dashboards and on-call set up for you.</p>
  <div class="steps">
    <div class="step"><b>1</b><h2>Create it</h2><p>Pick a language and a name; the template does the rest.</p><code>ex new service billing-api</code></div>
    <div class="step"><b>2</b><h2>Run it</h2><p>Start it locally with its dependencies in containers.</p><code>ex dev</code></div>
    <div class="step"><b>3</b><h2>Preview it</h2><p>Every pull request gets its own environment.</p><code>ex deploy --preview</code></div>
    <div class="step"><b>4</b><h2>Ship it</h2><p>Merging to main deploys, behind a flag you turn on.</p><code>ex flags on billing-api</code></div>
  </div>
</div>
</body>
</html>`;

export const SAMPLE_ARTIFACTS = [
    {
        id: '4f8c2a19d7e64b0f9a3c5e7b1d2f6a80', title: 'Build health, week 45', type: 'html', kind: 'Dashboard', author: 'Margaret Hamilton',
        hoursAgo: 2, ageDays: 96, version: 14, summary: 'Pass rate, build times and flaky tests across every pipeline in the monorepo, refreshed each morning.',
        content: { format: 'html', text: BUILD_HEALTH },
    },
    {
        id: '7e2b9d41c0a54f6e8b3d1c9a5f7e2b64', title: 'Q1 platform roadmap', type: 'paper', author: 'Grace Hopper',
        hoursAgo: 20, ageDays: 12, version: 6, summary: "Where Developer Experience is putting its time from January to March, and what we're leaving for later.",
        content: { format: 'markdown', text: ROADMAP },
    },
    {
        id: 'c3a17f5e9b2d4c8a6e0f1b7d3a9c5e21', title: 'Release notes: CLI 3.2', type: 'message', author: 'Barbara Liskov',
        hoursAgo: 46, ageDays: 1, version: 3, summary: 'Preview environments from ex deploy, ex logs across services, and commands that start 40% faster.',
        content: { format: 'text', text: RELEASE_NOTES },
    },
    {
        id: '1d9e6b3f7a2c4e8b0d5f9a1c3e7b2d58', title: 'On-call handbook', type: 'html', kind: 'Guide', author: 'Ken Thompson',
        hoursAgo: 97, ageDays: 210, version: 22, summary: "What to check before your shift, what to do when you're paged, and who to call for each system.",
        content: { format: 'html', text: ON_CALL },
    },
    {
        id: 'a6f04c8e2d1b9f7a5c3e6d0b8f2a4c93', title: 'Incident review: remote cache outage', type: 'paper', author: 'Frances Allen',
        hoursAgo: 146, ageDays: 9, version: 4, summary: 'An expired certificate on the remote cache slowed every build for 47 minutes. What happened, and the three things we will change.',
        content: { format: 'markdown', text: INCIDENT_REVIEW },
    },
    {
        id: '58b2e7d3a9f14c6b0e8d2a5f7c1b9e36', title: 'Flaky test leaderboard', type: 'html', kind: 'Dashboard', author: 'Alan Kay',
        hoursAgo: 170, ageDays: 64, version: 31, summary: 'The tests that pass only on a retry most often, with the team that owns each one.',
        content: { format: 'html', text: FLAKY_TESTS },
    },
    {
        id: 'e9c5a3f1b7d24e8c6a0f3b9d1e5c7a42', title: 'Runner capacity forecast', type: 'spreadsheet', author: 'Margaret Hamilton',
        hoursAgo: 219, ageDays: 40, version: 9, summary: 'Builds per day and the CI runners they need through March: we run short from January.',
        content: { format: 'markdown', text: RUNNER_FORECAST },
    },
    {
        id: '2b7f9e5d1c3a4b8f6e0d2c9a7f5b3e18', title: 'Golden path: start a new service', type: 'html', kind: 'Guide', author: 'Grace Hopper',
        hoursAgo: 290, ageDays: 150, version: 11, summary: 'From an empty folder to production in a day: create, run, preview and ship a service with the ex CLI.',
        content: { format: 'html', text: GOLDEN_PATH },
    },
    {
        id: 'd4a8c2e6f0b14d9a7c5e3f1b8d6a2c75', title: 'DevEx weekly, episode 18', type: 'podcast', author: 'Barbara Liskov',
        hoursAgo: 336, ageDays: 0, version: 1, summary: 'Eighteen minutes on preview environments: what we built, what broke on the way, and what comes next.',
        content: null,
    },
];
