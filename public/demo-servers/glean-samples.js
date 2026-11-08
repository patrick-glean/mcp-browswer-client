// The Glean demo server's made-up team and what it made in Glean: Example Co's Developer
// Experience team, its people borrowed from computing history as the front desk's visitors are.
// Each artifact's content is what Glean's read_document gives of one: a paper's Markdown, a
// page's whole HTML (two of them scripted, as artifacts can be), or a message's text. `hoursAgo`
// says when it last changed, so the team's newest always look recent; it was made `ageDays`
// before that. Six of them are papers and pages, with a message and a spreadsheet among them.

export const SAMPLE_TEAM = 'Developer Experience';

const BUILD_HEALTH = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Build health</title>
<style>
  body { margin: 0; background: #f4f5fa; color: #17181c; font: 16px/1.45 system-ui, sans-serif; }
  .wrap { padding: 28px 32px; }
  header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0 16px; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 20px; color: #687083; }
  .weeks { display: flex; padding: 3px; border-radius: 999px; background: #e4e6f0; }
  .weeks button { padding: 6px 14px; border: 0; border-radius: 999px; background: none; color: #484e5e; font: 600 14px/1 system-ui, sans-serif; cursor: pointer; }
  .weeks button[aria-pressed="true"] { background: #fff; color: #17181c; box-shadow: 0 1px 2px rgba(20, 24, 40, 0.12); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; margin-bottom: 14px; }
  .card { padding: 16px 18px; border-radius: 16px; background: #fff; box-shadow: 0 1px 3px rgba(20, 24, 40, 0.08); }
  .kpi span { color: #687083; font-size: 14px; }
  .kpi b { display: block; margin: 2px 0; font-size: 30px; letter-spacing: -0.03em; }
  .kpi i { font-size: 14px; font-style: normal; font-weight: 600; }
  .good { color: #138a4a; } .bad { color: #c2410c; }
  .row { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; }
  @media (max-width: 640px) { .wrap { padding: 20px 18px; } .row { grid-template-columns: 1fr; } .weeks { margin-bottom: 16px; } }
  h2 { margin: 0 0 12px; font-size: 16px; }
  canvas { display: block; width: 100%; height: 180px; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { padding: 7px 4px; border-bottom: 1px solid #eceef4; text-align: left; }
  th { color: #687083; font-weight: 600; }
  td:last-child, th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  .more { margin: 12px 0 0; font-size: 14px; }
  a { color: #4338ca; }
  .status { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; color: #687083; font-size: 14px; }
  .status button { padding: 6px 14px; border: 1px solid #cfd3e0; border-radius: 999px; background: #fff; font: 600 14px/1 system-ui, sans-serif; cursor: pointer; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Build health</h1>
      <p class="sub">Every pipeline in the monorepo, Monday to Sunday.</p>
    </div>
    <div class="weeks" role="group" aria-label="Week">
      <button type="button" data-week="45" aria-pressed="true">Week 45</button>
      <button type="button" data-week="44" aria-pressed="false">Week 44</button>
    </div>
  </header>
  <div class="kpis" id="kpis"></div>
  <div class="row">
    <div class="card">
      <h2>Builds per day</h2>
      <canvas id="chart" role="img" aria-label="Builds per day"></canvas>
    </div>
    <div class="card">
      <h2>Slowest pipelines</h2>
      <table id="slowest"></table>
      <p class="more"><a href="https://ci.example.com/pipelines" target="_blank">Every pipeline, in CI</a></p>
    </div>
  </div>
  <p class="status"><button type="button" id="refresh">Refresh</button><span id="status">These are this morning's numbers, from 7:00.</span></p>
</div>
<script>
  const WEEKS = {
    45: {
      kpis: [['Pass rate', '96.8%', '▲ 0.9 points', 'good'], ['Median build', '7m 12s', '▼ 38s', 'good'], ['Flaky tests', '14', '▼ 6', 'good'], ['Queue wait', '41s', '▲ 9s', 'bad']],
      builds: [612, 748, 806, 690, 544, 152, 98],
      slowest: [['web-e2e', '18m 40s'], ['payments-integration', '14m 05s'], ['mobile-release', '12m 51s'], ['search-indexer', '9m 22s']],
    },
    44: {
      kpis: [['Pass rate', '95.9%', '▼ 0.4 points', 'bad'], ['Median build', '7m 50s', '▲ 12s', 'bad'], ['Flaky tests', '20', '▲ 3', 'bad'], ['Queue wait', '32s', '▼ 5s', 'good']],
      builds: [588, 702, 741, 715, 566, 131, 104],
      slowest: [['web-e2e', '19m 12s'], ['mobile-release', '13m 30s'], ['payments-integration', '13m 58s'], ['search-indexer', '9m 40s']],
    },
  };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cell = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

  function draw(builds) {
    const canvas = document.getElementById('chart');
    const scale = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    const top = Math.max(...builds), slot = width / builds.length, bar = slot * 0.62, floor = height - 22;
    builds.forEach((count, day) => {
      const x = day * slot + (slot - bar) / 2, y = floor - (count / top) * (floor - 18);
      const fill = context.createLinearGradient(0, y, 0, floor);
      fill.addColorStop(0, '#5b5ff0');
      fill.addColorStop(1, '#a5a9ff');
      context.fillStyle = fill;
      context.beginPath();
      context.roundRect(x, y, bar, floor - y, [7, 7, 0, 0]);
      context.fill();
      context.fillStyle = '#17181c';
      context.font = '600 12px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(String(count), x + bar / 2, y - 5);
      context.fillStyle = '#687083';
      context.font = '12px system-ui, sans-serif';
      context.fillText(DAYS[day], x + bar / 2, height - 5);
    });
  }

  let shown = WEEKS[45];
  function show(week) {
    const data = shown = WEEKS[week] || WEEKS[45];
    document.getElementById('kpis').replaceChildren(...data.kpis.map(([name, value, change, tone]) => {
      const card = document.createElement('div');
      card.className = 'card kpi';
      card.append(cell('span', name), cell('b', value), Object.assign(cell('i', change), { className: tone }));
      return card;
    }));
    const rows = data.slowest.map(([pipeline, median]) => {
      const row = document.createElement('tr');
      row.append(cell('td', pipeline), cell('td', median));
      return row;
    });
    const head = document.createElement('tr');
    head.append(cell('th', 'Pipeline'), cell('th', 'Median'));
    document.getElementById('slowest').replaceChildren(head, ...rows);
    for (const button of document.querySelectorAll('[data-week]')) button.setAttribute('aria-pressed', String(button.dataset.week === String(week)));
    draw(data.builds);
    try { localStorage.setItem('week', String(week)); } catch { /* Not kept, then. */ }
  }

  for (const button of document.querySelectorAll('[data-week]')) button.addEventListener('click', () => show(button.dataset.week));
  addEventListener('resize', () => draw(shown.builds));
  document.getElementById('refresh').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.textContent = 'Asking CI for the latest numbers…';
    try {
      await fetch('https://ci.example.com/api/builds?week=45');
      status.textContent = 'Up to date.';
    } catch {
      status.textContent = "Couldn't reach CI from here, so these are this morning's numbers, from 7:00.";
    }
  });
  let week = '45';
  try { week = localStorage.getItem('week') || week; } catch { /* The newest week, then. */ }
  show(week);
</script>
</body>
</html>`;

const ROADMAP = `# Q1 platform roadmap

Where Developer Experience is putting its time from January to March, and what we're leaving for later.

## Goals

1. **A preview environment for every pull request**, ready in under 5 minutes.
   - Built from the same images as production.
   - Torn down when the pull request closes.
2. **Half the flaky failures** on the main branch: from 2.1% of runs to 1%.
3. **One golden path per language**, from \`ex new\` to production in a day.

## Milestones

| Milestone | Owner | Due | Status |
| --- | --- | --- | --- |
| Preview environments beta | Grace Hopper | Jan 24 | On track |
| Flaky test quarantine | Alan Kay | Feb 7 | On track |
| Go and Rust golden paths | Ken Thompson | Mar 14 | At risk |

## Done so far

- [x] Preview environments: design review
- [x] A quarantine list in the test runner
- [ ] Golden path templates for Go and Rust

## Trying it

Preview environments are behind a flag until the beta:

\`\`\`sh
ex deploy --preview --flag preview-envs
\`\`\`

![How a preview environment is built](https://example.com/devex/preview-environments.png)

> **Not this quarter:** replacing the build system, or a second CI provider. We'll look again in Q3, with the remote cache numbers in hand.

---

Questions go to [#devex-help](https://example.com/chat/devex-help), or to Grace Hopper.
`;

const RELEASE_NOTES = `CLI 3.2 is out for everyone at Example Co.

What's new:
- ex deploy --preview gives your branch its own environment, and posts its link on the pull request
- ex logs follows the logs of several services at once, each in its own color
- Commands start 40% faster: they load only the plugins they use

Upgrade with ex upgrade. Questions go to #devex-help, and thanks to everyone who tried the beta.`;

const FLAKY_TESTS = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Flaky test leaderboard</title>
<style>
  body { margin: 0; background: #0f172a; color: #e2e8f0; font: 16px/1.45 system-ui, sans-serif; }
  .wrap { padding: 28px 32px; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 18px; color: #94a3b8; }
  .teams { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .teams button { padding: 6px 12px; border: 1px solid #334155; border-radius: 999px; background: none; color: #cbd5e1; font: 600 13px/1 system-ui, sans-serif; cursor: pointer; }
  .teams button[aria-pressed="true"] { border-color: #fbbf24; background: #fbbf24; color: #0f172a; }
  table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
  th { padding: 0 14px; text-align: left; }
  th button { padding: 0; border: 0; background: none; color: #94a3b8; font: 600 13px/1 system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
  th button[aria-sort]::after { content: ' ↓'; }
  th button[aria-sort="ascending"]::after { content: ' ↑'; }
  td { padding: 11px 14px; background: #1e293b; }
  td:first-child { width: 40px; border-radius: 12px 0 0 12px; color: #fbbf24; font-weight: 700; }
  td:last-child { border-radius: 0 12px 12px 0; color: #94a3b8; }
  .name { font: 15px/1.3 ui-monospace, Menlo, monospace; }
  .rate { display: flex; align-items: center; gap: 10px; }
  .rate i { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #f97316, #ef4444); }
  .rate b { min-width: 48px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Flaky test leaderboard</h1>
  <p class="sub">The tests that failed and then passed on a retry most often in the last 14 days. Pick a team, or sort by a column.</p>
  <div class="teams" id="teams" role="group" aria-label="Team"></div>
  <table>
    <thead><tr><th>#</th><th><button type="button" data-sort="name">Test</button></th><th><button type="button" data-sort="rate" aria-sort="descending">Fails on retry</button></th><th><button type="button" data-sort="team">Owner</button></th></tr></thead>
    <tbody id="tests"></tbody>
  </table>
</div>
<script>
  const TESTS = [
    { name: 'checkout/applies_coupon_twice', rate: 8.4, team: 'Payments' },
    { name: 'search/suggests_while_typing', rate: 6.1, team: 'Search' },
    { name: 'auth/refreshes_expired_session', rate: 4.7, team: 'Identity' },
    { name: 'web/renders_dashboard_offline', rate: 3.2, team: 'Web platform' },
    { name: 'cli/upgrade_keeps_plugins', rate: 2.9, team: 'Developer Experience' },
    { name: 'payments/retries_declined_card', rate: 2.4, team: 'Payments' },
    { name: 'search/ranks_exact_title_first', rate: 1.8, team: 'Search' },
  ];
  let sort = { by: 'rate', descending: true };
  let team = 'Every team';
  const cell = (text, className) => Object.assign(document.createElement('td'), { textContent: text, className: className || '' });

  function render() {
    const shown = TESTS.filter(test => team === 'Every team' || test.team === team).sort((a, b) => {
      const order = typeof a[sort.by] === 'number' ? a[sort.by] - b[sort.by] : a[sort.by].localeCompare(b[sort.by]);
      return sort.descending ? -order : order;
    });
    const top = Math.max(...TESTS.map(test => test.rate));
    document.getElementById('tests').replaceChildren(...shown.map((test, index) => {
      const row = document.createElement('tr');
      const rate = document.createElement('td');
      rate.innerHTML = '<div class="rate"><b></b><i></i></div>';
      rate.querySelector('b').textContent = test.rate.toFixed(1) + '%';
      rate.querySelector('i').style.width = Math.round((test.rate / top) * 210) + 'px';
      row.append(cell(String(index + 1)), cell(test.name, 'name'), rate, cell(test.team));
      return row;
    }));
    for (const button of document.querySelectorAll('[data-sort]')) {
      if (button.dataset.sort === sort.by) button.setAttribute('aria-sort', sort.descending ? 'descending' : 'ascending');
      else button.removeAttribute('aria-sort');
    }
    for (const button of document.querySelectorAll('#teams button')) button.setAttribute('aria-pressed', String(button.textContent === team));
  }

  document.getElementById('teams').append(...['Every team', ...new Set(TESTS.map(test => test.team))].map(name => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: name });
    button.addEventListener('click', () => { team = name; render(); });
    return button;
  }));
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => {
      sort = sort.by === button.dataset.sort ? { by: sort.by, descending: !sort.descending } : { by: button.dataset.sort, descending: button.dataset.sort === 'rate' };
      render();
    });
  }
  render();
</script>
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

const RUNNER_FORECAST = `| Month | Builds per day | Runners needed | Runners today | Gap |
| --- | --- | --- | --- | --- |
| November | 4,200 | 180 | 190 | +10 |
| December | 3,600 | 155 | 190 | +35 |
| January | 4,900 | 210 | 190 | −20 |
| February | 5,300 | 228 | 190 | −38 |
| March | 5,800 | 249 | 190 | −59 |
`;

const ON_CALL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>On-call handbook</title>
<style>
  :root { --ink: #1c1917; --muted: #6b645c; --accent: #c2410c; }
  body { margin: 0; background: #fffaf5; color: var(--ink); font: 16px/1.55 Georgia, 'Times New Roman', serif; }
  header { padding: 32px 40px 24px; background: linear-gradient(120deg, #7c2d12, #c2410c); color: #fff; }
  header p { margin: 0 0 6px; font: 600 13px/1 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.8; }
  h1 { margin: 0; font-size: 34px; line-height: 1.1; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; padding: 26px 40px; }
  @media (max-width: 640px) { header { padding: 24px 20px 18px; } main { grid-template-columns: 1fr; padding: 20px; } }
  h2 { margin: 0 0 10px; color: var(--accent); font: 700 18px/1.2 system-ui, sans-serif; }
  ol { margin: 0; padding-left: 22px; }
  li { margin-bottom: 8px; }
  .callout { grid-column: 1 / -1; margin: 0; padding: 16px 20px; border-left: 5px solid var(--accent); border-radius: 10px; background: #fde9dc; font-family: system-ui, sans-serif; }
  table { width: 100%; border-collapse: collapse; font: 15px/1.4 system-ui, sans-serif; }
  td { padding: 7px 0; border-bottom: 1px solid #f0e2d6; }
  td:first-child { width: 42%; color: var(--muted); }
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

const GOLDEN_PATH = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Golden path: start a new service</title>
<style>
  body { margin: 0; background: #f0fdf9; color: #0f2e27; font: 16px/1.5 system-ui, sans-serif; }
  .wrap { padding: 30px 36px; }
  .tag { display: inline-block; margin-bottom: 8px; padding: 4px 10px; border-radius: 999px; background: #ccfbef; color: #0f766e; font-size: 13px; font-weight: 700; }
  h1 { margin: 0 0 6px; font-size: 32px; letter-spacing: -0.02em; }
  .sub { margin: 0 0 24px; color: #3f6b61; }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; }
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

// Newest first. `type` is Glean's kind of artifact: paper (Markdown), html, message or spreadsheet.
export const SAMPLE_ARTIFACTS = [
    {
        id: '4f8c2a19d7e64b0f9a3c5e7b1d2f6a80', title: 'Build health', type: 'html', author: 'Margaret Hamilton', hoursAgo: 2, ageDays: 96,
        summary: 'Pass rate, build times and flaky tests across every pipeline in the monorepo, week by week.', content: BUILD_HEALTH,
    },
    {
        id: '7e2b9d41c0a54f6e8b3d1c9a5f7e2b64', title: 'Q1 platform roadmap', type: 'paper', author: 'Grace Hopper', hoursAgo: 20, ageDays: 12,
        summary: "Where Developer Experience is putting its time from January to March, and what we're leaving for later.", content: ROADMAP,
    },
    {
        id: 'c3a17f5e9b2d4c8a6e0f1b7d3a9c5e21', title: 'Release notes: CLI 3.2', type: 'message', author: 'Barbara Liskov', hoursAgo: 30, ageDays: 1,
        summary: 'Preview environments from ex deploy, ex logs across services, and commands that start 40% faster.', content: RELEASE_NOTES,
    },
    {
        id: '58b2e7d3a9f14c6b0e8d2a5f7c1b9e36', title: 'Flaky test leaderboard', type: 'html', author: 'Alan Kay', hoursAgo: 46, ageDays: 64,
        summary: 'The tests that pass only on a retry most often, with the team that owns each one.', content: FLAKY_TESTS,
    },
    {
        id: 'a6f04c8e2d1b9f7a5c3e6d0b8f2a4c93', title: 'Incident review: remote cache outage', type: 'paper', author: 'Frances Allen', hoursAgo: 97, ageDays: 9,
        summary: 'An expired certificate on the remote cache slowed every build for 47 minutes. What happened, and the three things we will change.', content: INCIDENT_REVIEW,
    },
    {
        id: 'e9c5a3f1b7d24e8c6a0f3b9d1e5c7a42', title: 'Runner capacity forecast', type: 'spreadsheet', author: 'Margaret Hamilton', hoursAgo: 120, ageDays: 40,
        summary: 'Builds per day and the CI runners they need through March: we run short from January.', content: RUNNER_FORECAST,
    },
    {
        id: '1d9e6b3f7a2c4e8b0d5f9a1c3e7b2d58', title: 'On-call handbook', type: 'html', author: 'Ken Thompson', hoursAgo: 146, ageDays: 210,
        summary: "What to check before your shift, what to do when you're paged, and who to call for each system.", content: ON_CALL,
    },
    {
        id: '2b7f9e5d1c3a4b8f6e0d2c9a7f5b3e18', title: 'Golden path: start a new service', type: 'html', author: 'Grace Hopper', hoursAgo: 170, ageDays: 150,
        summary: 'From an empty folder to production in a day: create, run, preview and ship a service with the ex CLI.', content: GOLDEN_PATH,
    },
];
