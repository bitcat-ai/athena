import assert from 'node:assert/strict';
import test from 'node:test';
import { startBuildPlatform, type BuildProof } from './frontend-build-fixture';

test('mock platform validates names and reflects real build failures without duplicate execution', async () => {
  let finish!: (proof: BuildProof) => void;
  const platform = await startBuildPlatform(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const post = async (route: string, value: unknown) => {
    const response = await fetch(platform.url + '/api/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    const fields = {
      name: 'demo-app',
      level: 'P2',
      group: 'demo',
      owner: 'demo',
      tester: 'demo',
      alerts: 'demo',
      language: 'JS',
      repository: 'https://git.example.test/demo/wrong.git',
      description: 'demo',
      deployment: 'static',
      environment: 'QA',
    };
    assert.equal((await post('applications', fields)).status, 400);
    const application = (
      await post('applications', {
        ...fields,
        repository: 'https://git.example.test/demo/demo-app.git',
      })
    ).body;
    assert.equal(
      (
        await post('plans', {
          applicationId: application.id,
          branch: 'main',
          type: 'frontend',
          environment: 'production',
        })
      ).status,
      400,
    );
    const plan = (
      await post('plans', {
        applicationId: application.id,
        branch: 'main',
        type: 'frontend',
        environment: 'QA',
      })
    ).body;
    const first = await post('builds', { planId: plan.id });
    const repeated = await post('builds', { planId: plan.id });
    assert.equal(first.body.status, 'running');
    assert.equal(first.body.id, repeated.body.id);
    assert.equal(platform.buildInvocations, 1);
    finish({ exitCode: 7, logs: 'actual compiler failure' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(platform.builds[0].status, 'failed');
    assert.equal(platform.builds[0].previewUrl, undefined);
    const rejected = await fetch(platform.url + '/api/builds', {
      method: 'POST',
      headers: { origin: 'https://other.example', 'content-type': 'application/json' },
      body: JSON.stringify({ planId: plan.id }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await platform.close();
  }
});
