import { describe, it, expect, vi } from 'vitest';
import { createVersionedCache } from '../src/versioned-cache.js';

/** Построение, которое можно завершить вручную — чтобы поймать состояние «в полёте». */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createVersionedCache', () => {
  it('строит один раз и потом отдаёт из кеша', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const build = vi.fn(async () => 'manifest');

    expect(await cache.get('room', 1, build)).toBe('manifest');
    expect(await cache.get('room', 1, build)).toBe('manifest');

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('перестраивает при смене версии — запись от прошлой серии не отдаётся', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    let n = 0;
    const build = vi.fn(async () => `v${++n}`);

    expect(await cache.get('room', 1, build)).toBe('v1');
    expect(await cache.get('room', 2, build)).toBe('v2');
    expect(await cache.get('room', 2, build)).toBe('v2');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('перестраивает после истечения TTL', async () => {
    let clock = 0;
    const cache = createVersionedCache<string>({ ttlMs: 1000, now: () => clock });
    let n = 0;
    const build = vi.fn(async () => `v${++n}`);

    expect(await cache.get('room', 1, build)).toBe('v1');
    clock = 999;
    expect(await cache.get('room', 1, build)).toBe('v1');
    clock = 1001;
    expect(await cache.get('room', 1, build)).toBe('v2');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('одновременные запросы делят одно построение', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const d = deferred<string>();
    const build = vi.fn(() => d.promise);

    const waiters = [
      cache.get('room', 1, build),
      cache.get('room', 1, build),
      cache.get('room', 1, build),
    ];
    d.resolve('manifest');

    expect(await Promise.all(waiters)).toEqual(['manifest', 'manifest', 'manifest']);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('разные ключи строятся независимо', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const build = vi.fn(async () => 'x');

    await Promise.all([cache.get('a', 1, build), cache.get('b', 1, build)]);

    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  it('отказ достаётся всем ожидающим и не кешируется', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const d = deferred<string>();
    const build = vi
      .fn<[], Promise<string>>()
      .mockImplementationOnce(() => d.promise)
      .mockImplementationOnce(async () => 'recovered');

    const first = cache.get('room', 1, build);
    const second = cache.get('room', 1, build);
    d.reject(new Error('upstream 502'));

    await expect(first).rejects.toThrow('upstream 502');
    await expect(second).rejects.toThrow('upstream 502');
    expect(build).toHaveBeenCalledTimes(1);

    // Следующий запрос обязан попробовать снова, а не получить отказ из кеша.
    expect(await cache.get('room', 1, build)).toBe('recovered');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('версия, уехавшая во время построения, не отдаётся следующему читателю', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const d = deferred<string>();
    const buildOld = vi.fn(() => d.promise);
    const buildNew = vi.fn(async () => 'new-episode');

    // Запрос пришёл на версии 1; пока шло построение, лидер переключил серию.
    const inFlight = cache.get('room', 1, buildOld);
    d.resolve('old-episode');
    expect(await inFlight).toBe('old-episode');

    // Читатель с новой версией получает новое, а не подсунутое из кеша старое.
    expect(await cache.get('room', 2, buildNew)).toBe('new-episode');
  });

  it('идущее построение прошлой версии не отдаётся тем, кто просит новую', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const d = deferred<string>();
    const buildOld = vi.fn(() => d.promise);
    const buildNew = vi.fn(async () => 'new-episode');

    // Смена серии рассылает source-change, и вся комната просит манифест разом —
    // ровно пока построение прошлой серии ещё не завершилось.
    const stale = cache.get('room', 1, buildOld);
    const viewers = [cache.get('room', 2, buildNew), cache.get('room', 2, buildNew)];
    d.resolve('old-episode');

    expect(await stale).toBe('old-episode');
    expect(await Promise.all(viewers)).toEqual(['new-episode', 'new-episode']);
    // Зрителей двое, а построение новой версии одно — склейка внутри версии жива.
    expect(buildNew).toHaveBeenCalledTimes(1);
  });

  it('поздно завершившееся построение не затирает уже записанную новую версию', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    const d = deferred<string>();

    const stale = cache.get('room', 1, () => d.promise);
    expect(await cache.get('room', 2, async () => 'new-episode')).toBe('new-episode');
    d.resolve('old-episode'); // прошлая версия финиширует последней
    await stale;

    expect(await cache.get('room', 2, async () => 'rebuilt')).toBe('new-episode');
  });

  it('просроченные записи выметаются, а не копятся навсегда', async () => {
    let clock = 0;
    const cache = createVersionedCache<string>({ ttlMs: 1000, now: () => clock });
    const build = async () => 'x';

    await cache.get('dead-room-1', 1, build);
    await cache.get('dead-room-2', 1, build);
    expect(cache.size()).toBe(2);

    // Комнаты умерли; спустя TTL запись о новой комнате выметает их обе.
    clock = 5000;
    await cache.get('live-room', 1, build);
    expect(cache.size()).toBe(1);
  });

  it('delete убирает запись', async () => {
    const cache = createVersionedCache<string>({ ttlMs: 1000 });
    let n = 0;
    const build = async () => `v${++n}`;

    expect(await cache.get('room', 1, build)).toBe('v1');
    cache.delete('room');
    expect(await cache.get('room', 1, build)).toBe('v2');
  });
});
