// The case registry for the Claude Code field-coverage report.
//
// `cases` are REAL: each `run()` writes a synthetic session through
// `loadFixture` and asserts on what the actual converter (src/agents/claude-agent.ts)
// did with it — ground truth from executing the code, never a guess about it.
// Status is declared up front (`covered` / `not-covered`) as a claim; `run()`
// is what proves the claim true today. If the converter's behavior ever changes,
// the matching case starts failing — that IS the "not maintained anymore" signal
// the report is for, same idea as any other regression test.
//
// `stubs` are an inventory, not proof: real Claude Code fields we have not written
// an assertion for yet (mostly the ~80 per-tool `toolUseResult` keys and the ~30
// `attachment.attachment` variants — see .vault/claude-session-format.md). They
// show up in the report as "pending decision", not red or green. Promote one to
// `cases` by writing a real fixture + assertion once we decide it matters.
import assert from 'node:assert/strict';
import {assistantLine, loadFixture, userLine} from './fixtures.js';

export type CaseStatus = 'covered' | 'not-covered';

export interface CoverageCase {
    recordType: string;
    title: string;
    status: CaseStatus;
    run: () => Promise<void>;
}

export interface StubGroup {
    group: string;
    note: string;
    items: string[];
}

export const cases: CoverageCase[] = [
    {
        recordType: 'user',
        title: 'a plain string prompt becomes a user message',
        status: 'covered',
        async run() {
            const session = await loadFixture([userLine('What does this code do?')]);
            assert.equal(session.messages.length, 1);
            assert.deepEqual([session.messages[0]?.role, session.messages[0]?.text], ['user', 'What does this code do?']);
        },
    },
    {
        recordType: 'assistant',
        title: 'a text content block becomes an assistant message',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('Hello'),
                assistantLine([{type: 'text', text: 'Hi there'}]),
            ]);
            assert.equal(session.messages.length, 2);
            assert.deepEqual([session.messages[1]?.role, session.messages[1]?.text], ['assistant', 'Hi there']);
        },
    },
    {
        recordType: 'assistant',
        title: 'message.model is captured',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                assistantLine([{type: 'text', text: 'Hi'}], 'claude-opus-5'),
            ]);
            assert.equal(session.messages[0]?.model, 'claude-opus-5');
        },
    },
    {
        recordType: 'assistant',
        title: 'a thinking block contributes no text — its reasoning is invisible to the converter',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                assistantLine([{type: 'thinking', thinking: 'reasoning privately about the answer', signature: 'sig'}]),
            ]);
            // the turn is still *counted*...
            assert.equal(session.messageCount, 1);
            // ...but no message text was extracted from it.
            assert.equal(session.messages.length, 0);
        },
    },
    {
        recordType: 'assistant',
        title: 'a tool_use block contributes no text',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                assistantLine([{type: 'tool_use', id: 'toolu_0001', name: 'Bash', input: {command: 'echo hi'}}]),
            ]);
            assert.equal(session.messageCount, 1);
            assert.equal(session.messages.length, 0);
        },
    },
    {
        recordType: 'user',
        title: 'a tool_result block contributes no text (its own `content` is a different field than `message.content`)',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                userLine([{type: 'tool_result', tool_use_id: 'toolu_0001', content: 'command output here'}]),
            ]);
            assert.equal(session.messageCount, 1);
            assert.equal(session.messages.length, 0);
        },
    },
    {
        recordType: 'user',
        title: 'an image content block contributes no text',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                userLine([{type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}}]),
            ]);
            assert.equal(session.messageCount, 1);
            assert.equal(session.messages.length, 0);
        },
    },
    {
        recordType: 'user',
        title: 'a toolUseResult sibling key is never inspected, even when message.content has no extractable text either',
        status: 'not-covered',
        async run() {
            const withEnvelope = await loadFixture([
                userLine(
                    [{type: 'tool_result', tool_use_id: 'toolu_0001', content: 'ok'}],
                    {toolUseResult: {stdout: 'ok\n', stderr: '', interrupted: false, isImage: false}},
                ),
            ]);
            const withoutEnvelope = await loadFixture([
                userLine([{type: 'tool_result', tool_use_id: 'toolu_0001', content: 'ok'}]),
            ]);
            assert.deepEqual(
                [withEnvelope.messageCount, withEnvelope.messages.length],
                [withoutEnvelope.messageCount, withoutEnvelope.messages.length],
            );
            assert.equal(withEnvelope.messages.length, 0);
        },
    },
    {
        recordType: 'custom-title',
        title: 'customTitle becomes the session\'s native title',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('hello'),
                {type: 'custom-title', customTitle: 'My Renamed Session'},
            ]);
            assert.equal(session.title, 'My Renamed Session');
        },
    },
    {
        recordType: 'ai-title',
        title: 'aiTitle becomes the native title when there is no custom-title',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('hello'),
                {type: 'ai-title', aiTitle: 'Auto-generated title'},
            ]);
            assert.equal(session.title, 'Auto-generated title');
        },
    },
    {
        recordType: 'custom-title',
        title: 'customTitle wins over aiTitle when both are present',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('hello'),
                {type: 'ai-title', aiTitle: 'Auto title'},
                {type: 'custom-title', customTitle: 'Manual title'},
            ]);
            assert.equal(session.title, 'Manual title');
        },
    },
    {
        recordType: 'system',
        title: 'a compact_boundary system line becomes a compaction message carrying its summary text',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('first message'),
                {type: 'system', subtype: 'compact_boundary', content: 'Summary of the earlier conversation', isMeta: false},
                assistantLine([{type: 'text', text: 'continuing from the summary'}]),
            ]);
            const compaction = session.messages.find((m) => m.isCompaction);
            assert.ok(compaction, 'expected a compaction message');
            assert.deepEqual([compaction?.role, compaction?.text], ['user', 'Summary of the earlier conversation']);
        },
    },
    {
        recordType: 'system',
        title: 'a non-compaction system line (e.g. an API error) has no effect beyond the common envelope',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                {type: 'system', timestamp: '2026-01-01T00:00:00.000Z', subtype: 'api_error', content: '529 Overloaded', error: {status: 529}},
            ]);
            assert.equal(session.messageCount, 0);
            assert.equal(session.messages.length, 0);
            // the common envelope IS read even here: `started` is set for any system/user/assistant
            // line, so the session's own timestamp reflects it rather than falling back to file mtime.
            assert.equal(session.timestamp, '2026-01-01T00:00:00.000Z');
        },
    },
    {
        recordType: 'user',
        title: 'isCompactSummary marks a line as a compaction message even without a system boundary line (round-trip fidelity)',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('normal first prompt'),
                {type: 'user', message: {role: 'user', content: 'Earlier summary text'}, isCompactSummary: true},
            ]);
            const compaction = session.messages.find((m) => m.isCompaction);
            assert.ok(compaction, 'expected a compaction message');
            assert.equal(compaction?.text, 'Earlier summary text');
        },
    },
    {
        recordType: 'assistant',
        title: 'isMeta is carried through onto the extracted message',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                assistantLine([{type: 'text', text: 'hi'}], 'claude-fixture-model', {isMeta: true}),
            ]);
            assert.equal(session.messages[0]?.isMeta, true);
        },
    },
    {
        recordType: 'assistant',
        title: 'identity/environment envelope fields (uuid, parentUuid, version, gitBranch, userType, entrypoint, requestId) carry no observable effect — SessionData has nowhere to put them',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                assistantLine([{type: 'text', text: 'hi'}], 'claude-fixture-model', {
                    uuid: '22222222-2222-2222-2222-222222222001',
                    parentUuid: '11111111-1111-1111-1111-111111111001',
                    version: '2.1.260',
                    gitBranch: 'feature/x',
                    userType: 'external',
                    entrypoint: 'cli',
                    requestId: 'req_0001',
                }),
            ]);
            assert.equal(session.messages[0]?.text, 'hi');
            assert.deepEqual(Object.keys(session).sort(), [
                'cwd', 'latestTimestamp', 'messageCount', 'messages', 'path', 'provider', 'sessionId', 'timestamp', 'title',
            ]);
        },
    },
    {
        recordType: 'assistant',
        title: 'latestTimestamp tracks the newest line, including lines of an otherwise-ignored type',
        status: 'covered',
        async run() {
            const session = await loadFixture([
                userLine('first', {timestamp: '2026-01-01T00:00:00.000Z'}),
                {type: 'mode', mode: 'normal', timestamp: '2026-06-01T00:00:00.000Z'},
                assistantLine([{type: 'text', text: 'later'}], 'claude-fixture-model', {timestamp: '2026-01-01T00:05:00.000Z'}),
            ]);
            assert.equal(session.latestTimestamp, '2026-06-01T00:00:00.000Z');
        },
    },
    {
        recordType: 'user',
        title: 'cwd is captured once, from the first record carrying a sessionId — a later mid-session cwd change is not picked up',
        status: 'not-covered',
        async run() {
            const session = await loadFixture([
                userLine('first', {cwd: '/workspace/first'}),
                assistantLine([{type: 'text', text: 'second'}], 'claude-fixture-model', {cwd: '/workspace/second'}),
            ], {cwd: '/workspace/first'});
            assert.equal(session.cwd, '/workspace/first');
        },
    },
];

const INERT_TYPES: Array<{type: string; extra: Record<string, unknown>}> = [
    {type: 'mode', extra: {mode: 'normal'}},
    {type: 'permission-mode', extra: {permissionMode: 'plan'}},
    {type: 'agent-name', extra: {agentName: 'general-purpose'}},
    {type: 'atis-latch', extra: {atis: ''}},
    {type: 'bridge-session', extra: {bridgeSessionId: 'cse_0001', ownerAccountUuid: 'acct-0001'}},
    {type: 'queue-operation', extra: {operation: 'enqueue', content: 'queued prompt text'}},
    {type: 'file-history-snapshot', extra: {isSnapshotUpdate: false, snapshot: {trackedFileBackups: {}}}},
    {type: 'file-history-delta', extra: {trackingPath: 'src/example.ts', backup: {version: 1}}},
    {type: 'cost-state', extra: {totalCostUSD: 1.23, modelUsage: {}}},
    {type: 'progress', extra: {data: {type: 'bash_progress', output: ''}}},
    {type: 'artifact-autoreact-ledger', extra: {v: 1, artifacts: {}}},
    {type: 'summary', extra: {leafUuid: '33333333-3333-3333-3333-333333333001', summary: 'A short branch title'}},
    {type: 'artifact-comment-monitor', extra: {v: 1, artifacts: {}}},
    {type: 'attachment', extra: {attachment: {type: 'hook_success', content: 'Session status updated.'}}},
    {type: 'pr-link', extra: {prNumber: 1, prUrl: 'https://example.invalid/pull/1', prRepository: 'octo/example'}},
];

for (const {type, extra} of INERT_TYPES) {
    cases.push({
        recordType: type,
        title: `a \`${type}\` line has no effect on the extracted session beyond the common envelope`,
        status: 'not-covered',
        async run() {
            const session = await loadFixture([{type, timestamp: '2026-01-01T00:00:00.000Z', ...extra}]);
            assert.equal(session.messageCount, 0);
            assert.equal(session.messages.length, 0);
        },
    });
}

export const stubs: StubGroup[] = [
    {
        group: 'toolUseResult — Bash',
        note: 'the whole `toolUseResult` key is proven ignored by the "toolUseResult sibling key is never inspected" case above; these are just the specific fields that would matter if that ever changes.',
        items: ['stdout', 'stderr', 'interrupted', 'isImage', 'noOutputExpected', 'backgroundTaskId', 'backgroundCwdHint', 'backgroundedByUser', 'assistantAutoBackgrounded', 'timedOutAfterMs', 'returnCodeInterpretation', 'gitOperation'],
    },
    {
        group: 'toolUseResult — Edit / Write',
        note: 'same umbrella proof as Bash above.',
        items: ['filePath', 'oldString', 'newString', 'originalFile', 'structuredPatch', 'userModified', 'replaceAll', 'staleRecovered', 'memdirStamped'],
    },
    {
        group: 'toolUseResult — Read',
        note: 'nested under `file`, per the upstream reference correction.',
        items: ['file.content', 'file.filePath', 'file.numLines', 'file.startLine', 'file.totalLines', 'file.truncatedByTokenCap'],
    },
    {
        group: 'toolUseResult — Grep / Glob',
        note: '',
        items: ['mode', 'filenames', 'numFiles', 'content', 'numLines', 'totalLines', 'totalFiles', 'truncated', 'totalMatches', 'countIsComplete'],
    },
    {
        group: 'toolUseResult — WebFetch / WebSearch',
        note: '',
        items: ['url', 'result', 'bytes', 'code', 'codeText', 'durationMs', 'query', 'results', 'searchCount', 'durationSeconds'],
    },
    {
        group: 'toolUseResult — AskUserQuestion',
        note: '',
        items: ['questions', 'answers', 'annotations'],
    },
    {
        group: 'toolUseResult — Agent',
        note: 'the richest envelope — see reference/tool-invocation.md if any of these end up worth reading.',
        items: ['status', 'agentId', 'agentType', 'prompt', 'resolvedModel', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'toolStats', 'isAsync', 'outputFile', 'canReadOutputFile'],
    },
    {
        group: 'toolUseResult — ToolSearch',
        note: '',
        items: ['query', 'matches', 'total_deferred_tools'],
    },
    {
        group: 'toolUseResult — Task tools',
        note: '',
        items: ['task', 'taskId', 'statusChange', 'updatedFields'],
    },
    {
        group: 'toolUseResult — spilled-output pointers',
        note: '',
        items: ['persistedOutputPath', 'persistedOutputSize'],
    },
    {
        group: 'attachment',
        note: 'one real case above already proves the whole `attachment` line type is inert; these are the ~30 known `attachment.type` values it carries, kept as an inventory in case that ever changes for one of them specifically.',
        items: ['hook_success', 'total_tokens_reminder', 'hook_additional_context', 'task_reminder', 'edited_text_file', 'skill_listing', 'environment', 'queued_command', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'prompt_snapshot', 'date', 'session_context', 'auto_mode', 'file', 'instructions', 'deferred_tools_record', 'model', 'command_permissions', 'compact_file_reference', 'remote_session_change', 'date_change', 'plan_mode_exit', 'silent_turn_reminder', 'plan_mode', 'invoked_skills', 'plan_file_reference', 'auto_mode_exit', 'thinking_stripped', 'hook_system_message', 'hook_cancelled'],
    },
];
