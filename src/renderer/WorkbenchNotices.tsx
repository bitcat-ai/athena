import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, CodexUpdateStatus } from '../shared/types';
import { AppNotice } from './AppNotice';

type CodexRelease = Exclude<CodexUpdateStatus, { status: 'unknown' }>;
const dismissedReleaseKey = 'athena.dismissedCodexRelease';

export function useCodexUpdate(agent: AgentInfo | undefined, enabled: boolean) {
  const [release, setRelease] = useState<CodexRelease>();
  const [refreshCount, setRefreshCount] = useState(0);
  const lastRefresh = useRef(refreshCount);

  useEffect(() => {
    setRelease(undefined);
    if (!enabled || !agent?.available || !agent.version) return;
    let latestRequest = 0;
    const check = async (force = false) => {
      if (document.hidden && !force) return;
      const request = ++latestRequest;
      const status = await window.workbench
        .invoke<CodexUpdateStatus>('codex:update-status', { refresh: force })
        .catch(() => undefined);
      if (request === latestRequest)
        setRelease(
          status?.status === 'available' || status?.status === 'current' ? status : undefined,
        );
    };
    void check(refreshCount !== lastRefresh.current);
    lastRefresh.current = refreshCount;
    const onWake = () => void check();
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    const timer = window.setInterval(onWake, 6 * 60 * 60 * 1000);
    return () => {
      latestRequest++;
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.clearInterval(timer);
    };
  }, [enabled, agent?.available, agent?.path, agent?.version, refreshCount]);
  return {
    update: release?.status === 'available' ? release : undefined,
    installedVersion: release?.installedVersion,
    refresh: () => setRefreshCount((count) => count + 1),
  };
}

/** App-level notices only. Requests from a turn live in the conversation that raised them. */
export function WorkbenchNotices({
  update,
  onShowRelease,
}: {
  update?: CodexRelease;
  onShowRelease: (url: string) => void;
}) {
  const [dismissedRelease, setDismissedRelease] = useState(() => {
    try {
      return localStorage.getItem(dismissedReleaseKey);
    } catch {
      return null;
    }
  });
  return (
    <div aria-live="polite" aria-relevant="additions text" className="workbench-notices">
      {update && update.latestVersion !== dismissedRelease && (
        <AppNotice
          title="Codex CLI 有新版本"
          description={`${update.installedVersion} → ${update.latestVersion}`}
          actionLabel="查看更新说明"
          onAction={() => onShowRelease(update.releaseUrl)}
          onDismiss={() => {
            setDismissedRelease(update.latestVersion);
            try {
              localStorage.setItem(dismissedReleaseKey, update.latestVersion);
            } catch {
              /* Session dismissal still applies. */
            }
          }}
        />
      )}
    </div>
  );
}
