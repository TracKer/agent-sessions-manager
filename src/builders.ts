import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue, Provider, TextMessage } from './types.js';
import { isoToEpochMs, openCodeId, openCodeSlug } from './paths.js';
import { titleFromMessages } from './session-title.js';

export function buildRecords(
  target: Provider,
  sessionId: string,
  cwd: string,
  timestamp: string,
  messages: TextMessage[],
): JsonObject[] {
  switch (target) {
    case 'codex':
      return buildCodex(sessionId, cwd, timestamp, messages);
    case 'pi':
      return buildPi(sessionId, cwd, timestamp, messages);
    case 'opencode':
      return [buildOpenCode(sessionId, cwd, timestamp, messages)];
    case 'claude':
      return buildClaude(sessionId, cwd, timestamp, messages);
  }
}

function buildCodex(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
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

function buildPi(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
  const records: JsonObject[] = [{ type: 'session', version: 3, id: sessionId, timestamp, cwd }];
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
      content: [{ type: 'text', text: message.text }],
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      payload.stopReason = 'stop';
      pendingInputTokens = 0;
    } else {
      pendingInputTokens += tokenCount;
    }
    records.push({ type: 'message', id, parentId, timestamp: message.timestamp, message: payload });
    parentId = id;
  }
  return records;
}

function buildOpenCode(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject {
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
        parts: [{ id: compactPartId, sessionID: sessionId, messageID: compactId, type: 'compaction', auto: true }],
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
        parts: [{ id: summaryPartId, sessionID: sessionId, messageID: summaryId, type: 'text', text: message.text, time: { start: time, end: time } }],
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
  const updated = messages.length ? Math.max(...messages.map((message) => isoToEpochMs(message.timestamp))) : created;
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

function buildClaude(sessionId: string, cwd: string, timestamp: string, messages: TextMessage[]): JsonObject[] {
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
        compactMetadata: { trigger: 'manual', preTokens: 0 },
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
      ? [{ type: 'text', text: message.text }]
      : message.text;
    const messageData: JsonObject = message.role === 'assistant'
      ? {
          role: 'assistant',
          content,
          model: message.model ?? 'imported',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
        }
      : { role: 'user', content };
    records.push({
      type: message.role,
      message: messageData,
      uuid,
      parentUuid: message.isCompaction ? null : parentUuid,
      ...(message.isCompaction ? { isCompactSummary: true } : {}),
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
