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
  // Версия хранится рядом с промисом, а не только в готовых записях: построение
  // для прошлой версии нельзя отдавать тем, кто пришёл за новой (см. get).
  const inFlight = new Map<string, { version: number; promise: Promise<T> }>();

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
      //
      // Сверять версию тут обязательно. Смена серии рассылает source-change, по
      // которому все клиенты разом просят index.m3u8 заново — а построение для
      // прошлой серии в этот момент ещё идёт (для videoseed это заход
      // Playwright, то есть секунды). Без проверки все они получали именно его,
      // то есть манифест предыдущей серии.
      const pending = inFlight.get(key);
      if (pending && pending.version === version) return pending.promise;

      const run = build()
        .then((value) => {
          const t = now();
          sweep(t);
          // Построение прошлой версии может закончиться позже нового — тогда
          // записывать его поверх свежего нельзя.
          const cur = entries.get(key);
          if (!cur || cur.version <= version) entries.set(key, { value, version, at: t });
          return value;
        })
        .finally(() => {
          // Убираем только свою запись: пока мы строили, ключ мог занять
          // построитель новой версии.
          const cur = inFlight.get(key);
          if (cur && cur.promise === run) inFlight.delete(key);
        });
      inFlight.set(key, { version, promise: run });
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
