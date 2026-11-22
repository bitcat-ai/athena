/** Real host approval, agent-browser, Chrome and screencast; no model turn. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { webFixture } from './web-fixture';

const frames: number[] = [];
const f = await webFixture('/lab', () => frames.push(performance.now()));
try {
  const { page } = await f.begin('script-receipt');
  for (let i = 0; i < 4; i++) {
    frames.length = 0;
    const label = 'Changed ' + i,
      colour = i % 2 ? 'red' : 'blue',
      start = performance.now();
    const result = await f.call('web_evaluate_in_page', {
      page,
      code: `const heading=document.querySelector('h1');heading.textContent=${JSON.stringify(label)};heading.style.backgroundColor=${JSON.stringify(colour)};return heading.textContent;`,
    });
    const receiptMs = Math.round(performance.now() - start);
    assert(result.text.includes(label));
    await delay(Math.max(0, start + 1050 - performance.now()));
    const samples = frames.filter((t) => t >= start + 150 && t <= start + 1050);
    const intervals = samples
      .slice(1)
      .map((t, i) => t - samples[i])
      .sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        round: i + 1,
        receiptMs,
        hostCaptureFps: Number((samples.length / 0.9).toFixed(1)),
        p95FrameIntervalMs: intervals[Math.floor(intervals.length * 0.95)],
      }),
    );
    assert.equal(await f.state("document.querySelector('h1').textContent"), label);
    await delay(1000);
  }
} finally {
  await f.cleanup();
}
