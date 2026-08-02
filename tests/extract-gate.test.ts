import { describe, it, expect } from 'vitest';
import { createExtractGate, BusyError } from '../src/extract-gate.js';

/** Работа, которую можно завершить вручную. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Дать очереди микрозадач прокрутиться. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createExtractGate', () => {
  it('пропускает не больше потолка одновременно', async () => {
    const gate = createExtractGate({ concurrency: 2, queueLimit: 8 });
    const d = [deferred<string>(), deferred<string>(), deferred<string>()];
    const runs = d.map((x) => gate.run(() => x.promise));

    await settle();
    expect(gate.active()).toBe(2);
    expect(gate.queued()).toBe(1);

    d[0].resolve('a');
    await settle();
    expect(gate.active()).toBe(2); // слот перешёл третьему, а не освободился
    expect(gate.queued()).toBe(0);

    d[1].resolve('b');
    d[2].resolve('c');
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c']);
    expect(gate.active()).toBe(0);
  });

  it('потолок не превышается, когда новый запрос приходит вместе с пробуждением очереди', async () => {
    const gate = createExtractGate({ concurrency: 2, queueLimit: 8 });
    const d = [deferred<string>(), deferred<string>(), deferred<string>()];
    const runs = d.map((x) => gate.run(() => x.promise));
    await settle();

    // Освобождаем слот и в тот же момент подаём новый запрос: раньше счётчик
    // успевал упасть, вклинившийся видел свободное место, и работающих
    // становилось трое при потолке в два.
    d[0].resolve('a');
    const late = deferred<string>();
    const lateRun = gate.run(() => late.promise);
    await settle();

    expect(gate.active()).toBe(2);
    expect(gate.queued()).toBe(1);

    d[1].resolve('b');
    d[2].resolve('c');
    late.resolve('late');
    expect(await Promise.all([...runs, lateRun])).toEqual(['a', 'b', 'c', 'late']);
    expect(gate.active()).toBe(0);
    expect(gate.queued()).toBe(0);
  });

  it('отказывает, когда очередь переполнена', async () => {
    const gate = createExtractGate({ concurrency: 1, queueLimit: 1 });
    const busy = deferred<string>();
    const first = gate.run(() => busy.promise);
    const queued = gate.run(async () => 'queued');
    await settle();

    await expect(gate.run(async () => 'rejected')).rejects.toBeInstanceOf(BusyError);

    busy.resolve('first');
    expect(await first).toBe('first');
    expect(await queued).toBe('queued');
  });

  it('отказ работы освобождает слот, а не запирает пропускник', async () => {
    const gate = createExtractGate({ concurrency: 1, queueLimit: 4 });
    await expect(gate.run(async () => { throw new Error('extract failed'); })).rejects.toThrow(
      'extract failed',
    );
    expect(gate.active()).toBe(0);
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
