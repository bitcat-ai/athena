import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, Recording, Settings } from '../shared/types';
import type { OnboardingProgress } from '../shared/onboarding';

export interface StoredData {
  settings: Settings;
  conversations: Conversation[];
  recordings: Recording[];
  onboarding?: OnboardingProgress;
}
export class Store {
  data: StoredData;
  existingData = false;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  constructor(private directory: string) {
    this.data = {
      settings: { workspace: path.join(directory, 'workspace'), agent: 'codex' },
      conversations: [],
      recordings: [],
      onboarding: { version: 1, status: 'in-progress', stage: 'welcome', required: true },
    };
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.directory, 'workspace.json'), 'utf8'),
      );
      if (
        !parsed?.settings ||
        typeof parsed.settings.workspace !== 'string' ||
        !Array.isArray(parsed.conversations) ||
        !Array.isArray(parsed.recordings)
      )
        throw new Error('工作区数据格式不正确');
      this.data = parsed;
      this.existingData = true;
      for (const conversation of this.data.conversations)
        for (const message of conversation.messages)
          if (message.status === 'streaming') {
            message.status = 'error';
            // The turn died with the app; whatever it was doing is no longer in progress.
            message.phase = { kind: 'ended', outcome: 'failed' };
            message.failure ??= '应用已重启，这一轮没有完成。';
            for (const tool of message.tools ?? [])
              if (tool.status === 'running') {
                tool.status = 'error';
                tool.output = '应用已重启，此操作结果未知；重新执行前需检查实际状态。';
              }
            if (message.execution)
              message.execution.push({
                id: randomUUID(),
                taskId: message.id,
                at: Date.now(),
                kind: 'finished',
                status: 'failed',
                summary: '应用已重启，上一轮结果未核对',
              });
          }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Loading metadata never creates or repairs a project directory.
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save().catch(() => {}), 500);
  }
  save() {
    clearTimeout(this.timer);
    const json = JSON.stringify(this.data, null, 2);
    const file = path.join(this.directory, 'workspace.json');
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(`${file}.tmp`, json, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return this.writes;
  }
}
