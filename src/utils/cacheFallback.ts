import type { LoggerLike } from "../services/Logger.js";
import type { LocalCache } from "../types/cache.types.js";
import { ConnectionError } from "../types/errors.js";

/**
 * Options for cache fallback operations
 */
export interface CacheFallbackOptions<T> {
  /**
   * Unique cache key for storing/retrieving data
   */
  cacheKey: string;

  /**
   * Cache instance to use
   */
  cache: LocalCache;

  /**
   * Function to fetch fresh data
   */
  fetch: () => Promise<T>;

  /**
   * Value to return when a connection error leaves no stale cache to fall back
   * on. OPTIONAL, and for most operations it should stay unset: answering a
   * failed fetch with an empty list tells the caller "there is nothing" when the
   * truth is "we could not look". Set it only where a substitute is genuinely
   * indistinguishable from the real answer.
   */
  defaultValue?: T;

  /**
   * Logger instance for logging warnings and errors
   */
  logger: LoggerLike;

  /**
   * Operation name for logging context
   */
  operation: string;

  /**
   * Service name for logging context
   */
  service: string;

  /**
   * Time-to-live for cached data in milliseconds
   */
  ttl?: number;

  /**
   * Additional context for logging (optional)
   */
  logContext?: Record<string, unknown>;
}

/**
 * Executes an operation with cache-first strategy and fallback handling.
 *
 * Flow:
 * 1. Check cache for fresh data → return if found
 * 2. Try to fetch fresh data → cache and return if successful
 * 3. On error:
 *    - If connection error:
 *      a. Try stale cache → return if found
 *      b. Return default value if no stale cache
 *    - If other error: throw
 *
 * @param options - Configuration for the cached operation
 * @returns The cached, fresh, stale, or default data
 */
export async function withCacheFallback<T>(
  options: CacheFallbackOptions<T>,
): Promise<T> {
  const {
    cacheKey,
    cache,
    fetch,
    defaultValue,
    logger,
    operation,
    service,
    ttl,
    logContext = {},
  } = options;

  // Check for fresh cached data
  const cached = cache.get<T>(cacheKey);
  if (cached) {
    return cached;
  }

  // Try to get fresh data
  try {
    const freshData = await fetch();

    // Cache the fresh data if TTL is provided
    if (ttl) {
      cache.set(cacheKey, freshData, ttl);
    }

    return freshData;
  } catch (error) {
    // Log the error
    await logger.error(
      `Error in ${operation}`,
      { operation, service },
      {
        error: error instanceof Error ? error.message : String(error),
        ...logContext,
      },
    );

    // Only use fallback for connection errors
    if (isConnectionError(error)) {
      // Try to return stale cached data
      const staleData = cache.getStale<T>(cacheKey);
      if (staleData) {
        await logger.warning(
          `Returning stale cached data due to connection failure`,
          { operation, service },
          { cacheKey, ...logContext },
        );
        return staleData;
      }

      // No stale data. Only substitute a default if the caller explicitly
      // supplied one; otherwise the failure has to reach them.
      if (defaultValue !== undefined) {
        await logger.warning(
          `No cached data available, returning default value due to connection failure`,
          { operation, service },
          { ...logContext },
        );
        return defaultValue;
      }
    }

    // Not a connection error, or no substitute available: the caller must learn
    // that the operation failed rather than receive an empty success.
    throw error;
  }
}

/**
 * Determines if an error is a connection-related error.
 *
 * Type only. This used to also match message substrings ("connection",
 * "timeout", "socket", …), which made the test useless: ConnectionPool wraps
 * every failure in "Failed to create connection after N attempts: …", so a
 * wrong password, a rejected certificate and a locked mailbox all matched and
 * were answered with an empty default instead of an error.
 *
 * Producers classify their own failures via classifyTransportError(); anything
 * that is not a ConnectionError must reach the caller.
 */
function isConnectionError(error: unknown): boolean {
  return error instanceof ConnectionError;
}
