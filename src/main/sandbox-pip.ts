import type { SandboxPipState } from '../shared/sandbox';

export interface PipTarget {
  conversationId: string;
  /** A built-in target or the id of an instance the user created; see `sandboxKey`. */
  target: string;
}

export const pipKey = (target: PipTarget) => `${target.conversationId}:${target.target}`;

export interface SandboxPipOptions {
  /** Builds what the preview shows for a target. */
  state: (target: PipTarget) => Omit<SandboxPipState, 'conversationId'>;
  publish: (states: SandboxPipState[]) => void;
  onVisible: () => void;
}

/**
 * Codex-style picture-in-picture for the anonymous sandbox, shown inside the Athena window.
 * It opens on its own when the agent starts working in a sandbox; closing it lasts for the
 * current turn only, and the topbar entry reopens it.
 */
export class SandboxPip {
  private targets = new Map<string, PipTarget>();
  private dismissed = new Set<string>();
  private pending?: NodeJS.Timeout;

  constructor(private readonly options: SandboxPipOptions) {}

  get current() {
    return [...this.targets.values()];
  }

  /** A new turn may show the preview again even if the user closed it last time. */
  resetDismissal(conversationId: string) {
    for (const key of this.dismissed)
      if (key.startsWith(conversationId + ':')) this.dismissed.delete(key);
  }

  /** Opens automatically for agent activity, unless dismissed during this turn. */
  autoOpen(target: PipTarget) {
    if (!this.dismissed.has(pipKey(target))) this.open(target);
  }

  open(target: PipTarget) {
    const key = pipKey(target);
    this.dismissed.delete(key);
    const changed = !this.targets.has(key);
    this.targets.set(key, target);
    if (changed) this.options.onVisible();
    this.update();
  }

  /** Pushes fresh state, coalesced so streaming output does not flood the renderer. */
  update() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.options.publish(
        this.current.map((target) => ({
          conversationId: target.conversationId,
          ...this.options.state(target),
        })),
      );
    }, 80);
  }

  dismiss(target: PipTarget) {
    const key = pipKey(target);
    this.dismissed.add(key);
    this.targets.delete(key);
    this.update();
    this.options.onVisible();
  }

  hide() {
    clearTimeout(this.pending);
    this.pending = undefined;
    if (this.targets.size) {
      this.targets.clear();
      this.options.publish([]);
      this.options.onVisible();
    }
  }
}
