import {FieldTargetingMode, HandInteractor} from "../../../Core/HandInteractor/HandInteractor"
import {InteractionManager} from "../../../Core/InteractionManager/InteractionManager"
import {
  Interactor,
  InteractorInputType,
  InteractorTriggerType,
  TargetingMode
} from "../../../Core/Interactor/Interactor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {ColliderUtils} from "../../../Utils/ColliderUtils"
import Event from "../../../Utils/Event"
import {LensConfig} from "../../../Utils/LensConfig"
import {smoothstep} from "../../../Utils/mathUtils"
import {findComponentInSelfOrParents} from "../../../Utils/SceneObjectUtils"
import {SpringAnimate1D} from "../../../Utils/springAnimate"
import StateMachine from "../../../Utils/StateMachine"
import {DispatchedUpdateEvent, IUpdateDispatcher} from "../../../Utils/UpdateDispatcher"
import {ScrollBar} from "../../UI/ScrollBar/ScrollBar"
import {ScrollView} from "../../UI/ScrollView/ScrollView"
import {Interactable, TargetingVisual} from "../Interactable/Interactable"
import {InteractableManipulation} from "../InteractableManipulation/InteractableManipulation"
import {InteractionPlane} from "../InteractionPlane/InteractionPlane"

const CONE_RADIUS = 220.0
const INV_CONE_RADIUS = 1.0 / CONE_RADIUS
const INTERACTABLE_FADE_HOTSPOT_RADIUS = 20.0
const PLANE_FADE_HOTSPOT_RADIUS = 0.0
const ALPHA_FADE_DISTANCE = 100.0
const HIDE_ALPHA_THRESHOLD = 0.05
const MIN_LENGTH_THRESHOLD = 1e-6
const SCORE_DIVISOR_EPSILON = 1e-3
const GEOMETRY_EPSILON = 1e-4
const DOMINANCE_RADIUS = 1.0
const DOMINANCE_FADE_WIDTH = 20.0
const PLANE_SLOW_ZONE_DISTANCE = 10.0
const PLANE_BLEND_ZONE_WIDTH = 5.0
const PROXIMITY_HOT_ZONE_FACTOR = 2.0
const PROXIMITY_NEAR_ZONE_FACTOR = 1.0
const SMALL_SPHERE_RADIUS_THRESHOLD = 2.0

const REFERENCE_SCALE = 0.6
const REFERENCE_DISTANCE_CM = 100
const SCALING_FACTOR = REFERENCE_SCALE / REFERENCE_DISTANCE_CM
const MIN_SCALE = 0.4
const MAX_SCALE = 5.0
const SCALE_COMPENSATION_STRENGTH = 0.5
const SCALE_DISTANCE_EPSILON = 4.0

// ============================================================================
// FIELD TARGETING MODE TRANSITION FADE
// NOTE: Transition timing is now managed by HandInteractor.
// This file uses HandInteractor.fieldModeTransitionInfo to synchronize cursor fading.
// ============================================================================

const CursorStates = {
  Hidden: "Hidden",
  Override: "Override",
  Hover: "Hover",
  Manipulating: "Manipulating",
  ScrollDrag: "ScrollDrag"
}

export type CursorViewState = {
  cursorEnabled: boolean
  position: vec3
  scale: number
  cursorAlpha: number
  rayAlpha: number
  isTriggering: boolean
}

type DirectHitRecord = {
  interactable: Interactable
  position: vec3
}

enum DebugCalculationState {
  None, // Default/uninitialized
  Cheap, // Bounding sphere approximation or small-sphere path
  Blended, // Lerped between the cheap and expensive results
  Expensive // A precise, expensive getClosestPointOnColliderToPoint call
}

type CachedInteractableData = {
  score: number
  targetT: number
  radialDistance: number
  positionalDistance: number
  coneRadiusAtT: number
  hotspotRadius: number
  targetingVisual: number
  dominanceFactor: number
  lastUpdated: number
  lastSeenFrame: number
  isEligible: boolean
  debugState?: DebugCalculationState
  debugClosestPointOnRay?: vec3
  debugClosestPointOnCollider?: vec3
}

type CachedPlaneTransform = {
  origin: vec3
  normal: vec3
  right: vec3
  up: vec3
  halfWidth: number
  halfHeight: number
}

class CursorInteractionContext {
  snapDepthNextFrame = true

  manipulationInteractable: Interactable | null = null
  manipulationHitLocal: vec3 | null = null

  scrollingView: ScrollView | null = null
  scrollHitLocal: vec3 | null = null
  scrollPlaneNormal: vec3 | null = null

  get manipulatedInteractable(): Interactable | null {
    return this.manipulationInteractable
  }

  startManipulation(directHit: DirectHitRecord): void {
    const t = directHit.interactable.sceneObject.getTransform()
    this.manipulationInteractable = directHit.interactable
    this.manipulationHitLocal = t.getWorldTransform().inverse().multiplyPoint(directHit.position)
  }

  endManipulation(): void {
    this.manipulationInteractable = null
    this.manipulationHitLocal = null
  }

  updateManipulation(): vec3 | null {
    if (this.manipulationInteractable && this.manipulationHitLocal) {
      const t = this.manipulationInteractable.sceneObject.getTransform()
      return t.getWorldTransform().multiplyPoint(this.manipulationHitLocal)
    }
    return null
  }
}

export class CursorViewModel {
  private segmentLength = 500.0
  private updateDispatcher: IUpdateDispatcher = LensConfig.getInstance().updateDispatcher

  private minDistanceSquared: number
  private maxDistanceSquared: number

  private lastHiddenTriggering: boolean | null = null

  private interactor: Interactor
  private interactionManager: InteractionManager = InteractionManager.getInstance()
  private camera = WorldCameraFinderProvider.getInstance()
  private context = new CursorInteractionContext()
  private cursorStateMachine: StateMachine = new StateMachine("CursorView")
  private pendingScrollData: {sv: ScrollView; worldHit: vec3} | null = null
  private pendingManipulationHit: DirectHitRecord | null = null
  private triggerData: {
    interactable: Interactable
    localHit: vec3
    initialWorld: vec3
    planePoint: vec3
    planeNormal: vec3
    lastIntersect?: vec3
  } | null = null
  private overlappingInteractables = new Map<Interactable, CachedInteractableData>()
  private eligibilityProcessingList: Interactable[] = []
  private eligibilityProcessingIndex: number = 0
  private overlappingPlanes = new Map<InteractionPlane, CachedInteractableData>()
  private planesStillValid = new Set<InteractionPlane>()
  private processingQueue: Interactable[] = []
  private processingIndex: number = 0
  private wasHiddenLastFrame: boolean = true
  private planeTransformCache = new Map<InteractionPlane, CachedPlaneTransform>()

  private isTracked = false
  private wasTracked = false
  private wasOverride = false

  private _cursorPosition: vec3 = vec3.zero()
  private stableAnchorPoint: vec3 = vec3.zero()

  private cursorDepthSpring: SpringAnimate1D = SpringAnimate1D.snappy(0.35)
  private cursorDepthSpringSlow: SpringAnimate1D = SpringAnimate1D.snappy(0.6)

  private onCursorUpdateEvent = new Event<CursorViewState>()
  public onCursorUpdate = this.onCursorUpdateEvent.publicApi()
  public positionOverride: vec3 | null = null
  private debugDrawEnabled: boolean = false
  private debugPlaneLines: {intersection: vec3; closest: vec3}[] = []
  private debugColliderLines: {rayPoint: vec3; closest: vec3}[] = []
  private lateUpdateEvent: DispatchedUpdateEvent
  private interactorLabel: string

  private fadeMultiplierSpring: SpringAnimate1D = SpringAnimate1D.smooth(0.2)
  private fadeMultiplier: number = 1.0
  private fadeMultiplierTarget: number = 1.0

  // ============================================================================
  // MODE TRANSITION FADE STATE
  // ============================================================================

  private lastScaleDistanceSq: number | null = null
  private cachedScale: number = MIN_SCALE

  private coneInteractables: Interactable[] = []
  private coneInteractablesIndex: number = 0

  public get cursorPosition(): vec3 | null {
    return this._cursorPosition
  }

  constructor(interactor: Interactor) {
    this.interactor = interactor
    this.segmentLength = interactor.maxRaycastDistance ?? this.segmentLength
    this.interactorLabel = `${interactor.inputType}`

    const calculateDistanceForScale = (scale: number): number => {
      const idealScale = REFERENCE_SCALE + (scale - REFERENCE_SCALE) / SCALE_COMPENSATION_STRENGTH
      return idealScale / SCALING_FACTOR
    }

    const minDistance = calculateDistanceForScale(MIN_SCALE)
    const maxDistance = calculateDistanceForScale(MAX_SCALE)

    this.minDistanceSquared = minDistance * minDistance
    this.maxDistanceSquared = maxDistance * maxDistance

    this.setupStateMachine()
    this.cursorStateMachine.enterState(CursorStates.Hidden)

    const label = `${this.interactorLabel}`
    this.lateUpdateEvent = this.updateDispatcher.createLateUpdateEvent(`CursorViewModelUpdate_${label}`, () =>
      this.onUpdate()
    )
    this.lateUpdateEvent.enabled = false
  }

  /**
   * Dispose the internal UpdateDispatcher event.
   */
  public destroy(): void {
    if (this.lateUpdateEvent) {
      this.updateDispatcher.removeEvent(this.lateUpdateEvent)
    }
  }

  /**
   * Triggers a fade-in animation.
   */
  public fadeIn(duration?: number): void {
    if (duration && duration > 0) {
      this.fadeMultiplierSpring.setDurationSmooth(duration, true)
    }
    this.fadeMultiplierTarget = 1.0
  }

  /**
   * Triggers a fade-out animation.
   */
  public fadeOut(duration?: number): void {
    if (duration && duration > 0) {
      this.fadeMultiplierSpring.setDurationSmooth(duration, true)
    }
    this.fadeMultiplierTarget = 0.0
  }

  /**
   * Enable or disable the internal UpdateDispatcher event.
   */
  public enableUpdateEvent(enabled: boolean): void {
    if (this.lateUpdateEvent) {
      this.lateUpdateEvent.enabled = enabled
    }
  }

  public onUpdate(): void {
    this.isTracked = this.shouldShowCursor()
    const isTriggering = this.interactor.currentTrigger !== InteractorTriggerType.None

    if (!this.isTracked && !this.positionOverride) {
      this.hideCursor(isTriggering)
      return
    }

    this.planeTransformCache.clear()

    if (this.interactor.activeTargetingMode !== TargetingMode.Indirect) {
      this.hideCursor(isTriggering)
      return
    }

    this.fadeMultiplier = this.fadeMultiplierSpring.evaluate(this.fadeMultiplier, this.fadeMultiplierTarget)

    // Get ray data and update the targeting cone
    const {segmentStart, segmentEnd, rayVector, rayDir, rayLength} = this.getUpdatedRayData()

    const hasDirectHit = this.interactor.currentInteractable !== null && this.interactor.targetHitPosition !== null
    const shouldUpdateConeOverlap = this.isTracked && !hasDirectHit
    if (shouldUpdateConeOverlap) {
      this.updateConeOverlap(segmentStart, rayDir, rayLength)
    }

    // Update the state machine
    this.updateStateMachineSignals(isTriggering, this.isTracked)

    if (this.debugDrawEnabled) {
      if (shouldUpdateConeOverlap) {
        this.debugDrawCone(segmentStart, segmentEnd)
      }
      this.debugDrawRay(segmentStart, segmentEnd)
    }

    // Check if we need plane scanning for the current state
    const needsPlaneScan = this.doesCurrentStateNeedPlaneScan(isTriggering)
    if (needsPlaneScan) {
      // Update potential targets (only needed for hover fallback path)
      this.updateOverlappingPlanes(segmentStart, rayDir, rayLength)
      this.updateEligibilityCache()

      // If no targets are visible, hide the cursor
      if (!this.hasVisibleTargets(isTriggering)) {
        this.hideCursor(isTriggering)
        if (this.debugDrawEnabled) {
          this.debugDrawCachedData()
        }
        return
      }
    }

    // Execute the logic for the current state
    this.executeCurrentStateLogic({isTriggering, isTracked: this.isTracked, segmentStart, rayVector, rayDir, rayLength})

    if (this.debugDrawEnabled) {
      this.debugDrawCachedData()
    }
  }

  private getUpdatedRayData() {
    const {segmentStart, segmentEnd} = this.getInteractionRay()

    const rayVector = segmentEnd.sub(segmentStart)
    const rayLength = rayVector.length
    const rayDir = rayLength > MIN_LENGTH_THRESHOLD ? rayVector.uniformScale(1.0 / rayLength) : vec3.down()

    return {segmentStart, segmentEnd, rayVector, rayDir, rayLength}
  }

  private updateOverlappingPlanes(segmentStart: vec3, rayDir: vec3, rayLength: number): void {
    const tanConeAngle = rayLength > GEOMETRY_EPSILON ? CONE_RADIUS / rayLength : 0.0

    this.planesStillValid.clear()

    // Mark valid planes and add new ones
    for (const plane of this.interactionManager.interactionPlanes) {
      if (!this.isPlaneEligible(plane)) {
        continue
      }

      if (this.isPlaneInCone(plane, segmentStart, rayDir, rayLength, tanConeAngle)) {
        this.planesStillValid.add(plane)

        const existing = this.overlappingPlanes.get(plane)
        if (!existing) {
          this.overlappingPlanes.set(plane, {
            score: 0,
            targetT: 0,
            radialDistance: Infinity,
            positionalDistance: Infinity,
            coneRadiusAtT: 0,
            hotspotRadius: 0,
            targetingVisual: TargetingVisual.Cursor,
            dominanceFactor: 0,
            lastUpdated: 0,
            lastSeenFrame: this.updateDispatcher.frameCount,
            isEligible: true
          })
        }
      }
    }

    // Remove planes that weren't marked as valid
    for (const plane of this.overlappingPlanes.keys()) {
      if (!this.planesStillValid.has(plane)) {
        this.overlappingPlanes.delete(plane)
      }
    }
  }

  private hasVisibleTargets(isTriggering: boolean): boolean {
    if (this.positionOverride) {
      return true
    }

    if (this.triggerData) {
      return true
    }

    if (isTriggering) {
      return true
    }

    if (this.overlappingInteractables.size + this.overlappingPlanes.size === 0) {
      return false
    }

    for (const plane of this.overlappingPlanes.keys()) {
      if (this.isPlaneEligible(plane)) {
        return true
      }
    }
    for (const data of this.overlappingInteractables.values()) {
      if (data.isEligible) {
        return true
      }
    }
    return false
  }

  private updateStateMachineSignals(isTriggering: boolean, isTracked: boolean): void {
    const isOverride = !!this.positionOverride
    if (isOverride && !this.wasOverride) {
      this.cursorStateMachine.sendSignal("OverrideOn")
    } else if (!isOverride && this.wasOverride) {
      this.cursorStateMachine.sendSignal("OverrideOff")
    }
    this.wasOverride = isOverride

    if (isTracked && !this.wasTracked) {
      this.cursorStateMachine.sendSignal("TrackGained")
    } else if (!isTracked && this.wasTracked) {
      this.cursorStateMachine.sendSignal("TrackLost")
    }
    this.wasTracked = isTracked

    // Handle scroll state changes
    if (this.context.scrollingView && !this.context.scrollingView.isDragging) {
      this.cursorStateMachine.sendSignal("ScrollDragEnd")
    }

    // Handle trigger-down events (manipulation, scrolling, trigger)
    if (isTriggering) {
      const currentInteractable = this.interactor.currentInteractable
      const scrollViewCandidate = currentInteractable
        ? findComponentInSelfOrParents(currentInteractable.sceneObject, ScrollView.getTypeName())
        : null
      const directHitRecord = this.getDirectHit()

      if (scrollViewCandidate) {
        this.pendingScrollData = {sv: scrollViewCandidate, worldHit: this.interactor.targetHitPosition!}
        this.cursorStateMachine.sendSignal("ScrollDragStart")
      } else if (directHitRecord) {
        const interactableManipulationComponent = directHitRecord.interactable.sceneObject.getComponent(
          InteractableManipulation.getTypeName()
        )
        const hasManipulation =
          interactableManipulationComponent !== null &&
          interactableManipulationComponent.enabled &&
          (interactableManipulationComponent.canRotate() ||
            interactableManipulationComponent.canTranslate() ||
            interactableManipulationComponent.canScale())

        const isScrollBar = directHitRecord.interactable.sceneObject.getComponent(ScrollBar.getTypeName()) !== null
        if (hasManipulation || isScrollBar) {
          this.pendingManipulationHit = directHitRecord
          this.cursorStateMachine.sendSignal("TriggerDownManipulate")
        } else if (!this.triggerData) {
          const so = directHitRecord.interactable.sceneObject
          const t = so.getTransform()
          const worldHit = directHitRecord.position

          const baseTriggerData = {
            interactable: directHitRecord.interactable,
            localHit: t.getWorldTransform().inverse().multiplyPoint(worldHit),
            initialWorld: worldHit,
            blend: 0,
            hasBroken: false
          }

          const parentPlane = findComponentInSelfOrParents(so, InteractionPlane.getTypeName())
          if (this.isPlaneEnabled(parentPlane) && !directHitRecord.interactable.ignoreInteractionPlane) {
            const {normal} = this.getPlaneWorldOriginAndAxes(parentPlane)
            this.triggerData = {...baseTriggerData, planePoint: worldHit, planeNormal: normal}
          } else {
            const planeNormal = this.camera.forward()
            planeNormal.length = 1
            this.triggerData = {
              ...baseTriggerData,
              planePoint: worldHit,
              planeNormal: planeNormal
            }
          }
        }
      }
    } else {
      // Handle trigger-up event
      this.cursorStateMachine.sendSignal("TriggerUp")
      this.triggerData = null
    }
  }

  private doesCurrentStateNeedPlaneScan(isTriggering: boolean): boolean {
    if (this.context.scrollingView && isTriggering) {
      return false
    }

    if (this.triggerData && isTriggering) {
      return false
    }

    if (this.cursorStateMachine.currentState?.name === CursorStates.Manipulating) {
      return false
    }

    if (this.getDirectHit()) {
      return false
    }

    return true
  }

  private executeCurrentStateLogic(frameData: {
    isTriggering: boolean
    isTracked: boolean
    segmentStart: vec3
    rayVector: vec3
    rayDir: vec3
    rayLength: number
  }): void {
    const {isTriggering, isTracked, segmentStart, rayVector, rayDir, rayLength} = frameData
    const currentStateName = this.cursorStateMachine.currentState?.name

    if (this.debugDrawEnabled) {
      this.debugPlaneLines.length = 0
      this.debugColliderLines.length = 0
    }

    switch (currentStateName) {
      case CursorStates.Hidden:
        this.hideCursor(isTriggering)
        break

      case CursorStates.Override:
        this.updateWithOverride(isTriggering, isTracked)
        break

      case CursorStates.Manipulating:
        this.handleManipulationState(isTriggering)
        break

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - intentional fall through (using @ts-ignore instead of @ts-expect-error for cross-config compatibility)
      case CursorStates.ScrollDrag:
        if (this.handleActiveScrollDrag(segmentStart, rayDir, isTriggering)) {
          // Scroll handled the frame, nothing else to do.
          return
        }
      // Fall through to hover logic if scroll fails

      case CursorStates.Hover:
        // Trigger takes priority over normal hover behavior to follow only the plane of the triggered Interactable.
        if (this.handleTriggerState(isTriggering, segmentStart, rayDir)) {
          return
        }
        this.handleHoverState(isTriggering, segmentStart, rayVector, rayDir, rayLength)
        break
    }
  }

  private handleHoverState(
    isTriggering: boolean,
    segmentStart: vec3,
    rayVector: vec3,
    rayDir: vec3,
    rayLength: number
  ): void {
    const directHitRecord = this.getDirectHit()
    if (directHitRecord) {
      this.runDirectHitInteraction(segmentStart, rayDir, directHitRecord, isTriggering)
    } else {
      this.runFallbackInteraction(segmentStart, rayVector, rayDir, rayLength, isTriggering)
    }
  }

  private handleTriggerState(isTriggering: boolean, segmentStart: vec3, rayDir: vec3): boolean {
    const trigger = this.triggerData
    if (!trigger || !isTriggering) {
      return false
    }

    const latchedWorld = trigger.initialWorld
    const {planePoint, planeNormal} = trigger
    let planeIntersect = trigger.lastIntersect ?? latchedWorld

    const denom = rayDir.dot(planeNormal)
    if (Math.abs(denom) > GEOMETRY_EPSILON) {
      const t = planePoint.sub(segmentStart).dot(planeNormal) / denom
      if (t >= 0) {
        planeIntersect = segmentStart.add(rayDir.uniformScale(t))
      }
    }
    trigger.lastIntersect = planeIntersect

    this._cursorPosition = planeIntersect
    this.stableAnchorPoint = planeIntersect

    const visualInteractable = trigger.interactable

    const targetingVisual =
      visualInteractable && !isNull(visualInteractable.sceneObject)
        ? this.getEffectiveTargetingVisual(visualInteractable)
        : TargetingVisual.None

    // Apply near-field distance-based fade for cursor and ray
    const fadeMultiplier = this.calculateNearFieldFadeMultiplier()
    const cursorAlpha = (targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0) * fadeMultiplier
    const rayAlpha = (targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0) * fadeMultiplier

    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
    return true
  }

  private handleManipulationState(isTriggering: boolean): void {
    const manipulatedPos = this.context.updateManipulation()
    if (
      manipulatedPos &&
      this.context.manipulatedInteractable &&
      !isNull(this.context.manipulatedInteractable.sceneObject)
    ) {
      this._cursorPosition = manipulatedPos
      this.stableAnchorPoint = manipulatedPos

      const targetingVisual = this.getEffectiveTargetingVisual(this.context.manipulatedInteractable)
      // Apply near-field distance-based fade for cursor and ray
      const fadeMultiplier = this.calculateNearFieldFadeMultiplier()
      const blendFactor = (targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0) * fadeMultiplier
      const rayAlpha = (targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0) * fadeMultiplier

      this.updateAndDrawCursor(blendFactor, rayAlpha, isTriggering)
    }
  }

  private setupStateMachine(): void {
    this.cursorStateMachine.addState({
      name: CursorStates.Hidden,
      transitions: [
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn"
        },
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "TrackGained" && this.positionOverride === null
        }
      ]
    })

    // Override
    this.cursorStateMachine.addState({
      name: CursorStates.Override,
      transitions: [
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "OverrideOff" && this.isTracked
        },
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "OverrideOff" && !this.isTracked
        }
      ]
    })

    // Hover
    this.cursorStateMachine.addState({
      name: CursorStates.Hover,
      transitions: [
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "TrackLost"
        },
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn"
        },
        {
          nextStateName: CursorStates.ScrollDrag,
          checkOnSignal: (signal) => signal === "ScrollDragStart",
          onExecution: () => {
            if (this.pendingScrollData) {
              const {sv, worldHit} = this.pendingScrollData
              this.context.scrollingView = sv
              const scrollTransform = sv.getSceneObject().getTransform()
              this.context.scrollHitLocal = scrollTransform.getWorldTransform().inverse().multiplyPoint(worldHit)
              this.context.scrollPlaneNormal = scrollTransform.forward
              this.pendingScrollData = null
            }
          }
        },
        {
          nextStateName: CursorStates.Manipulating,
          checkOnSignal: (signal) => signal === "TriggerDownManipulate",
          onExecution: () => {
            if (this.pendingManipulationHit) {
              this.context.startManipulation(this.pendingManipulationHit)
              this._cursorPosition = this.context.updateManipulation()!
              this.stableAnchorPoint = this._cursorPosition
              this.pendingManipulationHit = null
            }
          }
        }
      ]
    })

    // Manipulating
    this.cursorStateMachine.addState({
      name: CursorStates.Manipulating,
      transitions: [
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "TriggerUp",
          onExecution: () => {
            this.context.endManipulation()
          }
        },
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "TrackLost",
          onExecution: () => {
            this.context.endManipulation()
          }
        },
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn",
          onExecution: () => {
            this.context.endManipulation()
          }
        }
      ]
    })

    // ScrollDrag
    this.cursorStateMachine.addState({
      name: CursorStates.ScrollDrag,
      onExit: () => {
        this.context.scrollingView = null
        this.context.scrollHitLocal = null
        this.context.scrollPlaneNormal = null
      },
      transitions: [
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "ScrollDragEnd"
        },
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "TrackLost"
        },
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn"
        }
      ]
    })
  }

  private handleActiveScrollDrag(segmentStart: vec3, rayDir: vec3, isTriggering: boolean): boolean {
    if (this.context.scrollingView && this.context.scrollHitLocal && this.context.scrollPlaneNormal) {
      const scrollTransform = this.context.scrollingView.getSceneObject().getTransform()
      const currentAnchorPoint = scrollTransform.getWorldTransform().multiplyPoint(this.context.scrollHitLocal)

      const denom = rayDir.dot(this.context.scrollPlaneNormal)

      if (Math.abs(denom) > GEOMETRY_EPSILON) {
        const t = currentAnchorPoint.sub(segmentStart).dot(this.context.scrollPlaneNormal) / denom
        if (t >= 0) {
          this._cursorPosition = segmentStart.add(rayDir.uniformScale(t))
        } else {
          this._cursorPosition = currentAnchorPoint
        }
      } else {
        this._cursorPosition = currentAnchorPoint
      }

      this.stableAnchorPoint = this._cursorPosition

      const visualInteractable =
        this.interactor.currentInteractable ??
        this.context.scrollingView.getSceneObject().getComponent(Interactable.getTypeName())

      const targetingVisual =
        visualInteractable && !isNull(visualInteractable.sceneObject)
          ? this.getEffectiveTargetingVisual(visualInteractable)
          : TargetingVisual.None
      const cursorAlpha = targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0
      const rayAlpha = targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0

      this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
      return true
    }
    return false
  }

  private runDirectHitInteraction(
    rayOrigin: vec3,
    rayDir: vec3,
    directHitRecord: DirectHitRecord,
    isTriggering: boolean
  ): void {
    this.handleDirectHit(rayOrigin, rayDir, directHitRecord)

    const targetingVisual = this.getEffectiveTargetingVisual(directHitRecord.interactable)

    // Apply near-field distance-based fade for cursor and ray
    const fadeMultiplier = this.calculateNearFieldFadeMultiplier()
    const cursorAlpha = (targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0) * fadeMultiplier
    const rayAlpha = (targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0) * fadeMultiplier

    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
  }

  private runFallbackInteraction(
    rayOrigin: vec3,
    rayVector: vec3,
    rayDir: vec3,
    rayLength: number,
    isTriggering: boolean
  ): void {
    if (this.overlappingInteractables.size + this.overlappingPlanes.size === 0) {
      this.updateAndDrawCursor(0.0, 0.0, isTriggering)
      return
    }
    this.updateInteractableCacheBatch(rayOrigin, rayVector, rayDir, rayLength)
    const blendResult = this.blendCachedInteractables(rayOrigin, rayVector)

    const defaultPosition = rayOrigin.add(rayDir.uniformScale(REFERENCE_DISTANCE_CM))
    let finalCursorPosition = defaultPosition
    let cursorAlpha = 0.0
    let rayAlpha = 0.0

    if (blendResult) {
      const rawTargetPosition = rayOrigin.add(rayVector.uniformScale(blendResult.targetT))
      const currentDepth = this.stableAnchorPoint.sub(rayOrigin).dot(rayDir)
      const targetDepth = rawTargetPosition.sub(rayOrigin).dot(rayDir)

      // If visuals are effectively hidden, snap immediately to avoid a visible lerp
      const overallAlphaNow = Math.max(blendResult.cursorAlpha, blendResult.rayAlpha)
      if (overallAlphaNow <= HIDE_ALPHA_THRESHOLD) {
        this.cursorDepthSpring.reset()
        this.context.snapDepthNextFrame = true
      }

      let smoothedDepth: number
      if (this.context.snapDepthNextFrame || this.wasHiddenLastFrame) {
        this.cursorDepthSpring.reset()
        smoothedDepth = targetDepth
      } else {
        smoothedDepth = this.cursorDepthSpring.evaluate(currentDepth, targetDepth)
      }

      finalCursorPosition = rayOrigin.add(rayDir.uniformScale(smoothedDepth))

      // Apply near-field distance-based fade for cursor and ray
      const fadeMultiplier = this.calculateNearFieldFadeMultiplier()
      cursorAlpha = blendResult.cursorAlpha * fadeMultiplier
      rayAlpha = blendResult.rayAlpha * fadeMultiplier
    }

    this._cursorPosition = finalCursorPosition
    this.stableAnchorPoint = finalCursorPosition
    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
  }

  private shouldShowCursor(): boolean {
    if (
      !this.interactor.enabled ||
      !this.interactor.startPoint ||
      !this.interactor.direction ||
      !this.interactor.isActive() ||
      !this.interactor.isTargeting()
    ) {
      return false
    }

    const isVisibleTargetingMode =
      (this.interactor.activeTargetingMode & (TargetingMode.Poke | TargetingMode.Direct | TargetingMode.None)) === 0
    if (!isVisibleTargetingMode) {
      return false
    }

    return true
  }

  /**
   * Calculates the near-field fade multiplier for cursor and ray alpha.
   *
   * Uses HandInteractor.fieldModeTransitionInfo to synchronize cursor fading with ray switching.
   * The HandInteractor manages all transition timing; we just read the blendFactor from it.
   *
   * Behavior:
   * - FarField: Cursor visible (multiplier = 1.0)
   * - NearField: Cursor visible (multiplier = 1.0) for indirect pinching
   * - Direct/BehindNearField: Cursor hidden (multiplier = 0.0)
   * - During transitions: blendFactor fades out, ray switches at midpoint, blendFactor fades in
   *
   * @returns fade multiplier between 0.0 and 1.0
   */
  private calculateNearFieldFadeMultiplier(): number {
    if ((this.interactor.inputType & InteractorInputType.BothHands) === 0) {
      return 1.0
    }

    const handInteractor = this.interactor as HandInteractor
    const transitionInfo = handInteractor.fieldModeTransitionInfo

    // During a transition, use the blendFactor from the transition info
    // This is synchronized with when the ray switches (at the midpoint)
    if (transitionInfo.isTransitioning) {
      return transitionInfo.blendFactor
    }

    // Not in transition - check if cursor should be hidden based on current mode
    const effectiveMode = transitionInfo.toMode // The final/current mode
    if (effectiveMode === FieldTargetingMode.Direct || effectiveMode === FieldTargetingMode.BehindNearField) {
      return 0.0
    }

    // FarField or NearField - cursor is visible
    return 1.0
  }

  private getDirectHit(): DirectHitRecord | null {
    const interactable = this.interactor.currentInteractable
    const hitPosition = this.interactor.targetHitPosition
    if (interactable && hitPosition) {
      return {interactable, position: hitPosition}
    }
    return null
  }

  private handleDirectHit(rayOrigin: vec3, rayDir: vec3, directHitRecord: DirectHitRecord): void {
    const rawTargetPosition = directHitRecord.position
    const currentDepth = this.stableAnchorPoint.sub(rayOrigin).dot(rayDir)
    const targetDepth = rawTargetPosition.sub(rayOrigin).dot(rayDir)

    let smoothedDepth: number
    if (this.context.snapDepthNextFrame) {
      this.cursorDepthSpring.reset()
      this.cursorDepthSpringSlow.reset()
      smoothedDepth = targetDepth
    } else {
      const parentPlane = findComponentInSelfOrParents(
        directHitRecord.interactable.sceneObject,
        InteractionPlane.getTypeName()
      )
      if (this.isPlaneEnabled(parentPlane) && !directHitRecord.interactable.ignoreInteractionPlane) {
        const snappyDepth = this.cursorDepthSpring.evaluate(currentDepth, targetDepth)
        const slowDepth = this.cursorDepthSpringSlow.evaluate(currentDepth, targetDepth)

        const {origin: planeOrigin, normal: planeNormal} = this.getPlaneWorldOriginAndAxes(parentPlane)

        const vectorToCursor = this.stableAnchorPoint.sub(planeOrigin)
        const worldDistance = Math.abs(vectorToCursor.dot(planeNormal))

        const blendStartDistance = PLANE_SLOW_ZONE_DISTANCE + PLANE_BLEND_ZONE_WIDTH
        const blendEndDistance = PLANE_SLOW_ZONE_DISTANCE

        const blendFactor = smoothstep(blendStartDistance, blendEndDistance, worldDistance)

        smoothedDepth = snappyDepth * (1.0 - blendFactor) + slowDepth * blendFactor
      } else {
        smoothedDepth = this.cursorDepthSpring.evaluate(currentDepth, targetDepth)
      }
    }

    const finalCursorPosition = rayOrigin.add(rayDir.uniformScale(smoothedDepth))
    this._cursorPosition = finalCursorPosition
    this.stableAnchorPoint = finalCursorPosition
  }

  private updateAndDrawCursor(cursorAlpha: number, rayAlpha: number, isTriggering: boolean): void {
    const overallAlpha = Math.max(cursorAlpha, rayAlpha)
    const willSnap = overallAlpha <= HIDE_ALPHA_THRESHOLD
    this.context.snapDepthNextFrame = willSnap

    this.stableAnchorPoint = this._cursorPosition

    const scale = this.calculateCursorScale(this._cursorPosition)

    this.onCursorUpdateEvent.invoke({
      cursorEnabled: true,
      position: this._cursorPosition,
      scale: scale,
      cursorAlpha: cursorAlpha * this.fadeMultiplier,
      rayAlpha: rayAlpha * this.fadeMultiplier,
      isTriggering: isTriggering
    })

    this.lastHiddenTriggering = null
    this.wasHiddenLastFrame = overallAlpha * this.fadeMultiplier <= HIDE_ALPHA_THRESHOLD
  }

  public setDebugDraw(enabled: boolean): void {
    this.debugDrawEnabled = enabled
  }

  private debugDrawCone(segmentStart: vec3, segmentEnd: vec3): void {
    const CONE_LINE_COLOR = new vec4(1.0, 1.0, 0.0, 0.3)
    const axis = segmentEnd.sub(segmentStart)
    if (axis.length > MIN_LENGTH_THRESHOLD) {
      const rayDir = axis.normalize()
      const up = Math.abs(rayDir.dot(vec3.up())) < 0.99 ? vec3.up() : vec3.right()
      const right = rayDir.cross(up).normalize()
      const orthoUp = right.cross(rayDir).normalize()

      const segments = 16
      const angleStep = (Math.PI * 2) / segments

      for (let i = 0; i < segments; i++) {
        const angle = i * angleStep
        const x = Math.cos(angle) * CONE_RADIUS
        const y = Math.sin(angle) * CONE_RADIUS

        const p1 = segmentEnd.add(right.uniformScale(x)).add(orthoUp.uniformScale(y))

        // Line from tip to base
        global.debugRenderSystem.drawLine(segmentStart, p1, CONE_LINE_COLOR)

        // Base circle
        const nextAngle = (i + 1) * angleStep
        const nextX = Math.cos(nextAngle) * CONE_RADIUS
        const nextY = Math.sin(nextAngle) * CONE_RADIUS
        const p2 = segmentEnd.add(right.uniformScale(nextX)).add(orthoUp.uniformScale(nextY))

        global.debugRenderSystem.drawLine(p1, p2, CONE_LINE_COLOR)
      }
    }
  }

  private debugDrawRay(segmentStart: vec3, segmentEnd: vec3): void {
    const COLOR_RAY = new vec4(0.1, 0.7, 1.0, 1.0)
    global.debugRenderSystem.drawLine(segmentStart, segmentEnd, COLOR_RAY)
  }

  private debugDrawCachedData(): void {
    const COLOR_CACHED = new vec4(0.85, 0.85, 0.85, 1.0)
    const COLOR_CHEAP = new vec4(0.2, 1.0, 0.2, 1.0)
    const COLOR_BLENDED = new vec4(1.0, 1.0, 0.2, 1.0)
    const COLOR_EXPENSIVE = new vec4(1.0, 0.2, 0.2, 1.0)
    const COLOR_BOUNDING_SPHERE = new vec4(0.6, 0.2, 1.0, 0.5)

    const currentTime = getTime()
    const staleThreshold = 1.0 / 55.0

    const drawDebugForData = (data: CachedInteractableData) => {
      if (data.score <= 0) return
      if (!data.debugState || !data.debugClosestPointOnRay || !data.debugClosestPointOnCollider) return
      let color = COLOR_CACHED
      if (Math.abs(currentTime - data.lastUpdated) < staleThreshold) {
        switch (data.debugState) {
          case DebugCalculationState.Cheap:
            color = COLOR_CHEAP
            break
          case DebugCalculationState.Blended:
            color = COLOR_BLENDED
            break
          case DebugCalculationState.Expensive:
            color = COLOR_EXPENSIVE
            break
        }
      }
      global.debugRenderSystem.drawLine(data.debugClosestPointOnRay, data.debugClosestPointOnCollider, color)
      global.debugRenderSystem.drawSphere(data.debugClosestPointOnCollider, 0.5, color)
    }

    for (const data of this.overlappingPlanes.values()) {
      drawDebugForData(data)
    }
    for (const data of this.overlappingInteractables.values()) {
      drawDebugForData(data)
    }

    for (const [interactable, data] of this.overlappingInteractables.entries()) {
      if (data.score <= 0) continue
      for (const collider of interactable.colliders) {
        const bs = ColliderUtils.getColliderWorldBoundingSphere(collider)
        if (bs) {
          global.debugRenderSystem.drawSphere(bs.center, bs.radius, COLOR_BOUNDING_SPHERE)
        }
      }
    }
  }

  private updateInteractableCacheBatch(segmentStart: vec3, segDir: vec3, segDirNorm: vec3, segLen: number): void {
    const currentTime = getTime()

    for (const plane of this.overlappingPlanes.keys()) {
      if (!this.isPlaneEligible(plane)) {
        continue
      }
      const newData = this.getTargetingDataForPlane(plane, segmentStart, segDirNorm, segLen)
      if (newData) {
        const cachedData = this.overlappingPlanes.get(plane)!
        cachedData.score = newData.score
        cachedData.targetT = newData.targetT
        cachedData.radialDistance = newData.radialDistance
        cachedData.positionalDistance = newData.positionalDistance
        cachedData.coneRadiusAtT = newData.coneRadiusAtT
        cachedData.hotspotRadius = newData.hotspotRadius
        cachedData.targetingVisual = newData.targetingVisual
        if (newData.debugState !== undefined) {
          cachedData.debugState = newData.debugState
        }
        if (newData.debugClosestPointOnRay !== undefined) {
          cachedData.debugClosestPointOnRay = newData.debugClosestPointOnRay
        }
        if (newData.debugClosestPointOnCollider !== undefined) {
          cachedData.debugClosestPointOnCollider = newData.debugClosestPointOnCollider
        }
        cachedData.lastUpdated = currentTime
      }
    }

    this.processingQueue.length = 0

    for (const [interactable, data] of this.overlappingInteractables.entries()) {
      if (data.isEligible) {
        this.processingQueue.push(interactable)
      } else {
        data.score = 0
      }
    }

    const eligibleCount = this.processingQueue.length
    if (eligibleCount === 0) {
      this.processingIndex = 0
      return
    }
    if (this.processingIndex >= this.processingQueue.length) {
      this.processingIndex = 0
    }

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(eligibleCount)))

    for (let i = 0; i < chunkSize; i++) {
      if (this.processingIndex >= this.processingQueue.length) break

      const interactable = this.processingQueue[this.processingIndex]
      const cachedData = this.overlappingInteractables.get(interactable)

      const newData = this.getTargetingDataForInteractable(interactable, segmentStart, segDirNorm, segLen)
      if (cachedData) {
        cachedData.score = newData.score
        cachedData.targetT = newData.targetT
        cachedData.radialDistance = newData.radialDistance
        cachedData.positionalDistance = newData.positionalDistance
        cachedData.coneRadiusAtT = newData.coneRadiusAtT
        cachedData.hotspotRadius = newData.hotspotRadius
        cachedData.targetingVisual = newData.targetingVisual
        if (newData.debugState !== undefined) {
          cachedData.debugState = newData.debugState
        }
        if (newData.debugClosestPointOnRay !== undefined) {
          cachedData.debugClosestPointOnRay = newData.debugClosestPointOnRay
        }
        if (newData.debugClosestPointOnCollider !== undefined) {
          cachedData.debugClosestPointOnCollider = newData.debugClosestPointOnCollider
        }
        cachedData.lastUpdated = currentTime
      }
      this.processingIndex++
    }
  }

  private getTargetingDataForPlane(
    plane: InteractionPlane,
    segmentStart: vec3,
    segDirNorm: vec3,
    segLen: number
  ): Omit<CachedInteractableData, "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"> | null {
    if (segLen <= MIN_LENGTH_THRESHOLD) {
      return null
    }

    const baseRadius = CONE_RADIUS
    const invSegLen = 1.0 / segLen

    let targetT = 0,
      radialDistance = Infinity,
      coneRadiusAtT = 0,
      hotspotRadius = 0
    let debugState: DebugCalculationState | undefined,
      debugClosestPointOnRay: vec3 | undefined,
      debugClosestPointOnCollider: vec3 | undefined

    {
      const {origin: planeOrigin, normal, right, up, halfWidth, halfHeight} = this.getPlaneWorldOriginAndAxes(plane)

      const denom = segDirNorm.dot(normal)
      if (Math.abs(denom) <= GEOMETRY_EPSILON) return null

      const tWorld = planeOrigin.sub(segmentStart).dot(normal) / denom
      if (tWorld < 0 || tWorld > segLen) return null

      const intersection = segmentStart.add(segDirNorm.uniformScale(tWorld))
      const d = intersection.sub(planeOrigin)

      const rx = d.dot(right)
      const ry = d.dot(up)
      // clampedX = clamp(rx, -halfWidth, +halfWidth)
      const clampedX = rx < -halfWidth ? -halfWidth : rx > halfWidth ? halfWidth : rx
      // clampedY = clamp(ry, -halfHeight, +halfHeight)
      const clampedY = ry < -halfHeight ? -halfHeight : ry > halfHeight ? halfHeight : ry

      const clampedPoint = planeOrigin.add(right.uniformScale(clampedX)).add(up.uniformScale(clampedY))

      if (this.debugDrawEnabled) {
        debugState = DebugCalculationState.Cheap
        debugClosestPointOnRay = intersection
        debugClosestPointOnCollider = clampedPoint
      }

      targetT = tWorld * invSegLen
      radialDistance = intersection.distance(clampedPoint)

      coneRadiusAtT = baseRadius * targetT
      hotspotRadius = PLANE_FADE_HOTSPOT_RADIUS
    }

    const radialWeight = 1.0
    const score = radialWeight / (radialDistance + SCORE_DIVISOR_EPSILON)

    if (score <= 0) return null

    const result: Omit<CachedInteractableData, "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"> = {
      score: score,
      targetT,
      radialDistance,
      positionalDistance: radialDistance,
      coneRadiusAtT,
      hotspotRadius,
      targetingVisual: plane.targetingVisual
    }
    if (this.debugDrawEnabled) {
      result.debugState = debugState
      result.debugClosestPointOnRay = debugClosestPointOnRay
      result.debugClosestPointOnCollider = debugClosestPointOnCollider
    }
    return result
  }

  private getPlaneWorldOriginAndAxes(plane: InteractionPlane): CachedPlaneTransform {
    let cached = this.planeTransformCache.get(plane)
    if (cached) {
      return cached
    }

    const planeXform = plane.getSceneObject().getTransform()
    const normal = planeXform.forward
    const right = planeXform.right
    const up = planeXform.up
    const scale = planeXform.getWorldScale()
    const baseOrigin = planeXform.getWorldPosition()
    const offset = plane.offset
    const worldOffset = right
      .uniformScale(offset.x * scale.x)
      .add(up.uniformScale(offset.y * scale.y))
      .add(normal.uniformScale(offset.z * scale.z))
    const origin = baseOrigin.add(worldOffset)
    const halfWidth = Math.max(0, plane.planeSize.x * 0.5 * scale.x)
    const halfHeight = Math.max(0, plane.planeSize.y * 0.5 * scale.y)

    cached = {origin, normal, right, up, halfWidth, halfHeight}
    this.planeTransformCache.set(plane, cached)
    return cached
  }

  private getTargetingDataForInteractable(
    interactable: Interactable,
    segmentStart: vec3,
    segDirNorm: vec3,
    segLen: number
  ): Omit<CachedInteractableData, "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"> {
    const baseRadius = CONE_RADIUS
    const invSegLen = 1.0 / segLen

    if (segLen <= MIN_LENGTH_THRESHOLD) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      const fallbackData: Omit<
        CachedInteractableData,
        "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"
      > = {
        score: 1.0 / (fallbackDistance + SCORE_DIVISOR_EPSILON),
        targetT: 0.1, // Small but non-zero
        radialDistance: fallbackDistance,
        positionalDistance: fallbackDistance,
        coneRadiusAtT: baseRadius * 0.1,
        hotspotRadius: INTERACTABLE_FADE_HOTSPOT_RADIUS,
        targetingVisual: this.getEffectiveTargetingVisual(interactable)
      }
      return fallbackData
    }

    let targetT = 0,
      alphaDistance = Infinity,
      coneRadiusAtT = 0,
      hotspotRadius = 0
    let debugState: DebugCalculationState | undefined,
      debugClosestPointOnRay: vec3 | undefined,
      debugClosestPointOnCollider: vec3 | undefined

    const primaryCollider = interactable.colliders[0]
    if (!primaryCollider) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      const fallbackData: Omit<
        CachedInteractableData,
        "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"
      > = {
        score: 1.0 / (fallbackDistance + SCORE_DIVISOR_EPSILON),
        targetT: Math.min(1.0, fallbackDistance / segLen),
        radialDistance: fallbackDistance,
        positionalDistance: fallbackDistance,
        coneRadiusAtT: baseRadius * Math.min(1.0, fallbackDistance / segLen),
        hotspotRadius: INTERACTABLE_FADE_HOTSPOT_RADIUS,
        targetingVisual: this.getEffectiveTargetingVisual(interactable)
      }
      return fallbackData
    }

    const worldSphere = ColliderUtils.getColliderWorldBoundingSphere(primaryCollider)

    if (!worldSphere) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      const fallbackData: Omit<
        CachedInteractableData,
        "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"
      > = {
        score: 1.0 / (fallbackDistance + SCORE_DIVISOR_EPSILON),
        targetT: Math.min(1.0, fallbackDistance / segLen),
        radialDistance: fallbackDistance,
        positionalDistance: fallbackDistance,
        coneRadiusAtT: baseRadius * Math.min(1.0, fallbackDistance / segLen),
        hotspotRadius: INTERACTABLE_FADE_HOTSPOT_RADIUS,
        targetingVisual: this.getEffectiveTargetingVisual(interactable)
      }
      return fallbackData
    }

    const planePoint = worldSphere.center
    const cameraPos = this.camera.getWorldPosition()
    let planeNormal = cameraPos.sub(planePoint)
    if (planeNormal.lengthSquared <= GEOMETRY_EPSILON) {
      planeNormal = this.camera.forward()
    } else {
      planeNormal.length = 1
    }
    const toCenter = planePoint.sub(segmentStart)
    const denominator = planeNormal.dot(segDirNorm)

    let clampedTWorld: number
    if (Math.abs(denominator) > GEOMETRY_EPSILON) {
      const numerator = planeNormal.dot(toCenter)
      const tWorld = numerator / denominator
      clampedTWorld = tWorld < 0 ? 0 : tWorld > segLen ? segLen : tWorld // clamp(tWorld, 0, segLen)
    } else {
      const tAlongRay = toCenter.dot(segDirNorm)
      clampedTWorld = Math.max(0, Math.min(segLen, tAlongRay))
    }

    const closestPointOnRayVec = segmentStart.add(segDirNorm.uniformScale(clampedTWorld))
    if (this.debugDrawEnabled) {
      debugClosestPointOnRay = closestPointOnRayVec
    }

    const distanceToCenterSq = closestPointOnRayVec.distanceSquared(worldSphere.center)
    const distanceToCenter = Math.sqrt(distanceToCenterSq)
    alphaDistance = Math.max(0, distanceToCenter - worldSphere.radius)

    let positionalDistance: number
    targetT = clampedTWorld * invSegLen
    coneRadiusAtT = baseRadius * targetT
    hotspotRadius = INTERACTABLE_FADE_HOTSPOT_RADIUS

    if (worldSphere.radius <= SMALL_SPHERE_RADIUS_THRESHOLD) {
      positionalDistance = distanceToCenter
      if (this.debugDrawEnabled) {
        debugState = DebugCalculationState.Cheap
        debugClosestPointOnCollider = worldSphere.center
      }
    } else {
      const fastDistance = distanceToCenter - worldSphere.radius
      const hotZoneStart = worldSphere.radius * PROXIMITY_HOT_ZONE_FACTOR

      if (fastDistance > hotZoneStart) {
        positionalDistance = fastDistance
        if (this.debugDrawEnabled) {
          debugState = DebugCalculationState.Cheap
          if (distanceToCenter > GEOMETRY_EPSILON) {
            const directionToRay = worldSphere.center.sub(closestPointOnRayVec)
            directionToRay.length = 1
            const cheapClosestPoint = worldSphere.center.sub(directionToRay.uniformScale(worldSphere.radius))
            debugClosestPointOnCollider = cheapClosestPoint
          } else {
            debugClosestPointOnCollider = worldSphere.center
          }
        }
      } else {
        const preciseClosestPoint = ColliderUtils.getClosestPointOnColliderToPoint(
          primaryCollider,
          closestPointOnRayVec
        )

        const projection = preciseClosestPoint.sub(segmentStart).dot(segDirNorm)
        const s = projection < 0 ? 0 : projection > segLen ? segLen : projection // clamp(projection, 0, segLen)
        const pointOnRay = segmentStart.add(segDirNorm.uniformScale(s))
        const preciseDistance = preciseClosestPoint.distance(pointOnRay)

        const nearZoneEnd = worldSphere.radius * PROXIMITY_NEAR_ZONE_FACTOR

        if (fastDistance <= nearZoneEnd) {
          positionalDistance = preciseDistance
          targetT = s * invSegLen
          coneRadiusAtT = baseRadius * targetT
          if (this.debugDrawEnabled) {
            debugState = DebugCalculationState.Expensive
            debugClosestPointOnCollider = preciseClosestPoint
            debugClosestPointOnRay = pointOnRay
          }
        } else {
          const denom = hotZoneStart - nearZoneEnd
          const rawBlend = denom > GEOMETRY_EPSILON ? (hotZoneStart - fastDistance) / denom : 1.0
          const blendAmount = rawBlend < 0 ? 0 : rawBlend > 1 ? 1 : rawBlend // clamp(rawBlend, 0, 1)
          positionalDistance = MathUtils.lerp(fastDistance, preciseDistance, blendAmount)

          const blendedTWorld = MathUtils.lerp(clampedTWorld, s, blendAmount)
          targetT = blendedTWorld * invSegLen
          coneRadiusAtT = baseRadius * targetT

          if (this.debugDrawEnabled) {
            debugState = DebugCalculationState.Blended
            const directionToRay = worldSphere.center.sub(closestPointOnRayVec)
            directionToRay.length = 1
            const cheapClosestPoint = worldSphere.center.sub(directionToRay.uniformScale(worldSphere.radius))
            debugClosestPointOnCollider = vec3.lerp(cheapClosestPoint, preciseClosestPoint, blendAmount)
            debugClosestPointOnRay = vec3.lerp(closestPointOnRayVec, pointOnRay, blendAmount)
          }
        }
      }
    }

    const baseScore = 1.0 / (positionalDistance + SCORE_DIVISOR_EPSILON)

    let t = coneRadiusAtT > 1e-4 ? positionalDistance / coneRadiusAtT : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t // clamp(t, 0, 1)
    let linearBonus = 1 - t
    linearBonus = linearBonus < 0 ? 0 : linearBonus // clamp(linearBonus, 0, 1)
    const radialBonus = smoothstep(0.0, 1.0, linearBonus)

    const score = baseScore * (1.0 + radialBonus)

    const result: Omit<CachedInteractableData, "lastUpdated" | "dominanceFactor" | "isEligible" | "lastSeenFrame"> = {
      score: score,
      targetT,
      radialDistance: alphaDistance,
      positionalDistance: positionalDistance,
      coneRadiusAtT,
      hotspotRadius,
      targetingVisual: this.getEffectiveTargetingVisual(interactable)
    }
    if (this.debugDrawEnabled) {
      result.debugState = debugState
      result.debugClosestPointOnRay = debugClosestPointOnRay
      result.debugClosestPointOnCollider = debugClosestPointOnCollider
    }

    return result
  }

  private blendCachedInteractables(
    segmentStart: vec3,
    segDir: vec3
  ): {targetT: number; cursorAlpha: number; rayAlpha: number} | null {
    const segLen = segDir.length
    if (segLen <= MIN_LENGTH_THRESHOLD) {
      return null
    }

    if (this.overlappingInteractables.size + this.overlappingPlanes.size === 0) {
      return null
    }

    let maxDominanceFactor = 0.0

    const calculateDominance = (data: CachedInteractableData) => {
      if (data.score <= 0) {
        data.dominanceFactor = 0
        return
      }
      const scale = data.coneRadiusAtT * INV_CONE_RADIUS
      const scaledDominanceRadius = DOMINANCE_RADIUS * scale
      const scaledFadeWidth = DOMINANCE_FADE_WIDTH * scale
      data.dominanceFactor = smoothstep(
        scaledDominanceRadius + scaledFadeWidth,
        scaledDominanceRadius,
        data.positionalDistance
      )
      maxDominanceFactor = Math.max(maxDominanceFactor, data.dominanceFactor)
    }

    for (const [plane, data] of this.overlappingPlanes.entries()) {
      if (!this.isPlaneEligible(plane)) {
        continue
      }
      calculateDominance(data)
    }
    for (const data of this.overlappingInteractables.values()) {
      if (!data.isEligible) {
        data.score = 0
        continue
      }
      calculateDominance(data)
    }

    let totalPositioningScore = 0.0,
      blendedT = 0.0,
      overallAlphaMax = 0.0,
      alphaWeightedCursorScore = 0.0,
      alphaWeightedRayScore = 0.0

    const processBlendData = (data: CachedInteractableData) => {
      if (data.score <= 0 || data.targetingVisual === TargetingVisual.None) {
        return
      }

      const dominanceInfluence = 1.0 - maxDominanceFactor
      const finalScore = data.score * (data.dominanceFactor > 0 ? 1.0 : dominanceInfluence)
      if (finalScore <= 0) return

      totalPositioningScore += finalScore
      blendedT += data.targetT * finalScore

      const scale = data.coneRadiusAtT * INV_CONE_RADIUS
      const fadeStart = data.hotspotRadius * scale
      const fadeDistance = ALPHA_FADE_DISTANCE * scale
      let individualAlpha = 0.0

      if (fadeDistance > GEOMETRY_EPSILON) {
        const a = 1.0 - (data.radialDistance - fadeStart) / fadeDistance
        individualAlpha = a < 0 ? 0 : a > 1 ? 1 : a // clamp(a, 0, 1)
      } else if (data.radialDistance <= fadeStart) {
        individualAlpha = 1.0
      }

      overallAlphaMax = Math.max(overallAlphaMax, individualAlpha)

      const alphaWeightedScore = finalScore * individualAlpha
      if (data.targetingVisual === TargetingVisual.Cursor) {
        alphaWeightedCursorScore += alphaWeightedScore
      } else if (data.targetingVisual === TargetingVisual.Ray) {
        alphaWeightedRayScore += alphaWeightedScore
      }
    }

    for (const [plane, data] of this.overlappingPlanes.entries()) {
      if (!this.isPlaneEligible(plane)) {
        continue
      }
      data.targetingVisual = plane.targetingVisual
      processBlendData(data)
    }
    for (const [interactable, data] of this.overlappingInteractables.entries()) {
      if (!data.isEligible) {
        continue
      }
      data.targetingVisual = this.getEffectiveTargetingVisual(interactable)
      processBlendData(data)
    }

    if (totalPositioningScore <= GEOMETRY_EPSILON) {
      return null
    }

    const finalT = blendedT / totalPositioningScore
    const overallAlpha = overallAlphaMax

    const totalAlphaWeightedScore = alphaWeightedCursorScore + alphaWeightedRayScore
    const rayInfluence =
      totalAlphaWeightedScore > GEOMETRY_EPSILON ? alphaWeightedRayScore / totalAlphaWeightedScore : 0.0

    const finalRayAlpha = overallAlpha * rayInfluence
    const finalCursorAlpha = overallAlpha * (1.0 - rayInfluence)

    return {targetT: finalT, cursorAlpha: finalCursorAlpha, rayAlpha: finalRayAlpha}
  }

  private calculateCursorScale(cursorPosition: vec3): number {
    const cameraPos = this.camera.getWorldPosition()
    const distanceSq = cursorPosition.distanceSquared(cameraPos)

    if (this.lastScaleDistanceSq !== null && Math.abs(distanceSq - this.lastScaleDistanceSq) < SCALE_DISTANCE_EPSILON) {
      return this.cachedScale
    }

    this.lastScaleDistanceSq = distanceSq

    if (distanceSq <= this.minDistanceSquared) {
      this.cachedScale = MIN_SCALE
      return MIN_SCALE
    }
    if (distanceSq >= this.maxDistanceSquared) {
      this.cachedScale = MAX_SCALE
      return MAX_SCALE
    }

    const distance = Math.sqrt(distanceSq)
    const idealScale = distance * SCALING_FACTOR
    const tunedScale = REFERENCE_SCALE + (idealScale - REFERENCE_SCALE) * SCALE_COMPENSATION_STRENGTH
    this.cachedScale = tunedScale
    return tunedScale
  }

  private getInteractionRay(): {segmentStart: vec3; segmentEnd: vec3} {
    const segmentStart = this.interactor.startPoint!
    const length = this.interactor.maxRaycastDistance ?? this.segmentLength
    const segmentEnd = segmentStart.add(this.interactor.direction!.uniformScale(length))
    return {segmentStart, segmentEnd}
  }

  private getEffectiveTargetingVisual(interactable: Interactable): number {
    const plane = findComponentInSelfOrParents(interactable.sceneObject, InteractionPlane.getTypeName())
    if (!interactable.ignoreInteractionPlane && this.isPlaneEnabled(plane)) {
      return plane.targetingVisual
    }
    return interactable.targetingVisual
  }

  private updateWithOverride(isTriggering: boolean, isTracked: boolean): void {
    this._cursorPosition = this.positionOverride!
    const scale = this.calculateCursorScale(this._cursorPosition)

    this.onCursorUpdateEvent.invoke({
      cursorEnabled: isTracked,
      position: this.positionOverride!,
      scale: scale,
      cursorAlpha: isTracked ? 1.0 * this.fadeMultiplier : 0,
      rayAlpha: 0.0,
      isTriggering: isTriggering
    })
    this.lastHiddenTriggering = null
  }

  private hideCursor(isTriggering: boolean): void {
    if (this.lastHiddenTriggering !== isTriggering) {
      this.context.snapDepthNextFrame = true
      this.cursorDepthSpring.reset()
      this.cursorDepthSpringSlow.reset()

      this.onCursorUpdateEvent.invoke({
        cursorEnabled: false,
        position: this._cursorPosition,
        scale: MIN_SCALE,
        cursorAlpha: 0.0,
        rayAlpha: 0.0,
        isTriggering: isTriggering
      })
      this.lastHiddenTriggering = isTriggering
    }
  }

  private isPlaneInCone(
    plane: InteractionPlane,
    rayOrigin: vec3,
    rayDir: vec3,
    rayLength: number,
    tanConeAngle: number
  ): boolean {
    const {origin: planeCenter, halfWidth, halfHeight} = this.getPlaneWorldOriginAndAxes(plane)
    const planeRadiusSq = halfWidth * halfWidth + halfHeight * halfHeight

    const vecToCenter = planeCenter.sub(rayOrigin)
    const toCenterDistSq = vecToCenter.lengthSquared

    const maxDim = Math.max(halfWidth, halfHeight)
    const planeRadiusUpperBound = maxDim * Math.SQRT2

    const maxDistance = rayLength + planeRadiusUpperBound
    if (toCenterDistSq > maxDistance * maxDistance) {
      return false
    }

    const distanceAlongAxis = vecToCenter.dot(rayDir)
    if (distanceAlongAxis > rayLength + planeRadiusUpperBound) return false

    const coneRadiusAtPoint = distanceAlongAxis * tanConeAngle
    const distanceToAxisSq = toCenterDistSq - distanceAlongAxis * distanceAlongAxis

    if (distanceToAxisSq < coneRadiusAtPoint * coneRadiusAtPoint) {
      return true
    }

    const planeRadius = Math.sqrt(planeRadiusSq)
    const minSeparationSq = coneRadiusAtPoint * coneRadiusAtPoint + 2 * coneRadiusAtPoint * planeRadius + planeRadiusSq
    return distanceToAxisSq < minSeparationSq
  }

  private isPlaneEnabled(plane: InteractionPlane | null): plane is InteractionPlane {
    return !!(plane && plane.enabled && plane.sceneObject.isEnabledInHierarchy)
  }

  private isPlaneEligible(plane: InteractionPlane | null): plane is InteractionPlane {
    return this.isPlaneEnabled(plane) && plane.targetingVisual !== TargetingVisual.None
  }

  private isInteractableEligible(interactable: Interactable | null): interactable is Interactable {
    if (
      isNull(interactable) ||
      !interactable ||
      !interactable.enabled ||
      interactable.targetingVisual === TargetingVisual.None ||
      (interactable.targetingMode & TargetingMode.Indirect) === 0 ||
      !interactable.sceneObject.isEnabledInHierarchy
    ) {
      return false
    }

    const parentPlane = findComponentInSelfOrParents(interactable.sceneObject, InteractionPlane.getTypeName())
    if (parentPlane) {
      if (!interactable.ignoreInteractionPlane && this.isPlaneEnabled(parentPlane)) {
        return false
      }
    }

    return true
  }

  private updateEligibilityCache(): void {
    if (this.eligibilityProcessingList.length === 0 && this.overlappingInteractables.size > 0) {
      this.eligibilityProcessingList.length = 0
      for (const interactable of this.overlappingInteractables.keys()) {
        this.eligibilityProcessingList.push(interactable)
      }
      this.eligibilityProcessingIndex = 0
    }

    const eligibleCount = this.eligibilityProcessingList.length
    if (eligibleCount === 0) {
      this.eligibilityProcessingIndex = 0
      return
    }

    if (this.eligibilityProcessingIndex >= eligibleCount) {
      this.eligibilityProcessingIndex = 0
    }

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(eligibleCount)))

    for (let i = 0; i < chunkSize; i++) {
      if (this.eligibilityProcessingIndex >= this.eligibilityProcessingList.length) {
        break
      }

      const interactable = this.eligibilityProcessingList[this.eligibilityProcessingIndex]
      const data = this.overlappingInteractables.get(interactable)

      if (data) {
        data.isEligible = this.isInteractableEligible(interactable)
        this.eligibilityProcessingIndex++
      } else {
        const lastIndex = this.eligibilityProcessingList.length - 1
        this.eligibilityProcessingList[this.eligibilityProcessingIndex] = this.eligibilityProcessingList[lastIndex]
        this.eligibilityProcessingList.pop()
      }
    }
  }

  private updateConeOverlap(rayStart: vec3, rayDir: vec3, rayLength: number): void {
    if (this.coneInteractablesIndex === 0) {
      const interactablesSet = this.interactionManager.interactables

      const setSize = interactablesSet.size
      if (this.coneInteractables.length !== setSize) {
        this.coneInteractables.length = setSize
      }

      let idx = 0
      for (const interactable of interactablesSet) {
        this.coneInteractables[idx++] = interactable
      }
    }

    const totalCount = this.coneInteractables.length
    const frameCount = this.updateDispatcher.frameCount
    const coneScale = CONE_RADIUS / rayLength

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(totalCount) * 0.5))
    let processedCount = 0

    while (processedCount < chunkSize && this.coneInteractablesIndex < totalCount) {
      const interactable = this.coneInteractables[this.coneInteractablesIndex]
      this.coneInteractablesIndex++
      processedCount++

      if (isNull(interactable) || !interactable.enabled) {
        this.overlappingInteractables.delete(interactable)
        continue
      }

      const collider = interactable.colliders && interactable.colliders.length > 0 ? interactable.colliders[0] : null
      if (isNull(collider)) {
        this.overlappingInteractables.delete(interactable)
        continue
      }

      const sphere = ColliderUtils.getColliderWorldBoundingSphere(collider!)
      if (!sphere) {
        this.overlappingInteractables.delete(interactable)
        continue
      }

      const center = sphere.center
      const radius = sphere.radius

      const distSq = rayStart.distanceSquared(center)

      const actualBroadPhaseThres = rayLength + radius
      const actualBroadPhaseThresSq = actualBroadPhaseThres * actualBroadPhaseThres

      if (distSq > actualBroadPhaseThresSq) {
        this.overlappingInteractables.delete(interactable)
        continue
      }

      const toCenter = center.sub(rayStart)
      const distOnAxis = toCenter.dot(rayDir)

      if (distOnAxis < -radius || distOnAxis > rayLength + radius) {
        this.overlappingInteractables.delete(interactable)
        continue
      }

      const coneRadiusAtDepth = distOnAxis * coneScale
      const perpDistSq = distSq - distOnAxis * distOnAxis
      const maxDist = coneRadiusAtDepth + radius

      if (perpDistSq < maxDist * maxDist) {
        if (!interactable.sceneObject.isEnabledInHierarchy) {
          this.overlappingInteractables.delete(interactable)
          continue
        }

        const existing = this.overlappingInteractables.get(interactable)
        if (existing) {
          existing.lastSeenFrame = frameCount
        } else {
          this.overlappingInteractables.set(interactable, {
            score: 0,
            targetT: 0,
            radialDistance: Infinity,
            positionalDistance: Infinity,
            coneRadiusAtT: 0,
            hotspotRadius: 0,
            targetingVisual: TargetingVisual.Cursor,
            dominanceFactor: 0,
            lastUpdated: 0,
            lastSeenFrame: frameCount,
            isEligible: false
          })
          this.eligibilityProcessingList.push(interactable)
        }
      } else {
        this.overlappingInteractables.delete(interactable)
      }
    }

    if (this.coneInteractablesIndex >= totalCount) {
      this.coneInteractablesIndex = 0
    }
  }
}
