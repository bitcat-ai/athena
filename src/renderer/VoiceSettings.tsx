import { useEffect, useState } from 'react';
import { Input } from '@heroui/react';
import type { LiveVoiceConfig } from '../shared/live-voice';
import { ActionButton } from './ui';
import { voiceError } from './live-voice-client';
import './voice-settings.css';

export function VoiceSettings({ managedCall = false }: { managedCall?: boolean }) {
  const [config, setConfig] = useState<LiveVoiceConfig>();
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void window.workbench
      .invoke<LiveVoiceConfig>('voice:config')
      .then((result) => {
        if (!disposed) setConfig(result);
      })
      .catch((failure) => {
        if (!disposed) setError(voiceError(failure));
      });
    return () => {
      disposed = true;
    };
  }, [managedCall]);
  const keyLocked = pending || managedCall || !config || config.active;
  const save = async (remove = false) => {
    if (keyLocked) return;
    setPending(true);
    setError('');
    try {
      setConfig(
        await window.workbench.invoke<LiveVoiceConfig>(
          remove ? 'voice:forget' : 'voice:configure',
          remove ? undefined : { key },
        ),
      );
      setKey('');
    } catch (failure) {
      setError(voiceError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="voice-settings" aria-label="语音设置">
      <div className="settings-section-heading">
        <div>
          <h3>与 Athena 语音交流</h3>
          <p>使用 OpenAI GPT-Live，可以边听边说，也可以让当前 Agent 处理任务。</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        aria-busy={pending}
      >
        <label htmlFor="voice-api-key">OpenAI API 密钥</label>
        <Input
          id="voice-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={keyLocked}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={config?.configured ? '输入新密钥以替换' : 'sk-…'}
          aria-describedby="voice-key-note voice-key-error"
        />
        <p id="voice-key-note" className="settings-note">
          密钥加密保存在本机。需要拥有 GPT-Live 使用权限的 OpenAI 项目密钥。
        </p>
        <div className="voice-actions">
          <ActionButton type="submit" variant="primary" isDisabled={keyLocked || !key.trim()}>
            {pending ? '正在保存…' : config?.configured ? '替换密钥' : '保存密钥'}
          </ActionButton>
          {config?.configured && (
            <ActionButton
              variant="secondary"
              isDisabled={keyLocked}
              onPress={() => void save(true)}
            >
              移除密钥
            </ActionButton>
          )}
          <span role="status" className="settings-note">
            {config ? (config.configured ? '已保存' : '未配置') : '正在读取…'}
          </span>
        </div>
        <p id="voice-key-error" role={error ? 'alert' : undefined} className="voice-error">
          {error}
        </p>
      </form>
      {config?.active && !managedCall && (
        <ActionButton
          variant="secondary"
          isDisabled={pending}
          onPress={() => {
            setPending(true);
            void window.workbench
              .invoke('voice:disconnect', {})
              .then(() => window.workbench.invoke<LiveVoiceConfig>('voice:config'))
              .then(setConfig)
              .catch((failure) => setError(voiceError(failure)))
              .finally(() => setPending(false));
          }}
        >
          结束语音通话
        </ActionButton>
      )}
      <p className="settings-note">
        通话音频与转写会发送给 OpenAI。语音按通话时长计费，静音期间也计时。Agent 用量另计。
      </p>
    </section>
  );
}
