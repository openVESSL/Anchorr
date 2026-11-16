/**
 * Trailing-edge debounce: `fn` runs once, `waitMs` after the last call, with that call's
 * arguments. `flush()` runs a pending call now; `cancel()` drops it.
 */
export function debounce(fn, waitMs) {
  let timer = null;
  let lastArgs = null;

  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    return fn(...args);
  };

  const debounced = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  };
  debounced.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    return run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return debounced;
}
