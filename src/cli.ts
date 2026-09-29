#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { planConversion, writeConversion } from './converter.js';
import { defaultHome } from './paths.js';
import { listSessions } from './session-storages.js';
import { PROVIDERS, type Provider } from './types.js';

export interface CliIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive: boolean;
}

interface ParsedOptions {
  dryRun: boolean;
  yes: boolean;
  newId: boolean;
}

const defaultIO: CliIO = {
  input: process.stdin,
  output: process.stdout,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

export async function runCli(args: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp(io.output);
    return 0;
  }
  if (command === 'list') {
    const provider = parseProvider(rest[0]);
    parseOptions(rest.slice(1));
    const sessions = await listSessions(provider, defaultHome(provider));
    io.output.write(`${providerLabel(provider)} sessions (${sessions.length}):\n\n`);
    for (const session of sessions) {
      const messageLabel = session.messageCount === 1 ? 'message' : 'messages';
      io.output.write(`${session.sessionId} · ${formatDateTime(session.timestamp)} (${session.messageCount} ${messageLabel}) · ${session.title}\n`);
    }
    return 0;
  }
  if (command === 'convert') {
    const source = parseProvider(rest[0]);
    const target = parseProvider(rest[1]);
    const sessionId = rest[2];
    if (!sessionId || sessionId.startsWith('--')) {
      throw new Error('convert requires a source session ID');
    }
    const options = parseOptions(rest.slice(3));
    const plan = await planConversion(source, target, sessionId, {
      ...(options.newId ? { preserveIds: false } : {}),
    });
    io.output.write(`Source:      ${plan.source.path}\n`);
    io.output.write(`Destination: ${plan.destination}\n`);
    io.output.write(`Messages:    ${plan.messages.length}\n`);
    for (const service of plan.services) {
      io.output.write(`Service:     ${service.destination}\n`);
    }
    if (options.dryRun) {
      io.output.write('Dry run; no files were written.\n');
      return 0;
    }

    const destinations = [plan.destination, ...plan.services.map((service) => service.destination)];
    const existing = await existingPaths(destinations);
    let overwrite = options.yes;
    if (existing.length && !options.yes) {
      const confirmed = await confirmOverwrite(existing, io);
      if (!confirmed) {
        io.output.write('Conversion cancelled; no files were written.\n');
        return 0;
      }
      overwrite = true;
    }
    await writeConversion(plan, overwrite);
    io.output.write('Conversion written.\n');
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args: string[]): ParsedOptions {
  const options: ParsedOptions = { dryRun: false, yes: false, newId: false };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--dry') options.dryRun = true;
    else if (item === '-y' || item === '--yes') options.yes = true;
    else if (item === '--new-id') options.newId = true;
    else {
      throw new Error(`Unknown option: ${item}`);
    }
  }
  return options;
}

function parseProvider(value: string | undefined): Provider {
  if (value && PROVIDERS.includes(value as Provider)) return value as Provider;
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
  const formattedDate = date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formattedTime = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${formattedDate} ${formattedTime}`;
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
  const prompt = createInterface({ input: io.input, output: io.output });
  try {
    const answer = await prompt.question('Overwrite? [y/N] ');
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function printHelp(output: NodeJS.WritableStream): void {
  output.write('asm\n\n');
  output.write('Usage:\n');
  output.write('  asm list <provider>\n');
  output.write('  asm convert <source> <target> <session-id> [options]\n\n');
  output.write(`Providers: ${PROVIDERS.join(', ')}\n\n`);
  output.write('Options:\n');
  output.write('  --dry                 Preview without writing (conversions write by default)\n');
  output.write('  -y, --yes             Automatically confirm interactive prompts (including overwrites)\n');
  output.write('  --new-id              Generate a new session ID\n');
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
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
