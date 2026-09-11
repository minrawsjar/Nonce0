/**
 * Submit independent note spends without allowing one transport/proof failure
 * to cancel the remaining notes. Results preserve input order.
 */
export async function runPaymentLanes<T, R>(
  items: readonly T[],
  limit: number,
  submit: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('payment lane limit must be a positive integer');
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const lane = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { status: 'fulfilled', value: await submit(item, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
