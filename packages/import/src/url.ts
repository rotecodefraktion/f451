/** `base` without trailing slashes. A loop instead of `/\/+$/`, which
 *  backtracks quadratically on long runs of slashes. */
export function trimTrailingSlashes(base: string): string {
  let end = base.length
  while (end > 0 && base.charCodeAt(end - 1) === 47) end--
  return base.slice(0, end)
}
