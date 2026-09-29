import { describe, expect, it } from 'vitest';
import { countMessages } from '../src/session-storages.js';
import type { JsonObject, NativeSession, Provider } from '../src/types.js';

function session(provider: Provider, records: JsonObject[]): NativeSession {
  return { provider, sessionId: 'test-session', cwd: '', timestamp: '', path: 'session', records };
}

describe('provider-native message counts', () => {
  it('counts Codex message and compacted records', () => {
    expect(countMessages(session('codex', [
      { type: 'session_meta' },
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
      { type: 'response_item', payload: { type: 'function_call' } },
      { type: 'compacted', payload: { message: 'summary' } },
    ]))).toBe(2);
  });

  it('counts Pi message and compaction records', () => {
    expect(countMessages(session('pi', [
      { type: 'session' },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'model_change' },
      { type: 'compaction' },
    ]))).toBe(2);
  });

  it('counts Claude user, assistant, and compact-boundary records', () => {
    expect(countMessages(session('claude', [
      { type: 'file-history-snapshot' },
      { type: 'user' },
      { type: 'assistant', message: { content: [] } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'other' },
    ]))).toBe(3);
  });

  it('counts all OpenCode message entries', () => {
    expect(countMessages(session('opencode', [{
      messages: [
        { info: { role: 'user' }, parts: [] },
        { info: { role: 'assistant', summary: true }, parts: [] },
      ],
    }]))).toBe(2);
  });
});
