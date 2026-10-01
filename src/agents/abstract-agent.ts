import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversionService,
  JsonObject,
  NativeSession,
  Provider,
  SessionSummary,
  TextMessage,
} from '../types.js';
import { asObject } from '../json.js';
import { readJsonl, writeJson, writeJsonl } from '../jsonl.js';
import { formatNativeSessionTitle, titleFromMessages } from '../session-title.js';

export type AgentStorageFormat = 'json' | 'jsonl';

export interface AgentListOptions {
  fullName?: boolean;
}

export interface AgentConversionOptions {
  piDcpHome?: string;
}

type SessionMetadata = Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'>;

export abstract class AbstractAgent {
  abstract readonly provider: Provider;
  abstract readonly label: string;
  abstract readonly storageFormat: AgentStorageFormat;
  abstract readonly sessionExtension: '.json' | '.jsonl';

  abstract defaultHome(home?: string): string;
  protected abstract sessionRoots(home: string): string[];
  protected abstract metadataFor(
    records: JsonObject[],
    filePath: string,
    fallbackTimestamp: string,
  ): SessionMetadata;
  abstract extractMessages(session: NativeSession): TextMessage[];
  abstract countMessages(session: NativeSession): number;
  abstract destinationPath(home: string, sessionId: string, cwd: string, timestamp: string): string;
  abstract buildRecords(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[];

  protected nativeTitle(_session: NativeSession): string | undefined {
    return undefined;
  }

  protected summaryTimestamp(session: NativeSession): string {
    return session.timestamp;
  }

  protected normalizeRecords(records: JsonObject[]): JsonObject[] {
    return records;
  }

  createSessionId(sourceId: string, _timestamp: string, preserveIds: boolean): string {
    return preserveIds ? sourceId : randomUUID();
  }

  buildServices(_sessionId: string, _options: AgentConversionOptions): ConversionService[] {
    return [];
  }

  async readSession(filePath: string): Promise<NativeSession> {
    const { records, modified } = await this.readRecords(filePath);
    return {
      provider: this.provider,
      path: filePath,
      records,
      ...this.metadataFor(records, filePath, modified),
    };
  }

  async listSessions(
    home = this.defaultHome(),
    options: AgentListOptions = {},
  ): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const filePath of await this.sessionFiles(home)) {
      try {
        const session = await this.readSession(filePath);
        const title = formatNativeSessionTitle(this.nativeTitle(session))
          ?? titleFromMessages(this.extractMessages(session), options.fullName === true)
          ?? 'Untitled session';
        summaries.push({
          provider: this.provider,
          sessionId: session.sessionId,
          title,
          cwd: session.cwd,
          timestamp: this.summaryTimestamp(session),
          path: filePath,
          messageCount: this.countMessages(session),
        });
      } catch (error) {
        process.stderr.write(`warning: skipped unreadable session ${filePath}: ${String(error)}\n`);
      }
    }
    return summaries.sort(compareSessionTimestamp);
  }

  async loadSession(sessionId: string, home = this.defaultHome()): Promise<NativeSession> {
    for (const filePath of await this.sessionFiles(home)) {
      try {
        const candidate = await this.readSession(filePath);
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

  private async readRecords(filePath: string): Promise<{ records: JsonObject[]; modified: string }> {
    let records: JsonObject[];
    if (this.storageFormat === 'json') {
      const value = asObject(JSON.parse(await readFile(filePath, 'utf8')));
      if (!value) throw new TypeError(`${this.label} export must contain a JSON object: ${filePath}`);
      records = [value];
    } else {
      records = await readJsonl(filePath);
    }
    return {
      records: this.normalizeRecords(records),
      modified: (await stat(filePath)).mtime.toISOString(),
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
      entries = await readdir(directory, { withFileTypes: true });
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
