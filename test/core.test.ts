import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planConversion, writeConversion } from '../src/converter.js';
import { listSessions, loadSession } from '../src/session-storages.js';
import { sanitizeClaudeCwd } from '../src/agents/claude-agent.js';
import { encodePiCwd } from '../src/agents/pi-agent.js';

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-sessions-manager-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('path helpers', () => {
  it('encodes Pi and Claude workspace paths using their native conventions', () => {
    expect(encodePiCwd('C:\\projects\\test-app')).toBe('--C--projects-test-app--');
    expect(sanitizeClaudeCwd('/Users/me/project')).toBe('-Users-me-project');
  });
});

describe('session conversion', () => {
  it('loads Codex rollouts and writes a Pi session through the plan/write API', async () => {
    const root = await tempDir();
    const codexHome = path.join(root, '.codex');
    const piHome = path.join(root, '.pi', 'agent');
    const sessionId = '01234567-89ab-cdef-8123-456789abcdef';
    const sourcePath = path.join(codexHome, 'sessions', '2026', '06', '10', `rollout-2026-06-10T23-22-58-${sessionId}.jsonl`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      JSON.stringify({
        timestamp: '2026-06-10T23:22:58.000Z',
        type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-06-10T23:22:58.000Z', cwd: 'C:\\projects\\test-app' },
      }),
      JSON.stringify({
        timestamp: '2026-06-10T23:23:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-10T23:23:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      }),
    ].join('\n') + '\n');

    const listed = await listSessions('codex', codexHome);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.messageCount).toBe(2);

    const piDcpHome = path.join(root, '.pi-dcp');
    const plan = await planConversion('codex', 'pi', sessionId, { sourceHome: codexHome, targetHome: piHome, piDcpHome });
    expect(plan.records[0]?.type).toBe('session');
    expect(plan.records[1]?.type).toBe('message');
    expect(plan.records[2]?.type).toBe('message');
    expect(plan.destination).toContain('--C--projects-test-app--');
    expect(plan.services[0]?.destination).toBe(path.join(piDcpHome, 'sessions', `${sessionId}.json`));

    await writeConversion(plan);
    expect(JSON.parse(await readFile(plan.services[0]!.destination, 'utf8'))).toMatchObject({
      version: 1,
      sessionId,
      compressions: [],
    });
    const converted = await loadSession('pi', sessionId, piHome);
    expect(converted.records).toHaveLength(3);
    expect(converted.records[2]?.message).toMatchObject({ role: 'assistant' });
  });

  it('converts OpenCode exports to Claude JSONL and rejects accidental overwrites', async () => {
    const root = await tempDir();
    const openCodeHome = path.join(root, 'opencode');
    const claudeHome = path.join(root, '.claude');
    const sessionId = 'ses_9d9ddbe00001aaaaaaaaaaaaaa';
    const nativeTitle = `Native OpenCode title ${'extended '.repeat(10)}`.trim();
    const sourcePath = path.join(openCodeHome, 'session-export', `${sessionId}.json`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, JSON.stringify({
      info: {
        id: sessionId,
        directory: '/work/project',
        title: nativeTitle,
        time: { created: 1782601231629 },
      },
      messages: [{
        info: {
          id: 'msg_9d9ddbe00001bbbbbbbbbbbbbb',
          role: 'user',
          time: { created: 1782601231629 },
        },
        parts: [{ type: 'text', text: 'hello from OpenCode' }],
      }],
    }));

    const [listed] = await listSessions('opencode', openCodeHome);
    expect(listed?.title).toBe(nativeTitle);

    const plan = await planConversion('opencode', 'claude', sessionId, { sourceHome: openCodeHome, targetHome: claudeHome });
    expect(plan.messages[0]?.text).toBe('hello from OpenCode');
    const piPlan = await planConversion('opencode', 'pi', sessionId, {
      sourceHome: openCodeHome,
      targetHome: path.join(root, '.pi', 'agent'),
      piDcpHome: path.join(root, '.pi-dcp'),
    });
    expect(piPlan.records).toHaveLength(2);
    expect(piPlan.services).toHaveLength(1);
    await writeConversion(plan);
    await expect(writeConversion(plan)).rejects.toThrow('Refusing to overwrite');

    const saved = await readFile(plan.destination, 'utf8');
    expect(JSON.parse(saved.split('\n')[0] ?? '{}')).toMatchObject({
      type: 'user',
      sessionId,
      message: { role: 'user', content: 'hello from OpenCode' },
    });
  });

  it('maps Codex contextual prompts away from exports', async () => {
    const root = await tempDir();
    const codexHome = path.join(root, '.codex');
    const sessionId = '01234567-89ab-cdef-8123-456789abcdef';
    const sourcePath = path.join(codexHome, 'sessions', '2026', '06', '10', `rollout-2026-06-10T23-22-58-${sessionId}.jsonl`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      JSON.stringify({
        timestamp: '2026-06-10T23:22:58.000Z',
        type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-06-10T23:22:58.000Z', cwd: '/work/app' },
      }),
      JSON.stringify({
        timestamp: '2026-06-10T23:23:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>internal' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-10T23:23:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real question' }] },
      }),
    ].join('\n') + '\n');

    const plan = await planConversion('codex', 'pi', sessionId, {
      sourceHome: codexHome,
      targetHome: path.join(root, 'pi'),
      piDcpHome: path.join(root, '.pi-dcp'),
    });
    expect(plan.messages).toHaveLength(2);
    expect(plan.records).toHaveLength(2);
  });

  it('normalizes legacy flat Codex message records', async () => {
    const root = await tempDir();
    const codexHome = path.join(root, '.codex');
    const sessionId = '01234567-89ab-cdef-8123-456789abcdef';
    const sourcePath = path.join(codexHome, 'sessions', '2026', '06', '10', `rollout-2026-06-10T23-22-58-${sessionId}.jsonl`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      JSON.stringify({ id: sessionId, timestamp: '2026-06-10T23:22:58.000Z', cwd: '/work/app' }),
      JSON.stringify({
        type: 'message',
        role: 'user',
        timestamp: '2026-06-10T23:23:00.000Z',
        content: [{ type: 'input_text', text: 'legacy prompt' }],
      }),
    ].join('\n') + '\n');

    const session = await loadSession('codex', sessionId, codexHome);
    const plan = await planConversion('codex', 'pi', sessionId, {
      sourceHome: codexHome,
      targetHome: path.join(root, 'pi'),
      piDcpHome: path.join(root, '.pi-dcp'),
    });
    expect(session.cwd).toBe('/work/app');
    expect(plan.messages.map((message) => message.text)).toEqual(['legacy prompt']);
  });

  it('converts Claude sessions to OpenCode export JSON', async () => {
    const root = await tempDir();
    const claudeHome = path.join(root, '.claude');
    const openCodeHome = path.join(root, 'opencode');
    const sessionId = 'a24f3ce2-445d-4f9d-9e81-7efda745d234';
    const sessionTimestamp = '2026-06-10T23:23:00.000Z';
    const lastRecordTimestamp = '2026-06-11T00:25:00.000Z';
    const sourcePath = path.join(claudeHome, 'projects', 'work-project', `${sessionId}.jsonl`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'file-history-snapshot', sessionId, cwd: '/work/project' }),
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/work/project',
        timestamp: sessionTimestamp,
        message: { role: 'user', content: 'question from Claude' },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-06-10T23:24:00.000Z',
      }),
      JSON.stringify({
        type: 'attachment',
        sessionId,
        cwd: '/work/project',
        timestamp: lastRecordTimestamp,
      }),
    ].join('\n') + '\n');
    const fileMtime = new Date('2020-01-01T00:00:00.000Z');
    await utimes(sourcePath, fileMtime, fileMtime);
    const [summary] = await listSessions('claude', claudeHome);
    expect(summary?.timestamp).toBe(lastRecordTimestamp);

    const plan = await planConversion('claude', 'opencode', sessionId, { sourceHome: claudeHome, targetHome: openCodeHome });
    expect(plan.source.timestamp).toBe(sessionTimestamp);
    expect(plan.targetId).toMatch(/^ses_/);
    const piPlan = await planConversion('claude', 'pi', sessionId, {
      sourceHome: claudeHome,
      targetHome: path.join(root, '.pi', 'agent'),
      piDcpHome: path.join(root, '.pi-dcp'),
    });
    expect(piPlan.records).toHaveLength(2);
    expect(piPlan.services).toHaveLength(1);
    await writeConversion(plan);
    const exportedData = JSON.parse(await readFile(plan.destination, 'utf8')) as {
      info: { directory: string };
      messages: Array<{ parts: Array<{ text?: string }> }>;
    };
    expect(exportedData.info.directory).toBe('/work/project');
    expect(exportedData.messages[0]?.parts[0]?.text).toBe('question from Claude');
  });

  it('converts Pi sessions to Codex rollout records', async () => {
    const root = await tempDir();
    const piHome = path.join(root, '.pi', 'agent');
    const codexHome = path.join(root, '.codex');
    const sessionId = '019f0c75-250d-7a48-ad78-92c861c3c49e';
    const sourcePath = path.join(piHome, 'sessions', '--work-project--', `2026-06-10T23-22-58-000Z_${sessionId}.jsonl`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-06-10T23:22:58.000Z', cwd: '/work/project' }),
      JSON.stringify({
        type: 'message',
        id: '00000001',
        parentId: null,
        timestamp: '2026-06-10T23:23:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'question from Pi' }] },
      }),
    ].join('\n') + '\n');

    const plan = await planConversion('pi', 'codex', sessionId, { sourceHome: piHome, targetHome: codexHome });
    expect(plan.targetId).toBe(sessionId);
    expect(plan.records[0]?.type).toBe('session_meta');
    expect(plan.records[1]?.payload).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'question from Pi' }],
    });
  });
});
