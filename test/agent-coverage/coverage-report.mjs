#!/usr/bin/env node
// Renders converter-coverage.html (repo root, gitignored) from the real vitest
// results of test/agent-coverage/claude-coverage.test.ts — no AI, no guessing
// from source text. Each row's color comes straight from whether a real
// synthetic-fixture test passed, failed, or is still `it.todo`:
//
//   covered claim, test passed      -> green  (the converter really does this)
//   not-covered claim, test passed  -> red    (the converter really ignores this)
//   either claim, test FAILED       -> orange (the claim no longer matches reality —
//                                               the converter's behavior drifted; the
//                                               failing assertion in `npm test` is the
//                                               actual thing to go fix, this is just a
//                                               loud pointer at it)
//   it.todo (no assertion written)  -> grey   (inventoried, not yet decided)
//
// Usage: npm run coverage:agent (or: node test/agent-coverage/coverage-report.mjs > converter-coverage.html)
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(__dirname));
const suitePath = path.join('test', 'agent-coverage', 'claude-coverage.test.ts');

// A drifted case makes vitest exit non-zero — that's the expected, reportable
// case here, not a script failure, so pull stdout off the thrown error too.
let raw;
try {
    raw = execFileSync('npx', ['vitest', 'run', suitePath, '--reporter=json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
} catch (error) {
    if (!error.stdout) throw error;
    raw = error.stdout;
}
// vitest's own progress/warnings can land on stdout ahead of the JSON blob; the
// report is the last top-level `{...}` in the output.
const jsonStart = raw.lastIndexOf('\n{');
const report = JSON.parse(jsonStart === -1 ? raw : raw.slice(jsonStart + 1));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "[covered] user: a plain string prompt becomes..." -> {claim: 'covered', recordType: 'user', title: '...'}
// "toolUseResult — Bash → stdout" (todo, no claim prefix) -> {claim: null, group: 'toolUseResult — Bash', item: 'stdout'}
function parseTitle(title) {
    const claimMatch = title.match(/^\[(covered|not-covered)]\s*([^:]+):\s*(.*)$/s);
    if (claimMatch) return {claim: claimMatch[1], recordType: claimMatch[2], detail: claimMatch[3]};
    const todoMatch = title.match(/^(.*?)\s*→\s*(.*)$/s);
    if (todoMatch) return {claim: null, recordType: todoMatch[1], detail: todoMatch[2]};
    return {claim: null, recordType: '(other)', detail: title};
}

const byRecordType = new Map();
let assertions = [];
for (const file of report.testResults) assertions = assertions.concat(file.assertionResults);

for (const a of assertions) {
    const {claim, recordType, detail} = parseTitle(a.title);
    let status;
    if (a.status === 'todo') status = 'pending';
    else if (a.status !== 'passed') status = 'drifted';
    else status = claim === 'covered' ? 'covered' : claim === 'not-covered' ? 'not-covered' : 'pending';

    const bucket = byRecordType.get(recordType) ?? [];
    bucket.push({detail, status, failure: a.failureMessages?.[0] ?? null});
    byRecordType.set(recordType, bucket);
}

const COLORS = {
    covered: {bg: '#0f2a1a', text: '#5fd98a', border: '#1d4a2c', label: 'covered'},
    'not-covered': {bg: '#2a1414', text: '#e0727a', border: '#4a1f22', label: 'not covered'},
    drifted: {bg: '#3a1f00', text: '#ffb454', border: '#5a3300', label: 'DRIFTED — claim no longer true, see npm test'},
    pending: {bg: '#1a1f26', text: '#7d8894', border: '#2a313b', label: 'pending — not yet decided'},
};

function rowsFor(items) {
    return items.map(({detail, status, failure}) => {
        const c = COLORS[status];
        const failureHtml = failure ? `<div class="failure">${esc(failure.split('\n')[0])}</div>` : '';
        return `<li class="${status}"><span class="badge" style="background:${c.text}"></span><span class="detail">${esc(detail)}</span><span class="tag" style="color:${c.text};border-color:${c.border};background:${c.bg}">${c.label}</span>${failureHtml}</li>`;
    }).join('');
}

const sortedTypes = [...byRecordType.entries()].sort((a, b) => {
    const score = (items) => items.filter((i) => i.status === 'covered' || i.status === 'not-covered').length;
    return score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]);
});

let totalCovered = 0, totalNotCovered = 0, totalDrifted = 0, totalPending = 0;
for (const items of byRecordType.values()) {
    for (const {status} of items) {
        if (status === 'covered') totalCovered += 1;
        else if (status === 'not-covered') totalNotCovered += 1;
        else if (status === 'drifted') totalDrifted += 1;
        else totalPending += 1;
    }
}
const decided = totalCovered + totalNotCovered;
const overallPct = decided ? Math.round(totalCovered / decided * 100) : 0;

// Shared with the TOC links below — section ids and hrefs must agree exactly.
const anchorFor = (recordType) => recordType.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');

const sections = sortedTypes.map(([recordType, items]) => {
    const decidedHere = items.filter((i) => i.status === 'covered' || i.status === 'not-covered');
    const coveredHere = items.filter((i) => i.status === 'covered').length;
    const sharePct = decidedHere.length ? Math.round(coveredHere / decidedHere.length * 100) : null;
    return `<section id="${esc(anchorFor(recordType))}">
<h2><code>${esc(recordType)}</code>${sharePct !== null ? `<span class="share">${sharePct}% of its own decided cases covered</span>` : '<span class="share pending-only">no decided cases yet — all pending</span>'}</h2>
<ul>${rowsFor(items)}</ul>
</section>`;
}).join('\n');

const toc = sortedTypes.map(([recordType, items]) => {
    const decidedHere = items.filter((i) => i.status === 'covered' || i.status === 'not-covered');
    const coveredHere = items.filter((i) => i.status === 'covered').length;
    const sharePct = decidedHere.length ? Math.round(coveredHere / decidedHere.length * 100) : 0;
    return `<a href="#${esc(anchorFor(recordType))}" class="toc-row"><code>${esc(recordType)}</code><span class="toc-bar"><span style="width:${sharePct}%"></span></span><span class="toc-pct">${decidedHere.length ? `${sharePct}%` : '—'}</span></a>`;
}).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>claude-agent.ts field coverage</title>
<style>
  :root { --bg:#0b0d10; --panel:#12161b; --border:#232a32; --text:#d7dde3; --muted:#8b96a3; --code-bg:#1a1f26; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0 0 80px; }
  header { padding: 32px 32px 20px; border-bottom: 1px solid var(--border); background: var(--bg); }
  header h1 { margin: 0 0 8px; font-size: 20px; }
  header p { margin: 4px 0; color: var(--muted); }
  main { padding: 0 32px; }
  code { background: var(--code-bg); border-radius: 3px; padding: 1px 5px; font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfe3ff; }
  section { margin: 30px 0; border-radius: 8px; transition: background-color 150ms ease; }
  section:hover { background-color: rgba(255, 255, 255, 0.025); }
  section h2 { font-size: 15px; margin: 0 0 8px; display: flex; align-items: baseline; gap: 10px; }
  .share { font-size: 12px; color: var(--muted); font-weight: 400; }
  .share.pending-only { color: #7d8894; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 5px 8px; border-radius: 5px; margin: 1px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; transition: background-color 150ms ease, opacity 150ms ease; }
  li.covered { background: #0f2a1a; }
  li.not-covered { background: transparent; }
  li.drifted { background: #3a1f00; }
  li.pending { background: transparent; opacity: .7; }
  li.covered:hover { background: #1a4a2c; }
  li.not-covered:hover { background: rgba(255, 255, 255, 0.08); }
  li.drifted:hover { background: #5c3900; }
  li.pending:hover { background: rgba(255, 255, 255, 0.07); opacity: 1; }
  .badge { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .detail { flex: 1 1 auto; min-width: 200px; }
  .tag { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
  .failure { width: 100%; font: 11px ui-monospace, monospace; color: #ffb454; margin-top: 2px; }
  nav.toc { display: flex; flex-direction: column; gap: 4px; margin: 18px 0 8px; max-width: 50%; }
  .toc-row { display: grid; grid-template-columns: 180px 1fr 36px; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font-size: 12.5px; }
  .toc-bar { background: var(--code-bg); border-radius: 4px; height: 8px; overflow: hidden; }
  .toc-bar span { display: block; height: 100%; background: linear-gradient(90deg, #e0727a, #5fd98a); }
  .toc-pct { text-align: right; color: var(--muted); }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; margin: 14px 0; font-size: 12.5px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend .dot { width: 8px; height: 8px; border-radius: 50%; }
  .big-stat { font-size: 32px; font-weight: 700; }
  .methodology { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin: 16px 0; font-size: 12.5px; color: var(--muted); }
  details summary { cursor: pointer; color: #bcd0ff; }
</style>
</head>
<body>
<header>
  <h1>What <code>src/agents/claude-agent.ts</code> actually reads</h1>
  <p>Colored from a real run of <code>test/agent-coverage/claude-coverage.test.ts</code> — synthetic (non-confidential, English-only) fixtures fed through
     the actual converter (<code>AgentRegistry.get('claude').loadSession(...)</code>), not source-text guessing. Regenerate any time with
     <code>npm run coverage:agent</code> — zero AI involved.</p>
  <p class="big-stat">${overallPct}%</p>
  <p style="margin-top:-4px">of the <strong>decided</strong> cases (${decided} of them) are things the converter actually reads.
     ${totalPending} more are inventoried but not yet decided (<code>it.todo</code> in the suite) — mostly per-tool <code>toolUseResult</code>
     fields and <code>attachment.attachment</code> variants. ${totalDrifted ? `<strong style="color:#ffb454">${totalDrifted} case(s) are currently failing — see below.</strong>` : 'All decided cases currently pass.'}</p>
  <div class="legend">
    <span><span class="dot" style="background:#5fd98a"></span> covered — converter reads this</span>
    <span><span class="dot" style="background:#e0727a"></span> not covered — converter ignores this</span>
    <span><span class="dot" style="background:#ffb454"></span> drifted — the test now fails, go check <code>npm test</code></span>
    <span><span class="dot" style="background:#7d8894"></span> pending — <code>it.todo</code>, not decided yet</span>
  </div>
  <nav class="toc">${toc}</nav>
</header>
<main>
<details class="methodology">
<summary>Methodology (click to expand)</summary>
<p>Each row is one vitest test from <code>test/agent-coverage/claude-coverage/cases.ts</code>. A <code>covered</code>/<code>not-covered</code> row
declares what the real converter does, then a synthetic fixture (built with <code>test/agent-coverage/claude-coverage/fixtures.ts</code>) is run through
the actual <code>ClaudeAgent</code> and the claim is asserted with plain <code>node:assert</code>. If the converter's behavior ever changes,
the matching test fails and this report turns that row <strong>orange</strong> instead of silently staying green or red — the report can't
drift out of sync with the code the way a hand-written or regex-derived one can. Pending rows are <code>it.todo()</code> stubs: fields we've
inventoried from real sessions but have not written an assertion for — promote one to a real case in <code>cases.ts</code> once we decide
it matters.</p>
</details>
${sections}
</main>
</body>
</html>`;

process.stdout.write(html);
