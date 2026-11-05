/**
 * True only under the Jest runner: NODE_ENV=test AND a Jest worker id. The
 * Flashnet mock accepts every webhook signature, so a production host started
 * with NODE_ENV=test by mistake must still never reach it.
 */
export function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' && process.env.JEST_WORKER_ID !== undefined
  )
}
