import path from 'node:path';
import { buildRecords } from './builders.js';
import { MessageExtractor } from './extractors.js';
import { destinationPath, defaultHome, defaultPiDcpHome, isUuid, SessionIdFactory } from './paths.js';
import { loadSession } from './session-storages.js';
import type { ConversionPlan, ConversionService, Provider } from './types.js';
import { writeJson, writeJsonl } from './jsonl.js';

export interface PlanOptions {
  sourceHome?: string;
  targetHome?: string;
  piDcpHome?: string;
  targetId?: string;
  preserveIds?: boolean;
}

const extractor = new MessageExtractor();

export async function planConversion(
  source: Provider,
  target: Provider,
  sessionId: string,
  options: PlanOptions = {},
): Promise<ConversionPlan> {
  if (source === target) throw new Error('Source and target providers must be different');
  const sourceSession = await loadSession(source, sessionId, options.sourceHome ?? defaultHome(source));
  const messages = extractor.extract(sourceSession);
  const idFactory = new SessionIdFactory(options.preserveIds ?? true);
  let targetId = options.targetId ?? idFactory.create(sourceSession.sessionId);
  if (target === 'codex' && !isUuid(targetId)) targetId = idFactory.createCodex('');
  if (target === 'opencode' && !targetId.startsWith('ses_')) targetId = idFactory.createOpenCode('', sourceSession.timestamp);
  const targetHome = options.targetHome ?? defaultHome(target);
  const services: ConversionService[] = target === 'pi'
    ? [buildPiDcpService(targetId, options.piDcpHome ?? defaultPiDcpHome())]
    : [];
  return {
    source: sourceSession,
    target,
    targetId,
    destination: await destinationPath(target, targetHome, targetId, sourceSession.cwd, sourceSession.timestamp),
    records: buildRecords(target, targetId, sourceSession.cwd, sourceSession.timestamp, messages),
    messages,
    services,
  };
}

export async function writeConversion(plan: ConversionPlan, overwrite = false): Promise<void> {
  switch (plan.target) {
    case 'opencode': {
      const exportObject = plan.records[0];
      if (!exportObject) throw new Error(`${plan.target} conversion produced no export record`);
      await writeJson(plan.destination, exportObject, overwrite);
      break;
    }
    case 'codex':
    case 'pi':
    case 'claude':
      await writeJsonl(plan.destination, plan.records, overwrite);
      break;
  }
  for (const service of plan.services) {
    await writeJson(service.destination, service.content, overwrite);
  }
}

function buildPiDcpService(sessionId: string, home: string): ConversionService {
  return {
    destination: path.join(home, 'sessions', `${sessionId}.json`),
    content: {
      version: 1,
      sessionId,
      savedAt: 0,
      nextCompressionId: 1,
      turnIndex: 0,
      compressions: [],
      dedupedCallIds: [],
      purgedErrorCallIds: [],
      appliedCompressionTargets: [],
      erroredAt: [],
      stats: {
        dedupPruned: 0,
        errorInputsPurged: 0,
        compressionsApplied: 0,
        tokensSaved: 0,
      },
    },
  };
}
