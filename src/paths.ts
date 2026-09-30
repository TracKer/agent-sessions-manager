import {randomInt, randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {Provider} from './types.js';

export class SessionIdFactory {
    constructor(private readonly preserveIds = true) {
    }

    create(sourceId: string): string {
        return this.preserveIds ? sourceId : randomUUID();
    }

    createCodex(sourceId: string): string {
        return this.preserveIds && isUuid(sourceId) ? sourceId : randomUUID();
    }

    createOpenCode(sourceId: string, timestamp: string): string {
        return this.preserveIds && sourceId.startsWith('ses_') ? sourceId : openCodeId('ses', timestamp);
    }
}

export function defaultHome(provider: Provider, home = os.homedir()): string {
    switch (provider) {
        case 'codex':
            return path.join(home, '.codex');
        case 'pi':
            return path.join(home, '.pi', 'agent');
        case 'claude':
            return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
        case 'opencode':
            if (process.env.OPENCODE_GLOBAL_DATA_DIR) return process.env.OPENCODE_GLOBAL_DATA_DIR;
            if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode');
            return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
    }
}

export function defaultPiDcpHome(home = os.homedir()): string {
    return path.join(home, '.pi-dcp');
}

export function sessionRoot(provider: Provider, home: string): string {
    switch (provider) {
        case 'codex':
            return path.join(home, 'sessions');
        case 'pi':
            return path.join(home, 'sessions');
        case 'claude':
            return path.join(home, 'projects');
        case 'opencode':
            return path.join(home, 'session-export');
    }
}

export async function destinationPath(
    provider: Provider,
    home: string,
    sessionId: string,
    cwd: string,
    timestamp: string,
): Promise<string> {
    switch (provider) {
        case 'codex': {
            const [year, month, day] = dateParts(timestamp);
            return path.join(home, 'sessions', year, month, day, `rollout-${codexFilenameTimestamp(timestamp)}-${sessionId}.jsonl`);
        }
        case 'pi':
            return path.join(home, 'sessions', encodePiCwd(cwd), `${piFilenameTimestamp(timestamp)}_${sessionId}.jsonl`);
        case 'claude':
            return path.join(home, 'projects', sanitizeClaudeCwd(cwd), `${sessionId}.jsonl`);
        case 'opencode':
            return path.join(home, 'session-export', `${sessionId}.json`);
    }
}

export function piFilenameTimestamp(timestamp: string): string {
    return timestamp.replace(/[:.]/g, '-');
}

export function codexFilenameTimestamp(timestamp: string): string {
    return timestamp.replace(/[:.]/g, '-').replace(/Z$/, '');
}

export function dateParts(timestamp: string): [string, string, string] {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
    if (!match?.[1] || !match[2] || !match[3]) {
        throw new Error(`Invalid ISO timestamp for Codex session path: ${timestamp}`);
    }
    return [match[1], match[2], match[3]];
}

export function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isoToEpochMs(timestamp: string): number {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) ? value : Date.now();
}

export function epochMsToIso(value: number): string {
    return new Date(value).toISOString();
}

export function openCodeId(prefix: 'ses' | 'msg' | 'prt', timestamp: string): string {
    const mask = (1n << 48n) - 1n;
    let encoded = (BigInt(isoToEpochMs(timestamp)) * 0x1000n + 1n) & mask;
    if (prefix === 'ses') encoded = ~encoded & mask;
    const timePart = encoded.toString(16).padStart(12, '0');
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randomPart = '';
    for (let index = 0; index < 14; index += 1) randomPart += alphabet[randomInt(alphabet.length)];
    return `${prefix}_${timePart}${randomPart}`;
}

export function openCodeSlug(text: string): string {
    const parts = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean);
    return parts.slice(0, 8).join('-') || 'imported-session';
}

export function sanitizeClaudeCwd(cwd: string): string {
    return cwd.replace(/^\\\\\?\\/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

export function encodePiCwd(cwd: string): string {
    const withoutPrefix = cwd.startsWith('\\\\?\\') ? cwd.slice(4) : cwd;
    return `--${withoutPrefix.replace(/^[/\\]+/, '').replace(/[/:\\]/g, '-')}--`;
}
