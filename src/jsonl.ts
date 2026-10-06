import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import type {Buffer} from 'node:buffer';
import path from 'node:path';
import type {JsonObject} from './types.js';
import {asObject} from './json.js';

const lineFeed = 0x0a;

export async function readJsonl(filePath: string): Promise<JsonObject[]> {
    // Decoding per line beats readFile(utf8): a whole-file string costs ~20% more on large sessions.
    const content = await readFile(filePath);
    const records: JsonObject[] = [];
    let start = 0;
    let line = 0;
    while (start < content.length) {
        const breakAt = content.indexOf(lineFeed, start);
        const end = breakAt === -1 ? content.length : breakAt;
        const trimmed = content.toString('utf8', start, end).trim();
        start = end + 1;
        line += 1;
        if (!trimmed) continue;
        try {
            const value: unknown = JSON.parse(trimmed);
            const object = asObject(value);
            if (!object) throw new TypeError('record is not a JSON object');
            records.push(object);
        } catch (error) {
            process.stderr.write(`warning: skipped invalid JSONL record ${filePath}:${line}: ${String(error)}\n`);
        }
    }
    return records;
}

export async function writeJsonl(
    filePath: string,
    records: JsonObject[],
    overwrite = false,
): Promise<void> {
    await atomicWrite(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', overwrite);
}

export async function writeJson(
    filePath: string,
    value: JsonObject,
    overwrite = false,
): Promise<void> {
    await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, overwrite);
}

export async function writeBinary(filePath: string, content: Buffer, overwrite = false): Promise<void> {
    await atomicWrite(filePath, content, overwrite);
}

async function atomicWrite(filePath: string, content: string | Buffer, overwrite: boolean): Promise<void> {
    const directory = path.dirname(filePath);
    await mkdir(directory, {recursive: true});
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, content, {flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY});
        if (overwrite) {
            await rename(tempPath, filePath);
        } else {
            try {
                await link(tempPath, filePath);
            } catch (error) {
                if (isAlreadyExists(error)) {
                    throw new Error(`Refusing to overwrite existing file: ${filePath}`);
                }
                throw error;
            }
            await unlink(tempPath);
        }
    } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}

function isAlreadyExists(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
