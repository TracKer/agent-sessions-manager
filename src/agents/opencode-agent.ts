import {randomInt} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {JsonObject, TextMessage} from '../types.js';
import {asArray, asObject, numberValue, stringValue} from '../json.js';
import {epochMsToIso, isoToEpochMs} from '../date-time.js';
import {titleFromMessages} from '../session-title.js';
import {
    AbstractAgent,
    type AccumulatedSession,
    type AccumulatorOptions,
    type SessionAccumulator,
} from './abstract-agent.js';

export class OpenCodeAgent extends AbstractAgent {
    readonly provider = 'opencode' as const;
    readonly label = 'OpenCode';
    readonly storageFormat = 'json' as const;
    readonly sessionExtension = '.json' as const;

    private readonly builder = new OpenCodeRecordBuilder();

    defaultHome(home = os.homedir()): string {
        if (process.env.OPENCODE_GLOBAL_DATA_DIR) return process.env.OPENCODE_GLOBAL_DATA_DIR;
        if (process.platform === 'win32') {
            return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode');
        }
        return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
    }

    createAccumulator(options: AccumulatorOptions): SessionAccumulator {
        return new OpenCodeAccumulator(options.collectMessages);
    }

    destinationPath(home: string, sessionId: string, _cwd: string, _timestamp: string): string {
        return path.join(home, 'session-export', `${sessionId}.json`);
    }

    createSessionId(sourceId: string, timestamp: string, preserveIds: boolean): string {
        return preserveIds && sourceId.startsWith('ses_') ? sourceId : openCodeId('ses', timestamp);
    }

    buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
        return [this.builder.build(sessionId, cwd, timestamp, messages)];
    }

    protected sessionRoots(home: string): string[] {
        return [path.join(home, 'session-export')];
    }

}

/** The whole export arrives as one record, so this accumulates from `info` and `messages` at once. */
class OpenCodeAccumulator implements SessionAccumulator {
    private readonly messages: TextMessage[] = [];
    private sessionId: string | undefined;
    private cwd: string | undefined;
    private created: string | undefined;
    private nativeTitle: string | undefined;
    private fallbackTitle: string | undefined;
    private messageCount = 0;

    constructor(private readonly collectMessages: boolean) {
    }

    add(record: JsonObject): void {
        const info = asObject(record.info);
        if (info) {
            this.sessionId = stringValue(info, 'id');
            this.cwd = stringValue(info, 'directory');
            this.nativeTitle = stringValue(info, 'title');
            const time = asObject(info.time);
            if (time && typeof time.created === 'number') this.created = new Date(time.created).toISOString();
        }

        const rawMessages = asArray(record.messages) ?? [];
        this.messageCount = rawMessages.length;
        for (const raw of rawMessages) {
            const message = asObject(raw);
            const messageInfo = message ? asObject(message.info) : undefined;
            if (!message || !messageInfo) continue;
            const role = stringValue(messageInfo, 'role');
            if (role !== 'user' && role !== 'assistant') continue;
            const text = (asArray(message.parts) ?? []).flatMap((part) => {
                const object = asObject(part);
                return object?.type === 'text' && typeof object.text === 'string' ? [object.text] : [];
            }).join('\n');
            const time = asObject(messageInfo.time);
            const createdAt = time ? numberValue(time, 'created') : undefined;
            const timestamp = createdAt === undefined ? '' : epochMsToIso(createdAt);
            if (messageInfo.summary === true && role === 'assistant' && text) {
                this.consider({role: 'user', text, timestamp, isCompaction: true});
                continue;
            }
            if (!text) continue;
            const modelObject = asObject(messageInfo.model);
            const model = stringValue(messageInfo, 'modelID')
                ?? (modelObject ? stringValue(modelObject, 'modelID') : undefined);
            const provider = stringValue(messageInfo, 'providerID')
                ?? (modelObject ? stringValue(modelObject, 'providerID') : undefined);
            this.consider({
                role,
                text,
                timestamp,
                ...(model !== undefined ? {model} : {}),
                ...(provider !== undefined ? {provider} : {}),
            });
        }
    }

    finish(fallbackTimestamp: string): AccumulatedSession {
        return {
            ...(this.sessionId !== undefined ? {sessionId: this.sessionId} : {}),
            cwd: this.cwd ?? '',
            timestamp: this.created ?? fallbackTimestamp,
            ...(this.nativeTitle !== undefined ? {nativeTitle: this.nativeTitle} : {}),
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

class OpenCodeRecordBuilder {
    build(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject {
        const title = titleFromMessages(messages) ?? 'Imported session';
        const created = isoToEpochMs(timestamp);
        const exported: JsonObject[] = [];
        let parentId = '';
        for (const [index, message] of messages.entries()) {
            if (message.isContextual) continue;
            const messageId = openCodeId('msg', message.timestamp);
            const time = isoToEpochMs(message.timestamp);
            if (message.isCompaction) {
                const compactId = openCodeId('msg', message.timestamp);
                const compactPartId = openCodeId('prt', message.timestamp);
                exported.push({
                    info: {
                        id: compactId,
                        sessionID: sessionId,
                        role: 'user',
                        time: {created: time},
                        agent: 'agent-sessions-manager',
                        model: {providerID: 'session-import', modelID: 'imported'},
                    },
                    parts: [{
                        id: compactPartId,
                        sessionID: sessionId,
                        messageID: compactId,
                        type: 'compaction',
                        auto: true,
                    }],
                });
                const summaryId = openCodeId('msg', message.timestamp);
                const summaryPartId = openCodeId('prt', message.timestamp);
                exported.push({
                    info: {
                        id: summaryId,
                        sessionID: sessionId,
                        role: 'assistant',
                        time: {created: time, completed: time},
                        parentID: compactId,
                        modelID: 'imported',
                        providerID: 'session-import',
                        mode: 'build',
                        agent: 'agent-sessions-manager',
                        path: {cwd, root: cwd},
                        cost: 0,
                        summary: true,
                        tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
                    },
                    parts: [{
                        id: summaryPartId,
                        sessionID: sessionId,
                        messageID: summaryId,
                        type: 'text',
                        text: message.text,
                        time: {start: time, end: time},
                    }],
                });
                parentId = summaryId;
                continue;
            }
            const provider = message.provider ?? 'session-import';
            const model = message.model ?? 'imported';
            const info: JsonObject = message.role === 'assistant'
                ? {
                    id: messageId,
                    sessionID: sessionId,
                    role: 'assistant',
                    time: {created: time, completed: time},
                    parentID: parentId || messageId,
                    modelID: model,
                    providerID: provider,
                    mode: 'build',
                    agent: 'agent-sessions-manager',
                    path: {cwd, root: cwd},
                    cost: 0,
                    tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
                }
                : {
                    id: messageId,
                    sessionID: sessionId,
                    role: 'user',
                    time: {created: time},
                    agent: 'agent-sessions-manager',
                    model: {providerID: provider, modelID: model},
                };
            exported.push({
                info,
                parts: [{
                    id: openCodeId('prt', message.timestamp),
                    sessionID: sessionId,
                    messageID: messageId,
                    type: 'text',
                    text: message.text,
                    time: {start: time, end: time},
                }],
            });
            if (message.role === 'user' || index === 0) parentId = messageId;
        }
        const updated = messages.length
            ? Math.max(...messages.map((message) => isoToEpochMs(message.timestamp)))
            : created;
        return {
            info: {
                id: sessionId,
                slug: openCodeSlug(title),
                projectID: 'global',
                directory: cwd,
                title,
                version: 'agent-sessions-manager',
                time: {created, updated},
            },
            messages: exported,
        };
    }
}

export function openCodeId(prefix: 'ses' | 'msg' | 'prt', timestamp: string): string {
    const mask = (1n << 48n) - 1n;
    let encoded = (BigInt(isoToEpochMs(timestamp)) * 0x1000n + 1n) & mask;
    if (prefix === 'ses') encoded = ~encoded & mask;
    const timePart = encoded.toString(16).padStart(12, '0');
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randomPart = '';
    for (let index = 0; index < 14; index += 1) randomPart += alphabet[randomInt(alphabet.length)];
    return `${prefix}_${timePart}${randomPart}`;
}

function openCodeSlug(text: string): string {
    const parts = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean);
    return parts.slice(0, 8).join('-') || 'imported-session';
}
