import kimi from './assets/agents/kimi-color.svg';
import codex from './assets/agents/codex-color.svg';
import claude from './assets/agents/claudecode-color.svg';
import opencode from './assets/agents/opencode.svg';
import gemini from './assets/agents/geminicli-color.svg';
import pi from './assets/agents/pi.svg';
import cursor from './assets/agents/cursor.svg';
import type { AgentId } from '../shared/types';
import { TerminalIcon } from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';

const marks: Record<AgentId, string> = { codex, claude, opencode, gemini, pi, cursor, kimi };

export function AgentIcon({ agent, size = 20 }: { agent: AgentId; size?: number }) {
  if (!marks[agent])
    return <Icon icon={TerminalIcon} size={size} className="agent-icon" aria-hidden />;
  return (
    <img
      className="agent-icon"
      data-agent={agent}
      src={marks[agent]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}
