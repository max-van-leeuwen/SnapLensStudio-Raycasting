import {RaycastInfo, RayProvider} from "./RayProvider"

import {InteractionPlane} from "../../Components/Interaction/InteractionPlane/InteractionPlane"
import {HandInputData} from "../../Providers/HandInputData/HandInputData"
import {HandType} from "../../Providers/HandInputData/HandType"
import {interpolateVec3} from "../../Utils/mathUtils"
import {FieldTargetingMode, HandInteractor} from "../HandInteractor/HandInteractor"
import {FINGERTIP_UP_OFFSET} from "./FingertipConstants"
import {InteractorTriggerType} from "./Interactor"
import RaycastProxy from "./raycastAlgorithms/RaycastProxy"

// ============================================================================
// PINCH INTENT DETECTION THRESHOLDS
// ============================================================================

/**
 * Pinch strength above which we cache the locus (if velocity detection didn't catch it).
 * Set low so user's relaxed hand position is just below this threshold.
 */
const PINCH_STRENGTH_CACHE_THRESHOLD = 0.1

/**
 * Pinch strength below which the cache is fully released (100% dynamic locus).
 * Between RELEASE and STABLE thresholds, we blend cached ↔ dynamic.
 */
const PINCH_STRENGTH_RELEASE_THRESHOLD = 0.05

/**
 * Pinch strength above which we use 100% cached locus.
 * Between RELEASE and STABLE thresholds, we blend cached ↔ dynamic.
 */
const PINCH_STRENGTH_STABLE_THRESHOLD = 0.4

/**
 * Closing velocity threshold (cm/second) to detect pinch intent.
 * When fingers are closing faster than this AND pinch strength is low, we cache the locus.
 */
const CLOSING_VELOCITY_THRESHOLD_CM_PER_SEC = 15.0

/**
 * Debug visualization colors
 */
const DEBUG_COLOR_FINAL_LOCUS = new vec4(0, 1, 0, 1) // Green - final locus
const DEBUG_COLOR_DYNAMIC_LOCUS = new vec4(1, 1, 0, 1) // Yellow - dynamic (index tip)
const DEBUG_COLOR_CACHED_LOCUS = new vec4(0, 1, 1, 1) // Cyan - cached locus
const DEBUG_COLOR_PALM_CENTER = new vec4(1, 0, 1, 1) // Magenta - palm center
const DEBUG_COLOR_INDEX_TIP = new vec4(1, 0.5, 0, 1) // Orange - index tip
const DEBUG_COLOR_THUMB_TIP = new vec4(1, 0, 0.5, 1) // Pink - thumb tip
const DEBUG_COLOR_RAY = new vec4(0, 0.5, 1, 1) // Blue - ray direction

export type HandRayProviderConfig = {
  handType: HandType
  handInteractor: HandInteractor
  drawDebug?: boolean
}

/**
 * Provides raycasting functionality for hand interactions.
 *
 * In near-field mode, uses velocity-based pinch intent detection to stabilize the locus:
 * - Detects pinch intent by watching closing velocity while pinch strength is low
 * - Caches locus offset from palm center at intent detection
 * - Smoothly blends between cached and dynamic locus based on pinch strength
 * - Cached offset follows hand translation while staying stable during pinch
 */
export class HandRayProvider implements RayProvider {
  private handProvider: HandInputData = HandInputData.getInstance()

  private hand = this.handProvider.getHand(this.config.handType)

  // Inner lerp: Near-field locus → Index tip (based on distance to direct zone)
  private innerLerpValue: number = 0

  // Offset to keep locus in front of plane surface
  private offsetDistance: number = 0

  // ============================================================================
  // PINCH INTENT CACHING STATE
  // ============================================================================

  // Cached offset from palm center in HAND-LOCAL space.
  // Stored relative to the wrist rotation at cache time.
  // When recovering, we use the CURRENT wrist rotation to transform back to world,
  // making the locus follow the hand 1:1 as if parented to it (yaw, pitch, AND roll).
  private cachedLocalOffset: vec3 | null = null

  // Previous frame's finger distance for velocity calculation
  private prevFingerDistance: number | null = null

  // Timestamp of previous frame for velocity calculation
  private prevFrameTime: number | null = null

  // Frame-based caching for velocity calculation (to handle multiple calls per frame)
  private cachedVelocityFrameTime: number | null = null
  private cachedClosingVelocity: number | null = null

  // Whether we're currently in "pinch active" state (using cached locus)
  private isPinchActive: boolean = false

  // Release phase tracking for smooth time-based transition
  private isInReleasePhase: boolean = false
  private releaseStartTime: number = 0 // When release phase started (seconds)
  private hasReachedStableThreshold: boolean = false // Must reach stable before release is allowed

  // Duration for release transition (blend goes from 1.0 to 0.0 over this time)
  private static readonly RELEASE_DURATION_SEC = 0.3

  // Debug visualization flag
  private _drawDebug: boolean

  readonly raycast = new RaycastProxy(this.hand)

  constructor(private config: HandRayProviderConfig) {
    this._drawDebug = config.drawDebug ?? false
  }

  /**
   * Enable/disable debug visualization of locus points
   */
  set drawDebug(enabled: boolean) {
    this._drawDebug = enabled
  }

  get drawDebug(): boolean {
    return this._drawDebug
  }

  /**
   * Calculates the closing velocity of index and thumb tips.
   * Returns positive value when fingers are closing, negative when opening.
   * Returns null if we don't have enough data yet.
   *
   * NOTE: This method caches the result per frame to handle multiple callers
   * within the same frame (e.g., different interactors or debug scripts).
   */
  private calculateClosingVelocity(currentDistance: number): number | null {
    const currentTime = getTime()

    // Check if we've already calculated velocity for this frame
    // Use a small epsilon (0.0001s = 0.1ms) to handle floating point comparison
    if (this.cachedVelocityFrameTime !== null && Math.abs(currentTime - this.cachedVelocityFrameTime) < 0.0001) {
      return this.cachedClosingVelocity
    }

    if (this.prevFingerDistance === null || this.prevFrameTime === null) {
      // First frame - store values and return null
      this.prevFingerDistance = currentDistance
      this.prevFrameTime = currentTime
      this.cachedVelocityFrameTime = currentTime
      this.cachedClosingVelocity = null
      return null
    }

    const deltaTime = currentTime - this.prevFrameTime
    if (deltaTime <= 0) {
      // Same frame as previous calculation but cache wasn't hit (shouldn't happen normally)
      this.cachedVelocityFrameTime = currentTime
      this.cachedClosingVelocity = null
      return null
    }

    // Closing velocity = -(change in distance) / time
    // Positive when distance is decreasing (fingers closing)
    const closingVelocity = -(currentDistance - this.prevFingerDistance) / deltaTime

    // Update for next frame
    this.prevFingerDistance = currentDistance
    this.prevFrameTime = currentTime

    // Cache the result for this frame
    this.cachedVelocityFrameTime = currentTime
    this.cachedClosingVelocity = closingVelocity

    return closingVelocity
  }

  /**
   * Gets the wrist rotation for locus tracking.
   * Uses the raw wrist rotation - the locus follows the hand 1:1 as if parented to it.
   * No filtering or decomposition, which avoids artifacts from rotation analysis.
   */
  private getWristRotation(): quat {
    return this.hand.wrist.rotation
  }

  /**
   * Detects pinch intent and manages locus caching with ASYMMETRIC BLENDING.
   *
   * IMPORTANT: We cache the offset in hand-local space using raw wrist rotation.
   * The locus follows the hand 1:1 as if parented to it:
   * - Hand translation (palm center moves in world)
   * - Full hand rotation (yaw, pitch, AND roll)
   *
   * Entry behavior (pinch):
   * - On pinch intent detection: immediately use 100% cached locus (no blend)
   * - This avoids the "dip" toward dropping index tip during pinch
   *
   * Release behavior:
   * - Only start lerping toward index when index has risen above cached position
   * - One-way ratchet: blendFactor can only decrease during release (no rubber-band)
   */
  private getStableLocus(
    dynamicLocus: vec3,
    palmCenter: vec3,
    pinchStrength: number,
    fingerDistance: number,
    indexLocalY: number | null,
    plane: InteractionPlane | null
  ): {locus: vec3; cachedWorldPos: vec3 | null; blendFactor: number} {
    const closingVelocity = this.calculateClosingVelocity(fingerDistance)
    const wristRotation = this.getWristRotation()

    // ========================================================================
    // CACHE CREATION
    // Cache locus on pinch intent (velocity-based) or strength threshold.
    // Cache is cleared only after release transition completes (prevents jumps).
    // ========================================================================

    if (this.cachedLocalOffset === null) {
      let shouldCache = false

      // Velocity-based: detect fast closing motion at low strength (early intent)
      if (closingVelocity !== null) {
        const isLowStrength = pinchStrength < PINCH_STRENGTH_CACHE_THRESHOLD
        const isClosingFast = closingVelocity > CLOSING_VELOCITY_THRESHOLD_CM_PER_SEC
        if (isLowStrength && isClosingFast) {
          shouldCache = true
        }
      }

      // Strength-based fallback: cache when strength exceeds threshold
      if (!shouldCache && pinchStrength > PINCH_STRENGTH_CACHE_THRESHOLD) {
        shouldCache = true
      }

      if (shouldCache) {
        const worldOffset = dynamicLocus.sub(palmCenter)
        // Store offset in hand-local space (relative to wrist rotation)
        // The locus will follow the hand 1:1 as if parented to it
        this.cachedLocalOffset = wristRotation.invert().multiplyVec3(worldOffset)
        this.isPinchActive = true
        this.isInReleasePhase = false
        this.releaseStartTime = 0
      }
    }

    // ========================================================================
    // BLEND CALCULATION
    // Entry: immediately 100% cached (no blend zone)
    // Release: smooth time-based transition over 300ms
    // ========================================================================

    let blendFactor = 0.0

    if (this.cachedLocalOffset !== null) {
      // 1:1 HAND ROTATION TRACKING:
      // Use raw wrist rotation to transform cached offset back to world space.
      // The locus follows the hand exactly as if it were parented to it.
      // No filtering = no artifacts from rotation decomposition.
      const worldOffset = wristRotation.multiplyVec3(this.cachedLocalOffset)
      const cachedWorldPos = palmCenter.add(worldOffset)

      // Track if pinch reached stable threshold (arms release)
      if (pinchStrength >= PINCH_STRENGTH_STABLE_THRESHOLD && !this.hasReachedStableThreshold) {
        this.hasReachedStableThreshold = true
      }

      // Aborted pinch: velocity triggered cache but user never completed pinch
      if (
        !this.hasReachedStableThreshold &&
        !this.isInReleasePhase &&
        pinchStrength < PINCH_STRENGTH_RELEASE_THRESHOLD
      ) {
        this.isInReleasePhase = true
        this.releaseStartTime = getTime()
      }

      // Normal release: armed and either Y-condition or strength condition met
      if (!this.isInReleasePhase && this.hasReachedStableThreshold) {
        let shouldRelease = false

        // Y-condition: finger rises above cached point (only when strength decreasing)
        // Lazily compute planeOrigin only when needed (optimization: avoids 7+ vec3 ops per frame)
        if (pinchStrength < PINCH_STRENGTH_STABLE_THRESHOLD && indexLocalY !== null && plane !== null) {
          const planeUp = plane.up
          const planeOrigin = plane.planeOrigin
          const cachedLocalY = cachedWorldPos.sub(planeOrigin).dot(planeUp)
          if (indexLocalY >= cachedLocalY) {
            shouldRelease = true
          }
        }

        // Strength condition: strength drops below cache threshold
        if (!shouldRelease && pinchStrength < PINCH_STRENGTH_CACHE_THRESHOLD) {
          shouldRelease = true
        }

        if (shouldRelease) {
          this.isInReleasePhase = true
          this.releaseStartTime = getTime()
        }
      }

      // Calculate blend factor
      if (this.isInReleasePhase) {
        // Re-pinch during release: cancel and return to hold
        if (pinchStrength >= PINCH_STRENGTH_CACHE_THRESHOLD) {
          this.isInReleasePhase = false
          this.releaseStartTime = 0
          blendFactor = 1.0
        } else {
          // Time-based transition: 1.0 → 0.0 over RELEASE_DURATION_SEC
          const elapsed = getTime() - this.releaseStartTime
          const t = Math.min(1.0, elapsed / HandRayProvider.RELEASE_DURATION_SEC)
          blendFactor = 1.0 - t

          // Transition complete: clear cache
          if (t >= 1.0) {
            this.isPinchActive = false
            this.isInReleasePhase = false
            this.releaseStartTime = 0
            this.hasReachedStableThreshold = false
            this.cachedLocalOffset = null
            return {locus: dynamicLocus, cachedWorldPos: null, blendFactor: 0}
          }
        }
      } else {
        // Hold phase: 100% cached
        blendFactor = 1.0
      }

      const blendedLocus = interpolateVec3(dynamicLocus, cachedWorldPos, blendFactor)
      return {locus: blendedLocus, cachedWorldPos, blendFactor}
    }

    return {locus: dynamicLocus, cachedWorldPos: null, blendFactor: 0}
  }

  /** @inheritdoc */
  getRaycastInfo(): RaycastInfo {
    const ray = this.raycast.getRay()

    if (ray === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // ========================================================================
    // CHECK TRANSITION STATE
    // During a field mode transition, we use the OLD mode's ray until the cursor
    // has fully faded out (shouldUseNewMode becomes true).
    // ========================================================================
    const transitionInfo = this.config.handInteractor.fieldModeTransitionInfo
    const effectiveMode = transitionInfo.shouldUseNewMode ? transitionInfo.toMode : transitionInfo.fromMode

    // Use effective plane (which may be cached during Near→Far transition)
    const effectivePlane = this.config.handInteractor.getEffectiveInteractionPlane()

    // Determine if we should use far-field ray
    const useFarFieldRay =
      effectiveMode === FieldTargetingMode.FarField ||
      // Also use far-field ray if we don't have near-field data
      effectivePlane === null

    // When using far-field ray, return the GestureModule's ray
    if (useFarFieldRay) {
      // Reset pinch state when in far-field mode
      if (this.isPinchActive || this.cachedLocalOffset !== null) {
        this.isPinchActive = false
        this.cachedLocalOffset = null
        this.prevFingerDistance = null
        this.prevFrameTime = null
        this.cachedVelocityFrameTime = null
        this.cachedClosingVelocity = null
      }
      return ray
    }

    // Near field mode: use velocity-based pinch intent detection
    const indexTipRaw = this.hand.indexTip?.position
    const indexTipUp = this.hand.indexTip?.up
    const thumbTip = this.hand.thumbTip?.position

    if (indexTipRaw === undefined || indexTipUp === undefined || thumbTip === undefined) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // Apply fingertip offset to align raycast locus with poke spherecast endpoint.
    // FINGERTIP_UP_OFFSET shifts DOWN from the top of the fingertip to its center.
    const indexTip = indexTipRaw.add(indexTipUp.uniformScale(FINGERTIP_UP_OFFSET))

    // Use the effective projection (which may be cached during Near→Far transition)
    const planeProjection = this.config.handInteractor.getEffectiveCachedIndexProjection()

    if (planeProjection === null || effectivePlane === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    const planeNormal = effectivePlane.normal
    const physicalZoneDepth = effectivePlane.physicalZoneDepth
    const physicalZoneExitDepth = effectivePlane.physicalZoneExitDepth
    const distance = planeProjection.distance

    // Track direct mode for seamless transitions
    const isInDirectMode = effectiveMode === FieldTargetingMode.Direct
    const isTransitioningToFromDirect =
      transitionInfo.isTransitioning &&
      (transitionInfo.toMode === FieldTargetingMode.Direct || transitionInfo.fromMode === FieldTargetingMode.Direct)

    // Cache lerp values when not triggering so they stay stable during manipulation.
    if (this.config.handInteractor.currentTrigger === InteractorTriggerType.None) {
      // Inner lerp: stable pinch locus → index tip
      // Tied to cursor fade during Near↔Direct transitions:
      // - In NearField (cursor visible): use stable pinch locus (innerLerp=0)
      // - In Direct (cursor hidden): use index tip (innerLerp=1)
      // - During Near↔Direct transitions: blend based on cursor fade

      if (isInDirectMode && !transitionInfo.isTransitioning) {
        // Fully in Direct mode (not transitioning): always use index tip
        this.innerLerpValue = 1.0
      } else if (isTransitioningToFromDirect) {
        // During Near↔Direct transition: blend based on cursor fade
        // blendFactor goes 1→0 for Near→Direct, so innerLerp goes 0→1
        // blendFactor goes 0→1 for Direct→Near, so innerLerp goes 1→0
        this.innerLerpValue = 1 - transitionInfo.blendFactor
      } else {
        // In NearField mode (not transitioning to/from Direct): use stable pinch locus
        this.innerLerpValue = 0
      }

      // Offset for poke interactions - use hysteresis-aware threshold
      // When already in Direct mode, use the exit threshold (4cm) to prevent cursor snapping
      // during the 3cm-4cm transition zone
      const effectivePhysicalThreshold = isInDirectMode ? physicalZoneExitDepth : physicalZoneDepth
      this.offsetDistance = distance <= effectivePhysicalThreshold ? effectivePhysicalThreshold - distance : 0
    }

    // ========================================================================
    // PINCH INTENT DETECTION
    // Uses index tip as dynamic locus, caches OFFSET from palm when pinch intent is detected.
    // The cached offset follows hand translation while staying stable during pinch.
    // ========================================================================

    const pinchStrength = this.hand.getPinchStrength() ?? 0
    const fingerDistance = indexTip.distance(thumbTip)
    const palmCenter = this.hand.getPalmCenter()

    // Need palm center for caching offset
    if (palmCenter === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // Dynamic locus: use index tip for accurate targeting
    // (could also use halfway point - this is tunable)
    const dynamicLocus = indexTip

    // Get stable locus (blended between dynamic and cached based on pinch strength)
    // Pass plane for lazy Y-condition evaluation (avoids computing planeOrigin every frame)
    const {
      locus: stablePinchLocus,
      cachedWorldPos,
      blendFactor
    } = this.getStableLocus(
      dynamicLocus,
      palmCenter,
      pinchStrength,
      fingerDistance,
      planeProjection.localY,
      effectivePlane
    )

    // Calculate index tip with offset (for poke interactions)
    const indexTipWithOffset = indexTip.add(planeNormal.uniformScale(this.offsetDistance))

    // ========================================================================
    // LOCUS & DIRECTION CALCULATION
    // The ray switches at the transition midpoint (when cursor has faded out).
    // We only lerp between near-field locus and index tip (for poke preparation).
    // ========================================================================
    let finalLocus: vec3

    {
      // Near-field mode: stable pinch locus → index tip (inner lerp only)
      finalLocus = interpolateVec3(stablePinchLocus, indexTipWithOffset, this.innerLerpValue)
    }

    // Direction: points toward plane (opposite of normal)
    const lerpDirection = planeNormal.uniformScale(-1)

    // Debug visualization
    if (this._drawDebug) {
      this.drawDebugVisualization(
        finalLocus,
        dynamicLocus,
        cachedWorldPos,
        palmCenter,
        indexTip,
        thumbTip,
        lerpDirection,
        pinchStrength,
        blendFactor
      )
    }

    return {
      direction: lerpDirection,
      locus: finalLocus
    }
  }

  /**
   * Draws debug visualization of locus points and ray direction.
   */
  private drawDebugVisualization(
    finalLocus: vec3,
    dynamicLocus: vec3,
    cachedLocus: vec3 | null,
    palmCenter: vec3 | null,
    indexTip: vec3,
    thumbTip: vec3,
    direction: vec3,
    pinchStrength: number,
    blendFactor: number
  ): void {
    const crossSize = 0.5

    // Draw final locus (GREEN) - this is what's actually used for raycasting
    this.drawCross(finalLocus, crossSize * 1.5, DEBUG_COLOR_FINAL_LOCUS)

    // Draw dynamic locus (YELLOW) - the index tip
    this.drawCross(dynamicLocus, crossSize, DEBUG_COLOR_DYNAMIC_LOCUS)

    // Draw cached locus (CYAN) - only when pinch is active
    if (cachedLocus !== null) {
      this.drawCross(cachedLocus, crossSize * 1.2, DEBUG_COLOR_CACHED_LOCUS)

      // Draw line from dynamic to cached
      // RED when in hold phase (not releasing), GREEN when in release phase
      const lineColor = this.isInReleasePhase ? new vec4(0, 1, 0, 0.8) : new vec4(1, 0, 0, 0.8)
      global.debugRenderSystem.drawLine(dynamicLocus, cachedLocus, lineColor)
    }

    // Draw palm center (MAGENTA)
    if (palmCenter !== null) {
      this.drawCross(palmCenter, crossSize * 0.75, DEBUG_COLOR_PALM_CENTER)
    }

    // Draw index tip (ORANGE)
    this.drawCross(indexTip, crossSize * 0.5, DEBUG_COLOR_INDEX_TIP)

    // Draw thumb tip (PINK)
    this.drawCross(thumbTip, crossSize * 0.5, DEBUG_COLOR_THUMB_TIP)

    // Draw ray direction from final locus (BLUE)
    const rayEnd = finalLocus.add(direction.uniformScale(20))
    global.debugRenderSystem.drawLine(finalLocus, rayEnd, DEBUG_COLOR_RAY)

    // Draw pinch strength indicator (yellow to red)
    const pinchIndicatorStart = finalLocus.add(new vec3(0, 2, 0))
    const pinchIndicatorEnd = pinchIndicatorStart.add(new vec3(pinchStrength * 5, 0, 0))
    const pinchColor = new vec4(1, 1 - pinchStrength, 0, 1)
    global.debugRenderSystem.drawLine(pinchIndicatorStart, pinchIndicatorEnd, pinchColor)

    // Draw blend factor indicator (shows how much we're using cached vs dynamic)
    // Green bar when in hold/entry, cyan bar when in release phase
    const blendIndicatorStart = finalLocus.add(new vec3(0, 3, 0))
    const blendIndicatorEnd = blendIndicatorStart.add(new vec3(blendFactor * 5, 0, 0))
    const blendColor = this.isInReleasePhase ? new vec4(0, 1, 1, 1) : new vec4(0, 1, 0, 1)
    global.debugRenderSystem.drawLine(blendIndicatorStart, blendIndicatorEnd, blendColor)

    // Draw release phase indicator - white dot below final locus when releasing
    if (this.isInReleasePhase) {
      const releaseIndicator = finalLocus.add(new vec3(0, -1, 0))
      this.drawCross(releaseIndicator, crossSize * 0.3, new vec4(1, 1, 1, 1))
    }
  }

  /**
   * Draws a 3D cross at the specified position for debug visualization.
   */
  private drawCross(position: vec3, size: number, color: vec4): void {
    global.debugRenderSystem.drawLine(position.add(new vec3(-size, 0, 0)), position.add(new vec3(size, 0, 0)), color)
    global.debugRenderSystem.drawLine(position.add(new vec3(0, -size, 0)), position.add(new vec3(0, size, 0)), color)
    global.debugRenderSystem.drawLine(position.add(new vec3(0, 0, -size)), position.add(new vec3(0, 0, size)), color)
  }

  /** @inheritdoc */
  isAvailable(): boolean {
    return (this.hand.isInTargetingPose() && this.hand.isTracked()) || this.hand.isPinching()
  }

  /** @inheritdoc */
  reset(): void {
    this.raycast.reset()
    // Also reset pinch state
    this.isPinchActive = false
    this.cachedLocalOffset = null
    this.prevFingerDistance = null
    this.prevFrameTime = null
    this.cachedVelocityFrameTime = null
    this.cachedClosingVelocity = null
  }
}
