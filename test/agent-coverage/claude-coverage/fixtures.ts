// Synthetic (not-from-real-sessions) Claude Code session fixtures, plus a loader
// that writes them to a throwaway `.claude` home and reads them back through the
// *real* converter (`AgentRegistry.get('claude').loadSession`). Every case in
// `cases.ts` builds its input with these helpers, so what gets tested is actual
// code behavior, never an assumption about it.
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentRegistry} from '../../../src/agents/agent-registry.js';
import {sanitizeClaudeCwd} from '../../../src/agents/claude-agent.js';
import type {JsonObject, JsonValue, SessionData} from '../../../src/types.js';

const roots: string[] = [];
let counter = 0;

/** A short, readable, obviously-synthetic id — never collides within one test run. */
export function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
}

export async function cleanupFixtures(): Promise<void> {
    await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
}

export interface LoadOptions {
    cwd?: string;
    sessionId?: string;
}

/**
 * Writes `records` as one Claude Code session file under a fresh temp `.claude`
 * home, then loads it back through the real `ClaudeAgent`. Every record is
 * stamped with `sessionId`/`cwd` unless it already sets its own (so a case that
 * wants to test a mid-session `cwd` change can override it per-line).
 */
export async function loadFixture(records: JsonObject[], options: LoadOptions = {}): Promise<SessionData> {
    const cwd = options.cwd ?? '/workspace/fixture-project';
    const sessionId = options.sessionId ?? nextId('session');
    const stamped = records.map((record) => ({sessionId, cwd, ...record}));

    const root = await mkdtemp(path.join(os.tmpdir(), 'claude-coverage-'));
    roots.push(root);
    const home = path.join(root, '.claude');
    const destination = path.join(home, 'projects', sanitizeClaudeCwd(cwd), `${sessionId}.jsonl`);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, `${stamped.map((record) => JSON.stringify(record)).join('\n')}\n`);

    return AgentRegistry.get('claude').loadSession(sessionId, home);
}

const BASE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/** The envelope fields every real Claude Code line carries, with sane fixture defaults. */
export function line(type: string, extra: Partial<JsonObject> = {}): JsonObject {
    return {
        type,
        timestamp: BASE_TIMESTAMP,
        uuid: nextId('uuid'),
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        entrypoint: 'cli',
        version: '2.1.260',
        gitBranch: 'main',
        ...extra,
    };
}

export function userLine(content: JsonValue, extra: Partial<JsonObject> = {}): JsonObject {
    return line('user', {message: {role: 'user', content}, ...extra});
}

export function assistantLine(content: JsonValue, model = 'claude-fixture-model', extra: Partial<JsonObject> = {}): JsonObject {
    return line('assistant', {message: {role: 'assistant', content, model}, ...extra});
}
