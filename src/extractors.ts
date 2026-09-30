import type { JsonObject, MessageRole, NativeSession, TextMessage } from './types.js';
import { asArray, asObject, contentToText, numberValue, stringValue } from './json.js';
import { epochMsToIso } from './paths.js';

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

export class MessageExtractor {
  extract(session: NativeSession): TextMessage[] {
    switch (session.provider) {
      case 'codex':
        return this.fromCodex(session);
      case 'pi':
        return this.fromPi(session);
      case 'opencode':
        return this.fromOpenCode(session);
      case 'claude':
        return this.fromClaude(session);
    }
  }

  private fromCodex(session: NativeSession): TextMessage[] {
    const messages: TextMessage[] = [];
    for (const record of session.records) {
      const type = stringValue(record, 'type');
      const timestamp = stringValue(record, 'timestamp') ?? session.timestamp;
      if (type === 'compacted') {
        const payload = asObject(record.payload);
        const summary = payload ? stringValue(payload, 'message') : undefined;
        if (summary) messages.push({ role: 'user', text: summary, timestamp, isCompaction: true });
        const replacement = payload ? asArray(payload.replacement_history) : undefined;
        for (const item of replacement ?? []) {
          const object = asObject(item);
          if (object?.type !== 'message') continue;
          const textMessage = this.codexMessage(object, timestamp, true);
          if (textMessage) messages.push(textMessage);
        }
        continue;
      }
      const payload = asObject(record.payload);
      if (payload?.type !== 'message') continue;
      const textMessage = this.codexMessage(payload, timestamp, true);
      if (textMessage) messages.push(textMessage);
    }
    return messages;
  }

  private codexMessage(payload: JsonObject, timestamp: string, markContextual: boolean): TextMessage | undefined {
    const role = stringValue(payload, 'role');
    if (!role || !['user', 'assistant', 'system', 'developer'].includes(role)) return undefined;
    const text = contentToText(payload.content);
    if (!text) return undefined;
    return {
      role: role === 'system' || role === 'developer' ? 'user' : role as MessageRole,
      text,
      timestamp,
      ...(markContextual && isContextual(text) ? { isContextual: true } : {}),
    };
  }

  private fromPi(session: NativeSession): TextMessage[] {
    const messages: TextMessage[] = [];
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
        if (text) messages.push({ role: 'user', text, timestamp: stringValue(record, 'timestamp') ?? session.timestamp, isCompaction: true });
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
      messages.push({
        role: sourceRole === 'system' ? 'user' : sourceRole as MessageRole,
        text,
        timestamp: stringValue(record, 'timestamp') ?? stringValue(message, 'timestamp') ?? session.timestamp,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(api !== undefined ? { api } : {}),
      });
    }
    return messages;
  }

  private fromOpenCode(session: NativeSession): TextMessage[] {
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

  private fromClaude(session: NativeSession): TextMessage[] {
    const messages: TextMessage[] = [];
    for (const record of session.records) {
      const type = stringValue(record, 'type');
      const timestamp = stringValue(record, 'timestamp') ?? session.timestamp;
      const isMeta = record.isMeta === true ? { isMeta: true } : {};
      if (type === 'system' && record.subtype === 'compact_boundary') {
        const summary = stringValue(record, 'content');
        if (summary) messages.push({ role: 'user', text: summary, timestamp, isCompaction: true, ...isMeta });
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
        messages.push({ role: 'user', text, timestamp, isCompaction: true, ...isMeta });
      } else {
        const model = stringValue(message, 'model');
        messages.push({ role, text, timestamp, ...(model ? { model } : {}), ...isMeta });
      }
    }
    return messages;
  }

}

function isContextual(text: string): boolean {
  const head = text.slice(0, 120);
  return contextualMarkers.some((marker) => head.includes(marker));
}
