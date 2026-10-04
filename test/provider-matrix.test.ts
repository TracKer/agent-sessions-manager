import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planConversion, writeConversion } from '../src/converter.js';
import { AgentRegistry, PROVIDERS } from '../src/agents/agent-registry.js';
import type { Provider } from '../src/types.js';

const roots: string[] = [];
const expectedMessages = [
  ['user', 'Matrix prompt'],
  ['assistant', 'Matrix reply'],
];

interface Fixture {
  home: string;
  sessionId: string;
}

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-matrix-'));
  roots.push(root);
  return root;
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('supported providers', () => {
  it('registers only Codex, Pi, OpenCode, and Claude', () => {
    expect(PROVIDERS).toEqual(['codex', 'pi', 'opencode', 'claude']);
  });

  it('converts and reloads sessions in all 12 directed provider pairs', async () => {
    const root = await tempDirectory();
    const timestamp = '2026-07-01T15:00:00.000Z';
    const userTimestamp = '2026-07-01T15:00:01.000Z';
    const assistantTimestamp = '2026-07-01T15:00:02.000Z';
    const codexId = '01234567-89ab-cdef-8123-456789abcdef';
    const piId = '019f0c75-250d-7a48-ad78-92c861c3c49e';
    const openCodeId = 'ses_9d9ddbe00001aaaaaaaaaaaaaa';
    const claudeId = 'a24f3ce2-445d-4f9d-9e81-7efda745d234';
    const fixtures: Record<Provider, Fixture> = {
      codex: { home: path.join(root, 'sources', 'codex'), sessionId: codexId },
      pi: { home: path.join(root, 'sources', 'pi'), sessionId: piId },
      opencode: { home: path.join(root, 'sources', 'opencode'), sessionId: openCodeId },
      claude: { home: path.join(root, 'sources', 'claude'), sessionId: claudeId },
    };

    await writeJsonl(path.join(
      fixtures.codex.home,
      'sessions',
      '2026',
      '07',
      '01',
      `rollout-2026-07-01T15-00-00-${codexId}.jsonl`,
    ), [
      {
        timestamp,
        type: 'session_meta',
        payload: { id: codexId, timestamp, cwd: '/matrix/work' },
      },
      {
        timestamp: userTimestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Matrix prompt' }] },
      },
      {
        timestamp: assistantTimestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Matrix reply' }] },
      },
    ]);
    await writeJsonl(path.join(
      fixtures.pi.home,
      'sessions',
      '--matrix-work--',
      `${timestamp.replace(/[:.]/g, '-')}_${piId}.jsonl`,
    ), [
      { type: 'session', version: 3, id: piId, timestamp, cwd: '/matrix/work' },
      {
        type: 'message',
        id: '00000001',
        timestamp: userTimestamp,
        message: { role: 'user', content: [{ type: 'text', text: 'Matrix prompt' }] },
      },
      {
        type: 'message',
        id: '00000002',
        parentId: '00000001',
        timestamp: assistantTimestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Matrix reply' }] },
      },
    ]);
    const openCodePath = path.join(fixtures.opencode.home, 'session-export', `${openCodeId}.json`);
    await mkdir(path.dirname(openCodePath), { recursive: true });
    await writeFile(openCodePath, JSON.stringify({
      info: {
        id: openCodeId,
        directory: '/matrix/work',
        title: 'Matrix prompt',
        time: { created: Date.parse(timestamp), updated: Date.parse(assistantTimestamp) },
      },
      messages: [
        {
          info: { id: 'msg_9d9ddbe00001bbbbbbbbbbbbbb', role: 'user', time: { created: Date.parse(userTimestamp) } },
          parts: [{ type: 'text', text: 'Matrix prompt' }],
        },
        {
          info: {
            id: 'msg_9d9ddbe00001cccccccccccccc',
            role: 'assistant',
            modelID: 'fixture-model',
            providerID: 'fixture-provider',
            time: { created: Date.parse(assistantTimestamp) },
          },
          parts: [{ type: 'text', text: 'Matrix reply' }],
        },
      ],
    }));
    await writeJsonl(path.join(fixtures.claude.home, 'projects', 'matrix-work', `${claudeId}.jsonl`), [
      {
        type: 'user',
        sessionId: claudeId,
        cwd: '/matrix/work',
        timestamp: userTimestamp,
        message: { role: 'user', content: 'Matrix prompt' },
      },
      {
        type: 'assistant',
        sessionId: claudeId,
        cwd: '/matrix/work',
        timestamp: assistantTimestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Matrix reply' }], model: 'fixture-model' },
      },
    ]);

    const coveredPairs: string[] = [];
    for (const source of PROVIDERS) {
      const sourceAgent = AgentRegistry.get(source);
      const sourceSession = await sourceAgent.loadSession(fixtures[source].sessionId, fixtures[source].home);
      expect(sourceAgent.getSessionTitle(sourceSession), `${source} session title`).toBe('Matrix prompt');

      for (const target of PROVIDERS) {
        if (source === target) continue;
        const sourceFixture = fixtures[source];
        const targetHome = path.join(root, 'outputs', `${source}-to-${target}`);
        const plan = await planConversion(source, target, sourceFixture.sessionId, {
          sourceHome: sourceFixture.home,
          targetHome,
          piDcpHome: path.join(root, 'dcp', `${source}-to-${target}`),
        });

        expect(plan.messages.map(({ role, text }) => [role, text]), `${source} -> ${target} input`).toEqual(expectedMessages);
        await writeConversion(plan);
        const imported = await AgentRegistry.get(target).loadSession(plan.targetId, targetHome);
        expect(imported.cwd, `${source} -> ${target} cwd`).toBe('/matrix/work');
        expect(AgentRegistry.get(target).extractMessages(imported).map(({ role, text }) => [role, text]), `${source} -> ${target} output`)
          .toEqual(expectedMessages);
        coveredPairs.push(`${source}->${target}`);
      }
    }

    expect(new Set(coveredPairs).size).toBe(12);
  });
});
