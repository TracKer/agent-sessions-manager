import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {ConversionService, JsonObject, NativeSession, TextMessage,} from '../types.js';
import {asObject, contentToText, stringValue} from '../json.js';
import {AbstractAgent, type AgentConversionOptions} from './abstract-agent.js';

export class PiAgent extends AbstractAgent {
    readonly provider = 'pi' as const;
    readonly label = 'Pi';
    readonly storageFormat = 'jsonl' as const;
    readonly sessionExtension = '.jsonl' as const;

    private readonly extractor = new PiMessageExtractor();
    private readonly builder = new PiRecordBuilder();

    defaultHome(home = os.homedir()): string {
        return path.join(home, '.pi', 'agent');
    }

    extractMessages(session: NativeSession): TextMessage[] {
        return [...this.iterateMessages(session)];
    }

    protected iterateMessages(session: NativeSession): Iterable<TextMessage> {
        return this.extractor.iterate(session);
    }

    countMessages(session: NativeSession): number {
        return session.records.filter((record) => record.type === 'message' || record.type === 'compaction').length;
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

    protected metadataFor(
        records: JsonObject[],
        filePath: string,
        fallbackTimestamp: string,
    ): Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'> {
        const header = records.find((record) => record.type === 'session');
        return {
            sessionId: (header ? stringValue(header, 'id') : undefined)
                ?? path.basename(filePath, '.jsonl').split('_').at(-1)
                ?? path.basename(filePath),
            cwd: (header ? stringValue(header, 'cwd') : undefined) ?? '',
            timestamp: (header ? stringValue(header, 'timestamp') : undefined) ?? fallbackTimestamp,
        };
    }
}

class PiMessageExtractor {
    *iterate(session: NativeSession): Generator<TextMessage> {
        let currentProvider: string | undefined;
        let currentModel: string | undefined;
        for (const record of session.records) {
            if (record.type === 'model_change') {
                currentProvider = stringValue(record, 'provider') ?? currentProvider;
                currentModel = stringValue(record, 'modelId') ?? currentModel;
                continue;
            }
            if (record.type === 'compaction') {
                const text = stringValue(record, 'summary');
                if (text) yield {
                    role: 'user',
                    text,
                    timestamp: stringValue(record, 'timestamp') ?? session.timestamp,
                    isCompaction: true,
                };
                continue;
            }
            if (record.type !== 'message') continue;
            const message = asObject(record.message);
            if (!message) continue;
            const sourceRole = stringValue(message, 'role');
            if (!sourceRole || !['user', 'assistant', 'system'].includes(sourceRole)) continue;
            const text = contentToText(message.content);
            if (!text) continue;
            const model = stringValue(message, 'model') ?? currentModel;
            const provider = stringValue(message, 'provider') ?? currentProvider;
            const api = stringValue(message, 'api');
            yield {
                role: sourceRole === 'system' ? 'user' : sourceRole as TextMessage['role'],
                text,
                timestamp: stringValue(record, 'timestamp') ?? stringValue(message, 'timestamp') ?? session.timestamp,
                ...(model !== undefined ? {model} : {}),
                ...(provider !== undefined ? {provider} : {}),
                ...(api !== undefined ? {api} : {}),
            };
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
