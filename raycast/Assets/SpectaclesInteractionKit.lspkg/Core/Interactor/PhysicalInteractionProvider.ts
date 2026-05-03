import {ProximitySensor} from "../../Components/Helpers/ProximitySensor"
import {HandMeshType} from "../../Components/Interaction/HandVisual/HandVisual"
import {Interactable} from "../../Components/Interaction/Interactable/Interactable"
import {InteractionPlane} from "../../Components/Interaction/InteractionPlane/InteractionPlane"
import {HandInputData} from "../../Providers/HandInputData/HandInputData"
import {HandType} from "../../Providers/HandInputData/HandType"
import {INDEX_TIP} from "../../Providers/HandInputData/LandmarkNames"
import TargetProvider, {InteractableHitInfo} from "../../Providers/TargetProvider/TargetProvider"
import NativeLogger from "../../Utils/NativeLogger"
import {findComponentInSelfOrParents} from "../../Utils/SceneObjectUtils"
import {InteractorTriggerType, TargetingMode} from "../Interactor/Interactor"
import BaseInteractor from "./BaseInteractor"
import {
  FINGERTIP_FORWARD_OFFSET,
  FINGERTIP_MAINTAIN_RADIUS,
  FINGERTIP_SPHERECAST_RADIUS,
  FINGERTIP_UP_OFFSET
} from "./FingertipConstants"

/**
 * Config for PhysicalInteractionProvider
 */
export type PhysicalInteractionProviderConfig = {
  handType: HandType
  shouldPreventTargetUpdate: () => boolean
  colliderEnterRadius: number
  colliderExitRadius: number
  drawDebug: boolean
}

const POKE_STRENGTH_DISTANCE_THRESHOLD_CM = 2.5
const PUSH_THROUGH_THRESHOLD_CM = 5.0
const POKE_DIRECTION_THRESHOLD = 0.6

enum PokeXDirection {
  None = 0,
  Right = 1,
  Left = 2,
  All = 3
}

enum PokeYDirection {
  None = 0,
  Up = 1,
  Down = 2,
  All = 3
}

enum PokeZDirection {
  None = 0,
  Forward = 1,
  Back = 2,
  All = 3
}

/**
 * Unified provider for physical interactions (Poke and Direct/Pinch).
 * Combines precise index finger detection (spherecast) with proximity detection (collider).
 *
 * This provider handles both poke and pinch gestures in a single state machine,
 * eliminating async coordination issues between separate providers and enabling
 * seamless transitions between interaction types.
 */
export class PhysicalInteractionProvider extends TargetProvider {
  readonly targetingMode: TargetingMode = TargetingMode.Poke | TargetingMode.Direct

  // Hand tracking
  private handProvider: HandInputData = HandInputData.getInstance()
  private hand = this.handProvider.getHand(this.config.handType)

  // Detection System 1: Precise index finger detection (from PokeTargetProvider)
  private probe = Physics.createGlobalProbe()
  private indexFingerTouchedInteractables: Set<Interactable> = new Set()
  private raycastHitMap: Map<Interactable, RayCastHit> = new Map() // Store actual raycast hits
  private spherecastCallbackId: number = 0 // For async safety monitoring
  private _pokeIsValid: boolean = true
  private _pokeDepth: number = 0
  private _tipToKnuckleDistance: number = 0
  private _hasPushedThrough: boolean = false
  private initialPokePosition: vec3 | null = null // Where the surface was hit when poke started
  private initialFingerTipPosition: vec3 | null = null // Where the fingertip was when poke started
  private activePokeInteractable: Interactable | null = null
  private invalidPokeInteractables: Set<Interactable> = new Set<Interactable>()

  // Index finger proximity sensor (for spherecast gating optimization)
  private indexFingerProximitySensor!: ProximitySensor
  private indexFingerProximitySensorObject!: SceneObject

  // Detection System 2: Hand nearby detection (for pinch validation)
  private ownerSceneObject!: SceneObject
  private proximityColliders: ColliderComponent[] = []
  private nearbyInteractables: Set<Interactable> = new Set()

  // InteractionPlane tracking (for HandInteractor's field targeting mode logic)
  private _currentInteractionPlanes: Set<InteractionPlane> = new Set()

  // Unified state
  private _currentTrigger: InteractorTriggerType = InteractorTriggerType.None
  private recentlyEndedInteractable: Interactable | null = null
  private previousActiveGestureType: InteractorTriggerType = InteractorTriggerType.None // Track what gesture just ended

  // Debug
  private _drawDebug: boolean
  private log: NativeLogger

  // Reusable Set for currentInteractableSet (avoids allocation each call)
  private _currentInteractableSetCache = new Set<Interactable>()

  constructor(
    private interactor: BaseInteractor,
    private config: PhysicalInteractionProviderConfig
  ) {
    super()
    this.log = new NativeLogger(`PhysicalInteractionProvider${this.config.handType}`)
    this._drawDebug = this.config.drawDebug
    this.probe.debugDrawEnabled = this.config.drawDebug
    this.setupHandNearbyColliders()
  }

  /**
   * Current trigger type (Poke, Pinch, or None)
   * Exposed to HandInteractor for event dispatching
   */
  get currentTrigger(): InteractorTriggerType {
    return this._currentTrigger
  }

  /**
   * Current interaction planes detected by proximity colliders
   * Used by HandInteractor for field targeting mode
   */
  get currentInteractionPlanes(): InteractionPlane[] {
    return Array.from(this._currentInteractionPlanes)
  }

  /**
   * Clears an InteractionPlane from the cache (in the event of the InteractionPlane being de-registered).
   * @param plane - the InteractionPlane to clear.
   */
  clearInteractionPlane(plane: InteractionPlane): void {
    this._currentInteractionPlanes.delete(plane)
  }

  /**
   * Returns the start point for physical interactions.
   *
   * Design: Always uses poke-centric position (spherecast start) for BOTH poke and pinch modes.
   * This ensures zero discontinuity during Poke→Pinch transitions - the position source never changes.
   *
   * For Direct manipulation, this means the anchor point is near the index finger rather than
   * the pinch midpoint, but manipulation still works correctly since offsets are calculated
   * relative to this consistent position.
   *
   * @inheritdoc
   */
  get startPoint(): vec3 {
    return this.getPokeStartPoint()
  }

  /** @inheritdoc */
  get endPoint(): vec3 {
    return this.getPokeEndPoint()
  }

  set drawDebug(debug: boolean) {
    this._drawDebug = debug
    this.probe.debugDrawEnabled = debug
    for (const collider of this.proximityColliders) {
      collider.debugDrawEnabled = debug
    }
  }

  get drawDebug(): boolean {
    return this._drawDebug
  }

  /**
   * Whether the current poke gesture is valid for interaction.
   * Returns false if the finger has pushed through the interactable or hand tracking is unavailable.
   */
  get pokeIsValid(): boolean {
    return this._pokeIsValid && !this._hasPushedThrough && this.isAvailable()
  }

  /**
   * Whether the finger has pushed through the interactable beyond the threshold.
   * When true, the poke is considered invalid to prevent accidental triggers.
   */
  get hasPushedThrough(): boolean {
    return this._hasPushedThrough
  }

  /**
   * Current poke depth in centimeters.
   * Distance from the hit surface to the fingertip (increases as finger pushes deeper).
   */
  get pokeDepth(): number {
    return this._pokeDepth
  }

  /**
   * Normalized poke depth (0-1).
   * 0 = at surface, 1 = at or beyond max depth threshold (POKE_STRENGTH_DISTANCE_THRESHOLD_CM).
   */
  get normalizedPokeDepth(): number {
    const maxDepth = POKE_STRENGTH_DISTANCE_THRESHOLD_CM
    return Math.min(Math.max(this._pokeDepth / maxDepth, 0), 1)
  }

  /**
   * Direction of the index finger (forward vector).
   * Used for interaction raycasting and visual feedback.
   */
  get direction(): vec3 | null {
    return this.hand.indexTip.forward ?? null
  }

  /**
   * Current interaction strength (0-1).
   *
   * Returns different values based on interaction state:
   * - **Poke**: Normalized poke depth (0 at surface, 1 at max depth)
   * - **Pinch**: Pinch strength from hand tracking
   * - **Direct hover**: Pinch strength for visual feedback (e.g., cursor squish)
   * - **No interaction**: null
   */
  get interactionStrength(): number | null {
    if (this._currentTrigger === InteractorTriggerType.Poke) {
      return this.calculatePokeInteractionStrength()
    } else if (this._currentTrigger === InteractorTriggerType.Pinch) {
      return this.hand?.getPinchStrength() ?? null
    }

    // During Direct hover (trigger=None but hovering an interactable that supports Direct),
    // return pinch strength for visual feedback (e.g., cursor squish).
    // This happens after Poke→Pinch→Release when finger is still touching.
    const currentInteractable = this._currentInteractableHitInfo?.interactable
    if (currentInteractable !== null && currentInteractable !== undefined) {
      const supportsDirect = (currentInteractable.targetingMode & TargetingMode.Direct) !== 0

      if (supportsDirect) {
        return this.hand?.getPinchStrength() ?? null
      }
    }

    return null
  }

  /**
   * Calculate poke interaction strength based on fingertip distance from initial contact.
   * Uses fingertip position (endPoint) instead of spherecast hit position to ensure smooth
   * strength changes when pushing in AND pulling back.
   *
   * Why fingertip instead of hit position:
   * - Spherecast hit position tracks where the ray ENTERS the collider
   * - When finger pushes deep, the ray may enter from a different surface
   * - This causes hit position to jump discontinuously
   * - Fingertip position moves smoothly and predictably
   */
  private calculatePokeInteractionStrength(): number {
    const currentInteractable = this._currentInteractableHitInfo?.interactable
    if (!currentInteractable || this.initialFingerTipPosition === null) {
      return 0
    }

    // Use current fingertip position (endPoint) - this moves smoothly as you poke
    const currentFingerTipPosition = this.endPoint
    const distance = currentFingerTipPosition.distance(this.initialFingerTipPosition)

    // Normalize by the threshold constant
    const maxDistance = POKE_STRENGTH_DISTANCE_THRESHOLD_CM

    return Math.min(Math.max(distance / maxDistance, 0), 1)
  }

  /**
   * Reset all internal state
   */
  reset(): void {
    this.indexFingerTouchedInteractables.clear()
    this.raycastHitMap.clear()
    this.nearbyInteractables.clear()
    this._currentInteractionPlanes.clear()
    this._currentInteractableHitInfo = null
    this._currentTrigger = InteractorTriggerType.None
    this.previousActiveGestureType = InteractorTriggerType.None
    this.recentlyEndedInteractable = null
    this._pokeIsValid = true
    this._pokeDepth = 0
    this._tipToKnuckleDistance = 0
    this._hasPushedThrough = false
    this.initialPokePosition = null
    this.initialFingerTipPosition = null
    this.activePokeInteractable = null
    this.invalidPokeInteractables.clear()
  }

  /**
   * Destroy the provider and clean up resources
   */
  destroy(): void {
    if (this.indexFingerProximitySensorObject) {
      this.indexFingerProximitySensorObject.destroy()
    }
    if (this.ownerSceneObject) {
      this.ownerSceneObject.destroy()
    }
  }

  /**
   * Check if the provider is available for interaction
   */
  private isAvailable(): boolean {
    return this.hand.indexTip !== null && this.hand.enabled && (this.hand.isTracked() || this.hand.isPinching())
  }

  /**
   * @inheritdoc
   */
  override update(): void {
    if (!this.isAvailable()) {
      this.reset()
      if (this.indexFingerProximitySensorObject) {
        this.indexFingerProximitySensorObject.enabled = false
      }
      if (this.ownerSceneObject) {
        this.ownerSceneObject.enabled = false
      }
      return
    }

    // Update index finger proximity sensor position
    if (this.indexFingerProximitySensorObject) {
      this.indexFingerProximitySensorObject.getTransform().setWorldPosition(this.hand.indexTip.position)
      this.indexFingerProximitySensorObject.enabled = true
    }

    // Update hand nearby collider position
    if (this.ownerSceneObject) {
      this.ownerSceneObject.getTransform().setWorldPosition(this.getHandNearbyPosition())
      this.ownerSceneObject.enabled = true
    }

    // Update both detection systems during Physics Update phase
    this.updateIndexFingerDetection() // Spherecast (async-safe, gated by index finger proximity)
    // Hand nearby detection updated via collider events (onProximityStay/Exit)

    // Unified decision making
    this.updateInteractionState()

    // State tracking cleanup
    this.clearRecentlyEndedStateIfNeeded()
  }

  // ============================================================================
  // Detection System 1: Index Finger (Precise) - Spherecast
  // ============================================================================

  /**
   * Update index finger detection using spherecast
   * Tracks ALL touched Interactables (regardless of targeting mode)
   */
  private updateIndexFingerDetection(): void {
    // Track callback ID (even on early return) for debugging
    const currentCallbackId = ++this.spherecastCallbackId

    // Grab the proximity sensor on first poke spherecast.
    if (!this.indexFingerProximitySensor) {
      this.indexFingerProximitySensor = this.hand.getProximitySensor(INDEX_TIP)
    }

    // Optimization: Check proximity to INDEX FINGER (not pinch position!)
    const overlappingColliders = this.indexFingerProximitySensor?.getOverlappingColliders() ?? []

    if (overlappingColliders.length === 0) {
      // No Interactables in proximity to index finger - clear stale data (REQUIRED!)
      this.indexFingerTouchedInteractables.clear()
      this.raycastHitMap.clear()
      this.invalidPokeInteractables.clear() // Also clear invalid poke interactables

      this.log.d(
        `No Interactables in proximity to index finger (callbackId=${currentCallbackId}) - skipping spherecast`
      )

      return // Safe to skip spherecast (performance win!)
    }

    // Something nearby - do precise spherecast
    const startPoint = this.getPokeStartPoint()
    const endPoint = this.getPokeEndPoint()

    // Bistability: Use larger radius when already poking to maintain contact through hand tracking noise
    const radius =
      this._currentTrigger === InteractorTriggerType.Poke ? FINGERTIP_MAINTAIN_RADIUS : FINGERTIP_SPHERECAST_RADIUS

    this.probe.sphereCastAll(radius, startPoint, endPoint, (hits: RayCastHit[]) => {
      // Update data (not discarding late callbacks yet - just monitoring)
      this.indexFingerTouchedInteractables.clear()
      this.raycastHitMap.clear()

      for (const hit of hits) {
        const interactable = this.getInteractableFromHit(hit)
        if (interactable) {
          // Add ALL touched interactables (not filtered by targeting mode)
          // This enables dual validation for Direct-only Interactables
          this.indexFingerTouchedInteractables.add(interactable)

          // Store the actual raycast hit for accurate hit position/normal
          this.raycastHitMap.set(interactable, hit)
        }
      }

      // Clean up invalidPokeInteractables: remove any that are no longer being touched
      for (const invalidInteractable of Array.from(this.invalidPokeInteractables)) {
        if (!this.indexFingerTouchedInteractables.has(invalidInteractable)) {
          this.invalidPokeInteractables.delete(invalidInteractable)
          this.log.d(
            `Removed ${invalidInteractable.sceneObject.name} from invalidPokeInteractables (no longer touching)`
          )
        }
      }

      // Update poke validation state
      this.updatePokeValidation(hits)
    })
  }

  /**
   * Get interactable from a raycast hit
   */
  private getInteractableFromHit(hit: RayCastHit): Interactable | null {
    const collider = hit.collider
    if (!collider || !collider.getSceneObject()) {
      return null
    }

    // Use InteractionManager's collider-to-Interactable mapping which handles
    // cases where the collider is on a child SceneObject (e.g., UIKit Element)
    return this.interactionManager.getInteractableByCollider(collider)
  }

  /**
   * Update poke validation state (push-through, depth, etc.)
   * Inherited from PokeTargetProvider logic
   */
  private updatePokeValidation(hits: RayCastHit[]): void {
    // Get the closest hit
    if (hits.length === 0) {
      this._pokeIsValid = true
      this._hasPushedThrough = false
      this.activePokeInteractable = null
      return
    }

    // Find the closest hit that has an Interactable supporting Poke
    // (hits are sorted by distance, but the closest might be a non-interactable collider like InteractionPlane)
    let closestHit: RayCastHit | null = null
    let interactable: Interactable | null = null

    for (const hit of hits) {
      const candidate = this.getInteractableFromHit(hit)
      if (candidate !== null && (candidate.targetingMode & TargetingMode.Poke) !== 0) {
        closestHit = hit
        interactable = candidate
        break
      }
    }

    if (closestHit === null || interactable === null) {
      return
    }

    // Update active poke interactable
    if (this.activePokeInteractable !== interactable) {
      this.activePokeInteractable = interactable
      this.initialPokePosition = closestHit.position
      this.initialFingerTipPosition = this.endPoint
    }

    // Calculate poke depth: distance from hit surface to finger tip (endPoint)
    // This increases as the finger pushes deeper past the surface
    this._pokeDepth = closestHit.position.distance(this.endPoint)

    // Check for push-through with hysteresis to prevent flickering
    // Use a lower threshold for recovery (when coming back out)
    const PUSH_THROUGH_RECOVERY_CM = PUSH_THROUGH_THRESHOLD_CM * 0.5
    if (this._pokeDepth > PUSH_THROUGH_THRESHOLD_CM) {
      this._hasPushedThrough = true
    } else if (this._hasPushedThrough && this._pokeDepth < PUSH_THROUGH_RECOVERY_CM) {
      // Reset when finger has come back significantly above the threshold
      this._hasPushedThrough = false
    }

    // Update tip to knuckle distance
    const indexTipPos = this.hand.indexTip.position
    const indexKnucklePos = this.hand.indexKnuckle.position
    this._tipToKnuckleDistance = indexTipPos.distance(indexKnucklePos)
  }

  /**
   * Get the start point for poke spherecast
   * Inherited from PokeTargetProvider logic
   */
  private getPokeStartPoint(): vec3 {
    const handVisuals = this.hand.getHandVisuals() // double check this is same as poke target provider
    const isFullMesh = handVisuals?.meshType === HandMeshType.Full
    const upOffset = isFullMesh ? 0 : FINGERTIP_UP_OFFSET

    // Extend the collider length to the mid joint only when ACTIVELY poking (trigger engaged).
    // Using _currentInteractableHitInfo caused oscillation: hover sets it, which changes
    // the spherecast position, which loses the target, which clears it, repeat.
    const isActivelyPoking = this._currentTrigger === InteractorTriggerType.Poke
    const indexUpperJointPos = this.hand.indexUpperJoint.position

    if (isActivelyPoking || !this._pokeIsValid) {
      // Extend, but avoid changing the original raycast angle
      const indexTipPos = this.hand.indexTip.position
      const indexTipUp = this.hand.indexTip.up
      const indexKnucklePos = this.hand.indexKnuckle.position
      const tipToKnuckleDistance = indexTipPos.distance(indexKnucklePos)
      const tipToUpperJointDir = indexUpperJointPos.sub(indexTipPos).normalize()
      return indexTipPos
        .add(indexTipUp.uniformScale(upOffset))
        .add(tipToUpperJointDir.uniformScale(tipToKnuckleDistance))
    } else {
      const indexTipUp = this.hand.indexTip.up
      return indexUpperJointPos.add(indexTipUp.uniformScale(upOffset))
    }
  }

  /**
   * Get the end point for poke spherecast
   * Inherited from PokeTargetProvider logic
   */
  private getPokeEndPoint(): vec3 {
    const handVisuals = this.hand.getHandVisuals()
    const isFullMesh = handVisuals?.meshType === HandMeshType.Full
    const upOffset = isFullMesh ? 0 : FINGERTIP_UP_OFFSET
    const forwardOffset = isFullMesh ? 0 : FINGERTIP_FORWARD_OFFSET

    const indexTipPos = this.hand.indexTip.position
    const indexTipUp = this.hand.indexTip.up
    const indexTipBack = this.hand.indexTip.position.sub(this.startPoint).normalize()
    return indexTipPos
      .add(indexTipUp.uniformScale(upOffset))
      .sub(indexTipBack.uniformScale(FINGERTIP_SPHERECAST_RADIUS - forwardOffset))
  }

  /**
   * Get the index finger velocity from hand tracking data
   * Used for poke directionality checks
   * Inherited from PokeTargetProvider
   */
  private getIndexFingerVelocity(): vec3 {
    const objectSpecificData = this.hand.objectTracking3D.objectSpecificData
    if (objectSpecificData) {
      return (objectSpecificData as any)["index-3"]
    }
    return vec3.zero()
  }

  /**
   * Check if poke direction is valid for the given Interactable
   * Based on PokeTargetProvider.isValidPokeDirection()
   *
   * @param interactable - The interactable to check
   * @returns true if direction is valid, false otherwise
   */
  private isValidPokeDirection(interactable: Interactable): boolean {
    const velocity = this.getIndexFingerVelocity()

    // First check: If directionality is disabled, accept all directions
    if (!interactable.enablePokeDirectionality) {
      return true
    }

    // Second check: Test against acceptable directions
    const transform = interactable.getTransform()
    const normalizedVelocity = velocity.normalize()

    // Check X directions
    if (
      ((interactable.acceptableXDirections & PokeXDirection.Left) !== 0 &&
        transform.left.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD) ||
      ((interactable.acceptableXDirections & PokeXDirection.Right) !== 0 &&
        transform.right.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD)
    ) {
      return true
    }

    // Check Y directions
    if (
      ((interactable.acceptableYDirections & PokeYDirection.Up) !== 0 &&
        transform.up.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD) ||
      ((interactable.acceptableYDirections & PokeYDirection.Down) !== 0 &&
        transform.down.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD)
    ) {
      return true
    }

    // Check Z directions
    if (
      ((interactable.acceptableZDirections & PokeZDirection.Forward) !== 0 &&
        transform.forward.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD) ||
      ((interactable.acceptableZDirections & PokeZDirection.Back) !== 0 &&
        transform.back.dot(normalizedVelocity) <= -POKE_DIRECTION_THRESHOLD)
    ) {
      return true
    }

    // No valid direction found
    return false
  }

  // ============================================================================
  // Detection System 2: Hand Nearby (For Pinch Validation) - Collider
  // ============================================================================

  /**
   * Setup colliders for detecting when hand is nearby Interactables (for pinch)
   * Positioned at index/thumb midpoint, uses bistable thresholding
   */
  private setupHandNearbyColliders(): void {
    // Create owner scene object
    const handName = this.config.handType === "left" ? "Left" : "Right"
    this.ownerSceneObject = global.scene.createSceneObject(`${handName}PhysicalInteractionProvider`)
    this.ownerSceneObject.setParent(this.interactor.sceneObject)

    // Create enter collider (smaller radius)
    const enterCollider = this.createCollider(
      this.ownerSceneObject,
      this.config.colliderEnterRadius,
      this.onProximityEnter.bind(this),
      null
    )
    this.proximityColliders.push(enterCollider)

    // Create exit collider (larger radius)
    const exitCollider = this.createCollider(
      this.ownerSceneObject,
      this.config.colliderExitRadius,
      null,
      this.onProximityExit.bind(this)
    )
    this.proximityColliders.push(exitCollider)

    // Start disabled - will be enabled in update() when hand is available
    this.ownerSceneObject.enabled = false
    this.hand.onHandFound.add(() => {
      this.ownerSceneObject.enabled = true
    })
    this.hand.onHandLost.add(() => {
      this.ownerSceneObject.enabled = false
    })
  }

  /**
   * Create a collider for proximity detection
   */
  private createCollider(
    sceneObject: SceneObject,
    radius: number,
    onOverlapEnter: ((eventArgs: OverlapEnterEventArgs) => void) | null,
    onOverlapExit: ((eventArgs: OverlapExitEventArgs) => void) | null
  ): ColliderComponent {
    const collider = sceneObject.createComponent("Physics.ColliderComponent")

    const shape = Shape.createSphereShape()
    shape.radius = radius
    collider.shape = shape
    collider.intangible = true
    collider.debugDrawEnabled = this.config.drawDebug

    if (onOverlapEnter !== null) {
      collider.onOverlapEnter.add(onOverlapEnter)
    }

    if (onOverlapExit !== null) {
      collider.onOverlapExit.add(onOverlapExit)
    }

    return collider
  }

  /**
   * Called once when an object enters the proximity collider
   */
  private onProximityEnter(event: OverlapEnterEventArgs): void {
    // Add Interactable to nearby set (runs once, not every frame!)
    const interactable = this.getInteractableFromCollider(event.overlap.collider)
    if (interactable) {
      this.nearbyInteractables.add(interactable)
      this.log.d(`Proximity ENTER: ${interactable.sceneObject.name}`)
    }

    // Also track InteractionPlane components (for field targeting mode)
    this.addInteractionPlaneFromOverlap(event.overlap)
  }

  /**
   * Called when an Interactable exits the proximity range
   */
  private onProximityExit(event: OverlapExitEventArgs): void {
    const interactable = this.getInteractableFromCollider(event.overlap.collider)
    if (interactable) {
      this.nearbyInteractables.delete(interactable)
      this.log.d(`Proximity EXIT: ${interactable.sceneObject.name}`)
    }

    // Also remove InteractionPlane if it exits
    this.removeInteractionPlaneFromOverlap(event.overlap)
  }

  /**
   * Get interactable from a collider
   */
  private getInteractableFromCollider(collider: ColliderComponent): Interactable | null {
    if (!collider || !collider.getSceneObject()) {
      return null
    }

    // Use InteractionManager's collider-to-Interactable mapping which handles
    // cases where the collider is on a child SceneObject (e.g., UIKit Element)
    return this.interactionManager.getInteractableByCollider(collider)
  }

  private addInteractionPlaneFromOverlap(overlap: Overlap): void {
    const planeSceneObject = overlap.collider.getSceneObject()
    const plane = findComponentInSelfOrParents<InteractionPlane>(planeSceneObject, InteractionPlane.getTypeName(), 1)
    if (plane !== null) {
      this._currentInteractionPlanes.add(plane)
    }
  }

  private removeInteractionPlaneFromOverlap(overlap: Overlap): void {
    const planeSceneObject = overlap.collider.getSceneObject()
    const plane = findComponentInSelfOrParents<InteractionPlane>(planeSceneObject, InteractionPlane.getTypeName(), 1)
    if (plane !== null && plane.collider === overlap.collider) {
      this._currentInteractionPlanes.delete(plane)
    }
  }

  /**
   * Create an InteractableHitInfo object for a given Interactable with actual raycast data
   * Used when we have real raycast data from spherecast
   */
  private createInteractableHitInfoFromRaycast(
    interactable: Interactable,
    hit: RayCastHit,
    targetMode: TargetingMode
  ): InteractableHitInfo {
    const interactableTransform = interactable.sceneObject.getTransform()

    return {
      interactable: interactable,
      localHitPosition: interactableTransform.getInvertedWorldTransform().multiplyPoint(hit.position),
      hit: hit, // Use actual raycast hit!
      targetMode: targetMode
    }
  }

  /**
   * Create an InteractableHitInfo object for a given Interactable with synthetic data
   * Used when we don't have raycast data (e.g., pinch-only interactions)
   */
  private createInteractableHitInfo(interactable: Interactable, targetMode: TargetingMode): InteractableHitInfo {
    const position = this.getHandNearbyPosition()
    const interactableTransform = interactable.sceneObject.getTransform()

    // Create a synthetic RayCastHit
    const syntheticHit: RayCastHit = {
      collider: interactable.sceneObject.getComponent("Physics.ColliderComponent") as ColliderComponent,
      distance: position.distance(interactableTransform.getWorldPosition()),
      normal: vec3.zero(),
      position: position,
      skipRemaining: false,
      t: 0,
      triangle: null as unknown as TriangleHit,
      getTypeName: () => "RayCastHit",
      isSame: (_other: any) => false,
      isOfType: (type: string) => type === "RayCastHit"
    }

    return {
      interactable: interactable,
      localHitPosition: interactableTransform.getInvertedWorldTransform().multiplyPoint(position),
      hit: syntheticHit,
      targetMode: targetMode
    }
  }

  /**
   * Get the hand nearby position (midpoint between index and thumb)
   * This is used for positioning the pinch validation colliders
   */
  private getHandNearbyPosition(): vec3 {
    const indexPos = this.hand.indexTip.position
    const thumbPos = this.hand.thumbTip.position
    return indexPos.add(thumbPos).uniformScale(0.5)
  }

  // ============================================================================
  // Unified State Machine
  // ============================================================================

  /**
   * Update interaction state using combined detection data
   * This is the core state machine that decides what to do each frame
   */
  private updateInteractionState(): void {
    const isPinching = this.hand.isPinching()

    this.log.d(
      `State: trigger=${this._currentTrigger}, pinching=${isPinching}, ` +
        `indexTouching=${this.indexFingerTouchedInteractables.size}, nearby=${this.nearbyInteractables.size} currentInteractableHitInfo=${this._currentInteractableHitInfo ? this._currentInteractableHitInfo.interactable.sceneObject.name : "null"}`
    )

    // Store the gesture type before changing
    // This allows currentInteractableSet to distinguish between poke and pinch endings
    this.previousActiveGestureType = this._currentTrigger

    // CASE 0: Maintaining hover after interaction ended
    if (this._currentTrigger === InteractorTriggerType.None && this._currentInteractableHitInfo !== null) {
      this.maintainHoverAfterInteractionEnd(isPinching)
      return
    }

    // CASE 1: No active interaction - looking for new target
    if (this._currentTrigger === InteractorTriggerType.None) {
      this.checkForNewInteraction(isPinching)
      return
    }

    // CASE 2: Active poke interaction
    if (this._currentTrigger === InteractorTriggerType.Poke) {
      this.validatePokeInteraction(isPinching)
      return
    }

    // CASE 3: Active pinch interaction
    if (this._currentTrigger === InteractorTriggerType.Pinch) {
      this.validatePinchInteraction(isPinching)
      return
    }
  }

  /**
   * CASE 0: Maintain hover after interaction ends
   * Prevents HoverExit → HoverEnter flicker when unpinching while index still touching
   */
  private maintainHoverAfterInteractionEnd(isPinching: boolean): void {
    const hoveredInteractable = this._currentInteractableHitInfo?.interactable
    if (!hoveredInteractable) {
      return
    }

    // Check if dual validation still passes
    const indexStillTouching = this.indexFingerTouchedInteractables.has(hoveredInteractable)
    const stillNearby = this.nearbyInteractables.has(hoveredInteractable)

    const supportsDirect = (hoveredInteractable.targetingMode & TargetingMode.Direct) !== 0

    // If poke-only, clear hover if index is not touching.
    // If supports direct, clear hover if not nearby or index is not touching.

    const shouldClearHover = supportsDirect ? !stillNearby || !indexStillTouching : !indexStillTouching
    if (shouldClearHover) {
      this._currentInteractableHitInfo = null
      this.previousActiveGestureType = InteractorTriggerType.None // Reset
      return
    }

    // At least one validation check passes - maintain hover
    // Check if user wants to start a new interaction
    if (isPinching && stillNearby && indexStillTouching) {
      // User pinched while hovering - start new pinch interaction
      const supportsDirect = (hoveredInteractable.targetingMode & TargetingMode.Direct) !== 0

      if (supportsDirect && hoveredInteractable !== this.recentlyEndedInteractable) {
        // Start new pinch interaction (clears recently ended state)
        // Note: This is NOT a target update (same target, just gesture evolution),
        // so shouldPreventTargetUpdate() check is not needed here.
        this._currentTrigger = InteractorTriggerType.Pinch
        this.recentlyEndedInteractable = null
        this.log.d(`CASE 0: Starting new pinch from hover`)
        return
      }
    }

    // Otherwise: continue hovering, no interaction
    this.log.d(`CASE 0: Maintaining hover (indexTouching=${indexStillTouching}, nearby=${stillNearby})`)
  }

  /**
   * CASE 1: Check for new interaction
   * Decides whether to start a poke or show hover for Direct-only Interactables
   */
  private checkForNewInteraction(isPinching: boolean): void {
    // Don't acquire new targets while pinching in empty space
    if (isPinching && this._currentInteractableHitInfo === null) {
      this.log.d(`CASE 1: Blocking acquisition - pinching without interaction`)
      return
    }

    // Get best candidate (first element) from currentInteractableSet
    // Set maintains insertion order from spherecast hits (closest first)
    const bestCandidate = this.currentInteractableSet.values().next().value ?? null

    if (bestCandidate === null) {
      this._currentInteractableHitInfo = null
      return
    }

    // Block re-interaction with recently ended interactable (prevents re-poke after pinch release)
    if (bestCandidate === this.recentlyEndedInteractable) {
      this._currentInteractableHitInfo = null
      this.log.d(`CASE 1: Best candidate is recently ended - blocking`)
      return
    }

    // Check targeting mode support
    const supportsPoke = (bestCandidate.targetingMode & TargetingMode.Poke) !== 0
    const supportsDirect = (bestCandidate.targetingMode & TargetingMode.Direct) !== 0

    // Skip interactables that don't support physical interaction
    if (!supportsPoke && !supportsDirect) {
      return
    }

    // Check if we should prevent target update
    if (this.config.shouldPreventTargetUpdate()) {
      return
    }

    if (supportsPoke) {
      // Check poke directionality
      const isValidDirection = this.isValidPokeDirection(bestCandidate)

      if (!isValidDirection || this.invalidPokeInteractables.has(bestCandidate)) {
        // Invalid poke direction detected
        this.invalidPokeInteractables.add(bestCandidate)
        this.log.d(`CASE 1: Invalid poke direction for ${bestCandidate.sceneObject.name}`)

        // If interactable also supports Direct, fall through to Direct logic
        // If Poke-only, block interaction entirely
        if (!supportsDirect) {
          this._currentInteractableHitInfo = null
          this.log.d(`CASE 1: Blocking Poke-only with invalid direction`)
          return
        }

        // supportsDirect is true - fall through to Direct logic
        this.log.d(`CASE 1: Invalid poke direction, but supports Direct - falling through`)
        // Don't return here - let execution continue to Direct logic
      } else {
        // Valid poke direction - start interaction immediately
        this._currentTrigger = InteractorTriggerType.Poke

        // Use actual raycast hit for accurate hit position/normal
        const raycastHit = this.raycastHitMap.get(bestCandidate)
        if (raycastHit) {
          this._currentInteractableHitInfo = this.createInteractableHitInfoFromRaycast(
            bestCandidate,
            raycastHit,
            TargetingMode.Poke
          )
        } else {
          // Fallback to synthetic (shouldn't happen for poke, but defensive)
          this._currentInteractableHitInfo = this.createInteractableHitInfo(bestCandidate, TargetingMode.Poke)
        }

        this.log.d(`CASE 1: Starting POKE on ${bestCandidate.sceneObject.name}`)
        return // Early return after starting valid poke
      }
    }

    if (supportsDirect && isPinching) {
      // Direct-only + already pinching - start in pinch mode
      this._currentTrigger = InteractorTriggerType.Pinch
      this._currentInteractableHitInfo = this.createInteractableHitInfo(bestCandidate, TargetingMode.Direct)
      this.log.d(`CASE 1: Starting PINCH on ${bestCandidate.sceneObject.name}`)
      return
    }

    if (supportsDirect && !isPinching && this.nearbyInteractables.has(bestCandidate)) {
      // Direct-capable interactable, not pinching yet: show hover without starting interaction
      // Setting currentInteractableHitInfo enables HoverEnter, but _currentTrigger stays None
      this._currentInteractableHitInfo = this.createInteractableHitInfo(bestCandidate, TargetingMode.Direct)
      this.log.d(`CASE 1: Direct-only hover (awaiting pinch) on ${bestCandidate.sceneObject.name}`)
      return
    }

    // Fallback - no interaction
    this._currentInteractableHitInfo = null
  }

  /**
   * CASE 2: Validate active poke interaction
   * Checks if poke should continue, transition to pinch, or end
   */
  private validatePokeInteraction(isPinching: boolean): void {
    const currentInteractable = this._currentInteractableHitInfo?.interactable
    if (!currentInteractable) {
      this._currentTrigger = InteractorTriggerType.None
      this.log.d(`CASE 2: No current interactable - ending`)
      return
    }

    const indexStillTouching = this.indexFingerTouchedInteractables.has(currentInteractable)
    const supportsDirect = (currentInteractable.targetingMode & TargetingMode.Direct) !== 0

    // Check for Poke → Pinch transition
    if (isPinching && supportsDirect && indexStillTouching) {
      // Dual validation passes - transition to Pinch
      this._currentTrigger = InteractorTriggerType.Pinch
      // Keep same _currentInteractableHitInfo
      // HandInteractor will see this as TriggerUpdate (not new TriggerStart)
      this.log.d(`CASE 2: TRANSITION Poke → Pinch on ${currentInteractable.sceneObject.name}`)
      return
    }

    // Check if poke should continue
    if (!indexStillTouching) {
      // Finger left interactable - end poke
      this.log.d(`CASE 2: Index left - ending poke on ${currentInteractable.sceneObject.name}`)
      this.endInteraction()
      return
    }

    // Poke continues - no state change needed
    this.log.d(`CASE 2: Poke continues on ${currentInteractable.sceneObject.name}`)
  }

  /**
   * CASE 3: Validate active pinch interaction
   * Checks if pinch should continue or end
   */
  private validatePinchInteraction(isPinching: boolean): void {
    const currentInteractable = this._currentInteractableHitInfo?.interactable
    if (!currentInteractable) {
      this._currentTrigger = InteractorTriggerType.None
      this.log.d(`CASE 3: No current interactable - ending`)
      return
    }

    // Sticky pinch: Pinch maintains interaction regardless of distance
    // Only end when pinch releases
    if (!isPinching) {
      this.log.d(`CASE 3: Pinch released - ending on ${currentInteractable.sceneObject.name}`)
      this.endInteraction()
      return
    }

    // Pinch continues - no state change needed
    // Note: Hover state (HoverExit) can still occur when hand moves far
    // This is determined by isHoveringInteractable() checking nearbyInteractables
    this.log.d(`CASE 3: Pinch continues on ${currentInteractable.sceneObject.name}`)
  }

  /**
   * End the current interaction
   * Handles state tracking and hover maintenance
   */
  private endInteraction(): void {
    const endedInteractable = this._currentInteractableHitInfo?.interactable

    // Set the current trigger to none to indicate that the interaction has ended
    // previousActiveGestureType is used to distinguish between poke and pinch endings
    this._currentTrigger = InteractorTriggerType.None

    // CRITICAL: Don't clear _currentInteractableHitInfo here!
    // It needs to persist for the rest of this frame so:
    // 1. HandInteractor can set currentInteractable
    // 2. InteractionManager can dispatch TriggerEnd properly
    // Case 0 (maintainHoverAfterInteractionEnd) will handle cleanup in the next frame.

    // Mark as recently ended to prevent immediate re-poke
    this.recentlyEndedInteractable = endedInteractable ?? null

    if (this.recentlyEndedInteractable) {
      this.log.d(`endInteraction: Marked as recently ended: ${this.recentlyEndedInteractable.sceneObject.name}`)
    }

    // Cleanup will happen in Case 0 when:
    // - Both index touching AND nearby checks fail, OR
    // - User starts a new interaction
  }

  /**
   * Clear the "recently ended" state when appropriate
   * Prevents unwanted poke restarts after pinch release
   */
  private clearRecentlyEndedStateIfNeeded(): void {
    if (this.recentlyEndedInteractable === null) {
      return
    }

    // Clear "recently ended" state when finger leaves the specific interactable
    if (!this.indexFingerTouchedInteractables.has(this.recentlyEndedInteractable)) {
      this.log.d(`Clearing recently ended state (finger left): ${this.recentlyEndedInteractable.sceneObject.name}`)
      this.recentlyEndedInteractable = null
      return
    }

    // Clear "recently ended" state when user starts new pinch (intentional gesture)
    if (this.hand.isPinching() && this._currentTrigger === InteractorTriggerType.None) {
      this.log.d(`Clearing recently ended state (new pinch): ${this.recentlyEndedInteractable.sceneObject.name}`)
      this.recentlyEndedInteractable = null
      return
    }
  }

  // ============================================================================
  // Hover Logic
  // ============================================================================

  /**
   * Check if an Interactable is currently being hovered
   * Different logic for Poke vs Pinch gestures
   */
  override isHoveringInteractable(interactable: Interactable): boolean {
    return this.currentInteractableSet.has(interactable)
  }

  /**
   * Get the set of currently hovered Interactables
   * Poke hover requires single validation (index touching)
   * Direct-only hover requires dual validation (index touching and nearby)
   * @inheritdoc
   */
  override get currentInteractableSet(): Set<Interactable> {
    this._currentInteractableSetCache.clear()

    for (const interactable of this.indexFingerTouchedInteractables) {
      const supportsPoke = (interactable.targetingMode & TargetingMode.Poke) !== 0
      const supportsDirect = (interactable.targetingMode & TargetingMode.Direct) !== 0

      if (supportsPoke) {
        this._currentInteractableSetCache.add(interactable)
      } else if (supportsDirect && this.nearbyInteractables.has(interactable)) {
        this._currentInteractableSetCache.add(interactable)
      }
    }

    // For poke end, consider the currentInteractable as a member of the set
    if (
      this._currentTrigger === InteractorTriggerType.None &&
      this.previousActiveGestureType === InteractorTriggerType.Poke
    ) {
      const currentInteractable = this._currentInteractableHitInfo?.interactable
      if (currentInteractable) {
        this._currentInteractableSetCache.add(currentInteractable)
      }
    }

    return this._currentInteractableSetCache
  }
}
