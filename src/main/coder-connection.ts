import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoderApi, coderOrigin, type CoderFetch } from './coder-api';
import type { CoderAccess } from './coder-sandbox';
import type { CoderTemplateView, SandboxCoderState } from '../shared/sandbox';

export interface CoderConnectionOptions {
  /** Where the connection is kept; the token is in it only in encrypted form. */
  file: string;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
  fetch?: CoderFetch;
}
interface Saved {
  origin: string;
  username: string;
  /** Encrypted, or in the clear while the connection is not stored (see `connect`). */
  token: string;
  stored: boolean;
}

/** The one Coder deployment and account this profile creates sandboxes on. */
export class CoderConnection {
  private saved?: Saved;
  private token?: Promise<string>;
  constructor(private options: CoderConnectionOptions) {}

  /** Reads the stored address and account. The token is decrypted when it is first needed. */
  async load() {
    try {
      const value = JSON.parse(await readFile(this.options.file, 'utf8'));
      if (
        typeof value?.origin === 'string' &&
        typeof value.username === 'string' &&
        typeof value.token === 'string'
      )
        this.saved = {
          origin: coderOrigin(value.origin),
          username: value.username,
          token: value.token,
          stored: true,
        };
    } catch {
      // Nothing stored, or nothing usable: the settings page asks for the connection again.
    }
  }
  connection(): Pick<SandboxCoderState, 'connected' | 'origin' | 'username' | 'insecure'> {
    if (!this.saved) return { connected: false };
    const { origin, username } = this.saved;
    return { connected: true, origin, username, insecure: origin.startsWith('http://') };
  }
  /** Address and token for a request, or nothing while no deployment is connected. */
  access = async (): Promise<CoderAccess | undefined> => {
    const saved = this.saved;
    if (!saved) return undefined;
    this.token ??= saved.stored
      ? this.options.decrypt(saved.token).catch(() => {
          this.token = undefined;
          throw new Error('无法读取已保存的 Coder 令牌，请在「设置 › 沙箱」重新填写');
        })
      : Promise.resolve(saved.token);
    return { origin: saved.origin, token: await this.token };
  };
  private api(access: CoderAccess) {
    return new CoderApi(access.origin, access.token, this.options.fetch ?? fetch);
  }

  /**
   * Checks the address and the token against the deployment and keeps them. While connected,
   * only the token of the same account can be replaced, because the sandboxes on the list
   * belong to that account. Without `remember` the connection lasts for this run only.
   */
  async connect(address: unknown, token: unknown, remember = true) {
    if (typeof address !== 'string' || !address.trim()) throw new Error('请填写 Coder 地址');
    if (typeof token !== 'string' || !token.trim() || token.length > 500)
      throw new Error('请填写 Coder 令牌');
    const access = { origin: coderOrigin(address), token: token.trim() };
    const { username } = await this.api(access).me();
    if (this.saved && (this.saved.origin !== access.origin || this.saved.username !== username))
      throw new Error('已连接到另一个 Coder 地址或账号，请先断开当前连接');
    const saved: Saved = {
      origin: access.origin,
      username,
      token: remember ? await this.options.encrypt(access.token) : access.token,
      stored: remember,
    };
    if (remember) {
      const { stored: _, ...content } = saved;
      await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
      await writeFile(`${this.options.file}.tmp`, JSON.stringify({ version: 1, ...content }), {
        mode: 0o600,
      });
      await rename(`${this.options.file}.tmp`, this.options.file);
    }
    this.saved = saved;
    this.token = Promise.resolve(access.token);
  }
  async disconnect() {
    await rm(this.options.file, { force: true });
    this.saved = undefined;
    this.token = undefined;
  }
  /** The templates a sandbox can be created from. */
  async templates(): Promise<CoderTemplateView[]> {
    const access = await this.access();
    if (!access) return [];
    return (await this.api(access).templates())
      .filter((template) => !template.deprecated)
      .map((template) => ({ id: template.id, name: template.display_name || template.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
