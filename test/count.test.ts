import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import type { JsonObject, Provider } from '../src/types.js';

function countMessages(provider: Provider, records: JsonObject[]): number {
  const accumulator = AgentRegistry.get(provider).createAccumulator({ collectMessages: false });
  for (const record of records) accumulator.add(record);
  return accumulator.finish('2026-01-01T00:00:00.000Z').messageCount;
}

describe('provider-native message counts', () => {
  it('counts Codex message and compacted records', () => {
    expect(countMessages('codex', [
      { type: 'session_meta' },
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
      { type: 'response_item', payload: { type: 'function_call' } },
      { type: 'compacted', payload: { message: 'summary' } },
    ])).toBe(2);
  });

  it('counts Pi message and compaction records', () => {
    expect(countMessages('pi', [
      { type: 'session' },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'model_change' },
      { type: 'compaction' },
    ])).toBe(2);
  });

  it('counts Claude user, assistant, and compact-boundary records', () => {
    expect(countMessages('claude', [
      { type: 'file-history-snapshot' },
      { type: 'user' },
      { type: 'assistant', message: { content: [] } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'other' },
    ])).toBe(3);
  });

  it('counts all OpenCode message entries', () => {
    expect(countMessages('opencode', [{
      messages: [
        { info: { role: 'user' }, parts: [] },
        { info: { role: 'assistant', summary: true }, parts: [] },
      ],
    }])).toBe(2);
  });
});
