/** Local WebRTC peers with a synthetic microphone. No provider accounts or model calls. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { transform } from 'esbuild';
import { uiBrowserExecutable } from './ui-browser';

const source = await readFile('src/renderer/live-voice-client.ts', 'utf8');
const bundle = await transform(source + '\nwindow.VoiceClient = LiveVoiceClient;', {
  loader: 'ts',
  format: 'iife',
});
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-mock-keychain',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
});
try {
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1/session', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><title>Local WebRTC test</title></html>',
    }),
  );
  await page.goto('http://127.0.0.1/session');
  await page.addScriptTag({ content: bundle.code });
  await page.evaluate(() => {
    const fixture: any = ((window as any).testCall = {
      calls: [],
      events: [],
      states: [],
      input: 0,
      output: 0,
      didOverlap: false,
      tracks: [],
      contexts: [],
    });
    const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (fixture.denied) throw new DOMException('denied', 'NotAllowedError');
      const stream = await media(constraints);
      fixture.tracks.push(...stream.getTracks());
      if (fixture.holdMedia)
        await new Promise((resolve) => {
          fixture.releaseMedia = resolve;
        });
      return stream;
    };
    fixture.signal = (data: unknown) => fixture.channel.send(JSON.stringify(data));
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor() {
        super();
        fixture.contexts.push(this);
      }
    };
    fixture.client = new (window as any).VoiceClient(
      (state: unknown) => {
        fixture.state = state;
        fixture.states.push(state);
      },
      {
        async invoke(action: string, payload: any) {
          fixture.calls.push({ action, payload });
          if (action === 'voice:connect') {
            const peer = (fixture.peer = new RTCPeerConnection());
            peer.ondatachannel = ({ channel }) => {
              fixture.channel = channel;
              channel.onopen = () => fixture.signal({ type: 'session.started' });
              channel.onmessage = ({ data }) => {
                const event = JSON.parse(data);
                fixture.events.push(event);
                if (event.type === 'session.close')
                  fixture.signal({
                    type: 'session.closed',
                    usage: { seconds: 8 },
                    reason: 'requested',
                  });
              };
            };
            await peer.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            const context = (fixture.outputContext = new AudioContext());
            const oscillator = context.createOscillator(),
              gain = context.createGain(),
              dest = context.createMediaStreamDestination();
            gain.gain.value = 0.09;
            oscillator.connect(gain);
            gain.connect(dest);
            oscillator.start();
            await context.resume();
            peer.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
            await peer.setLocalDescription(await peer.createAnswer());
            await new Promise<void>((resolve) => {
              const check = () => {
                if (peer.iceGatheringState === 'complete') {
                  peer.removeEventListener('icegatheringstatechange', check);
                  resolve();
                }
              };
              peer.addEventListener('icegatheringstatechange', check);
              check();
            });
            return { sessionId: 'fixture', sdp: peer.localDescription!.sdp };
          }
          if (action === 'voice:delegate') {
            if (fixture.holdTask)
              await new Promise((resolve) => {
                fixture.releaseTask = resolve;
              });
            return '已读到本地结果。';
          }
          if (action === 'voice:disconnect') {
            if (fixture.failHangup) throw Error('未确认远端通话结束');
            fixture.peer?.close();
            if (fixture.outputContext && fixture.outputContext.state !== 'closed')
              await fixture.outputContext.close();
            return true;
          }
          throw Error('Unexpected IPC ' + action);
        },
      },
      (input: number, output: number) => {
        fixture.input = input;
        fixture.output = output;
        if (input > 0.01 && output > 0.01) fixture.didOverlap = true;
      },
    );
  });
  const wait = (condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: 15000 }).catch(async (error) => {
      console.error(
        condition,
        await page.evaluate(() => {
          const f = (window as any).testCall;
          return {
            state: f.state?.status,
            error: f.state?.error,
            levels: [f.input, f.output],
            peers: f.peer?.connectionState,
            events: f.events,
            actions: f.calls.map((c: any) => c.action),
          };
        }),
      );
      throw error;
    });
  await page.evaluate(() => (window as any).testCall.client.start('conversation'));
  await wait('testCall.state.status==="connected" && testCall.didOverlap');
  await page.evaluate(() => (window as any).testCall.client.mute());
  await wait(
    'testCall.events.some(e=>e.type==="session.input_audio.mute") && testCall.state.muted && !testCall.tracks[0].enabled && testCall.input===0 && testCall.output>0',
  );
  await page.evaluate(() => (window as any).testCall.client.mute());
  await wait(
    'testCall.events.some(e=>e.type==="session.input_audio.unmute") && testCall.tracks[0].enabled',
  );
  await page.evaluate(() => {
    const f = (window as any).testCall;
    f.signal({
      event_id: 'one',
      type: 'session.input_transcript.delta',
      delta: '读取当前页',
      start_ms: 0,
      end_ms: 800,
    });
    f.signal({
      event_id: 'one',
      type: 'session.input_transcript.delta',
      delta: '读取当前页',
      start_ms: 0,
      end_ms: 800,
    });
    f.signal({
      type: 'session.delegation.created',
      delegation: { id: 'tool', target: 'client' },
      offset_ms: 800,
    });
  });
  await wait(
    'testCall.events.some(e=>e.type==="session.commentary.append" && e.content.includes("已读到本地结果")) && !testCall.events.some(e=>e.type==="session.thinking.append")',
  );
  assert.deepEqual(
    await page.evaluate(() => {
      const f = (window as any).testCall;
      return [
        f.state.transcripts.length,
        f.state.tasks,
        f.calls.filter((c: any) => c.action === 'voice:delegate').length,
      ];
    }),
    [1, 0, 1],
  );
  await page.evaluate(() => {
    const f = (window as any).testCall;
    f.holdTask = true;
    f.signal({
      type: 'session.delegation.created',
      delegation: { id: 'interrupted', target: 'client' },
      offset_ms: 900,
    });
  });
  await wait('typeof testCall.releaseTask==="function"');
  await page.evaluate(() => (window as any).testCall.client.stop());
  await page.evaluate(() => (window as any).testCall.releaseTask());
  await wait(
    'testCall.state.status==="idle" && testCall.tracks.every(t=>t.readyState==="ended") && testCall.contexts.every(c=>c.state==="closed")',
  );
  assert.equal(
    await page.evaluate(() =>
      (window as any).testCall.events.some((e: any) => e.delegation_id === 'interrupted'),
    ),
    false,
  );
  await page.evaluate(async () => {
    const f = (window as any).testCall;
    f.denied = true;
    await f.client.start('conversation');
  });
  await wait(
    'testCall.state.error.includes("麦克风") && testCall.state.status==="idle" && !testCall.client.needsHangup',
  );
  await page.evaluate(() => {
    const f = (window as any).testCall;
    f.denied = false;
    f.holdMedia = true;
    void f.client.start('conversation');
  });
  await wait('typeof testCall.releaseMedia==="function"');
  await page.evaluate(async () => {
    const f = (window as any).testCall;
    await f.client.stop();
    f.releaseMedia();
  });
  await wait(
    'testCall.tracks.every(t=>t.readyState==="ended") && testCall.calls.filter(c=>c.action==="voice:connect").length===1',
  );

  await page.evaluate(async () => {
    const f = (window as any).testCall;
    const original = window.RTCPeerConnection;
    try {
      (window as any).RTCPeerConnection = class {
        constructor() {
          throw new Error('WebRTC unavailable');
        }
      };
      await f.client.start('conversation');
    } finally {
      window.RTCPeerConnection = original;
    }
  });
  await wait('testCall.state.status==="idle" && testCall.state.error.includes("WebRTC")');
  await page.evaluate(async () => {
    const f = (window as any).testCall;
    f.holdMedia = false;
    await f.client.start('conversation');
  });
  await wait('testCall.state.status==="connected"');
  await page.evaluate(async () => {
    const f = (window as any).testCall;
    f.failHangup = true;
    const send = RTCDataChannel.prototype.send;
    try {
      RTCDataChannel.prototype.send = function () {
        throw new DOMException('closed', 'InvalidStateError');
      };
      await f.client.stop();
    } finally {
      RTCDataChannel.prototype.send = send;
    }
  });
  await wait(
    'testCall.state.error.includes("未确认远端通话结束") && testCall.client.needsHangup && testCall.tracks.every(t=>t.readyState==="ended")',
  );
  await page.evaluate(async () => {
    const f = (window as any).testCall;
    f.failHangup = false;
    await f.client.stop();
  });
  await wait('!testCall.client.needsHangup && testCall.contexts.every(c=>c.state==="closed")');
  assert.deepEqual(errors, []);
  console.log(
    'WebRTC delivered simultaneous input/output, mute/unmute, transcript deduplication and one task result; hangup released media and suppressed late results. Denied, cancelled and unavailable devices stayed idle.',
  );
} finally {
  await browser.close();
}
