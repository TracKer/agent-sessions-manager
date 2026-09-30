import type {JsonObject, JsonValue} from './types.js';

export function asObject(value: unknown): JsonObject | undefined {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as JsonObject;
    }
    return undefined;
}

export function asArray(value: unknown): JsonValue[] | undefined {
    return Array.isArray(value) ? value as JsonValue[] : undefined;
}

export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function stringValue(object: JsonObject, key: string): string | undefined {
    return asString(object[key]);
}

export function numberValue(object: JsonObject, key: string): number | undefined {
    const value = object[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function sequenceToText(parts: JsonValue[]): string {
    return parts.flatMap((part) => {
        if (typeof part === 'string') return [part];
        const object = asObject(part);
        if (!object) return [];
        const text = asString(object.text) ?? asString(object.input_text) ?? asString(object.output_text);
        return text ? [text] : [];
    }).filter(Boolean).join('\n');
}

export function contentToText(value: unknown): string {
    if (typeof value === 'string') return value;
    const parts = asArray(value);
    if (parts) return sequenceToText(parts);
    const object = asObject(value);
    return object ? asString(object.text) ?? '' : '';
}

export function requiredObject(value: unknown, label: string): JsonObject {
    const object = asObject(value);
    if (!object) throw new TypeError(`${label} must be a JSON object`);
    return object;
}
