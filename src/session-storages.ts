import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject, NativeSession, Provider, SessionSummary } from './types.js';
import { asArray, asObject, stringValue } from './json.js';
import { MessageExtractor } from './extractors.js';
import { readJsonl } from './jsonl.js';
import { defaultHome, sessionRoot } from './paths.js';
import { formatNativeSessionTitle, titleFromMessages } from './session-title.js';

const extractor = new MessageExtractor();

export async function listSessions(
  provider: Provider,
  home = defaultHome(provider),
  options: { fullName?: boolean } = {},
): Promise<SessionSummary[]> {
  const files = await sessionFiles(provider, home);
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    try {
      const session = await readSession(provider, file);
      summaries.push({
        provider,
        sessionId: session.sessionId,
        title: sessionTitle(session, options.fullName === true),
        cwd: session.cwd,
        timestamp: provider === 'claude'
          ? latestRecordTimestamp(session.records) ?? session.timestamp
          : session.timestamp,
        path: file,
        messageCount: countMessages(session),
      });
    } catch (error) {
      process.stderr.write(`warning: skipped unreadable session ${file}: ${String(error)}\n`);
    }
  }
  return summaries.sort(compareSessionTimestamp);
}

export async function loadSession(
  provider: Provider,
  sessionId: string,
  home = defaultHome(provider),
): Promise<NativeSession> {
  const files = await sessionFiles(provider, home);
  for (const file of files) {
    try {
      const candidate = await readSession(provider, file);
      if (candidate.sessionId === sessionId) return candidate;
    } catch (error) {
      process.stderr.write(`warning: skipped unreadable session ${file}: ${String(error)}\n`);
    }
  }
  throw new Error(`Session not found: ${provider}/${sessionId} (searched ${sessionRoot(provider, home)})`);
}

export async function readSession(provider: Provider, filePath: string): Promise<NativeSession> {
  let records = provider === 'opencode'
    ? [asObject(JSON.parse(await readFile(filePath, 'utf8'))) ?? failObject(filePath)]
    : await readJsonl(filePath);
  if (provider === 'codex') records = normalizeCodexRecords(records);
  const modified = (await stat(filePath)).mtime.toISOString();
  const metadata = metadataFor(provider, records, filePath, modified);
  return { provider, path: filePath, records, ...metadata };
}

async function sessionFiles(provider: Provider, home: string): Promise<string[]> {
  const root = sessionRoot(provider, home);
  const roots = provider === 'codex'
    ? [root, path.join(home, 'archived_sessions')]
    : [root];
  const files: string[] = [];
  for (const directory of roots) {
    files.push(...await walk(directory, provider === 'opencode' ? '.json' : '.jsonl'));
  }
  return [...new Set(files)].sort();
}

async function walk(directory: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'subagents' || entry.name === 'tool-results') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) output.push(fullPath);
  }
  return output;
}

function metadataFor(
  provider: Provider,
  records: JsonObject[],
  filePath: string,
  fallbackTimestamp: string,
): Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'> {
  const basename = path.basename(filePath);
  if (provider === 'opencode') {
    const info = asObject(records[0]?.info);
    const time = info ? asObject(info.time) : undefined;
    const created = time && typeof time.created === 'number' ? new Date(time.created).toISOString() : fallbackTimestamp;
    return {
      sessionId: (info ? stringValue(info, 'id') : undefined) ?? path.basename(filePath, '.json'),
      cwd: (info ? stringValue(info, 'directory') : undefined) ?? '',
      timestamp: created,
    };
  }
  if (provider === 'codex') {
    const meta = records.find((record) => record.type === 'session_meta');
    const payload = meta ? asObject(meta.payload) : undefined;
    const firstRecord = records[0];
    const timestamp = (payload ? stringValue(payload, 'timestamp') : undefined)
      ?? (meta ? stringValue(meta, 'timestamp') : undefined)
      ?? (firstRecord ? stringValue(firstRecord, 'timestamp') : undefined)
      ?? fallbackTimestamp;
    const fallbackId = basename.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1]
      ?? path.basename(filePath, '.jsonl');
    return {
      sessionId: (payload ? stringValue(payload, 'id') : undefined)
        ?? (firstRecord ? stringValue(firstRecord, 'id') : undefined)
        ?? fallbackId,
      cwd: (payload ? stringValue(payload, 'cwd') : undefined)
        ?? (firstRecord ? stringValue(firstRecord, 'cwd') : undefined)
        ?? '',
      timestamp,
    };
  }
  if (provider === 'pi') {
    const header = records.find((record) => record.type === 'session');
    return {
      sessionId: (header ? stringValue(header, 'id') : undefined) ?? path.basename(filePath, '.jsonl').split('_').at(-1) ?? basename,
      cwd: (header ? stringValue(header, 'cwd') : undefined) ?? '',
      timestamp: (header ? stringValue(header, 'timestamp') : undefined) ?? fallbackTimestamp,
    };
  }
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

function failObject(filePath: string): never {
  throw new TypeError(`OpenCode export must contain a JSON object: ${filePath}`);
}

function normalizeCodexRecords(records: JsonObject[]): JsonObject[] {
  const hasLegacyMessages = records.some((record) => record.type === 'message' && !asObject(record.payload));
  if (!hasLegacyMessages) return records;
  const normalized: JsonObject[] = [];
  for (const record of records) {
    if (record.type !== 'message' || asObject(record.payload)) {
      normalized.push(record);
      continue;
    }
    const payload: JsonObject = {
      type: 'message',
      role: stringValue(record, 'role') ?? 'user',
      content: record.content ?? [],
    };
    normalized.push({
      timestamp: stringValue(record, 'timestamp') ?? '',
      type: 'response_item',
      payload,
    });
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function countMessages(session: NativeSession): number {
  switch (session.provider) {
    case 'codex':
      return session.records.filter((record) => {
        const payload = asObject(record.payload);
        return payload?.type === 'message' || record.type === 'compacted';
      }).length;
    case 'pi':
      return session.records.filter((record) => record.type === 'message' || record.type === 'compaction').length;
    case 'claude':
      return session.records.filter((record) => {
        const type = stringValue(record, 'type');
        return type === 'user'
          || type === 'assistant'
          || (type === 'system' && stringValue(record, 'subtype') === 'compact_boundary');
      }).length;
    case 'opencode': {
      const exportObject = session.records[0];
      return (exportObject ? asArray(exportObject.messages) : undefined)?.length ?? 0;
    }
  }
}

function sessionTitle(session: NativeSession, fullName: boolean): string {
  let nativeTitle: string | undefined;
  if (session.provider === 'claude') {
    nativeTitle = latestClaudeCustomTitle(session.records);
  } else if (session.provider === 'opencode') {
    const openCodeInfo = asObject(session.records[0]?.info);
    nativeTitle = openCodeInfo ? stringValue(openCodeInfo, 'title') : undefined;
  }
  nativeTitle = formatNativeSessionTitle(nativeTitle);
  return nativeTitle ?? titleFromMessages(extractor.extract(session), fullName) ?? 'Untitled session';
}

function latestClaudeCustomTitle(records: JsonObject[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== 'custom-title') continue;
    const title = stringValue(record, 'customTitle');
    if (title?.trim()) return title;
  }
  return undefined;
}

function latestRecordTimestamp(records: JsonObject[]): string | undefined {
  let latestValue: string | undefined;
  let latestInstant = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const value = stringValue(record, 'timestamp');
    if (!value) continue;
    const instant = Date.parse(value);
    if (Number.isFinite(instant) && instant >= latestInstant) {
      latestValue = value;
      latestInstant = instant;
    }
  }
  return latestValue;
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
