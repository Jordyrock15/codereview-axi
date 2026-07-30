/**
 * Minimal SSE fanout keyed by session.
 * @returns {{subscribe: (key: string, res: any) => (() => void), publish: (key: string, event: string, data: unknown) => number, count: (key: string) => number}}
 */
export const createHub = () => {
  /** @type {Map<string, Set<any>>} */
  const byKey = new Map();

  /**
   * @param {string} key
   * @param {any} res
   * @returns {() => void}
   */
  const subscribe = (key, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const set = byKey.get(key) ?? new Set();
    byKey.set(key, set);

    const off = () => {
      set.delete(res);
      if (set.size === 0) byKey.delete(key);
    };

    try {
      res.write(': connected\n\n');
      set.add(res);
    } catch {
      // Dead on arrival: never add it, so publish and count never see it.
    }

    return off;
  };

  /**
   * @param {string} key
   * @param {string} event
   * @param {unknown} data
   * @returns {number}
   */
  const publish = (key, event, data) => {
    const set = byKey.get(key);
    if (!set) return 0;

    // JSON.stringify cannot emit a raw newline, so one data: line is always safe.
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;

    for (const res of [...set]) {
      try {
        res.write(frame);
        delivered += 1;
      } catch {
        set.delete(res);
      }
    }
    if (set.size === 0) byKey.delete(key);
    return delivered;
  };

  /** @param {string} key @returns {number} */
  const count = (key) => byKey.get(key)?.size ?? 0;

  return { subscribe, publish, count };
};
