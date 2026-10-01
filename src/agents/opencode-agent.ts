import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject, NativeSession, TextMessage } from '../types.js';
import { asArray, asObject, contentToText, numberValue, stringValue } from '../json.js';
import { isoToEpochMs, epochMsToIso } from '../date-time.js';
import { titleFromMessages } from '../session-title.js';
import { AbstractAgent } from './abstract-agent.js';

export class OpenCodeAgent extends AbstractAgent {
  readonly provider = 'opencode' as const;
  readonly label = 'OpenCode';
  readonly storageFormat = 'json' as const;
  readonly sessionExtension = '.json' as const;

  private readonly extractor = new OpenCodeMessageExtractor();
  private readonly builder = new OpenCodeRecordBuilder();

  defaultHome(home = os.homedir()): string {
    if (process.env.OPENCODE_GLOBAL_DATA_DIR) return process.env.OPENCODE_GLOBAL_DATA_DIR;
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode');
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
  }

  protected sessionRoots(home: string): string[] {
    return [path.join(home, 'session-export')];
  }

  protected metadataFor(
    records: JsonObject[],
    filePath: string,
    fallbackTimestamp: string,
  ): Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'> {
    const info = asObject(records[0]?.info);
    const time = info ? asObject(info.time) : undefined;
    const created = time && typeof time.created === 'number'
      ? new Date(time.created).toISOString()
      : fallbackTimestamp;
    return {
      sessionId: (info ? stringValue(info, 'id') : undefined) ?? path.basename(filePath, '.json'),
      cwd: (info ? stringValue(info, 'directory') : undefined) ?? '',
      timestamp: created,
    };
  }

  protected nativeTitle(session: NativeSession): string | undefined {
    const info = asObject(session.records[0]?.info);
    return info ? stringValue(info, 'title') : undefined;
  }

  extractMessages(session: NativeSession): TextMessage[] {
    return this.extractor.extract(session);
  }

  countMessages(session: NativeSession): number {
    const exportObject = session.records[0];
    return (exportObject ? asArray(exportObject.messages) : undefined)?.length ?? 0;
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
}

class OpenCodeMessageExtractor {
  extract(session: NativeSession): TextMessage[] {
    const exportObject = session.records[0];
    const rawMessages = exportObject ? asArray(exportObject.messages) ?? [] : [];
    const messages: TextMessage[] = [];
    for (const raw of rawMessages) {
      const message = asObject(raw);
      const info = message ? asObject(message.info) : undefined;
      if (!message || !info) continue;
      const role = stringValue(info, 'role');
      if (role !== 'user' && role !== 'assistant') continue;
      const parts = asArray(message.parts) ?? [];
      const text = parts.flatMap((part) => {
        const object = asObject(part);
        return object?.type === 'text' && typeof object.text === 'string' ? [object.text] : [];
      }).join('\n');
      const time = asObject(info.time);
      const created = time ? numberValue(time, 'created') : undefined;
      const timestamp = created === undefined ? session.timestamp : epochMsToIso(created);
      if (info.summary === true && role === 'assistant' && text) {
        messages.push({ role: 'user', text, timestamp, isCompaction: true });
        continue;
      }
      if (!text) continue;
      const modelObject = asObject(info.model);
      const model = stringValue(info, 'modelID') ?? (modelObject ? stringValue(modelObject, 'modelID') : undefined);
      const provider = stringValue(info, 'providerID') ?? (modelObject ? stringValue(modelObject, 'providerID') : undefined);
      messages.push({
        role,
        text,
        timestamp,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
    }
    return messages;
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
            time: { created: time },
            agent: 'agent-sessions-manager',
            model: { providerID: 'session-import', modelID: 'imported' },
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
            time: { created: time, completed: time },
            parentID: compactId,
            modelID: 'imported',
            providerID: 'session-import',
            mode: 'build',
            agent: 'agent-sessions-manager',
            path: { cwd, root: cwd },
            cost: 0,
            summary: true,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{
            id: summaryPartId,
            sessionID: sessionId,
            messageID: summaryId,
            type: 'text',
            text: message.text,
            time: { start: time, end: time },
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
          time: { created: time, completed: time },
          parentID: parentId || messageId,
          modelID: model,
          providerID: provider,
          mode: 'build',
          agent: 'agent-sessions-manager',
          path: { cwd, root: cwd },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        : {
          id: messageId,
          sessionID: sessionId,
          role: 'user',
          time: { created: time },
          agent: 'agent-sessions-manager',
          model: { providerID: provider, modelID: model },
        };
      exported.push({
        info,
        parts: [{
          id: openCodeId('prt', message.timestamp),
          sessionID: sessionId,
          messageID: messageId,
          type: 'text',
          text: message.text,
          time: { start: time, end: time },
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
        time: { created, updated },
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
