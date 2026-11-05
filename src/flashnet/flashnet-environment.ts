/**
 * True only under the test runner (Jest sets NODE_ENV=test, and the E2E setup
 * sets it explicitly). The Flashnet mock accepts every webhook signature, so it
 * must never be reachable in development or production.
 */
export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test'
}
