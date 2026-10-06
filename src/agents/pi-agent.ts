import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {ConversionService, JsonObject, TextMessage,} from '../types.js';
import {asObject, contentToText, stringValue} from '../json.js';
import {
    AbstractAgent,
    type AccumulatedSession,
    type AccumulatorOptions,
    type AgentConversionOptions,
    LatestTimestamp,
    type SessionAccumulator,
} from './abstract-agent.js';

export class PiAgent extends AbstractAgent {
    readonly provider = 'pi' as const;
    readonly label = 'Pi';
    readonly storageFormat = 'jsonl' as const;
    readonly sessionExtension = '.jsonl' as const;

    private readonly builder = new PiRecordBuilder();

    defaultHome(home = os.homedir()): string {
        return path.join(home, '.pi', 'agent');
    }

    createAccumulator(options: AccumulatorOptions): SessionAccumulator {
        return new PiAccumulator(options.collectMessages);
    }

    destinationPath(home: string, sessionId: string, cwd: string, timestamp: string): string {
        return path.join(home, 'sessions', encodePiCwd(cwd), `${piFilenameTimestamp(timestamp)}_${sessionId}.jsonl`);
    }

    createSessionId(sourceId: string, _timestamp: string, preserveIds: boolean): string {
        return preserveIds ? sourceId : randomUUID();
    }

    buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        return this.builder.build(sessionId, cwd, timestamp, messages);
    }

    buildServices(sessionId: string, options: AgentConversionOptions): ConversionService[] {
        const home = options.piDcpHome ?? defaultPiDcpHome();
        return [{
            destination: path.join(home, 'sessions', `${sessionId}.json`),
            content: {
                version: 1,
                sessionId,
                savedAt: 0,
                nextCompressionId: 1,
                turnIndex: 0,
                compressions: [],
                dedupedCallIds: [],
                purgedErrorCallIds: [],
                appliedCompressionTargets: [],
                erroredAt: [],
                stats: {
                    dedupPruned: 0,
                    errorInputsPurged: 0,
                    compressionsApplied: 0,
                    tokensSaved: 0,
                },
            },
        }];
    }

    protected sessionRoots(home: string): string[] {
        return [path.join(home, 'sessions')];
    }

    protected sessionIdFromPath(filePath: string): string {
        return path.basename(filePath, '.jsonl').split('_').at(-1) ?? path.basename(filePath);
    }

}

class PiAccumulator implements SessionAccumulator {
    private readonly latest = new LatestTimestamp();
    private readonly messages: TextMessage[] = [];
    private headerSeen = false;
    private headerId: string | undefined;
    private headerCwd: string | undefined;
    private headerTimestamp: string | undefined;
    private currentProvider: string | undefined;
    private currentModel: string | undefined;
    private fallbackTitle: string | undefined;
    private messageCount = 0;

    constructor(private readonly collectMessages: boolean) {
    }

    add(record: JsonObject): void {
        const timestamp = stringValue(record, 'timestamp');
        this.latest.offer(timestamp);

        if (!this.headerSeen && record.type === 'session') {
            this.headerSeen = true;
            this.headerId = stringValue(record, 'id');
            this.headerCwd = stringValue(record, 'cwd');
            this.headerTimestamp = timestamp;
        }
        if (record.type === 'model_change') {
            this.currentProvider = stringValue(record, 'provider') ?? this.currentProvider;
            this.currentModel = stringValue(record, 'modelId') ?? this.currentModel;
            return;
        }
        if (record.type === 'compaction') {
            this.messageCount += 1;
            const text = stringValue(record, 'summary');
            if (text) {
                this.consider({role: 'user', text, timestamp: timestamp ?? '', isCompaction: true});
            }
            return;
        }
        if (record.type !== 'message') return;
        this.messageCount += 1;
        const message = asObject(record.message);
        if (!message) return;
        const sourceRole = stringValue(message, 'role');
        if (!sourceRole || !['user', 'assistant', 'system'].includes(sourceRole)) return;
        const text = contentToText(message.content);
        if (!text) return;
        const model = stringValue(message, 'model') ?? this.currentModel;
        const provider = stringValue(message, 'provider') ?? this.currentProvider;
        const api = stringValue(message, 'api');
        this.consider({
            role: sourceRole === 'system' ? 'user' : sourceRole as TextMessage['role'],
            text,
            timestamp: timestamp ?? stringValue(message, 'timestamp') ?? '',
            ...(model !== undefined ? {model} : {}),
            ...(provider !== undefined ? {provider} : {}),
            ...(api !== undefined ? {api} : {}),
        });
    }

    finish(fallbackTimestamp: string): AccumulatedSession {
        return {
            ...(this.headerId !== undefined ? {sessionId: this.headerId} : {}),
            cwd: this.headerCwd ?? '',
            timestamp: this.headerTimestamp ?? fallbackTimestamp,
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

class PiRecordBuilder {
    build(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        const records: JsonObject[] = [{type: 'session', version: 3, id: sessionId, timestamp, cwd}];
        let parentId: string | null = null;
        let pendingInputTokens = 0;
        let counter = 0;
        const nextId = (): string => (++counter).toString(16).padStart(8, '0');

        for (const message of messages) {
            if (message.isContextual) continue;
            const id = nextId();
            if (message.isCompaction) {
                const firstKeptEntryId = nextId();
                records.push({
                    type: 'compaction',
                    id,
                    parentId,
                    timestamp: message.timestamp,
                    summary: message.text,
                    firstKeptEntryId,
                    tokensBefore: 0,
                    details: {},
                    fromHook: true,
                });
                parentId = id;
                continue;
            }
            const tokenCount = Math.max(1, Math.ceil(message.text.length / 4));
            const payload: JsonObject = {
                role: message.role,
                content: [{type: 'text', text: message.text}],
                timestamp: Date.parse(message.timestamp) || Date.now(),
            };
            if (message.role === 'assistant') {
                const output = tokenCount;
                payload.api = message.api ?? 'openai-completions';
                payload.provider = message.provider ?? 'session-import';
                payload.model = message.model ?? 'imported';
                payload.usage = {
                    input: pendingInputTokens,
                    output,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoning: 0,
                    totalTokens: pendingInputTokens + output,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
                };
                payload.stopReason = 'stop';
                pendingInputTokens = 0;
            } else {
                pendingInputTokens += tokenCount;
            }
            records.push({type: 'message', id, parentId, timestamp: message.timestamp, message: payload});
            parentId = id;
        }
        return records;
    }
}

export function encodePiCwd(cwd: string): string {
    const withoutPrefix = cwd.startsWith('\\\\?\\') ? cwd.slice(4) : cwd;
    return `--${withoutPrefix.replace(/^[/\\]+/, '').replace(/[/:\\]/g, '-')}--`;
}

function piFilenameTimestamp(timestamp: string): string {
    return timestamp.replace(/[:.]/g, '-');
}

function defaultPiDcpHome(home = os.homedir()): string {
    return path.join(home, '.pi-dcp');
}
