import { AgentRegistry } from './agents/agent-registry.js';
import type { AgentConversionOptions } from './agents/abstract-agent.js';
import type { ConversionPlan, ConversionService, Provider } from './types.js';
import { writeJson } from './jsonl.js';

export interface PlanOptions {
    sourceHome?: string;
    targetHome?: string;
    piDcpHome?: string;
    targetId?: string;
    preserveIds?: boolean;
}

export async function planConversion(
    source: Provider,
    target: Provider,
    sessionId: string,
    options: PlanOptions = {},
): Promise<ConversionPlan> {
    if (source === target) throw new Error('Source and target providers must be different');
    const sourceAgent = AgentRegistry.get(source);
    const targetAgent = AgentRegistry.get(target);
    const sourceSession = await sourceAgent.loadSession(
        sessionId,
        options.sourceHome ?? sourceAgent.defaultHome(),
    );
    const messages = sourceAgent.extractMessages(sourceSession);
    const targetId = targetAgent.createSessionId(
        options.targetId ?? sourceSession.sessionId,
        sourceSession.timestamp,
        options.preserveIds ?? true,
    );
    const targetHome = options.targetHome ?? targetAgent.defaultHome();
    const agentOptions: AgentConversionOptions = {
        ...(options.piDcpHome !== undefined ? { piDcpHome: options.piDcpHome } : {}),
    };
    const services: ConversionService[] = targetAgent.buildServices(targetId, agentOptions);
    return {
        source: sourceSession,
        target,
        targetId,
        destination: targetAgent.destinationPath(targetHome, targetId, sourceSession.cwd, sourceSession.timestamp),
        records: targetAgent.buildRecords(targetId, sourceSession.cwd, sourceSession.timestamp, messages),
        messages,
        services,
    };
}

export async function writeConversion(plan: ConversionPlan, overwrite = false): Promise<void> {
    await AgentRegistry.get(plan.target).writeSession(plan.destination, plan.records, overwrite);
    for (const service of plan.services) {
        await writeJson(service.destination, service.content, overwrite);
    }
}
