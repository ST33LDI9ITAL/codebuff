import { validateSingleAgent } from '@codebuff/common/templates/agent-validation'
import { DynamicAgentTemplateSchema } from '@codebuff/common/types/dynamic-agent-template'
import { getErrorObject } from '@codebuff/common/util/error'
import z from 'zod/v4'

import { WEBSITE_URL } from '../constants'
import {
  createAuthError,
  createNetworkError,
  createServerError,
  createHttpError,
  isRetryableStatusCode,
} from '../error-utils'
import {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
} from '../retry-config'

import type {
  AddAgentStepFn,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyInput,
  GetUserInfoFromApiKeyOutput,
  StartAgentRunFn,
  UserColumn,
} from '@codebuff/common/types/contracts/database'
import type { DynamicAgentTemplate } from '@codebuff/common/types/dynamic-agent-template'
import type { ParamsOf } from '@codebuff/common/types/function-params'

type CachedUserInfo = Partial<
  NonNullable<Awaited<GetUserInfoFromApiKeyOutput<UserColumn>>>
>

const userInfoCache: Record<
  string,
  CachedUserInfo | null
> = {}

const agentsResponseSchema = z.object({
  version: z.string(),
  data: DynamicAgentTemplateSchema,
})

/**
 * Fetch with retry logic for transient errors (502, 503, etc.)
 * Implements exponential backoff between retries.
 */
async function fetchWithRetry(
  url: URL | string,
  options: RequestInit,
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<Response> {
  let lastError: Error | null = null
  let backoffDelay = RETRY_BACKOFF_BASE_DELAY_MS

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_MESSAGE; attempt++) {
    try {
      const response = await fetch(url, options)

      // If response is OK or not retryable, return it
      if (response.ok || !isRetryableStatusCode(response.status)) {
        return response
      }

      // Retryable error - log and continue to retry
      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          { status: response.status, attempt: attempt + 1, url: String(url) },
          `Retryable HTTP error, retrying in ${backoffDelay}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      } else {
        // Last attempt, return the response even if it's an error
        return response
      }
    } catch (error) {
      // Network-level error (DNS, connection refused, etc.)
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          { error: getErrorObject(lastError), attempt: attempt + 1, url: String(url) },
          `Network error, retrying in ${backoffDelay}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      }
    }
  }

  // All retries exhausted - throw the last error
  throw lastError ?? new Error('Request failed after retries')
}

export async function getUserInfoFromApiKey<T extends UserColumn>(
  params: GetUserInfoFromApiKeyInput<T>,
): GetUserInfoFromApiKeyOutput<T> {
  const { apiKey, fields } = params

  // Standalone: return canned local user info for any apiKey
  const localUser: CachedUserInfo = {
    id: 'local',
    email: 'local@dev',
    discord_id: null,
    stripe_customer_id: null,
    banned: false,
    created_at: new Date(),
  }
  userInfoCache[apiKey] = localUser

  return Object.fromEntries(
    fields.map((field) => [field, localUser[field]]),
  ) as Awaited<GetUserInfoFromApiKeyOutput<T>>
}

export async function fetchAgentFromDatabase(
  params: ParamsOf<FetchAgentFromDatabaseFn>,
): ReturnType<FetchAgentFromDatabaseFn> {
  // Standalone: no remote agents available — rely on local .agents/ dirs
  return null
}

export async function startAgentRun(
  params: ParamsOf<StartAgentRunFn>,
): ReturnType<StartAgentRunFn> {
  const { apiKey, agentId, ancestorRunIds, logger } = params

  const url = new URL(`/api/v1/agent-runs`, WEBSITE_URL)

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'START',
          agentId,
          ancestorRunIds,
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'startAgentRun request failed')
      return null
    }

    const responseBody = await response.json()
    if (!responseBody?.runId) {
      logger.error(
        { responseBody },
        'no runId found from startAgentRun request',
      )
    }
    return responseBody?.runId ?? null
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), agentId },
      'startAgentRun error',
    )
    return null
  }
}

export async function finishAgentRun(
  params: ParamsOf<FinishAgentRunFn>,
): ReturnType<FinishAgentRunFn> {
  const {
    apiKey,
    runId,
    status,
    totalSteps,
    directCredits,
    totalCredits,
    logger,
  } = params

  const url = new URL(`/api/v1/agent-runs`, WEBSITE_URL)

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'FINISH',
          runId,
          status,
          totalSteps,
          directCredits,
          totalCredits,
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'finishAgentRun request failed')
      return
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), runId, status },
      'finishAgentRun error',
    )
  }
}

export async function addAgentStep(
  params: ParamsOf<AddAgentStepFn>,
): ReturnType<AddAgentStepFn> {
  const {
    apiKey,
    agentRunId,
    stepNumber,
    credits,
    childRunIds,
    messageId,
    status = 'completed',
    errorMessage,
    startTime,
    logger,
  } = params

  const url = new URL(`/api/v1/agent-runs/${agentRunId}/steps`, WEBSITE_URL)

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          stepNumber,
          credits,
          childRunIds,
          messageId,
          status,
          errorMessage,
          startTime,
        }),
      },
      logger,
    )

    const responseBody = await response.json()
    if (!response.ok) {
      logger.error({ responseBody }, 'addAgentStep request failed')
      return null
    }

    if (!responseBody?.stepId) {
      logger.error(
        { responseBody },
        'no stepId found from addAgentStep request',
      )
    }
    return responseBody.stepId ?? null
  } catch (error) {
    logger.error(
      {
        error: getErrorObject(error),
        agentRunId,
        stepNumber,
        credits,
        childRunIds,
        messageId,
        status,
        errorMessage,
        startTime,
      },
      'addAgentStep error',
    )
    return null
  }
}
