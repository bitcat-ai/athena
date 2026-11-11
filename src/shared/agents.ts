import type { AgentId, Conversation, Settings } from './types';
import type { ModelSelection } from './usage';

export const executableAgents = ['codex', 'claude', 'gemini', 'pi', 'cursor'] as const;
export function conversationAgent(conversation: Pick<Conversation, 'agent'>): AgentId {
  return conversation.agent ?? 'codex';
}
export function supportsBrowser(agent: AgentId) {
  return ['codex', 'claude', 'pi', 'cursor'].includes(agent);
}
export function supportsSelectedElement(agent: AgentId) {
  return supportsBrowser(agent);
}
export function agentModelSelection(
  settings: Settings,
  agent: AgentId,
): ModelSelection | undefined {
  return (
    settings.modelSelections?.[agent] ?? (agent === 'codex' ? settings.modelSelection : undefined)
  );
}
export function conversationModelSelection(settings: Settings, conversation: Conversation) {
  return (
    conversation.modelSelection ?? agentModelSelection(settings, conversationAgent(conversation))
  );
}
