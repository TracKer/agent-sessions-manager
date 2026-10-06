import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {JsonObject, JsonValue, TextMessage} from '../types.js';
import {asObject, contentToText, stringValue} from '../json.js';
import {
    AbstractAgent,
    type AccumulatedSession,
    type AccumulatorOptions,
    LatestTimestamp,
    type SessionAccumulator,
} from './abstract-agent.js';

const claudeCommandTags = /<(local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

export class ClaudeAgent extends AbstractAgent {
    readonly provider = 'claude' as const;
    readonly label = 'Claude Code';
    readonly storageFormat = 'jsonl' as const;
    readonly sessionExtension = '.jsonl' as const;

    private readonly builder = new ClaudeRecordBuilder();

    defaultHome(home = os.homedir()): string {
        return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    }

    createAccumulator(options: AccumulatorOptions): SessionAccumulator {
        return new ClaudeAccumulator(options.collectMessages);
    }

    destinationPath(home: string, sessionId: string, cwd: string, _timestamp: string): string {
        return path.join(home, 'projects', sanitizeClaudeCwd(cwd), `${sessionId}.jsonl`);
    }

    createSessionId(sourceId: string, _timestamp: string, preserveIds: boolean): string {
        return preserveIds ? sourceId : randomUUID();
    }

    buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        return this.builder.build(sessionId, cwd, timestamp, messages);
    }

    protected sessionRoots(home: string): string[] {
        return [path.join(home, 'projects')];
    }
}

class ClaudeAccumulator implements SessionAccumulator {
    private readonly latest = new LatestTimestamp();
    private readonly messages: TextMessage[] = [];
    private sessionId: string | undefined;
    private cwd: string | undefined;
    private started: string | undefined;
    private customTitle: string | undefined;
    private aiTitle: string | undefined;
    private fallbackTitle: string | undefined;
    private messageCount = 0;

    constructor(private readonly collectMessages: boolean) {
    }

    add(record: JsonObject): void {
        const type = stringValue(record, 'type');
        const timestamp = stringValue(record, 'timestamp');
        this.latest.offer(timestamp);

        if (this.sessionId === undefined) {
            const sessionId = stringValue(record, 'sessionId');
            if (sessionId !== undefined) {
                this.sessionId = sessionId;
                this.cwd = stringValue(record, 'cwd') ?? '';
            }
        }
        if (this.started === undefined && timestamp
            && (type === 'user' || type === 'assistant' || type === 'system')) {
            this.started = timestamp;
        }
        if (type === 'custom-title') {
            const title = stringValue(record, 'customTitle');
            if (title?.trim()) this.customTitle = title;
            return;
        }
        if (type === 'ai-title') {
            const title = stringValue(record, 'aiTitle');
            if (title?.trim()) this.aiTitle = title;
            return;
        }

        const isBoundary = type === 'system' && stringValue(record, 'subtype') === 'compact_boundary';
        if (type === 'user' || type === 'assistant' || isBoundary) this.messageCount += 1;

        const meta = record.isMeta === true ? {isMeta: true} : {};
        if (isBoundary) {
            const summary = stringValue(record, 'content');
            if (summary) {
                this.consider({role: 'user', text: summary, timestamp: timestamp ?? '', isCompaction: true, ...meta});
            }
            return;
        }
        if (type !== 'user' && type !== 'assistant') return;
        const message = asObject(record.message);
        if (!message) return;
        const role = stringValue(message, 'role') ?? type;
        if (role !== 'user' && role !== 'assistant') return;
        const text = contentToText(message.content);
        if (!text) return;
        if (record.isCompactSummary === true) {
            this.consider({role: 'user', text, timestamp: timestamp ?? '', isCompaction: true, ...meta});
            return;
        }
        const model = stringValue(message, 'model');
        this.consider({role, text, timestamp: timestamp ?? '', ...(model ? {model} : {}), ...meta});
    }

    finish(_fallbackTimestamp: string): AccumulatedSession {
        const nativeTitle = this.customTitle ?? this.aiTitle;
        return {
            ...(this.sessionId !== undefined ? {sessionId: this.sessionId} : {}),
            cwd: this.cwd ?? '',
            // Claude sessions keep an empty timestamp rather than borrowing the file's mtime.
            timestamp: this.started ?? '',
            ...(this.latest.latest !== undefined ? {latestTimestamp: this.latest.latest} : {}),
            ...(nativeTitle !== undefined ? {nativeTitle} : {}),
            ...(this.fallbackTitle !== undefined ? {fallbackTitle: this.fallbackTitle} : {}),
            messageCount: this.messageCount,
            messages: this.messages,
        };
    }

    private consider(message: TextMessage): void {
        if (this.collectMessages) this.messages.push(message);
        if (this.fallbackTitle === undefined && message.role === 'user') {
            const text = message.text.replace(claudeCommandTags, '').trim();
            if (text) this.fallbackTitle = text;
        }
    }
}

class ClaudeRecordBuilder {
    build(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        const records: JsonObject[] = [];
        let parentUuid: string | null = null;
        for (const message of messages) {
            if (message.isContextual) continue;
            if (message.isCompaction) {
                const boundaryUuid = randomUUID();
                records.push({
                    type: 'system',
                    subtype: 'compact_boundary',
                    content: 'Conversation compacted',
                    isMeta: false,
                    timestamp: message.timestamp,
                    uuid: boundaryUuid,
                    parentUuid: null,
                    logicalParentUuid: parentUuid,
                    level: 'info',
                    compactMetadata: {trigger: 'manual', preTokens: 0},
                    isSidechain: false,
                    userType: 'external',
                    entrypoint: 'cli',
                    cwd,
                    sessionId,
                    version: 'agent-sessions-manager',
                });
                parentUuid = boundaryUuid;
            }
            const uuid = randomUUID();
            const content: JsonValue = message.role === 'assistant'
                ? [{type: 'text', text: message.text}]
                : message.text;
            const messageData: JsonObject = message.role === 'assistant'
                ? {
                    role: 'assistant',
                    content,
                    model: message.model ?? 'imported',
                    usage: {input_tokens: 0, output_tokens: 0},
                    stop_reason: 'end_turn',
                }
                : {role: 'user', content};
            records.push({
                type: message.role,
                message: messageData,
                uuid,
                parentUuid: message.isCompaction ? null : parentUuid,
                ...(message.isCompaction ? {isCompactSummary: true} : {}),
                isSidechain: false,
                userType: 'external',
                entrypoint: 'cli',
                cwd,
                sessionId,
                timestamp: message.isCompaction ? timestamp : message.timestamp,
                version: 'agent-sessions-manager',
            });
            parentUuid = uuid;
        }
        return records;
    }
}

export function sanitizeClaudeCwd(cwd: string): string {
    return cwd.replace(/^\\\\\?\\/, '').replace(/[^a-zA-Z0-9]/g, '-');
}
