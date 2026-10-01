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

export interface NativeSession {
    provider: Provider;
    sessionId: string;
    cwd: string;
    timestamp: string;
    path: string;
    records: JsonObject[];
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
    source: NativeSession;
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
