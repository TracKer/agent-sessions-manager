import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {JsonObject, MessageRole, TextMessage} from '../types.js';
import {asArray, asObject, contentToText, stringValue} from '../json.js';
import {
    AbstractAgent,
    type AccumulatedSession,
    type AccumulatorOptions,
    LatestTimestamp,
    type SessionAccumulator,
} from './abstract-agent.js';

const contextualMarkers = [
    '# AGENTS.md instructions for ',
    '<environment_context>',
    '<permissions instructions>',
    '<apps_instructions>',
    '<skills_instructions>',
    '<collaboration_mode>',
    '<personality_spec>',
    '<token_budget>',
    '<model_switch>',
    '<realtime_conversation>',
    '<user_shell_command>',
    '<turn_aborted>',
    '<subagent_notification>',
    '<codex_internal_context',
    '<goal_context>',
    '<external_',
    '<hook_prompt',
    'Warning: The maximum number of unified exec processes',
    'Warning: apply_patch was requested via',
    'Warning: Your account was flagged for potentially high-risk cyber activity',
    'Approved command prefix saved:',
    'Use prior reviews as context, not binding precedent',
    'Generated images are saved to',
    'Allowed network rule saved in execpolicy',
    'Denied network rule saved in execpolicy',
];

export class CodexAgent extends AbstractAgent {
    readonly provider = 'codex' as const;
    readonly label = 'OpenAI Codex';
    readonly storageFormat = 'jsonl' as const;
    readonly sessionExtension = '.jsonl' as const;

    private readonly builder = new CodexRecordBuilder();

    defaultHome(home = os.homedir()): string {
        return path.join(home, '.codex');
    }

    createAccumulator(options: AccumulatorOptions): SessionAccumulator {
        return new CodexAccumulator(options.collectMessages);
    }

    destinationPath(home: string, sessionId: string, _cwd: string, timestamp: string): string {
        const [year, month, day] = dateParts(timestamp);
        return path.join(
            home,
            'sessions',
            year,
            month,
            day,
            `rollout-${timestamp.replace(/[:.]/g, '-').replace(/Z$/, '')}-${sessionId}.jsonl`,
        );
    }

    createSessionId(sourceId: string, _timestamp: string, preserveIds: boolean): string {
        return preserveIds && isUuid(sourceId) ? sourceId : randomUUID();
    }

    buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        return this.builder.build(sessionId, cwd, timestamp, messages);
    }

    protected sessionRoots(home: string): string[] {
        return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
    }

    protected sessionIdFromPath(filePath: string): string {
        return path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1]
            ?? path.basename(filePath, '.jsonl');
    }
}

class CodexAccumulator implements SessionAccumulator {
    private readonly latest = new LatestTimestamp();
    private readonly messages: TextMessage[] = [];
    private metaSeen = false;
    private metaId: string | undefined;
    private metaCwd: string | undefined;
    private metaPayloadTimestamp: string | undefined;
    private metaRecordTimestamp: string | undefined;
    private firstId: string | undefined;
    private firstCwd: string | undefined;
    private firstTimestamp: string | undefined;
    private seenFirst = false;
    private fallbackTitle: string | undefined;
    private messageCount = 0;

    constructor(private readonly collectMessages: boolean) {
    }

    add(raw: JsonObject): void {
        const record = normalizeCodexRecord(raw);
        const timestamp = stringValue(record, 'timestamp');
        this.latest.offer(timestamp);

        if (!this.seenFirst) {
            this.seenFirst = true;
            this.firstId = stringValue(record, 'id');
            this.firstCwd = stringValue(record, 'cwd');
            this.firstTimestamp = timestamp;
        }
        if (!this.metaSeen && record.type === 'session_meta') {
            this.metaSeen = true;
            const payload = asObject(record.payload);
            this.metaId = payload ? stringValue(payload, 'id') : undefined;
            this.metaCwd = payload ? stringValue(payload, 'cwd') : undefined;
            this.metaPayloadTimestamp = payload ? stringValue(payload, 'timestamp') : undefined;
            this.metaRecordTimestamp = timestamp;
        }

        if (record.type === 'compacted') {
            this.messageCount += 1;
            const payload = asObject(record.payload);
            const summary = payload ? stringValue(payload, 'message') : undefined;
            if (summary) {
                this.consider({role: 'user', text: summary, timestamp: timestamp ?? '', isCompaction: true});
            }
            for (const item of (payload ? asArray(payload.replacement_history) : undefined) ?? []) {
                const object = asObject(item);
                if (object?.type !== 'message') continue;
                const message = codexMessage(object, timestamp ?? '');
                if (message) this.consider(message);
            }
            return;
        }
        const payload = asObject(record.payload);
        if (payload?.type !== 'message') return;
        this.messageCount += 1;
        const message = codexMessage(payload, timestamp ?? '');
        if (message) this.consider(message);
    }

    finish(fallbackTimestamp: string): AccumulatedSession {
        const sessionId = this.metaId ?? this.firstId;
        return {
            ...(sessionId !== undefined ? {sessionId} : {}),
            cwd: this.metaCwd ?? this.firstCwd ?? '',
            timestamp: this.metaPayloadTimestamp
                ?? this.metaRecordTimestamp
                ?? this.firstTimestamp
                ?? fallbackTimestamp,
            ...(this.latest.latest !== undefined ? {latestTimestamp: this.latest.latest} : {}),
            ...(this.fallbackTitle !== undefined ? {fallbackTitle: this.fallbackTitle} : {}),
            messageCount: this.messageCount,
            messages: this.messages,
        };
    }

    private consider(message: TextMessage): void {
        if (this.collectMessages) this.messages.push(message);
        if (this.fallbackTitle === undefined && message.role === 'user' && message.text.trim()) {
            this.fallbackTitle = message.text;
        }
    }
}

/** Rewrites pre-`response_item` message records into the current payload shape. */
function normalizeCodexRecord(record: JsonObject): JsonObject {
    if (record.type !== 'message' || asObject(record.payload)) return record;
    return {
        timestamp: stringValue(record, 'timestamp') ?? '',
        type: 'response_item',
        payload: {
            type: 'message',
            role: stringValue(record, 'role') ?? 'user',
            content: record.content ?? [],
        },
    };
}

function codexMessage(payload: JsonObject, timestamp: string): TextMessage | undefined {
    const role = stringValue(payload, 'role');
    if (!role || !['user', 'assistant', 'system', 'developer'].includes(role)) return undefined;
    const text = contentToText(payload.content);
    if (!text) return undefined;
    return {
        role: role === 'system' || role === 'developer' ? 'user' : role as MessageRole,
        text,
        timestamp,
        ...(isContextual(text) ? {isContextual: true} : {}),
    };
}

class CodexRecordBuilder {
    build(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        const records: JsonObject[] = [{
            timestamp,
            type: 'session_meta',
            payload: {
                id: sessionId,
                timestamp,
                cwd,
                originator: 'agent-sessions-manager',
                cli_version: 'agent-sessions-manager',
                source: 'cli',
                model_provider: 'session-import',
            },
        }];
        for (const message of messages) {
            if (message.isContextual) continue;
            if (message.isCompaction) {
                records.push({timestamp: message.timestamp, type: 'compacted', payload: {message: message.text}});
            } else {
                records.push({
                    timestamp: message.timestamp,
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: message.role,
                        content: [{
                            type: message.role === 'assistant' ? 'output_text' : 'input_text',
                            text: message.text
                        }],
                    },
                });
            }
        }
        return records;
    }
}

function dateParts(timestamp: string): [string, string, string] {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
    if (!match?.[1] || !match[2] || !match[3]) {
        throw new Error(`Invalid ISO timestamp for Codex session path: ${timestamp}`);
    }
    return [match[1], match[2], match[3]];
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isContextual(text: string): boolean {
    const head = text.slice(0, 120);
    return contextualMarkers.some((marker) => head.includes(marker));
}
