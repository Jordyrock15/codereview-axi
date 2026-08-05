import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from '../helpers/repo.js';
import { startApp } from '../helpers/server.js';

/** @returns {Promise<void>} */
const waitPastIdleTimer = () => new Promise((resolve) => { setTimeout(resolve, 400); });

test('closing the last session with a real repo still open elsewhere does not stop the daemon, but a removed repo does not count as elsewhere', async (t) => {
  const gone = await makeRepo({ 'a.js': 'one\n' });
  t.after(gone.cleanup);
  await gone.write('a.js', 'two\n');

  const stillHere = await makeRepo({ 'b.js': 'one\n' });
  t.after(stillHere.cleanup);
  await stillHere.write('b.js', 'two\n');

  let idled = false;
  const { call } = await startApp(t, { onIdle: () => { idled = true; } });

  const goneSession = (await call('POST', '/api/sessions', { repo: gone.dir, note: 'n' })).json;
  const hereSession = (await call('POST', '/api/sessions', { repo: stillHere.dir, note: 'n' })).json;

  // The repo is gone, but the session left behind for it is still `open`: no
  // tab can ever close it, so it must not count towards keeping the daemon up.
  await gone.cleanup();

  await call('POST', `/api/sessions/${hereSession.key}/close?t=${hereSession.token}`, { closedBy: 'human' });
  await waitPastIdleTimer();

  assert.equal(idled, true, 'an open session whose repo no longer exists must not keep the daemon alive');
  assert.equal((await call('GET', `/api/sessions/${goneSession.key}?t=${goneSession.token}`)).json.status, 'open');
});

test('an open session whose repo does exist still keeps the daemon alive', async (t) => {
  const stillOpen = await makeRepo({ 'a.js': 'one\n' });
  t.after(stillOpen.cleanup);
  await stillOpen.write('a.js', 'two\n');

  const closing = await makeRepo({ 'b.js': 'one\n' });
  t.after(closing.cleanup);
  await closing.write('b.js', 'two\n');

  let idled = false;
  const { call } = await startApp(t, { onIdle: () => { idled = true; } });

  await call('POST', '/api/sessions', { repo: stillOpen.dir, note: 'n' });
  const closingSession = (await call('POST', '/api/sessions', { repo: closing.dir, note: 'n' })).json;

  await call('POST', `/api/sessions/${closingSession.key}/close?t=${closingSession.token}`, { closedBy: 'human' });
  await waitPastIdleTimer();

  assert.equal(idled, false, 'another repo genuinely still open must keep the daemon alive');
});
