export type Provider =
    | 'codex'
    | 'pi'
    | 'opencode'
    | 'claude';

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MessageRole = 'user' | 'assistant';

export interface TextMessage {
    role: MessageRole;
    text: string;
    timestamp: string;
    model?: string;
    provider?: string;
    api?: string;
    isMeta?: boolean;
    isCompaction?: boolean;
    isContextual?: boolean;
}

export interface SessionData {
    provider: Provider;
    path: string;
    sessionId: string;
    cwd: string;
    timestamp: string;
    /** Newest record timestamp, used to order lists; falls back to `timestamp`. */
    latestTimestamp: string;
    title: string;
    messageCount: number;
    /** Populated only when the session was read for conversion. */
    messages: TextMessage[];
}

export interface SessionSummary {
    provider: Provider;
    sessionId: string;
    title: string;
    cwd: string;
    timestamp: string;
    path: string;
    messageCount: number;
}

export interface ConversionPlan {
    source: SessionData;
    target: Provider;
    targetId: string;
    destination: string;
    records: JsonObject[];
    messages: TextMessage[];
    services: ConversionService[];
}

export interface ConversionService {
    destination: string;
    content: JsonObject;
}
