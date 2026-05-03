import {Interactable} from "../../Components/Interaction/Interactable/Interactable"
import {
  InteractionPlane,
  XY_HYSTERESIS_MARGIN_CM,
  ZoneProjection
} from "../../Components/Interaction/InteractionPlane/InteractionPlane"
import WorldCameraFinderProvider from "../../Providers/CameraProvider/WorldCameraFinderProvider"
import {HandInputData} from "../../Providers/HandInputData/HandInputData"
import {HandType} from "../../Providers/HandInputData/HandType"
import TrackedHand from "../../Providers/HandInputData/TrackedHand"
import TargetProvider, {InteractableHitInfo} from "../../Providers/TargetProvider/TargetProvider"
import Event, {PublicApi} from "../../Utils/Event"
import {FrameCache} from "../../Utils/FrameCache"
import {validate} from "../../Utils/validate"
import BaseInteractor from "../Interactor/BaseInteractor"
import {DragProvider} from "../Interactor/DragProvider"
import {HandRayProvider} from "../Interactor/HandRayProvider"
import IndirectTargetProvider from "../Interactor/IndirectTargetProvider"
import {InteractorInputType, InteractorTriggerType, TargetingMode} from "../Interactor/Interactor"
import {PhysicalInteractionProvider} from "../Interactor/PhysicalInteractionProvider"

/**
 * Enum representing the types of raycasts available for hand interactions.
 */
export type RaycastType = "AnchorShoulder" | "AnchorVariableShoulder" | "LegacySingleCamera" | "AnchorHead" | "Proxy"

export enum FieldTargetingMode {
  FarField,
  NearField,
  Direct,
  BehindNearField
}

export type NearFieldTransitionInfo = {
  /** @deprecated Use nearFieldDepth directly */
  totalTransitionDistance: number
  /** @deprecated Always 0 - lerp offset is no longer used */
  lerpOffset: number
  /** @deprecated Use nearFieldDepth instead */
  interactionZoneDistance: number
  distanceToPlane: number | null
}

const HANDUI_INTERACTION_DISTANCE_THRESHOLD_CM = 15

// The maximum allowed angle between the hand ray and the plane's normal for a near field interaction to be valid.
const NEAR_FIELD_ANGLE_THRESHOLD_RADIAN = Math.PI / 3

// The minimum pinch strength required to trigger a pinch instead of a poke during direct targeting.
export const MINIMUM_PINCH_STRENGTH = 0.2

// ============================================================================
// FIELD MODE TRANSITION
// ============================================================================

/**
 * Duration (seconds) for the fade-out phase of a field mode transition.
 * During this phase, the cursor fades out while the ray stays in the old mode.
 */
const MODE_TRANSITION_FADE_OUT_DURATION_SEC = 0.2

/**
 * Duration (seconds) for the fade-in phase of a field mode transition.
 * During this phase, the ray has switched and the cursor fades in at the new position.
 */
const MODE_TRANSITION_FADE_IN_DURATION_SEC = 0.2

/**
 * Duration (seconds) to debounce zone EXITS before triggering a transition.
 * This prevents accidental transitions when momentarily leaving a zone
 * (e.g., moving hand slightly outside the XY boundary of the plane).
 */
const MODE_EXIT_DEBOUNCE_DURATION_SEC = 0.15

/**
 * Total transition duration (fade out + fade in).
 */
const MODE_TRANSITION_TOTAL_DURATION_SEC = MODE_TRANSITION_FADE_OUT_DURATION_SEC + MODE_TRANSITION_FADE_IN_DURATION_SEC

/**
 * Information about an ongoing field mode transition (public API).
 */
export type FieldModeTransitionInfo = {
  /** Whether a transition is currently in progress */
  isTransitioning: boolean
  /** Progress from 0 to 1 (0.5 = midpoint where ray switches) */
  progress: number
  /** The mode we're transitioning FROM */
  fromMode: FieldTargetingMode
  /** The mode we're transitioning TO */
  toMode: FieldTargetingMode
  /** Whether the ray should use the new mode yet (true after fade-out completes) */
  shouldUseNewMode: boolean
  /** Cursor alpha multiplier (0 at midpoint, 1 at start/end) */
  blendFactor: number
}

/**
 * Internal state for managing field mode transitions.
 */
type ModeTransitionState = {
  /** Whether a transition is currently in progress */
  isActive: boolean
  /** Timestamp when the transition started */
  startTime: number
  /** The mode we're transitioning FROM */
  fromMode: FieldTargetingMode
  /** The mode we're transitioning TO */
  toMode: FieldTargetingMode
  /** Cached interaction plane (preserved until transition completes) */
  cachedPlane: InteractionPlane | null
  /** Cached index projection (preserved until transition completes) */
  cachedProjection: ZoneProjection | null
}

/**
 * Internal state for debouncing mode exits to prevent flickering.
 */
type ModeExitDebounceState = {
  /** Whether a mode exit is pending (being debounced) */
  isPending: boolean
  /** The mode we would transition to if debounce completes */
  targetMode: FieldTargetingMode
  /** Timestamp when the pending exit was first detected */
  startTime: number
  /** Cached plane data from when debounce started */
  cachedPlane: InteractionPlane | null
  /** Cached projection from when debounce started */
  cachedProjection: ZoneProjection | null
}

/**
 * This class handles hand interactions within the Spectacles Interaction Kit. It provides various configurations for hand types and raycast types.
 *
 */
@component
export class HandInteractor extends BaseInteractor {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Hand Configuration</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Specify which hand this interactor tracks</span>')

  /**
   * Specifies which hand this interactor tracks (left or right).
   */
  @input
  @label("Hand Type")
  @hint("Specifies which hand this interactor tracks (left or right).")
  @widget(new ComboBoxWidget([new ComboBoxItem("Left", "left"), new ComboBoxItem("Right", "right")]))
  private handType: string = "right"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Direct Interaction</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Configure collider radius and drag sensitivity for direct (pinch) interactions</span>'
  )

  /**
   * The radius in cm around the midpoint of the index/thumb to target Interactables.
   */
  @input
  @label("Direct Collider Enter Radius")
  @hint(
    "The radius (in cm) around the midpoint of the index/thumb to target Interactables. When the hand enters this \
radius around an Interactable, it becomes targetable for direct pinch interactions."
  )
  private directColliderEnterRadius: number = 1

  /**
   * The radius in cm around the midpoint of the index/thumb to de-target Interactables (for bistable thresholding).
   */
  @input
  @label("Direct Collider Exit Radius")
  @hint(
    "The radius (in cm) around the midpoint of the index/thumb to de-target Interactables. This should be larger than \
the enter radius to create bistable (hysteresis) behavior that prevents flickering when hovering near the boundary."
  )
  private directColliderExitRadius: number = 1.5

  /**
   * Controls the minimum distance the hand must move during direct interaction to be considered a drag. When the
   * distance between the interaction origin position and current position exceeds this threshold, dragging behavior is
   * detected and tracked. Lower values make dragging more sensitive and easier to trigger, while higher values require
   * more deliberate movement before dragging begins.
   */
  @input
  @label("Direct Drag Threshold")
  @hint(
    "Controls the minimum distance (in cm) the hand must move during direct interaction to be considered a drag. \
Lower values make dragging more sensitive and easier to trigger, while higher values require more deliberate \
movement before dragging begins."
  )
  private directDragThreshold: number = 3.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Advanced</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Additional options for specialized hand interaction scenarios</span>'
  )

  /**
   * Forces the usage of Poke targeting when interacting near the nondominant hand's palm.
   */
  @input
  @label("Force Poke On Non-Dominant Palm Proximity")
  @hint(
    "When enabled, forces the usage of Poke targeting when the dominant hand's index finger is near the nondominant \
hand's palm. Useful for hand-mounted UI interactions."
  )
  private forcePokeOnNonDominantPalmProximity: boolean = false
  protected handProvider: HandInputData = HandInputData.getInstance()

  private onFieldTargetingModeChangedEvent: Event<FieldTargetingMode> = new Event<FieldTargetingMode>()
  readonly onFieldTargetingModeChanged: PublicApi<FieldTargetingMode> =
    this.onFieldTargetingModeChangedEvent.publicApi()

  private _hand!: TrackedHand

  private handRayProvider!: HandRayProvider

  private indirectTargetProvider!: IndirectTargetProvider
  private indirectDragProvider!: DragProvider

  private physicalInteractionProvider!: PhysicalInteractionProvider
  private physicalDragProvider!: DragProvider

  private activeTargetProvider!: TargetProvider

  private _fieldTargetingMode: FieldTargetingMode = FieldTargetingMode.FarField
  private _currentInteractionPlane: InteractionPlane | null = null
  private _cachedIndexProjection: ZoneProjection | null = null

  // ============================================================================
  // FIELD MODE TRANSITION STATE (grouped for clarity)
  // ============================================================================

  /** State for managing animated transitions between field modes */
  private _transition: ModeTransitionState = {
    isActive: false,
    startTime: 0,
    fromMode: FieldTargetingMode.FarField,
    toMode: FieldTargetingMode.FarField,
    cachedPlane: null,
    cachedProjection: null
  }

  /** State for debouncing mode exits to prevent flickering */
  private _exitDebounce: ModeExitDebounceState = {
    isPending: false,
    targetMode: FieldTargetingMode.FarField,
    startTime: 0,
    cachedPlane: null,
    cachedProjection: null
  }

  // Frame cache for expensive computations
  private frameCache = FrameCache.getInstance()
  private cachedPreventTargetUpdateFn!: () => boolean

  private cameraProvider = WorldCameraFinderProvider.getInstance()

  onAwake(): void {
    this.inputType = this.handType === "left" ? InteractorInputType.LeftHand : InteractorInputType.RightHand

    this._hand = this.handProvider.getHand(this.handType as HandType)

    // Initialize cached function for preventTargetUpdate
    this.cachedPreventTargetUpdateFn = this.frameCache.wrapMethod(
      `HandInteractor_${this.handType}_preventTargetUpdate`,
      this,
      this.computePreventTargetUpdate
    )

    this.handRayProvider = new HandRayProvider({
      handType: this.handType as HandType,
      handInteractor: this
    })

    this.indirectTargetProvider = new IndirectTargetProvider(this as BaseInteractor, {
      maxRayDistance: this.maxRaycastDistance,
      rayProvider: this.handRayProvider,
      targetingVolumeMultiplier: this.indirectTargetingVolumeMultiplier,
      shouldPreventTargetUpdate: () => {
        return this.preventTargetUpdate()
      },
      spherecastRadii: this.spherecastRadii,
      spherecastDistanceThresholds: this.spherecastDistanceThresholds
    })
    this.indirectDragProvider = new DragProvider(this.indirectDragThreshold)

    if (this.directColliderEnterRadius >= this.directColliderExitRadius) {
      throw Error(
        `The direct collider enter radius should be less than the exit radius for bistable threshold behavior.`
      )
    }

    // Initialize unified physical interaction provider (replaces DirectTargetProvider + PokeTargetProvider)
    this.physicalInteractionProvider = new PhysicalInteractionProvider(this as BaseInteractor, {
      handType: this.handType as HandType,
      shouldPreventTargetUpdate: () => {
        return this.preventTargetUpdate()
      },
      drawDebug: this.drawDebug,
      colliderEnterRadius: this.directColliderEnterRadius,
      colliderExitRadius: this.directColliderExitRadius
    })
    this.physicalDragProvider = new DragProvider(this.directDragThreshold)

    this.activeTargetProvider = this.indirectTargetProvider
    this.dragProvider = this.indirectDragProvider

    this.defineSceneEvents()
  }

  /**
   * @returns the TrackedHand that this HandInteractor is using for tracking information.
   */
  get hand(): TrackedHand {
    return this._hand
  }

  get startPoint(): vec3 | null {
    return this.activeTargetProvider?.startPoint ?? null
  }

  get endPoint(): vec3 | null {
    return this.activeTargetProvider?.endPoint ?? null
  }

  get direction(): vec3 | null {
    const proposedDirection =
      this.activeTargetingMode === TargetingMode.Poke
        ? this.physicalInteractionProvider?.direction
        : this.indirectTargetProvider?.direction

    return proposedDirection ?? null
  }

  get orientation(): quat | null {
    return this.hand?.getPinchDirection() ?? null
  }

  get distanceToTarget(): number | null {
    return this.activeTargetProvider?.currentInteractableHitInfo?.hit.distance ?? null
  }

  get targetHitPosition(): vec3 | null {
    return this.activeTargetProvider?.currentInteractableHitInfo?.hit.position ?? null
  }

  get targetHitInfo(): InteractableHitInfo | null {
    return this.activeTargetProvider?.currentInteractableHitInfo ?? null
  }

  get activeTargetingMode(): TargetingMode {
    // For PhysicalInteractionProvider, derive the actual targeting mode from the current trigger
    // since it supports both Poke and Direct modes
    if (this.activeTargetProvider === this.physicalInteractionProvider) {
      if (this.currentTrigger === InteractorTriggerType.Poke) {
        return TargetingMode.Poke
      } else if (this.currentTrigger === InteractorTriggerType.Pinch) {
        return TargetingMode.Direct
      }
      // If hovering (no trigger yet), use the targetHitInfo's targetMode if available
      return this.targetHitInfo?.targetMode ?? TargetingMode.Direct
    }

    // For IndirectTargetProvider or other providers, use their static targetingMode
    return this.activeTargetProvider?.targetingMode ?? TargetingMode.None
  }

  get maxRaycastDistance(): number {
    return this._maxRaycastDistance
  }

  get interactionStrength(): number | null {
    // PhysicalInteractionProvider returns appropriate strength for both poke and pinch
    if (this.activeTargetProvider === this.physicalInteractionProvider) {
      return this.physicalInteractionProvider?.interactionStrength ?? null
    }

    // Indirect uses pinch strength
    return this.hand?.getPinchStrength() ?? null
  }

  /**
   * Set if the Interactor is should draw a debug gizmo of collider/raycasts in the scene.
   */
  set drawDebug(debug: boolean) {
    this._drawDebug = debug

    // If the target providers have not been created yet, no need to manually set the drawDebug.
    if (!this.indirectTargetProvider || !this.physicalInteractionProvider) {
      return
    }

    this.indirectTargetProvider.drawDebug = debug
    this.physicalInteractionProvider.drawDebug = debug
  }

  /**
   * @returns if the Interactor is currently drawing a debug gizmo of collider/raycasts in the scene.
   */
  get drawDebug(): boolean {
    return this._drawDebug
  }

  get isHoveringCurrentInteractable(): boolean | null {
    if (!this.currentInteractable) {
      return null
    }

    // PhysicalInteractionProvider handles poke edge cases internally via currentInteractableSet
    return this.activeTargetProvider.isHoveringInteractable(this.currentInteractable)
  }

  get hoveredInteractables(): Interactable[] {
    // PhysicalInteractionProvider handles poke edge cases internally via currentInteractableSet
    return Array.from(this.activeTargetProvider.currentInteractableSet)
  }

  isHoveringInteractable(interactable: Interactable): boolean {
    return this.activeTargetProvider.isHoveringInteractable(interactable)
  }

  isHoveringInteractableHierarchy(interactable: Interactable): boolean {
    if (this.activeTargetProvider.isHoveringInteractable(interactable)) {
      return true
    }

    for (const hoveredInteractable of this.activeTargetProvider.currentInteractableSet) {
      if (hoveredInteractable.isDescendantOf(interactable)) {
        return true
      }
    }
    return false
  }

  override updateState(): void {
    super.updateState()
    this.updateTransitionState()
    this.updateTarget()
    this.updatePinchFilter()
    this.updateDragVector()

    this.processTriggerEvents()
  }

  protected override clearDragProviders(): void {
    this.physicalDragProvider?.clear()
    this.indirectDragProvider?.clear()
    this.planecastDragProvider.clear()
  }

  override get planecastDragVector(): vec3 | null {
    // If the hand has been recently found, return vec3.zero() to allow time to determine if pinch is sustained.
    if (this.hand === undefined) return vec3.zero()
    return this.hand.isRecentlyFound() ? vec3.zero() : this.planecastDragProvider.currentDragVector
  }

  protected override set currentDragVector(dragVector: vec3 | null) {
    this._currentDragVector = dragVector
  }

  override get currentDragVector(): vec3 | null {
    // If the hand has been recently found, return vec3.zero() to allow time to determine if pinch is sustained.
    if (this.hand === undefined) return vec3.zero()
    return this.hand.isRecentlyFound() ? vec3.zero() : this._currentDragVector
  }

  override get planecastPoint(): vec3 | null {
    if (this.activeTargetProvider === this.indirectTargetProvider) {
      return this.raycastPlaneIntersection(this.currentInteractable)
    } else if (this.activeTargetProvider === this.physicalInteractionProvider) {
      return this.positionPlaneIntersection(this.currentInteractable, this.hand.indexTip.position)
    }

    return null
  }

  /**
   * Clears an InteractionPlane from the cache of planes if it is nearby.
   * @param plane
   */
  clearInteractionPlane(plane: InteractionPlane) {
    this.physicalInteractionProvider.clearInteractionPlane(plane)

    const fieldTargetingMode = this.updateNearestPlane()
    this.setFieldTargetingMode(fieldTargetingMode)
  }

  get fieldTargetingMode(): FieldTargetingMode {
    return this._fieldTargetingMode
  }

  get currentInteractionPlane(): InteractionPlane | null {
    return this._currentInteractionPlane
  }

  /**
   * @returns the cached index tip projection from the most recent update, or null if not in near field mode.
   * This cached value is computed once per frame in updateNearestPlane() and can be reused to avoid redundant InteractionPlane.projectPoint() calls.
   */
  get cachedIndexProjection(): ZoneProjection | null {
    return this._cachedIndexProjection
  }

  /**
   * Updates transition state once per frame. This handles transition completion
   * including state mutations and event firing.
   *
   * IMPORTANT: This is called once per frame from updateState() to ensure
   * side effects happen at a predictable time, not inside the getter.
   */
  private updateTransitionState(): void {
    if (!this._transition.isActive) {
      return
    }

    const currentTime = getTime()
    const elapsed = currentTime - this._transition.startTime
    const progress = Math.min(1.0, elapsed / MODE_TRANSITION_TOTAL_DURATION_SEC)

    // Check if transition is complete
    if (progress >= 1.0) {
      this._transition.isActive = false
      this._fieldTargetingMode = this._transition.toMode
      // Clear cached transition data
      this._transition.cachedPlane = null
      this._transition.cachedProjection = null
      this.onFieldTargetingModeChangedEvent.invoke(this._fieldTargetingMode)
    }
  }

  /**
   * Returns information about any ongoing field mode transition.
   * Use this API in HandRayProvider and CursorViewModelV2 to synchronize ray switching and cursor fading.
   *
   * NOTE: This getter is side-effect free. Transition completion is handled by
   * updateTransitionState() which is called once per frame from updateState().
   *
   * Key properties:
   * - `isTransitioning`: Whether a transition is in progress
   * - `progress`: 0-1 progress (0.5 = midpoint where ray switches)
   * - `shouldUseNewMode`: True when the ray should switch to the new mode (after fade-out)
   * - `blendFactor`: Multiplier for cursor visibility (0 at midpoint, 1 at edges)
   */
  get fieldModeTransitionInfo(): FieldModeTransitionInfo {
    if (!this._transition.isActive) {
      return {
        isTransitioning: false,
        progress: 1.0,
        fromMode: this._fieldTargetingMode,
        toMode: this._fieldTargetingMode,
        shouldUseNewMode: true,
        blendFactor: 1.0
      }
    }

    const currentTime = getTime()
    const elapsed = currentTime - this._transition.startTime
    const progress = Math.min(1.0, elapsed / MODE_TRANSITION_TOTAL_DURATION_SEC)

    // At progress 0.5, we're at the midpoint (end of fade-out, start of fade-in)
    const fadeOutProgress = Math.min(1.0, elapsed / MODE_TRANSITION_FADE_OUT_DURATION_SEC)
    const shouldUseNewMode = fadeOutProgress >= 1.0

    // Cursor alpha logic based on source and target modes:
    // The cursor is VISIBLE in FarField and NearField (just positioned differently).
    // The cursor is HIDDEN in Direct and BehindNearField (poke mode).
    //
    // Transition patterns:
    // - Far↔Near: Full fade-out/fade-in to hide position jump when ray switches
    // - Near↔Direct: Single fade (cursor hidden during poke)
    // - Direct↔Behind: Both hidden, stay at 0
    const sourceIsCursorHidden =
      this._transition.fromMode === FieldTargetingMode.Direct ||
      this._transition.fromMode === FieldTargetingMode.BehindNearField
    const targetIsCursorHidden =
      this._transition.toMode === FieldTargetingMode.Direct ||
      this._transition.toMode === FieldTargetingMode.BehindNearField

    let blendFactor: number
    if (sourceIsCursorHidden && targetIsCursorHidden) {
      // Both modes hide cursor - stay hidden
      blendFactor = 0.0
    } else if (sourceIsCursorHidden) {
      // FROM hidden TO visible - just fade in (use full transition time for fade-in)
      blendFactor = progress
    } else if (targetIsCursorHidden) {
      // FROM visible TO hidden - just fade out (use full transition time for fade-out)
      blendFactor = 1.0 - progress
    } else if (!shouldUseNewMode) {
      // Normal transition fade-out phase: 1 → 0
      blendFactor = 1.0 - fadeOutProgress
    } else {
      // Normal transition fade-in phase: 0 → 1
      const fadeInElapsed = elapsed - MODE_TRANSITION_FADE_OUT_DURATION_SEC
      const fadeInProgress = Math.min(1.0, fadeInElapsed / MODE_TRANSITION_FADE_IN_DURATION_SEC)
      blendFactor = fadeInProgress
    }

    return {
      isTransitioning: this._transition.isActive,
      progress,
      fromMode: this._transition.fromMode,
      toMode: this._transition.toMode,
      shouldUseNewMode,
      blendFactor
    }
  }

  /**
   * Returns the interaction plane to use, considering transitions.
   * During a Near→Far transition, returns the cached plane until the ray should switch.
   */
  getEffectiveInteractionPlane(): InteractionPlane | null {
    const transitionInfo = this.fieldModeTransitionInfo

    // If transitioning from near-field and ray hasn't switched yet, use cached plane
    if (transitionInfo.isTransitioning && !transitionInfo.shouldUseNewMode && this._transition.cachedPlane !== null) {
      // Validate cached plane is not destroyed
      if (!isNull(this._transition.cachedPlane)) {
        return this._transition.cachedPlane
      }
    }

    // During debounce period (before transition starts), use the debounce-cached plane
    // This prevents the ray from jumping to far-field during debounce
    if (this._exitDebounce.isPending && this._exitDebounce.cachedPlane !== null) {
      // Validate cached plane is not destroyed
      if (!isNull(this._exitDebounce.cachedPlane)) {
        return this._exitDebounce.cachedPlane
      }
    }

    // Validate current plane is not destroyed
    if (this._currentInteractionPlane !== null && isNull(this._currentInteractionPlane)) {
      this._currentInteractionPlane = null
    }

    return this._currentInteractionPlane
  }

  /**
   * Returns the cached index projection to use, considering transitions.
   * During a Near→Far transition, returns the cached projection until the ray should switch.
   */
  getEffectiveCachedIndexProjection(): ZoneProjection | null {
    const transitionInfo = this.fieldModeTransitionInfo

    // If transitioning from near-field and ray hasn't switched yet, use cached projection
    if (
      transitionInfo.isTransitioning &&
      !transitionInfo.shouldUseNewMode &&
      this._transition.cachedProjection !== null
    ) {
      return this._transition.cachedProjection
    }

    // During debounce period (before transition starts), use the debounce-cached projection
    // This prevents the ray from jumping to far-field during debounce
    if (this._exitDebounce.isPending && this._exitDebounce.cachedProjection !== null) {
      return this._exitDebounce.cachedProjection
    }

    return this._cachedIndexProjection
  }

  /**
   * @returns a normalized value between 0 and 1 representing proximity to an InteractionPlane when in near field mode,
   *          null if in FarField mode.
   */
  get nearFieldProximity(): number | null {
    if (this.fieldTargetingMode === FieldTargetingMode.FarField || this.currentInteractionPlane === null) {
      return null
    }

    // Use the cached projection from updateNearestPlane()
    const planeProjection = this._cachedIndexProjection

    if (planeProjection === null) {
      return null
    }

    if (
      this.fieldTargetingMode === FieldTargetingMode.NearField ||
      this.fieldTargetingMode === FieldTargetingMode.Direct
    ) {
      return 1 - planeProjection.distance / this.currentInteractionPlane.nearFieldDepth
    } else {
      return 1 + planeProjection.distance / this.currentInteractionPlane.behindZoneDepth
    }
  }

  isTargeting(): boolean {
    return this.hand?.isInTargetingPose() ?? false
  }

  /**
   * Returns true if the hand interactor and the hand it is associated with are both enabled.
   */
  isActive(): boolean {
    return (
      this.enabled && (this.hand?.enabled ?? false) && !this.hand.isPhoneInHand && this.sceneObject.isEnabledInHierarchy
    )
  }

  /**
   * Returns true if the hand this interactor is associated with is both enabled and tracked.
   */
  isTracking(): boolean {
    validate(this.hand)

    return this.hand.enabled && this.hand.isTracked()
  }

  /**
   * Returns true if the hand is targeting via far field raycasting.
   */
  isFarField(): boolean {
    // If the hand is not yet triggering, check if the raycast actually intersects within the plane's bounds.
    if (
      !this.isTriggering &&
      this.currentInteractable !== null &&
      this.currentInteractionPlane !== null &&
      this.startPoint !== null &&
      this.targetHitInfo !== null
    ) {
      return !this.currentInteractionPlane.checkRayIntersection(this.startPoint, this.targetHitInfo.hit.position)
    } else {
      return this.fieldTargetingMode === FieldTargetingMode.FarField
    }
  }

  /**
   * Returns whether the interactor is effectively in near-field mode, considering transitions.
   * Use this for visual feedback (like Frame glow) that should follow the transition animation.
   *
   * @returns false if in far-field OR transitioning TO far-field (glow should fade)
   * @returns true if in near-field AND not transitioning TO far-field
   */
  isEffectivelyNearField(): boolean {
    const transitionInfo = this.fieldModeTransitionInfo

    // If transitioning TO far-field, treat as "not near field" for visual purposes
    if (transitionInfo.isTransitioning && transitionInfo.toMode === FieldTargetingMode.FarField) {
      return false
    }

    // If transitioning FROM far-field TO near-field, treat as "near field" for visual purposes
    if (transitionInfo.isTransitioning && transitionInfo.fromMode === FieldTargetingMode.FarField) {
      return true
    }

    return !this.isFarField()
  }

  /**
   * Returns the transition alpha (0-1) that visual elements should use for fading.
   * Returns 1.0 when not transitioning or in near-field mode.
   * Returns blendFactor during transitions (fades out then in).
   */
  getNearFieldVisualAlpha(): number {
    const transitionInfo = this.fieldModeTransitionInfo

    if (transitionInfo.isTransitioning) {
      return transitionInfo.blendFactor
    }

    // When not transitioning, return 1.0 for near-field, 0.0 for far-field
    return this.isFarField() ? 0.0 : 1.0
  }

  isWithinDirectZone(): boolean {
    return this.fieldTargetingMode === FieldTargetingMode.Direct
  }

  protected clearCurrentHitInfo(): void {
    this.indirectTargetProvider?.clearCurrentInteractableHitInfo()
    this.physicalInteractionProvider?.clearCurrentInteractableHitInfo()
  }

  /** @inheritdoc */
  override setInputEnabled(enabled: boolean): void {
    super.setInputEnabled(enabled)
    this.handProvider.getHand(this.handType as HandType).setEnabled(enabled)
  }

  private defineSceneEvents() {
    this.createEvent("OnDestroyEvent").bind(() => {
      this.onDestroy()
    })
  }

  /**
   * Updates the active target provider and current interactable based on hand state.
   * Called every frame to determine which targeting system should be active.
   *
   * This method orchestrates the selection of the appropriate target provider (Indirect, Direct, or Poke)
   * based on hand position, gesture state, and interaction context.
   */
  private updateTarget(): void {
    // If the hand is not active or tracking, set the current trigger to none and handle the selection lifecycle.
    if (!this.isActive()) {
      this.currentTrigger = InteractorTriggerType.None
      this.handleSelectionLifecycle(this.activeTargetProvider)
      return
    }

    // If the user is mid-interaction, do not hijack raycast logic to avoid jerky interactions.
    if (!this.preventTargetUpdate()) {
      // Cache plane data BEFORE updateNearestPlane() can clear it
      // This is needed for Near→Far transitions where the plane becomes null
      const previousPlane = this._currentInteractionPlane
      const previousProjection = this._cachedIndexProjection
      const wasInNearField = this._fieldTargetingMode !== FieldTargetingMode.FarField

      const rawFieldTargetingMode = this.updateNearestPlane()

      // Apply debounce logic for zone EXITS to prevent accidental transitions
      const targetModeToApply = this.applyModeExitDebounce(rawFieldTargetingMode, previousPlane, previousProjection)

      // If transitioning from near-field to far-field, preserve the cached plane data
      // Only cache if NOT already in a transition (to avoid overwriting good cached values)
      if (wasInNearField && targetModeToApply === FieldTargetingMode.FarField && !this._transition.isActive) {
        // Use the debounce-cached plane data (from when exit was first detected)
        // This is important because updateNearestPlane() clears _currentInteractionPlane during debounce
        const debounceData = this.getPendingExitPlaneData()
        const planeToCache = debounceData.plane ?? previousPlane
        const projectionToCache = debounceData.projection ?? previousProjection

        this._transition.cachedPlane = planeToCache
        this._transition.cachedProjection = projectionToCache

        // Clear the debounce cache now that we've used it
        this._exitDebounce.cachedPlane = null
        this._exitDebounce.cachedProjection = null
      }

      this.setFieldTargetingMode(targetModeToApply)
    } else {
      // Even when target update is prevented (during pinch/poke), we still need to update
      // the cached index projection for visual feedback and cursor positioning.
      this.updateCachedIndexProjection()
    }

    // Update all target providers with current hand state.
    this.physicalInteractionProvider?.update()
    this.indirectTargetProvider?.update()

    // Select which target provider should be active based on hand state and priorities.
    this.selectActiveTargetProvider()

    // Get trigger type and interactable from the active provider
    // PhysicalInteractionProvider handles trigger determination internally!
    if (this.activeTargetProvider === this.physicalInteractionProvider) {
      this.currentTrigger = this.physicalInteractionProvider.currentTrigger
    } else if (this.activeTargetProvider === this.indirectTargetProvider && this.hand?.isPinching()) {
      this.currentTrigger = InteractorTriggerType.Pinch
    } else {
      this.currentTrigger = InteractorTriggerType.None
    }
    this.currentInteractable = this.activeTargetProvider?.currentInteractableHitInfo?.interactable ?? null

    // Handle hover/trigger lifecycle events
    this.handleSelectionLifecycle(this.activeTargetProvider)
  }

  private updatePinchFilter() {
    if (!this.isActive()) {
      return
    }

    if (this.currentInteractable === null) {
      this.hand.useFilteredPinch = false
      return
    }

    let useFilteredPinch = this.currentInteractable.useFilteredPinch
    let ancestor = this.currentInteractable.sceneObject.getParent()
    while (ancestor !== null) {
      const interactable = ancestor.getComponent(Interactable.getTypeName())
      if (interactable !== null) {
        useFilteredPinch = useFilteredPinch || interactable.useFilteredPinch
      }
      ancestor = ancestor.getParent()
    }

    this.hand.useFilteredPinch = useFilteredPinch
  }

  isPoking(): boolean {
    return (
      this.activeTargetProvider === this.physicalInteractionProvider &&
      this.physicalInteractionProvider?.currentTrigger === InteractorTriggerType.Poke
    )
  }

  get pokeIsValid(): boolean {
    return this.physicalInteractionProvider?.pokeIsValid ?? false
  }

  get pokeDepth(): number {
    return this.physicalInteractionProvider?.pokeDepth ?? 0
  }

  get normalizedPokeDepth(): number {
    return this.physicalInteractionProvider?.normalizedPokeDepth ?? 0
  }

  // ============================================================================
  // Helper methods for provider selection logic
  // ============================================================================

  /**
   * Helper to set both the active target provider and drag provider atomically.
   */
  private setActiveProvider(targetProvider: TargetProvider, dragProvider: DragProvider): void {
    this.activeTargetProvider = targetProvider
    this.dragProvider = dragProvider
  }

  /**
   * Selects which target provider should be active based on hand state and priorities.
   *
   * Priority order:
   * 1. If we were triggering last frame → maintain current provider (prevents switching mid-interaction)
   * 2. Otherwise → select based on targets and hand state (poke is prioritized in selectProviderBasedOnPriority)
   */
  private selectActiveTargetProvider(): void {
    // Priority 1: If we were triggering last frame, maintain current provider to prevent switching mid-interaction
    if ((this.previousTrigger & InteractorTriggerType.Select) !== 0) {
      return // Keep current provider
    }

    // Priority 2: Select provider based on what has targets and hand state
    this.selectProviderBasedOnPriority()
  }

  /**
   * Selects provider based on priority:
   * 1. Existing poke target
   * 2. Existing direct (pinch) target
   * 3. Hand is targeting → choose based on zone and hand state
   * 4. Hand not targeting → default to poke (will switch if direct detects target first)
   */
  private selectProviderBasedOnPriority(): void {
    // Check for existing physical interaction (poke or pinch)
    if (this.physicalInteractionProvider?.hasTarget()) {
      this.setActiveProvider(this.physicalInteractionProvider, this.physicalDragProvider)
      return
    }

    // No existing targets - select based on whether hand is in targeting pose
    if (this.hand.targetingData?.intendsToTarget) {
      this.selectProviderForTargetingIntent()
    } else {
      // Not in targeting pose and no targets yet - default to physical provider
      this.setActiveProvider(this.physicalInteractionProvider, this.physicalDragProvider)
    }
  }

  /**
   * Selects provider when hand is actively targeting (pointing/ray gesture).
   * Considers interaction planes and zones to determine the appropriate provider.
   */
  private selectProviderForTargetingIntent(): void {
    if (!this.currentInteractionPlane) {
      // No plane nearby - use indirect (ray) targeting with far field drag
      this.setActiveProvider(this.indirectTargetProvider, this.indirectDragProvider)
      return
    }

    // We have an interaction plane - check our position relative to it
    const planeProjection = this.cachedIndexProjection

    if (planeProjection === null) {
      // Can't project to plane - fall back to indirect with far field drag
      this.setActiveProvider(this.indirectTargetProvider, this.indirectDragProvider)
      return
    }

    // In normal near field zone - use ray targeting but with physical drag
    this.setActiveProvider(this.indirectTargetProvider, this.physicalDragProvider)
  }

  // ============================================================================
  // End of helper methods
  // ============================================================================

  /**
   * Returns the distance information for near-field transitions.
   * @returns NearFieldTransitionInfo containing distance information, or null if not in near field mode
   */
  get nearFieldTransitionInfo(): NearFieldTransitionInfo | null {
    if (this.currentInteractionPlane === null) {
      return null
    }

    const nearFieldDepth = this.currentInteractionPlane.nearFieldDepth

    // Use the cached projection from updateNearestPlane()
    const distanceToPlane =
      this.fieldTargetingMode !== FieldTargetingMode.FarField && this._cachedIndexProjection !== null
        ? this._cachedIndexProjection.distance
        : null

    return {
      // Deprecated fields kept for backward compatibility
      totalTransitionDistance: nearFieldDepth,
      lerpOffset: 0,
      interactionZoneDistance: nearFieldDepth,
      distanceToPlane: distanceToPlane
    }
  }

  /**
   * Determines if a transition between two field targeting modes requires an animated fade.
   * Transitions that change the ray significantly (Far↔Near) or cursor visibility (Near↔Direct)
   * need animation to hide the abrupt change.
   */
  private needsAnimatedTransition(fromMode: FieldTargetingMode, toMode: FieldTargetingMode): boolean {
    // No transition needed if modes are the same
    if (fromMode === toMode) {
      return false
    }

    // Far ↔ Near: Ray locus and direction change significantly
    if (
      (fromMode === FieldTargetingMode.FarField && toMode === FieldTargetingMode.NearField) ||
      (fromMode === FieldTargetingMode.NearField && toMode === FieldTargetingMode.FarField)
    ) {
      return true
    }

    // Near ↔ Direct: Cursor visibility changes
    if (
      (fromMode === FieldTargetingMode.NearField && toMode === FieldTargetingMode.Direct) ||
      (fromMode === FieldTargetingMode.Direct && toMode === FieldTargetingMode.NearField)
    ) {
      return true
    }

    // Near ↔ Behind: Similar to Near ↔ Direct
    if (
      (fromMode === FieldTargetingMode.NearField && toMode === FieldTargetingMode.BehindNearField) ||
      (fromMode === FieldTargetingMode.BehindNearField && toMode === FieldTargetingMode.NearField)
    ) {
      return true
    }

    // Far → Direct or Far → Behind: These are jumps that should animate
    if (
      fromMode === FieldTargetingMode.FarField &&
      (toMode === FieldTargetingMode.Direct || toMode === FieldTargetingMode.BehindNearField)
    ) {
      return true
    }

    // Direct/Behind → Far: Reverse of above
    if (
      (fromMode === FieldTargetingMode.Direct || fromMode === FieldTargetingMode.BehindNearField) &&
      toMode === FieldTargetingMode.FarField
    ) {
      return true
    }

    // Default: no animation needed for other transitions
    return false
  }

  /**
   * Returns the "engagement level" of a field targeting mode.
   * Higher values = more engaged with near-field UI.
   * Used to determine if a mode change is an "exit" (less engaged) or "entry" (more engaged).
   */
  private getModeEngagementLevel(mode: FieldTargetingMode): number {
    switch (mode) {
      case FieldTargetingMode.FarField:
        return 0
      case FieldTargetingMode.NearField:
      case FieldTargetingMode.BehindNearField:
        return 1
      case FieldTargetingMode.Direct:
        return 2
      default:
        return 0
    }
  }

  /**
   * Applies time-based debounce for zone EXITS to prevent accidental transitions.
   *
   * Zone ENTRIES (going to more engaged mode) are applied instantly for responsiveness.
   * Zone EXITS (going to less engaged mode) are debounced - we wait a short period
   * to confirm the user actually wants to leave the zone.
   *
   * Also caches plane data when debounce starts, so we can use it for the transition
   * even after updateNearestPlane() has cleared _currentInteractionPlane.
   *
   * @param rawMode The raw mode returned by updateNearestPlane()
   * @param previousPlane The plane before updateNearestPlane() was called
   * @param previousProjection The projection before updateNearestPlane() was called
   * @returns The mode to actually apply (may be current mode if debounce is active)
   */
  private applyModeExitDebounce(
    rawMode: FieldTargetingMode,
    previousPlane: InteractionPlane | null,
    previousProjection: ZoneProjection | null
  ): FieldTargetingMode {
    const currentMode = this._transition.isActive ? this._transition.toMode : this._fieldTargetingMode
    const currentEngagement = this.getModeEngagementLevel(currentMode)
    const rawEngagement = this.getModeEngagementLevel(rawMode)

    // No change - clear any pending exit
    if (rawMode === currentMode) {
      if (this._exitDebounce.isPending) {
        this._exitDebounce.isPending = false
        this._exitDebounce.cachedPlane = null
        this._exitDebounce.cachedProjection = null
      }
      return currentMode
    }

    // Entry (more engaged) - apply instantly, cancel any pending exit
    if (rawEngagement > currentEngagement) {
      if (this._exitDebounce.isPending) {
        this._exitDebounce.isPending = false
        this._exitDebounce.cachedPlane = null
        this._exitDebounce.cachedProjection = null
      }
      return rawMode
    }

    // Exit (less engaged) - apply debounce
    const currentTime = getTime()

    if (!this._exitDebounce.isPending || this._exitDebounce.targetMode !== rawMode) {
      // Start new debounce timer and CACHE the plane data from this moment
      this._exitDebounce.isPending = true
      this._exitDebounce.targetMode = rawMode
      this._exitDebounce.startTime = currentTime
      this._exitDebounce.cachedPlane = previousPlane
      this._exitDebounce.cachedProjection = previousProjection
      return currentMode // Don't exit yet
    }

    // Check if debounce period has elapsed
    const elapsedTime = currentTime - this._exitDebounce.startTime
    if (elapsedTime >= MODE_EXIT_DEBOUNCE_DURATION_SEC) {
      // Debounce complete - apply the exit
      // Note: _pendingExitPlane/_pendingExitProjection will be used in updateTarget()
      this._exitDebounce.isPending = false
      return rawMode
    }

    // Still debouncing - stay in current mode
    return currentMode
  }

  /**
   * Returns true if we're currently debouncing a mode exit.
   * Used by getEffectiveInteractionPlane() to use cached plane data during debounce.
   */
  private isPendingModeExit(): boolean {
    return this._exitDebounce.isPending
  }

  /**
   * Returns the cached plane data from when debounce started (for Near→Far transitions).
   * This is needed because updateNearestPlane() clears _currentInteractionPlane during debounce.
   */
  getPendingExitPlaneData(): {plane: InteractionPlane | null; projection: ZoneProjection | null} {
    return {
      plane: this._exitDebounce.cachedPlane,
      projection: this._exitDebounce.cachedProjection
    }
  }

  /**
   * Starts a field mode transition or instantly switches if no animation is needed.
   * During a transition, the ray stays in the old mode until fade-out completes,
   * then switches to the new mode during the fade-in phase.
   */
  private setFieldTargetingMode(newMode: FieldTargetingMode): void {
    // Get the effective current mode (consider in-progress transitions)
    const effectiveCurrentMode = this._transition.isActive ? this._transition.toMode : this._fieldTargetingMode

    // No change needed
    if (effectiveCurrentMode === newMode) {
      return
    }

    // If already in a transition, check if the new target is different from what we're transitioning to
    if (this._transition.isActive) {
      // If going back to where we came from, reverse the transition
      if (newMode === this._transition.fromMode) {
        // Swap from/to and recalculate timing to reverse smoothly
        const oldFrom = this._transition.fromMode
        this._transition.fromMode = this._transition.toMode
        this._transition.toMode = oldFrom

        // Invert progress timing (if we were 30% through, now we're 70% through the reverse)
        const elapsed = getTime() - this._transition.startTime
        const currentProgress = Math.min(1.0, elapsed / MODE_TRANSITION_TOTAL_DURATION_SEC)
        const reverseProgress = 1.0 - currentProgress
        this._transition.startTime = getTime() - reverseProgress * MODE_TRANSITION_TOTAL_DURATION_SEC
        return
      }

      // Otherwise, update the target (keeps the transition going to the new mode)
      this._transition.toMode = newMode
      return
    }

    // Check if this transition needs animation
    if (this.needsAnimatedTransition(this._fieldTargetingMode, newMode)) {
      // Start animated transition
      this._transition.isActive = true
      this._transition.startTime = getTime()
      this._transition.fromMode = this._fieldTargetingMode
      this._transition.toMode = newMode

      // Cache plane data when transitioning FROM near-field (plane may become null during transition)
      // Only cache here if not already pre-cached in updateTarget()
      if (
        this._fieldTargetingMode !== FieldTargetingMode.FarField &&
        newMode === FieldTargetingMode.FarField &&
        this._transition.cachedPlane === null
      ) {
        this._transition.cachedPlane = this._currentInteractionPlane
        this._transition.cachedProjection = this._cachedIndexProjection
      }
    } else {
      // Instant switch (no animation needed)
      this._fieldTargetingMode = newMode
      this.onFieldTargetingModeChangedEvent.invoke(newMode)
    }
  }

  /**
   * @returns if we should prevent any updates to the currently targeted item.
   * In the case of pinching (indirect or direct) or poking, we prevent updates to the targeting system.
   * Otherwise, allow updates to the targeted item.
   * This method is automatically cached by FrameCache utility.
   */
  private preventTargetUpdate(): boolean {
    return this.cachedPreventTargetUpdateFn()
  }

  /**
   * Expensive computation for prevent target update logic.
   * This is wrapped by FrameCache and called only once per frame.
   */
  private computePreventTargetUpdate(): boolean {
    return this.hand !== undefined && (this.hand.isPinching() || this.isPoking())
  }

  private isPokingNonDominantHand(): boolean {
    return this.forcePokeOnNonDominantPalmProximity && this.isNearNonDominantHand()
  }

  private isNearNonDominantHand(): boolean {
    const nonDominantHand = this.handProvider.getNonDominantHand()
    const dominantHand = this.handProvider.getDominantHand()

    /** If either the dominant or non-dominant hand is not tracked,
     * or if both hands are in an active targeting pose,
     * then the user is not intending to interact with the nondominant hand UI.
     */
    if (
      !nonDominantHand.isTracked() ||
      !dominantHand.isTracked() ||
      (dominantHand.isInTargetingPose() && nonDominantHand.isInTargetingPose())
    ) {
      return false
    }

    // Detect if dominant index is within interaction proximity to non-dominant palm
    const palmCenter = nonDominantHand.getPalmCenter()
    const dominantIndexTip = dominantHand.indexTip?.position

    return (
      palmCenter !== null &&
      dominantIndexTip !== undefined &&
      palmCenter.distanceSquared(dominantIndexTip) <
        HANDUI_INTERACTION_DISTANCE_THRESHOLD_CM * HANDUI_INTERACTION_DISTANCE_THRESHOLD_CM
    )
  }

  /**
   * Updates the cached index projection without changing the field targeting mode or current interaction plane.
   * This is called during pinch/poke to keep the projection up-to-date for visual feedback.
   */
  private updateCachedIndexProjection(): void {
    if (this._currentInteractionPlane === null) {
      this._cachedIndexProjection = null
      return
    }

    const indexPoint = this.hand.indexTip.position
    if (indexPoint === null) {
      this._cachedIndexProjection = null
      return
    }

    this._cachedIndexProjection = this._currentInteractionPlane.projectPoint(indexPoint)
  }

  // Check for cached planes (via direct collider overlap), choosing the nearest plane if multiple are available.
  // Uses ray-intersection check and hysteresis to prevent erroneous near-field activation.
  private updateNearestPlane(): FieldTargetingMode {
    const colliderPlanes = this.physicalInteractionProvider.currentInteractionPlanes

    // HYSTERESIS: Include the currently-tracked or debounce-cached plane even if collider overlap ended.
    // This allows XY margin logic to work - the collider might be exited before we're outside XY+margin bounds.
    // Use getEffectiveInteractionPlane() which already validates planes aren't destroyed.
    const effectivePlaneForHysteresis = this.getEffectiveInteractionPlane()

    let interactionPlanes = colliderPlanes
    if (effectivePlaneForHysteresis !== null && !colliderPlanes.includes(effectivePlaneForHysteresis)) {
      interactionPlanes = [...colliderPlanes, effectivePlaneForHysteresis]
    }

    let nearestPlane: InteractionPlane | null = null
    let nearestDistance = Number.POSITIVE_INFINITY

    const planeRaycastLocus = this.hand.indexTip.position
    if (planeRaycastLocus === null) {
      this._currentInteractionPlane = null
      this._cachedIndexProjection = null
      return FieldTargetingMode.FarField
    }

    // Get the far-field ray for ray-intersection check
    const farFieldRay = this.handRayProvider.raycast.getRay()
    const rayStart = farFieldRay?.locus ?? null
    const rayEnd = farFieldRay !== null ? farFieldRay.locus.add(farFieldRay.direction.uniformScale(500)) : null

    for (const interactionPlane of interactionPlanes) {
      const planeProjection = interactionPlane.projectPoint(planeRaycastLocus)
      if (planeProjection === null) {
        continue
      }

      const absDistance = Math.abs(planeProjection.distance)

      // ========================================================================
      // HYSTERESIS: Use different thresholds for entering vs staying in near-field
      // Get thresholds from the InteractionPlane itself
      // ========================================================================
      // During debounce, use the debounce-cached plane for hysteresis checks
      // This allows the user to return to bounds and cancel the exit
      const effectivePlane = this._exitDebounce.isPending
        ? this._exitDebounce.cachedPlane
        : this._currentInteractionPlane
      const isCurrentlyActiveForThisPlane = effectivePlane === interactionPlane
      const proximityThreshold = isCurrentlyActiveForThisPlane
        ? interactionPlane.nearFieldExitDepth
        : interactionPlane.nearFieldDepth

      // Check if within proximity (with hysteresis for both depth AND XY)
      // For ENTRY: require isInNearFieldZone (stricter XY + depth check, no margin)
      // For EXIT (already active): use relaxed depth threshold AND XY margin
      // Use projection's pre-computed local coords to avoid duplicate transform calculations
      const xyMargin = isCurrentlyActiveForThisPlane ? XY_HYSTERESIS_MARGIN_CM : 0
      const withinXYWithHysteresis =
        Math.abs(planeProjection.localX) <= planeProjection.halfWidth + xyMargin &&
        Math.abs(planeProjection.localY) <= planeProjection.halfHeight + xyMargin
      const isWithinProximity = isCurrentlyActiveForThisPlane
        ? (planeProjection.distance >= 0 && absDistance < proximityThreshold && withinXYWithHysteresis) ||
          planeProjection.isInBehindZone
        : (planeProjection.isInNearFieldZone && absDistance < proximityThreshold) || planeProjection.isInBehindZone

      // ========================================================================
      // RAY INTERSECTION CHECK: Only enter near-field if ray hits the plane
      // (Skip this check if already in physical/behind zone - user is clearly interacting)
      // ========================================================================
      const isInPhysicalOrBehindZone = planeProjection.isInPhysicalZone || planeProjection.isInBehindZone

      // If already tracking this plane, skip ray check entirely (be lenient for exit)
      // Only check ray intersection when trying to enter NF for a new plane
      let passesRayCheck = isCurrentlyActiveForThisPlane || isInPhysicalOrBehindZone
      if (!passesRayCheck && rayStart !== null && rayEnd !== null) {
        passesRayCheck = interactionPlane.checkRayIntersection(rayStart, rayEnd, XY_HYSTERESIS_MARGIN_CM)
      }

      // ========================================================================
      // EXISTING CHECKS: Angle and FoV
      // ========================================================================
      const normal = interactionPlane.normal
      const isTowardPlane =
        farFieldRay !== null &&
        farFieldRay.direction.angleTo(normal.uniformScale(-1)) < NEAR_FIELD_ANGLE_THRESHOLD_RADIAN

      const isInFov = this.cameraProvider.inFoV(planeProjection.point)

      // ========================================================================
      // COMBINE ALL CHECKS
      // ========================================================================
      if (isWithinProximity && passesRayCheck && isTowardPlane && isInFov && absDistance < nearestDistance) {
        nearestPlane = interactionPlane
        nearestDistance = absDistance
      }
    }

    this._currentInteractionPlane = nearestPlane

    // Update the cached index projection (handles null plane case internally)
    this.updateCachedIndexProjection()

    // Return to far field targeting if no nearby planes were found or projection failed.
    if (this._currentInteractionPlane === null || this._cachedIndexProjection === null) {
      return FieldTargetingMode.FarField
    }

    // Check if the index tip is past the plane for purpose of visuals.
    const isIndexInBehindZone = this._cachedIndexProjection.isInBehindZone
    const indexDistance = this._cachedIndexProjection.distance

    if (isIndexInBehindZone) {
      return FieldTargetingMode.BehindNearField
    }

    // Apply hysteresis for Near ↔ Physical transitions
    // Get thresholds from the InteractionPlane itself
    const isCurrentlyDirect = this._fieldTargetingMode === FieldTargetingMode.Direct
    const physicalThreshold = isCurrentlyDirect
      ? this._currentInteractionPlane.physicalZoneExitDepth
      : this._currentInteractionPlane.physicalZoneDepth

    if (indexDistance >= 0 && indexDistance <= physicalThreshold) {
      return FieldTargetingMode.Direct
    } else {
      return FieldTargetingMode.NearField
    }
  }

  private onDestroy() {
    this.physicalInteractionProvider?.destroy()
    this.indirectTargetProvider?.destroy()
  }
}
