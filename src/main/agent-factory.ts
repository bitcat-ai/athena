import type { AgentId } from '../shared/types';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import { CodexSession } from './agents';
import { PiSession } from './pi-session';
import { StreamCliSession } from './stream-cli-session';
import { OpenCodeSession } from './opencode-session';

export function createAgentSession(agent: AgentId, options: AgentSessionOptions): AgentSession {
  if (agent === 'codex') return new CodexSession(options);
  if (agent === 'pi') return new PiSession(options);
  if (agent === 'opencode') return new OpenCodeSession(options);
  if (agent === 'claude' || agent === 'gemini' || agent === 'cursor')
    return new StreamCliSession({ ...options, cli: agent });
  throw new Error('此 CLI 的执行适配尚不可用');
}
