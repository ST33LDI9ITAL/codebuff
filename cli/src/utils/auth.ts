import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { z } from 'zod'


import { logger } from './logger'


// User schema
const userSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  email: z.string(),
  authToken: z.string(),
  fingerprintId: z.string().optional(),
  fingerprintHash: z.string().optional(),
  credits: z.number().optional(),
})

export type User = z.infer<typeof userSchema>

const credentialsSchema = z
  .object({
    default: userSchema.optional(),
  })
  .catchall(z.unknown())

// Standalone config dir — no env var dependency
const LOCAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'codebuff-local')

export const getConfigDir = (): string => LOCAL_CONFIG_DIR

/**
 * Get or create a local API key. Reads DEEPSEEK_API_KEY from env,
 * otherwise generates a random UUID and persists it.
 */
export function getOrCreateLocalApiKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv) return fromEnv

  const keyPath = path.join(LOCAL_CONFIG_DIR, 'api-key')
  try {
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf8').trim()
    }
  } catch {
    // fall through to generate
  }

  const key = crypto.randomUUID()
  fs.mkdirSync(LOCAL_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(keyPath, key, 'utf8')
  return key
}

// Get the credentials file path
export const getCredentialsPath = (): string => {
  return path.join(getConfigDir(), 'credentials.json')
}

/**
 * Parse user from JSON string
 */
const userFromJson = (
  json: string,
  profileName: string = 'default',
): User | undefined => {
  try {
    const allCredentials = credentialsSchema.parse(JSON.parse(json))
    const profile = allCredentials[profileName]
    // Validate that the profile matches the user schema
    const parsed = userSchema.safeParse(profile)
    return parsed.success ? parsed.data : undefined
  } catch (error) {
    logger.error(
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        profileName,
      },
      'Error parsing user JSON',
    )
    return
  }
}

/**
 * Get user credentials from file system
 * @returns User object or null if not found/authenticated
 */
export const getUserCredentials = (): User | null => {
  const credentialsPath = getCredentialsPath()

  // Read user credentials directly from file
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  try {
    const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
    const user = userFromJson(credentialsFile)
    return user || null
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error reading credentials',
    )
    return null
  }
}

export type AuthTokenSource = 'credentials' | 'environment' | null

export interface AuthTokenDetails {
  token?: string
  source: AuthTokenSource
}

/**
 * Resolve the auth token and track where it came from.
 */
export const getAuthTokenDetails = (): AuthTokenDetails => {
  const localKey = getOrCreateLocalApiKey()
  if (localKey) {
    return { token: localKey, source: 'environment' }
  }
  return { source: null }
}

/**
 * Get the auth token from user credentials or environment variable
 */
export const getAuthToken = (): string | undefined => {
  return getAuthTokenDetails().token
}

/**
 * Check if the user has authentication credentials (but doesn't validate them)
 */
export const hasAuthCredentials = (): boolean => {
  return !!getAuthTokenDetails().token
}

export interface AuthValidationResult {
  authenticated: boolean
  hasInvalidCredentials: boolean
}

/** Read existing credentials file, returns empty object if missing/invalid */
const readCredentialsFile = (): Record<string, unknown> => {
  const credentialsPath = getCredentialsPath()
  if (!fs.existsSync(credentialsPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Save user credentials to file system.
 */
export const saveUserCredentials = (user: User): void => {
  const configDir = getConfigDir()
  const credentialsPath = getCredentialsPath()

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    const updatedData = { ...readCredentialsFile(), default: user }
    fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2))
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving credentials',
    )
    throw error
  }
}

/**
 * Clear user credentials from file system.
 * Only removes the 'default' field, preserving other credentials.
 */
export const clearUserCredentials = (): void => {
  const credentialsPath = getCredentialsPath()

  try {
    if (!fs.existsSync(credentialsPath)) return

    const { default: _, ...rest } = readCredentialsFile()

    if (Object.keys(rest).length === 0) {
      fs.unlinkSync(credentialsPath)
    } else {
      fs.writeFileSync(credentialsPath, JSON.stringify(rest, null, 2))
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error clearing credentials',
    )
    throw error
  }
}

export async function logoutUser(): Promise<boolean> {
  try {
    clearUserCredentials()
  } catch (error) {
    logger.debug({ error }, 'Failed to clear credentials during logout')
  }
  return true
}
