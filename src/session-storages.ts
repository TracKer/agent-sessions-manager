import {AgentRegistry} from './agents/agent-registry.js';
import type {Provider, SessionData, SessionSummary} from './types.js';

export function listSessions(provider: Provider, home?: string): Promise<SessionSummary[]> {
    return AgentRegistry.get(provider).listSessions(home);
}

export function loadSession(
    provider: Provider,
    sessionId: string,
    home?: string,
): Promise<SessionData> {
    return AgentRegistry.get(provider).loadSession(sessionId, home);
}
