import { BrowserWindow, session } from 'electron';
import { randomUUID, X509Certificate } from 'node:crypto';
import { shareInvitation } from '../shared/share';

const guests = new Set<BrowserWindow>();

/** A guest views the host's existing web client in a separate, unprivileged browser session. */
export async function openShareGuest(link: string, certificate: string) {
  const invite = shareInvitation(link, certificate);
  const isolated = session.fromPartition('share-guest-' + randomUUID(), { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setCertificateVerifyProc((request, reply) => {
    let pinned = false;
    try {
      pinned =
        request.hostname === invite.hostname &&
        new X509Certificate(request.certificate.data).fingerprint256.replace(/:/g, '') ===
          invite.fingerprint;
    } catch {
      /* A missing or invalid certificate cannot identify the host. */
    }
    reply(pinned ? 0 : -2);
  });
  isolated.webRequest.onBeforeRequest((request, reply) => {
    const url = new URL(request.url);
    const allowed =
      url.origin === invite.origin ||
      (url.protocol === 'wss:' && 'https://' + url.host === invite.origin) ||
      ['data:', 'blob:'].includes(url.protocol);
    reply({ cancel: !allowed });
  });
  isolated.on('will-download', (e) => e.preventDefault());
  const guest = new BrowserWindow({
    title: 'Athena · 加入共享',
    width: 1100,
    height: 740,
    minWidth: 460,
    minHeight: 420,
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guests.add(guest);
  guest.once('closed', () => {
    guests.delete(guest);
    isolated.setCertificateVerifyProc(null);
    isolated.webRequest.onBeforeRequest(null);
  });
  guest.webContents.on('will-navigate', (e) => e.preventDefault());
  guest.webContents.on('will-redirect', (e) => e.preventDefault());
  const timer = setTimeout(() => {
    if (!guest.isDestroyed()) guest.destroy();
  }, 15_000);
  try {
    await guest.loadURL(invite.url);
    guest.show();
    return true;
  } catch {
    if (!guest.isDestroyed()) guest.destroy();
    throw new Error('连接共享页面失败，请核对网络、主持人状态和证书指纹');
  } finally {
    clearTimeout(timer);
  }
}
