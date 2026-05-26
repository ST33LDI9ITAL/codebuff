// No-op analytics module for standalone offline fork.
// All functions are empty stubs that preserve the same exports
// so no importers break.

export enum AnalyticsErrorStage {
  Init = 'init',
  Track = 'track',
  Identify = 'identify',
  Flush = 'flush',
  CaptureException = 'captureException',
}

export interface AnalyticsDeps {
  env: {
    NEXT_PUBLIC_POSTHOG_API_KEY?: string
    NEXT_PUBLIC_POSTHOG_HOST_URL?: string
  }
  isProd: boolean
  createClient: (apiKey: string, options: any) => any
  generateAnonymousId?: () => string
}

/** Reset analytics state - for testing only */
export function resetAnalyticsState(_deps?: AnalyticsDeps) {}

export let identified: boolean = false

export function setAnalyticsErrorLogger(_loggerFn: any) {}

export function initAnalytics() {}

export async function flushAnalytics() {}

export function trackEvent(
  _event: any,
  _properties?: Record<string, any>,
) {}

export function identifyUser(
  _userId: string,
  _properties?: Record<string, any>,
) {}

export function logError(
  _error: any,
  _userId?: string,
  _properties?: Record<string, any>,
) {}