import {Singleton} from "../Decorators/Singleton"
import {LensConfig} from "./LensConfig"
import NativeLogger from "./NativeLogger"
import {UpdateDispatcherPriority} from "./UpdateDispatcher"

const TAG = "FrameCache"
const log = new NativeLogger(TAG)

/**
 * A cached function wrapper that stores the result of expensive computations
 * and automatically flushes the cache at the start of each frame.
 */
interface CachedFunction<T> {
  (): T
  /** Force clear the cache (normally done automatically each frame) */
  clearCache(): void
  /** Check if the result is currently cached */
  isCached(): boolean
}

/**
 * FrameCache provides automatic per-frame caching for expensive function calls.
 *
 * This utility allows you to wrap expensive methods so that:
 * 1. The first call in a frame executes the original function and caches the result
 * 2. Subsequent calls in the same frame return the cached result
 * 3. The cache is automatically cleared at the start of each new frame
 *
 * Usage:
 * ```typescript
 * // Get the singleton instance
 * private frameCache = FrameCache.getInstance()
 *
 * // Wrap an expensive method
 * private getCachedHandOrientation = this.frameCache.wrap(
 *   'getHandOrientation',
 *   () => this.computeHandOrientation()
 * )
 *
 * // Use the cached version
 * const orientation = this.getCachedHandOrientation()
 *
 * Results in ~0.03ms overhead compared to a simple manual caching solution.
 * ```
 */
@Singleton
export class FrameCache {
  public static getInstance: () => FrameCache

  private cacheMap = new Map<string, CachedFunctionImpl<any>>()
  private isInitialized = false
  private readonly instanceName = "FrameCache"

  constructor() {
    this.initializeGlobalFlushIfNeeded()
  }

  /**
   * Wrap a function with per-frame caching.
   *
   * @param key Unique identifier for this cached function
   * @param fn The expensive function to cache
   * @returns A cached version of the function
   */
  wrap<T>(key: string, fn: () => T): CachedFunction<T> {
    if (this.cacheMap.has(key)) {
      log.w(`Cache key '${key}' already exists in ${this.instanceName}. Returning existing cached function.`)
      return this.cacheMap.get(key)!.getCallableFunction()
    }

    const cachedFn = new CachedFunctionImpl<T>(key, fn)
    this.cacheMap.set(key, cachedFn)

    log.v(`Registered cached function '${key}' in ${this.instanceName}`)
    return cachedFn.getCallableFunction()
  }

  /**
   * Wrap a method with per-frame caching, preserving 'this' context.
   *
   * @param key Unique identifier for this cached function
   * @param context The object context ('this')
   * @param fn The expensive method to cache
   * @returns A cached version of the method
   */
  wrapMethod<T, TContext>(key: string, context: TContext, fn: (this: TContext) => T): () => T {
    const cachedFn = this.wrap(key, () => fn.call(context))
    return () => cachedFn()
  }

  /**
   * Clear all caches managed by this instance
   */
  flushAll(): void {
    let flushedCount = 0
    for (const [, cachedFnImpl] of this.cacheMap) {
      if (cachedFnImpl.isCached()) {
        cachedFnImpl.clearCache()
        flushedCount++
      }
    }

    if (flushedCount > 0) {
      log.v(`Flushed ${flushedCount} cached functions in ${this.instanceName}`)
    }
  }

  /**
   * Remove a cached function
   */
  remove(key: string): boolean {
    const removed = this.cacheMap.delete(key)
    if (removed) {
      log.v(`Removed cached function '${key}' from ${this.instanceName}`)
    }
    return removed
  }

  /**
   * Initialize global cache flushing if not already done.
   * Only called once due to singleton pattern.
   */
  private initializeGlobalFlushIfNeeded(): void {
    if (this.isInitialized) {
      return
    }

    this.isInitialized = true

    // Register a high-priority update event to flush all caches at the start of each frame
    LensConfig.getInstance().updateDispatcher.createUpdateEvent(
      "FrameCache_GlobalFlush",
      () => this.flushAll(),
      UpdateDispatcherPriority.FlushCache
    )

    log.i(`Initialized global cache flushing for ${this.instanceName}`)
  }
}

/**
 * Implementation of a cached function
 */
class CachedFunctionImpl<T> {
  private cachedResult: T | undefined = undefined
  private hasCachedResult = false

  constructor(
    private key: string,
    private originalFn: () => T
  ) {}

  private call(): T {
    if (this.hasCachedResult) {
      return this.cachedResult!
    }

    // Execute the original function and cache the result
    this.cachedResult = this.originalFn()
    this.hasCachedResult = true

    log.v(`Computed and cached result for '${this.key}'`)
    return this.cachedResult!
  }

  clearCache(): void {
    if (this.hasCachedResult) {
      this.cachedResult = undefined
      this.hasCachedResult = false
      log.v(`Cleared cache for '${this.key}'`)
    }
  }

  isCached(): boolean {
    return this.hasCachedResult
  }

  getCallableFunction(): CachedFunction<T> {
    const callableFn = (() => this.call()) as CachedFunction<T>
    callableFn.clearCache = () => this.clearCache()
    callableFn.isCached = () => this.isCached()
    return callableFn
  }
}

// Global instance for convenience
export const frameCache = FrameCache.getInstance()
