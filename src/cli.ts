#!/usr/bin/env node
import {realpathSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {Argument, Command, CommanderError} from 'commander';
import stringWidth from 'string-width';
import {planConversion, writeConversion} from './converter.js';
import {defaultHome} from './paths.js';
import {listSessions} from './session-storages.js';
import {type Provider, PROVIDERS} from './types.js';

export interface CliIO {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    interactive: boolean;
    columns?: number;
}

interface ConvertOptions {
    dry?: boolean;
    yes?: boolean;
    newId?: boolean;
}

interface ListOptions {
    fullName?: boolean;
}

const titleSegmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

const defaultIO: CliIO = {
    input: process.stdin,
    output: process.stdout,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

export async function runCli(args: string[], io: CliIO = defaultIO): Promise<number> {
    const program = new Command();
    program
        .name('asm')
        .description('List and convert AI coding-agent sessions')
        .configureOutput({
            writeOut: (message) => {
                io.output.write(message);
            },
            writeErr: () => {
            },
        })
        .exitOverride()
        .addHelpText('after', `\nProviders: ${PROVIDERS.join(', ')}\n`);

    program
        .command('list')
        .description('List sessions for a provider')
        .addArgument(new Argument('<provider>', 'provider whose sessions to list').choices(PROVIDERS))
        .option('--full-name', 'Show complete session titles even when they exceed terminal width')
        .action(async (providerName: string, options: ListOptions) => {
            const provider = parseProvider(providerName);
            const sessions = await listSessions(provider, defaultHome(provider), {fullName: true});
            const terminalWidth = io.columns ?? process.stdout.columns ?? 80;
            io.output.write(`${providerLabel(provider)} sessions (${sessions.length}):\n\n`);
            for (const session of sessions) {
                const messageLabel = session.messageCount === 1 ? 'message' : 'messages';
                const prefix = `${session.sessionId} · ${formatDateTime(session.timestamp)} (${session.messageCount} ${messageLabel}) · `;
                const title = options.fullName
                    ? session.title
                    : truncateToTerminalWidth(session.title, terminalWidth - 1 - stringWidth(prefix));
                io.output.write(`${prefix}${title}\n`);
            }
        });

    program
        .command('convert')
        .description('Convert a session between providers')
        .addArgument(new Argument('<source>', 'provider containing the session').choices(PROVIDERS))
        .addArgument(new Argument('<target>', 'destination provider').choices(PROVIDERS))
        .argument('<session-id>', 'ID of the session to convert')
        .option('--dry', 'Preview without writing')
        .option('-y, --yes', 'Automatically confirm interactive prompts, including overwrites')
        .option('--new-id', 'Generate a new session ID')
        .action(async (sourceName: string, targetName: string, sessionId: string, options: ConvertOptions) => {
            const source = parseProvider(sourceName);
            const target = parseProvider(targetName);
            const plan = await planConversion(source, target, sessionId, {
                ...(options.newId ? {preserveIds: false} : {}),
            });
            io.output.write(`Source:      ${plan.source.path}\n`);
            io.output.write(`Destination: ${plan.destination}\n`);
            io.output.write(`Messages:    ${plan.messages.length}\n`);
            for (const service of plan.services) {
                io.output.write(`Service:     ${service.destination}\n`);
            }
            if (options.dry) {
                io.output.write('Dry run; no files were written.\n');
                return;
            }

            const destinations = [plan.destination, ...plan.services.map((service) => service.destination)];
            const existing = await existingPaths(destinations);
            let overwrite = options.yes === true;
            if (existing.length && !overwrite) {
                const confirmed = await confirmOverwrite(existing, io);
                if (!confirmed) {
                    io.output.write('Conversion cancelled; no files were written.\n');
                    return;
                }
                overwrite = true;
            }
            await writeConversion(plan, overwrite);
            io.output.write('Conversion written.\n');
        });

    if (args.length === 0) {
        program.outputHelp();
        return 0;
    }

    try {
        await program.parseAsync(args, {from: 'user'});
        return 0;
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.code === 'commander.helpDisplayed') return error.exitCode;
            throw new Error(error.message.replace(/^error:\s*/, ''));
        }
        throw error;
    }
}

function parseProvider(value: string): Provider {
    const provider = PROVIDERS.find((candidate) => candidate === value);
    if (provider) return provider;
    throw new Error(`Provider must be one of: ${PROVIDERS.join(', ')}`);
}

function providerLabel(provider: Provider): string {
    switch (provider) {
        case 'codex':
            return 'OpenAI Codex';
        case 'pi':
            return 'Pi';
        case 'opencode':
            return 'OpenCode';
        case 'claude':
            return 'Claude Code';
    }
}

function formatDateTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Unknown date';
    const date = new Date(timestamp);
    const formattedDate = date.toLocaleDateString(undefined, {year: 'numeric', month: '2-digit', day: '2-digit'});
    const formattedTime = date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    return `${formattedDate} ${formattedTime}`;
}

function truncateToTerminalWidth(value: string, maxWidth: number): string {
    if (stringWidth(value) <= maxWidth) return value;
    const ellipsis = '…';
    const maxContentWidth = Math.max(0, maxWidth - stringWidth(ellipsis));
    let result = '';
    let width = 0;
    for (const {segment} of titleSegmenter.segment(value)) {
        const segmentWidth = stringWidth(segment);
        if (width + segmentWidth > maxContentWidth) break;
        result += segment;
        width += segmentWidth;
    }
    return `${result}${ellipsis}`;
}

async function existingPaths(destinations: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const destination of new Set(destinations)) {
        try {
            await stat(destination);
            found.push(destination);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }
    return found;
}

async function confirmOverwrite(destinations: string[], io: CliIO): Promise<boolean> {
    if (!io.interactive) {
        throw new Error(`Destination already exists. Use --yes to overwrite without prompting: ${destinations.join(', ')}`);
    }
    io.output.write(`Existing output:\n${destinations.map((destination) => `  ${destination}\n`).join('')}`);
    const prompt = createInterface({input: io.input, output: io.output});
    try {
        const answer = await prompt.question('Overwrite? [y/N] ');
        return /^(?:y|yes)$/i.test(answer.trim());
    } finally {
        prompt.close();
    }
}

function isMissing(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isDirectInvocation(): boolean {
    const entryPath = process.argv[1];
    if (!entryPath) return false;
    try {
        return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

if (isDirectInvocation()) {
    runCli(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        },
    );
}
