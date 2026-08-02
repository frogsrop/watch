/**
 * Потолок на одновременные Playwright-заходы плюс короткая очередь.
 *
 * `probeInFlight` в server.ts склеивает только запросы с ОДИНАКОВЫМ url, так что
 * N разных ссылок — это N параллельных Chrome, каждая под минуту и по паре сотен
 * мегабайт. Ручка `/api/extract` открыта без авторизации, а машина общая (рядом
 * почта и соседние сервисы), поэтому лучше честный отказ, чем OOM у соседей.
 */
export class BusyError extends Error {}

export interface Gate {
  /** Выполнить работу, дождавшись слота. Бросает BusyError, если очередь полна. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Сколько работ идёт прямо сейчас — для тестов и диагностики. */
  active(): number;
  /** Сколько ждёт очереди. */
  queued(): number;
}

export function createExtractGate(opts: { concurrency: number; queueLimit: number }): Gate {
  const concurrency = Math.max(1, opts.concurrency);
  const queueLimit = Math.max(0, opts.queueLimit);
  const waiting: (() => void)[] = [];
  let active = 0;

  return {
    async run(work) {
      if (active >= concurrency) {
        if (waiting.length >= queueLimit) throw new BusyError('too many extracts queued');
        // Ждём, пока освободившийся передаст слот лично нам. Счётчик при этом
        // не трогаем: слот переходит из рук в руки и всё время занят.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }
      try {
        return await work();
      } finally {
        // Именно передача, а не «отпустить и разбудить»: между декрементом и
        // пробуждением ожидающего успел бы вклиниться новый запрос, и
        // работающих стало бы больше потолка.
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
    active: () => active,
    queued: () => waiting.length,
  };
}
