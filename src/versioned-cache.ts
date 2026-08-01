/**
 * Кеш на короткий срок с защитой от одновременных построений одного значения.
 *
 * Нужен там, где значение дорого строить, а просят его всплесками: зрители
 * заходят в комнату одновременно, обрыв WebSocket'а поднимает всех сразу, лидер
 * переключает серию. Без такой обёртки всплеск в N зрителей означал N построений
 * — а для части источников одно построение это отдельный заход Playwright.
 *
 * Версия проверяется при чтении, а не входит в ключ. Поэтому запись, построенную
 * для прошлой серии, никто уже не получит: следующий читатель придёт с новой
 * версией, не совпадёт и построит заново.
 */
export interface VersionedCache<T> {
  /**
   * Отдаёт значение: из кеша, из уже идущего построения, либо строит новое.
   * `build` для одного ключа не вызывается повторно, пока не завершится.
   */
  get(key: string, version: number, build: () => Promise<T>): Promise<T>;
  /** Забыть запись (идущее построение при этом не отменяется). */
  delete(key: string): void;
  /** Сколько записей лежит — для тестов и диагностики. */
  size(): number;
}

export function createVersionedCache<T>(opts: {
  ttlMs: number;
  /** Подменяемые часы — только для тестов. */
  now?: () => number;
}): VersionedCache<T> {
  const { ttlMs } = opts;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: T; version: number; at: number }>();
  const inFlight = new Map<string, Promise<T>>();

  // Просроченные записи выметаем при записи новой: иначе каждый ключ, о котором
  // когда-либо спрашивали, держал бы своё значение в памяти навсегда, а значения
  // тут — переписанные манифесты в сотни килобайт.
  const sweep = (t: number) => {
    for (const [k, v] of entries) {
      if (t - v.at > ttlMs) entries.delete(k);
    }
  };

  return {
    get(key, version, build) {
      const hit = entries.get(key);
      if (hit && hit.version === version && now() - hit.at < ttlMs) {
        return Promise.resolve(hit.value);
      }

      // Отказы не кешируем: следующий запрос должен попробовать снова. Все, кто
      // ждал этого построения, получат один и тот же отказ.
      const pending = inFlight.get(key);
      if (pending) return pending;

      const run = build()
        .then((value) => {
          const t = now();
          sweep(t);
          entries.set(key, { value, version, at: t });
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, run);
      return run;
    },
    delete(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}
