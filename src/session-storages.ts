import {AgentRegistry} from './agents/agent-registry.js';
import type {NativeSession, Provider, SessionSummary} from './types.js';

export function listSessions(provider: Provider, home?: string): Promise<SessionSummary[]> {
    return AgentRegistry.get(provider).listSessions(home);
}

export function loadSession(
    provider: Provider,
    sessionId: string,
    home?: string,
): Promise<NativeSession> {
    return AgentRegistry.get(provider).loadSession(sessionId, home);
}

export function readSession(provider: Provider, filePath: string): Promise<NativeSession> {
    return AgentRegistry.get(provider).readSession(filePath);
}

export function countMessages(session: NativeSession): number {
    return AgentRegistry.get(session.provider).countMessages(session);
}
