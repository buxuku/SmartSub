import { EventEmitter } from 'node:events';
import { setupRendererRecovery } from '../../main/helpers/rendererRecovery';
import { assert, finish, test } from './testkit';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  const contents = Object.assign(new EventEmitter(), {
    reloads: 0,
    isDestroyed: () => false,
    reload() {
      this.reloads++;
    },
  });
  const state = { destroyed: false, quitting: false, prompts: [] as any[] };
  const window = { webContents: contents, isDestroyed: () => state.destroyed };
  let answer: (result: { response: number }) => void;
  setupRendererRecovery(window as any, {
    isQuitting: () => state.quitting,
    language: () => 'zh',
    showMessageBox: async (_parent, options) => {
      state.prompts.push(options);
      return new Promise<{ response: number }>((resolve) => {
        answer = resolve;
      });
    },
  });
  return {
    contents,
    state,
    answer: (response: number) => answer({ response }),
  };
}

async function main() {
  await test('renderer crash offers one recovery prompt and reloads only when selected', async () => {
    const h = harness();
    h.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    h.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(h.state.prompts.length, 1);
    assert.equal(h.contents.reloads, 0);
    assert.match(h.state.prompts[0].buttons[0], /重新加载/);
    h.answer(0);
    await settle();
    assert.equal(h.contents.reloads, 1);
    h.contents.emit('render-process-gone', {}, { reason: 'oom' });
    h.answer(1);
    await settle();
    assert.equal(h.contents.reloads, 1, 'no automatic crash/reload loop');
  });
  await test('an unexpectedly killed renderer also offers recovery', async () => {
    const h = harness();
    h.contents.emit('render-process-gone', {}, { reason: 'killed' });
    assert.equal(h.state.prompts.length, 1);
    h.answer(0);
    await settle();
    assert.equal(h.contents.reloads, 1);
  });
  await test('normal exits and application quit do not prompt', async () => {
    const h = harness();
    h.contents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    h.state.quitting = true;
    h.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(h.state.prompts.length, 0);
  });
  await test('closing a window or quitting while the prompt is open cannot reload it', async () => {
    for (const flag of ['destroyed', 'quitting'] as const) {
      const h = harness();
      h.contents.emit('render-process-gone', {}, { reason: 'crashed' });
      h.state[flag] = true;
      h.answer(0);
      await settle();
      assert.equal(h.contents.reloads, 0);
    }
  });
  finish('renderer recovery');
}
void main();
