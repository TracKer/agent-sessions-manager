import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src/cli.js';
import { MessageExtractor } from '../src/extractors.js';
import { listSessions, loadSession } from '../src/session-storages.js';

const roots: string[] = [];
const sessionId = '01234567-89ab-cdef-8123-456789abcdef';
const environmentKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_GLOBAL_DATA_DIR',
  'XDG_DATA_HOME',
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sessions-cli-'));
  roots.push(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.OPENCODE_GLOBAL_DATA_DIR;
  delete process.env.XDG_DATA_HOME;
  return root;
}

function createIO(answer = '', interactive = false): { io: CliIO; output: () => string } {
  const input = Readable.from(answer ? [answer] : []);
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer) => { outputText += chunk.toString(); });
  return { io: { input, output, interactive }, output: () => outputText };
}

function formatSystemDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  const formattedDate = date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formattedTime = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${formattedDate} ${formattedTime}`;
}

async function writeCodexSession(home: string, assistantText: string): Promise<void> {
  const filePath = path.join(
    home,
    'sessions',
    '2026',
    '07',
    '01',
    `rollout-2026-07-01T15-00-00-${sessionId}.jsonl`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, [
    JSON.stringify({
      timestamp: '2026-07-01T15:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-07-01T15:00:00.000Z', cwd: '/work/project' },
    }),
    JSON.stringify({
      timestamp: '2026-07-01T15:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CLI prompt' }] },
    }),
    JSON.stringify({
      timestamp: '2026-07-01T15:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] },
    }),
  ].join('\n') + '\n');
}

async function writeClaudeSession(
  home: string,
  id: string,
  timestamp: string,
  userText: string,
  customTitles: string[] = [],
): Promise<void> {
  const filePath = path.join(home, 'projects', '-work-project', `${id}.jsonl`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const records = [
    {
      type: 'user',
      sessionId: id,
      cwd: '/work/project',
      timestamp,
      message: { role: 'user', content: userText },
    },
    ...customTitles.map((customTitle) => ({ type: 'custom-title', sessionId: id, customTitle })),
  ];
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function convertedTexts(home: string): Promise<string[]> {
  const [session] = await listSessions('claude', home);
  if (!session) return [];
  return new MessageExtractor().extract(await loadSession('claude', session.sessionId, home)).map((message) => message.text);
}

function restoreEnvironment(): void {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  restoreEnvironment();
});

describe('CLI conversion write modes', () => {
  it('shows global help without exposing command-specific options', async () => {
    const io = createIO();
    await runCli(['--help'], io.io);
    expect(io.output()).toContain('Usage: asm [options] [command]');
    expect(io.output()).toContain('list [options] <provider>');
    expect(io.output()).toContain('convert [options] <source> <target> <session-id>');
    expect(io.output()).not.toContain('--home');
    expect(io.output()).not.toContain('--source-home');
    expect(io.output()).not.toContain('--target-home');
    expect(io.output()).not.toContain('--pi-dcp-home');
    expect(io.output()).not.toContain('--dry');
    expect(io.output()).not.toContain('--yes');
    expect(io.output()).not.toContain('sessions list');
  });

  it('shows separate help and options for list and convert', async () => {
    const listHelp = createIO();
    await runCli(['list', '--help'], listHelp.io);
    expect(listHelp.output()).toContain('Usage: asm list [options] <provider>');
    expect(listHelp.output()).toContain('List sessions for a provider');
    expect(listHelp.output()).toContain('provider whose sessions to list');
    expect(listHelp.output()).toContain('"codex", "pi"');
    expect(listHelp.output()).toContain('"opencode", "claude"');
    expect(listHelp.output()).toContain('--full-name');
    expect(listHelp.output()).not.toContain('--dry');
    expect(listHelp.output()).not.toContain('--yes');

    const convertHelp = createIO();
    await runCli(['convert', '--help'], convertHelp.io);
    expect(convertHelp.output()).toContain('Usage: asm convert [options] <source> <target> <session-id>');
    expect(convertHelp.output()).toContain('--dry');
    expect(convertHelp.output()).toContain('Automatically confirm interactive prompts, including overwrites');
    expect(convertHelp.output()).toContain('--new-id');
    expect(convertHelp.output()).not.toContain('--full-name');
  });

  it('writes by default and leaves destinations untouched with --dry', async () => {
    const root = await tempDirectory();
    const codexHome = path.join(root, '.codex');
    const targetHome = path.join(root, '.claude');
    await writeCodexSession(codexHome, 'Initial reply');
    const dryIO = createIO();
    await runCli(['convert', 'codex', 'claude', sessionId, '--dry'], dryIO.io);
    expect(await listSessions('claude', targetHome)).toHaveLength(0);
    expect(dryIO.output()).toContain('Dry run; no files were written.');

    const writeIO = createIO();
    await runCli(['convert', 'codex', 'claude', sessionId], writeIO.io);
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Initial reply']);
    expect(writeIO.output()).toContain('Conversion written.');
  });

  it('generates a new session ID with --new-id', async () => {
    const root = await tempDirectory();
    const codexHome = path.join(root, '.codex');
    const targetHome = path.join(root, '.claude');
    await writeCodexSession(codexHome, 'New ID reply');

    await runCli(['convert', 'codex', 'claude', sessionId, '--new-id'], createIO().io);

    const [converted] = await listSessions('claude', targetHome);
    expect(converted).toBeDefined();
    expect(converted?.sessionId).not.toBe(sessionId);
  });

  it.each(['--home', '--source-home', '--target-home', '--pi-dcp-home'])('rejects the removed %s flag', async (flag) => {
    await expect(runCli(
      ['list', 'claude', flag, '/tmp/custom-home'],
      createIO().io,
    )).rejects.toThrow(new RegExp(`unknown option.*${flag}`, 'i'));
  });

  it('prints one-line sessions newest-first without file paths', async () => {
    const root = await tempDirectory();
    const claudeHome = path.join(root, '.claude');
    const olderId = '11111111-1111-4111-8111-111111111111';
    const newerId = '22222222-2222-4222-8222-222222222222';
    const olderTime = '2026-07-01T15:00:00.000Z';
    const newerTime = '2026-08-02T10:30:00.000Z';
    const newerTitle = `${'A newer session title '.repeat(6).trim()}\nwith additional details`;
    await writeClaudeSession(claudeHome, olderId, olderTime, 'An older session title');
    await writeClaudeSession(claudeHome, newerId, newerTime, newerTitle);

    const io = createIO();
    await runCli(['list', 'claude'], io.io);

    expect(io.output().trim().split('\n')).toEqual([
      'Claude Code sessions (2):',
      '',
      `${newerId} · ${formatSystemDateTime(newerTime)} (1 message) · ${newerTitle.split(/\r?\n/, 1)[0]?.slice(0, 80)}`,
      `${olderId} · ${formatSystemDateTime(olderTime)} (1 message) · An older session title`,
    ]);
    expect(io.output()).not.toContain(claudeHome);
  });

  it('prefers the latest Claude customTitle over the first user message', async () => {
    const root = await tempDirectory();
    const claudeHome = path.join(root, '.claude');
    const id = '33333333-3333-4333-8333-333333333333';
    const timestamp = '2026-08-03T10:30:00.000Z';
    const expectedTitle = 'Latest custom title '.repeat(8).trim();
    await writeClaudeSession(claudeHome, id, timestamp, 'Fallback first user message', [
      'Older custom title',
      expectedTitle,
    ]);

    const io = createIO();
    await runCli(['list', 'claude'], io.io);

    expect(io.output()).toContain(
      `${id} · ${formatSystemDateTime(timestamp)} (1 message) · ${expectedTitle}`,
    );
    expect(io.output()).not.toContain('Fallback first user message');
  });

  it('prints full fallback titles with --full-name', async () => {
    const root = await tempDirectory();
    const claudeHome = path.join(root, '.claude');
    const id = '44444444-4444-4444-8444-444444444444';
    const timestamp = '2026-08-04T10:30:00.000Z';
    const fullTitle = 'A long fallback title '.repeat(8).trim();
    await writeClaudeSession(claudeHome, id, timestamp, fullTitle);

    const defaultIO = createIO();
    await runCli(['list', 'claude'], defaultIO.io);
    expect(defaultIO.output()).toContain(fullTitle.slice(0, 80));
    expect(defaultIO.output()).not.toContain(fullTitle);

    const fullNameIO = createIO();
    await runCli(['list', 'claude', '--full-name'], fullNameIO.io);
    expect(fullNameIO.output()).toContain(fullTitle);
  });

  it('rejects the removed --dry-run alias', async () => {
    await expect(runCli(['convert', 'codex', 'claude', sessionId, '--dry-run'], createIO().io))
      .rejects.toThrow(/unknown option.*--dry-run/i);
  });

  it('prompts on conflicts, cancels on no, and lets -y/--yes replace without prompting', async () => {
    const root = await tempDirectory();
    const codexHome = path.join(root, '.codex');
    const targetHome = path.join(root, '.claude');
    const args = ['convert', 'codex', 'claude', sessionId];
    await writeCodexSession(codexHome, 'Original reply');
    await runCli(args, createIO().io);

    await writeCodexSession(codexHome, 'Updated reply');
    const noIO = createIO('no\n', true);
    await runCli(args, noIO.io);
    expect(noIO.output()).toContain('Overwrite? [y/N]');
    expect(noIO.output()).toContain('Conversion cancelled');
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Original reply']);

    const yesIO = createIO('yes\n', true);
    await runCli(args, yesIO.io);
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Updated reply']);

    await writeCodexSession(codexHome, 'Flag overwrite');
    const nonInteractiveYesIO = createIO();
    await runCli([...args, '--yes'], nonInteractiveYesIO.io);
    expect(nonInteractiveYesIO.output()).not.toContain('Overwrite?');
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Flag overwrite']);

    await writeCodexSession(codexHome, 'Short flag overwrite');
    await runCli([...args, '-y'], createIO().io);
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Short flag overwrite']);

    await expect(runCli([...args, '--overwrite'], createIO().io)).rejects.toThrow(/unknown option.*--overwrite/i);
  });

  it('requires --yes to overwrite when there is no interactive terminal', async () => {
    const root = await tempDirectory();
    const codexHome = path.join(root, '.codex');
    const targetHome = path.join(root, '.claude');
    const args = ['convert', 'codex', 'claude', sessionId];
    await writeCodexSession(codexHome, 'Original reply');
    await runCli(args, createIO().io);
    await writeCodexSession(codexHome, 'Should not write');

    await expect(runCli(args, createIO().io)).rejects.toThrow('Use --yes to overwrite without prompting');
    expect(await convertedTexts(targetHome)).toEqual(['CLI prompt', 'Original reply']);
  });

  it('treats an existing Pi DCP service file as an overwrite conflict', async () => {
    const root = await tempDirectory();
    const codexHome = path.join(root, '.codex');
    const piHome = path.join(root, '.pi', 'agent');
    const piDcpHome = path.join(root, '.pi-dcp');
    const dcpPath = path.join(piDcpHome, 'sessions', `${sessionId}.json`);
    await writeCodexSession(codexHome, 'Pi destination');
    await mkdir(path.dirname(dcpPath), { recursive: true });
    await writeFile(dcpPath, '{"existing":true}\n');
    const args = ['convert', 'codex', 'pi', sessionId];

    await expect(runCli(args, createIO().io)).rejects.toThrow('Destination already exists');
    expect(await listSessions('pi', piHome)).toHaveLength(0);

    await runCli([...args, '--yes'], createIO().io);
    expect(await listSessions('pi', piHome)).toHaveLength(1);
    expect(await readFile(dcpPath, 'utf8')).toContain('"sessionId": "01234567-89ab-cdef-8123-456789abcdef"');
  });
});
