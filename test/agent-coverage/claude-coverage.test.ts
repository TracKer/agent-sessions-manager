// Runs the Claude Code field-coverage case registry (claude-coverage/cases.ts)
// as real vitest tests. This file is deliberately thin: the cases themselves run
// against the real converter via synthetic fixtures (see fixtures.ts), so what's
// here is just wiring, not logic.
//
// `coverage-report.mjs` (run via `npm run coverage:agent`) re-runs this suite with
// `--reporter=json` and turns the result into a colored HTML page at the repo root
// (converter-coverage.html, gitignored): no AI involved, same test, same pass/fail
// ground truth, just rendered for a human. Keep each title descriptive on its own,
// since that JSON is the only thing the renderer reads.
import {afterEach, describe, it} from 'vitest';
import {cases, stubs} from './claude-coverage/cases.js';
import {cleanupFixtures} from './claude-coverage/fixtures.js';

afterEach(async () => {
    await cleanupFixtures();
});

describe('claude-agent.ts field coverage', () => {
    for (const testCase of cases) {
        it(`[${testCase.status}] ${testCase.recordType}: ${testCase.title}`, testCase.run);
    }

    // A plain `describe` (not `.todo`) — its body must actually run to register the
    // `it.todo()` calls inside it; a todo *suite* would skip the body entirely.
    describe('pending — not yet decided whether the converter should read these', () => {
        for (const group of stubs) {
            for (const item of group.items) {
                it.todo(`${group.group} → ${item}`);
            }
        }
    });
});
