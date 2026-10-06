import {randomUUID} from 'node:crypto';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import type {ConversionService, JsonObject, Provider, SessionData, SessionSummary, TextMessage,} from '../types.js';
import {requiredObject} from '../json.js';
import {forEachJsonlRecord, writeJson, writeJsonl} from '../jsonl.js';
import {formatNativeSessionTitle, formatSessionTitle} from '../session-title.js';

export type AgentStorageFormat = 'json' | 'jsonl';

export interface AgentConversionOptions {
    piDcpHome?: string;
}

export interface AccumulatorOptions {
    /** Retain extracted messages; conversion needs them, listing does not. */
    collectMessages: boolean;
}

export interface AccumulatedSession {
    sessionId?: string;
    cwd?: string;
    timestamp?: string;
    latestTimestamp?: string;
    nativeTitle?: string;
    fallbackTitle?: string;
    messageCount: number;
    messages: TextMessage[];
}

/**
 * Consumes a session's records one at a time. For `jsonl` stores that is one record per line;
 * for `json` stores the whole export arrives as a single record.
 */
export interface SessionAccumulator {
    add(record: JsonObject): void;
    finish(fallbackTimestamp: string): AccumulatedSession;
}

export abstract class AbstractAgent {
    abstract readonly provider: Provider;
    abstract readonly label: string;
    abstract readonly storageFormat: AgentStorageFormat;
    abstract readonly sessionExtension: '.json' | '.jsonl';

    abstract defaultHome(home?: string): string;

    abstract createAccumulator(options: AccumulatorOptions): SessionAccumulator;

    abstract destinationPath(home: string, sessionId: string, cwd: string, timestamp: string): string;

    abstract buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[];

    createSessionId(sourceId: string, _timestamp: string, preserveIds: boolean): string {
        return preserveIds ? sourceId : randomUUID();
    }

    buildServices(_sessionId: string, _options: AgentConversionOptions): ConversionService[] {
        return [];
    }

    async listSessions(home = this.defaultHome()): Promise<SessionSummary[]> {
        const summaries: SessionSummary[] = [];
        for (const filePath of await this.sessionFiles(home)) {
            try {
                const session = await this.scan(filePath, false);
                summaries.push({
                    provider: session.provider,
                    sessionId: session.sessionId,
                    title: session.title,
                    cwd: session.cwd,
                    timestamp: session.latestTimestamp,
                    path: session.path,
                    messageCount: session.messageCount,
                });
            } catch (error) {
                process.stderr.write(`warning: skipped unreadable session ${filePath}: ${String(error)}\n`);
            }
        }
        return summaries.sort(compareSessionTimestamp);
    }

    async loadSession(sessionId: string, home = this.defaultHome()): Promise<SessionData> {
        const files = await this.sessionFiles(home);
        const named = new Set(files.filter((filePath) => this.sessionIdFromPath(filePath) === sessionId));
        const ordered = named.size
            ? [...named, ...files.filter((filePath) => !named.has(filePath))]
            : files;
        for (const filePath of ordered) {
            try {
                const candidate = await this.scan(filePath, true);
                if (candidate.sessionId === sessionId) return candidate;
            } catch (error) {
                process.stderr.write(`warning: skipped unreadable session ${filePath}: ${String(error)}\n`);
            }
        }
        const root = this.sessionRoots(home)[0] ?? home;
        throw new Error(`Session not found: ${this.provider}/${sessionId} (searched ${root})`);
    }

    async writeSession(filePath: string, records: JsonObject[], overwrite = false): Promise<void> {
        if (this.storageFormat === 'json') {
            const exportObject = records[0];
            if (!exportObject) throw new Error(`${this.provider} conversion produced no export record`);
            await writeJson(filePath, exportObject, overwrite);
            return;
        }
        await writeJsonl(filePath, records, overwrite);
    }

    protected abstract sessionRoots(home: string): string[];

    /** Session id a file name implies, used only to try likely files first; records stay authoritative. */
    protected sessionIdFromPath(filePath: string): string {
        return path.basename(filePath, this.sessionExtension);
    }

    private async scan(filePath: string, collectMessages: boolean): Promise<SessionData> {
        const accumulator = this.createAccumulator({collectMessages});
        if (this.storageFormat === 'json') {
            const content = await readFile(filePath, 'utf8');
            accumulator.add(requiredObject(JSON.parse(content), `${this.label} export`));
        } else {
            await forEachJsonlRecord(filePath, (record) => accumulator.add(record));
        }
        const modified = (await stat(filePath)).mtime.toISOString();
        const scanned = accumulator.finish(modified);

        const timestamp = scanned.timestamp ?? modified;
        // A record without its own timestamp inherits the session's, which is only known now.
        for (const message of scanned.messages) {
            if (!message.timestamp) message.timestamp = timestamp;
        }
        return {
            provider: this.provider,
            path: filePath,
            sessionId: scanned.sessionId ?? this.sessionIdFromPath(filePath),
            cwd: scanned.cwd ?? '',
            timestamp,
            latestTimestamp: scanned.latestTimestamp ?? timestamp,
            title: formatNativeSessionTitle(scanned.nativeTitle)
                ?? formatSessionTitle(scanned.fallbackTitle)
                ?? 'Untitled session',
            messageCount: scanned.messageCount,
            messages: scanned.messages,
        };
    }

    private async sessionFiles(home: string): Promise<string[]> {
        const files: string[] = [];
        for (const root of this.sessionRoots(home)) {
            files.push(...await this.walk(root));
        }
        return [...new Set(files)].sort();
    }

    private async walk(directory: string): Promise<string[]> {
        let entries;
        try {
            entries = await readdir(directory, {withFileTypes: true});
        } catch (error) {
            if (isMissing(error)) return [];
            throw error;
        }
        const files: string[] = [];
        for (const entry of entries) {
            if (entry.name === 'subagents' || entry.name === 'tool-results') continue;
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) files.push(...await this.walk(filePath));
            else if (entry.isFile() && entry.name.endsWith(this.sessionExtension)) files.push(filePath);
        }
        return files;
    }
}

/** Tracks the newest timestamp seen while scanning records. */
export class LatestTimestamp {
    private value: string | undefined;
    private instant = Number.NEGATIVE_INFINITY;

    offer(timestamp: string | undefined): void {
        if (!timestamp) return;
        const instant = Date.parse(timestamp);
        if (Number.isFinite(instant) && instant >= this.instant) {
            this.value = timestamp;
            this.instant = instant;
        }
    }

    get latest(): string | undefined {
        return this.value;
    }
}

function compareSessionTimestamp(left: SessionSummary, right: SessionSummary): number {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid) return rightTime - leftTime || left.sessionId.localeCompare(right.sessionId);
    if (leftValid) return -1;
    if (rightValid) return 1;
    return left.sessionId.localeCompare(right.sessionId);
}

function isMissing(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
