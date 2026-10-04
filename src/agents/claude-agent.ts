import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {JsonObject, JsonValue, NativeSession, TextMessage} from '../types.js';
import {asObject, contentToText, stringValue} from '../json.js';
import {formatNativeSessionTitle, formatSessionTitle} from '../session-title.js';
import {AbstractAgent, type AgentListOptions} from './abstract-agent.js';

const claudeCommandTags = /<(local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

export class ClaudeAgent extends AbstractAgent {
    readonly provider = 'claude' as const;
    readonly label = 'Claude Code';
    readonly storageFormat = 'jsonl' as const;
    readonly sessionExtension = '.jsonl' as const;

    private readonly extractor = new ClaudeMessageExtractor();
    private readonly builder = new ClaudeRecordBuilder();

    defaultHome(home = os.homedir()): string {
        return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    }

    getSessionTitle(session: NativeSession, options: AgentListOptions = {}): string {
        const nativeTitle = formatNativeSessionTitle(this.nativeTitle(session));
        if (nativeTitle) return nativeTitle;

        for (const message of this.iterateMessages(session)) {
            if (message.role !== 'user') continue;
            const title = formatSessionTitle(
                message.text.replace(claudeCommandTags, '').trim(),
                options.fullName === true,
            );
            if (title) return title;
        }
        return 'Untitled session';
    }

    extractMessages(session: NativeSession): TextMessage[] {
        return [...this.iterateMessages(session)];
    }

    protected iterateMessages(session: NativeSession): Iterable<TextMessage> {
        return this.extractor.iterate(session);
    }

    countMessages(session: NativeSession): number {
        return session.records.filter((record) => {
            const type = stringValue(record, 'type');
            return type === 'user'
                || type === 'assistant'
                || (type === 'system' && stringValue(record, 'subtype') === 'compact_boundary');
        }).length;
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

    protected metadataFor(
        records: JsonObject[],
        filePath: string,
        _fallbackTimestamp: string,
    ): Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'> {
        const header = records.find((record) => stringValue(record, 'sessionId') !== undefined);
        const timestampRecord = records.find((record) => {
            const type = stringValue(record, 'type');
            return (type === 'user' || type === 'assistant' || type === 'system')
                && Boolean(stringValue(record, 'timestamp'));
        });
        return {
            sessionId: (header ? stringValue(header, 'sessionId') : undefined) ?? path.basename(filePath, '.jsonl'),
            cwd: (header ? stringValue(header, 'cwd') : undefined) ?? '',
            timestamp: (timestampRecord ? stringValue(timestampRecord, 'timestamp') : undefined) ?? '',
        };
    }

    protected nativeTitle(session: NativeSession): string | undefined {
        for (let index = session.records.length - 1; index >= 0; index -= 1) {
            const record = session.records[index];
            if (record?.type !== 'custom-title') continue;
            const title = stringValue(record, 'customTitle');
            if (title?.trim()) return title;
        }
        return undefined;
    }

    protected summaryTimestamp(session: NativeSession): string {
        let latestValue: string | undefined;
        let latestInstant = Number.NEGATIVE_INFINITY;
        for (const record of session.records) {
            const value = stringValue(record, 'timestamp');
            if (!value) continue;
            const instant = Date.parse(value);
            if (Number.isFinite(instant) && instant >= latestInstant) {
                latestValue = value;
                latestInstant = instant;
            }
        }
        return latestValue ?? session.timestamp;
    }
}

class ClaudeMessageExtractor {
    *iterate(session: NativeSession): Generator<TextMessage> {
        for (const record of session.records) {
            const type = stringValue(record, 'type');
            const timestamp = stringValue(record, 'timestamp') ?? session.timestamp;
            const meta = record.isMeta === true ? {isMeta: true} : {};
            if (type === 'system' && record.subtype === 'compact_boundary') {
                const summary = stringValue(record, 'content');
                if (summary) yield {role: 'user', text: summary, timestamp, isCompaction: true, ...meta};
                continue;
            }
            if (type !== 'user' && type !== 'assistant') continue;
            const message = asObject(record.message);
            if (!message) continue;
            const role = stringValue(message, 'role') ?? type;
            if (role !== 'user' && role !== 'assistant') continue;
            const text = contentToText(message.content);
            if (!text) continue;
            if (record.isCompactSummary === true) {
                yield {role: 'user', text, timestamp, isCompaction: true, ...meta};
            } else {
                const model = stringValue(message, 'model');
                yield {role, text, timestamp, ...(model ? {model} : {}), ...meta};
            }
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
