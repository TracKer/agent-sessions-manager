import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject, MessageRole, NativeSession, TextMessage } from '../types.js';
import { asArray, asObject, contentToText, stringValue } from '../json.js';
import { AbstractAgent } from './abstract-agent.js';

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

  private readonly extractor = new CodexMessageExtractor();
  private readonly builder = new CodexRecordBuilder();

  defaultHome(home = os.homedir()): string {
    return path.join(home, '.codex');
  }

  protected sessionRoots(home: string): string[] {
    return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
  }

  protected metadataFor(
    records: JsonObject[],
    filePath: string,
    fallbackTimestamp: string,
  ): Pick<NativeSession, 'sessionId' | 'cwd' | 'timestamp'> {
    const meta = records.find((record) => record.type === 'session_meta');
    const payload = meta ? asObject(meta.payload) : undefined;
    const firstRecord = records[0];
    const timestamp = (payload ? stringValue(payload, 'timestamp') : undefined)
      ?? (meta ? stringValue(meta, 'timestamp') : undefined)
      ?? (firstRecord ? stringValue(firstRecord, 'timestamp') : undefined)
      ?? fallbackTimestamp;
    const basename = path.basename(filePath);
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

  protected normalizeRecords(records: JsonObject[]): JsonObject[] {
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

  extractMessages(session: NativeSession): TextMessage[] {
    return this.extractor.extract(session);
  }

  countMessages(session: NativeSession): number {
    return session.records.filter((record) => {
      const payload = asObject(record.payload);
      return payload?.type === 'message' || record.type === 'compacted';
    }).length;
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
}

class CodexMessageExtractor {
  extract(session: NativeSession): TextMessage[] {
    const messages: TextMessage[] = [];
    for (const record of session.records) {
      const timestamp = stringValue(record, 'timestamp') ?? session.timestamp;
      if (record.type === 'compacted') {
        const payload = asObject(record.payload);
        const summary = payload ? stringValue(payload, 'message') : undefined;
        if (summary) messages.push({ role: 'user', text: summary, timestamp, isCompaction: true });
        const replacement = payload ? asArray(payload.replacement_history) : undefined;
        for (const item of replacement ?? []) {
          const object = asObject(item);
          if (object?.type !== 'message') continue;
          const message = this.codexMessage(object, timestamp);
          if (message) messages.push(message);
        }
        continue;
      }
      const payload = asObject(record.payload);
      if (payload?.type !== 'message') continue;
      const message = this.codexMessage(payload, timestamp);
      if (message) messages.push(message);
    }
    return messages;
  }

  private codexMessage(payload: JsonObject, timestamp: string): TextMessage | undefined {
    const role = stringValue(payload, 'role');
    if (!role || !['user', 'assistant', 'system', 'developer'].includes(role)) return undefined;
    const text = contentToText(payload.content);
    if (!text) return undefined;
    return {
      role: role === 'system' || role === 'developer' ? 'user' : role as MessageRole,
      text,
      timestamp,
      ...(isContextual(text) ? { isContextual: true } : {}),
    };
  }
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
        records.push({ timestamp: message.timestamp, type: 'compacted', payload: { message: message.text } });
      } else {
        records.push({
          timestamp: message.timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: message.role,
            content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
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
