import type {Provider} from '../types.js';
import type {AbstractAgent} from './abstract-agent.js';
import {ClaudeAgent} from './claude-agent.js';
import {CodexAgent} from './codex-agent.js';
import {OpenCodeAgent} from './opencode-agent.js';
import {PiAgent} from './pi-agent.js';

const agents = {
    codex: new CodexAgent(),
    pi: new PiAgent(),
    opencode: new OpenCodeAgent(),
    claude: new ClaudeAgent(),
} satisfies Record<Provider, AbstractAgent>;

export const PROVIDERS = Object.freeze(Object.keys(agents) as Provider[]);

export class AgentRegistry {
    static get(provider: Provider): AbstractAgent {
        return agents[provider];
    }

    static all(): readonly AbstractAgent[] {
        return PROVIDERS.map((provider) => agents[provider]);
    }
}
