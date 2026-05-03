import {InteractionManager} from "../../../Core/InteractionManager/InteractionManager"
import {LensConfig} from "../../../Utils/LensConfig"
import NativeLogger from "../../../Utils/NativeLogger"
import {DispatchedUpdateEvent} from "../../../Utils/UpdateDispatcher"
import {TargetingVisual} from "../Interactable/Interactable"

// ============================================================================
// ZONE PROJECTION TYPE
// ============================================================================

/**
 * Result of projecting a 3D point onto an InteractionPlane.
 *
 * @property point - The projection's position on the plane in world space
 * @property distance - Signed distance from point to plane (negative = behind)
 * @property isInNearFieldZone - True if point is within the near-field interaction volume
 * @property isInPhysicalZone - True if point is close enough for physical interactions (poke/direct pinch)
 * @property isInBehindZone - True if point is behind the plane (push-through tolerance)
 * @property withinXYBounds - True if the projected point is within the plane's XY bounds (independent of depth)
 */
export type ZoneProjection = {
  point: vec3
  distance: number
  isInNearFieldZone: boolean
  isInPhysicalZone: boolean
  isInBehindZone: boolean
  withinXYBounds: boolean

  // Local coordinates for external bounds checking (avoids re-computing transforms)
  localX: number
  localY: number
  halfWidth: number
  halfHeight: number

  // Deprecated aliases for backward compatibility
  /** @deprecated Use isInNearFieldZone instead */
  isWithinInteractionZone: boolean
  /** @deprecated Use isInPhysicalZone instead */
  isWithinDirectZone: boolean
  /** @deprecated Use isInBehindZone instead */
  isWithinBehindZone: boolean
  /** @deprecated No longer used (always 1) */
  lerpValue: number
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TAG = "InteractionPlane"

/** Default depth (cm) for the near-field interaction zone */
const DEFAULT_NEAR_FIELD_DEPTH_CM = 17

/** Default depth (cm) for the physical interaction zone (poke/direct pinch) */
const DEFAULT_PHYSICAL_ZONE_DEPTH_CM = 3

/** Default depth (cm) for behind-plane tolerance zone */
const DEFAULT_BEHIND_ZONE_DEPTH_CM = 15

/**
 * Hysteresis margin (cm) for far↔near transitions.
 * Exit threshold = nearFieldDepth + this value = 17 + 6 = 23cm
 */
const NEAR_FIELD_HYSTERESIS_CM = 6

/**
 * Hysteresis margin (cm) for near↔physical transitions.
 * Exit threshold = physicalZoneDepth + this value = 3 + 1 = 4cm
 */
const PHYSICAL_ZONE_HYSTERESIS_CM = 1

/**
 * Margin (cm) for XY bounds hysteresis.
 * Used for both ray intersection entry check and XY exit check.
 * Allows slightly off-plane positions to still count as "within bounds".
 */
export const XY_HYSTERESIS_MARGIN_CM = 3

// ============================================================================
// INTERACTION PLANE COMPONENT
// ============================================================================

/**
 * An InteractionPlane defines a zone which triggers near-field targeting logic for HandInteractors.
 *
 * Add an InteractionPlane to any 2D UI with high button density, such as ContainerFrame menus.
 * Only one InteractionPlane should be added per UI (ContainerFrame adds one by default).
 *
 * ## Interaction Zones (from far to close):
 * - **Far Field**: Beyond `nearFieldDepth` - uses standard ray targeting
 * - **Near Field**: Within `nearFieldDepth` (17cm default) - uses stabilized pinch locus
 * - **Physical Zone**: Within `physicalZoneDepth` (3cm default) - enables poke and direct pinch
 * - **Behind Zone**: Behind the plane - tolerance for push-through
 *
 * ## Hysteresis:
 * Entry and exit thresholds differ to prevent flickering at zone boundaries.
 */
@component
export class InteractionPlane extends BaseScriptComponent {
  // ==========================================================================
  // CONFIGURABLE PROPERTIES (@input)
  // ==========================================================================

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Plane Configuration</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Define the size and position of the interaction detection area</span>'
  )

  /**
   * The size of the interaction plane along the local X and Y axes.
   * Defines the rectangular area where hand interactions are detected.
   */
  @input
  @label("Plane Size")
  @hint("Size (X, Y) of the interaction plane. Defines the rectangular area where hand interactions are detected.")
  private _planeSize: vec2 = new vec2(10, 10)

  /**
   * Local-space offset of the plane. Allows positioning the effective interaction plane
   * relative to the host SceneObject.
   */
  @input
  @label("Offset")
  @hint("Local-space offset of the plane relative to the host SceneObject.")
  private _offset: vec3 = vec3.zero()

  /**
   * The depth (cm) of the near-field interaction zone along the local Z axis.
   * Hand interactions beyond this distance use far-field targeting.
   * @internal Not exposed in Inspector - use default value of 17cm
   */
  private _nearFieldDepth: number = DEFAULT_NEAR_FIELD_DEPTH_CM

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Visual Feedback</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Configure cursor and targeting visual preferences</span>')

  /**
   * Sets the preferred targeting visual. (Requires the V2 Cursor to be enabled on InteractorCursors).
   */
  @input
  @label("Targeting Visual")
  @hint("Preferred targeting visual style. Requires V2 Cursor on InteractorCursors.")
  @widget(new ComboBoxWidget([new ComboBoxItem("None", 0), new ComboBoxItem("Cursor", 1), new ComboBoxItem("Ray", 2)]))
  targetingVisual: number = TargetingVisual.Cursor

  /**
   * Enables visual debugging of the Interaction Plane.
   * @internal
   */
  private _drawDebug: boolean = false

  // ==========================================================================
  // INTERNAL PROPERTIES (not @input - use constants or computed values)
  // ==========================================================================

  /** Depth (cm) of the physical interaction zone (poke/direct pinch) */
  private _physicalZoneDepth: number = DEFAULT_PHYSICAL_ZONE_DEPTH_CM

  /** Depth (cm) of the behind-plane tolerance zone */
  private _behindZoneDepth: number = DEFAULT_BEHIND_ZONE_DEPTH_CM

  // ==========================================================================
  // PRIVATE STATE
  // ==========================================================================

  private _collider: ColliderComponent | null = null
  private _colliderRoot: SceneObject | null = null
  private _colliderRootTransform: Transform | null = null
  private log = new NativeLogger(TAG)
  private _updateEvent: DispatchedUpdateEvent | undefined

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  onAwake() {
    this.createEvent("OnDestroyEvent").bind(() => this.release())
    this.createEvent("OnEnableEvent").bind(() => {
      InteractionManager.getInstance().registerInteractionPlane(this)
      if (this._updateEvent) {
        this._updateEvent.enabled = true
      }
    })
    this.createEvent("OnDisableEvent").bind(() => {
      InteractionManager.getInstance().deregisterInteractionPlane(this)
      if (this._updateEvent) {
        this._updateEvent.enabled = false
      }
    })

    this.createEvent("OnStartEvent").bind(() => {
      const colliderRoot = global.scene.createSceneObject("InteractionPlaneColliderRoot")
      colliderRoot.setParent(this.sceneObject)
      this._colliderRoot = colliderRoot
      this._colliderRootTransform = colliderRoot.getTransform()

      this._collider = colliderRoot.createComponent("ColliderComponent")
      this.buildMeshShape()
      this._collider.debugDrawEnabled = this.drawDebug

      InteractionManager.getInstance().registerInteractionPlane(this)
    })

    if (this.drawDebug) {
      this._updateEvent = LensConfig.getInstance().updateDispatcher.createUpdateEvent("InteractionPlaneUpdate", () =>
        this.drawDebugPlane()
      )
    }
  }

  release() {
    if (this._updateEvent) {
      LensConfig.getInstance().updateDispatcher.removeEvent(this._updateEvent)
      this._updateEvent = undefined
    }
    InteractionManager.getInstance().deregisterInteractionPlane(this)
  }

  // ==========================================================================
  // COLLIDER SETUP
  // ==========================================================================

  private buildMeshShape() {
    if (this.collider === null) {
      return
    }

    if (this._nearFieldDepth <= 0 || this._behindZoneDepth <= 0 || this.planeSize.x <= 0 || this.planeSize.y <= 0) {
      this.log.f(`InteractionPlane must have nearFieldDepth, behindZoneDepth, or planeSize set to positive values.`)
    }

    // Use nearFieldExitDepth for collider to encompass the full hysteresis zone
    const colliderDepth = this.nearFieldExitDepth

    const shape = Shape.createBoxShape()
    shape.size = new vec3(this.planeSize.x, this.planeSize.y, colliderDepth * 2)

    this.collider.shape = shape

    if (this._colliderRootTransform !== null) {
      this._colliderRootTransform.setLocalPosition(this._offset)
    }
  }

  // ==========================================================================
  // PUBLIC API - PRIMARY PROPERTIES
  // ==========================================================================

  /** Sets the size (in world units) of the plane along the local X and Y axes. */
  set planeSize(size: vec2) {
    this._planeSize = size
    this.buildMeshShape()
  }

  /** Returns the size (in world units) of the plane along the local X and Y axes. */
  get planeSize(): vec2 {
    return this._planeSize
  }

  /** Sets the depth (cm) of the near-field zone. */
  set nearFieldDepth(depth: number) {
    this._nearFieldDepth = depth
    this.buildMeshShape()
  }

  /** Returns the depth (cm) of the near-field zone. */
  get nearFieldDepth(): number {
    return this._nearFieldDepth
  }

  /** Returns the depth (cm) at which near-field mode is exited (includes hysteresis). */
  get nearFieldExitDepth(): number {
    return this._nearFieldDepth + NEAR_FIELD_HYSTERESIS_CM
  }

  /** Sets the depth (cm) of the physical interaction zone (poke/direct pinch). */
  set physicalZoneDepth(depth: number) {
    this._physicalZoneDepth = depth
  }

  /** Returns the depth (cm) of the physical interaction zone. */
  get physicalZoneDepth(): number {
    return this._physicalZoneDepth
  }

  /** Returns the depth (cm) at which physical mode is exited (includes hysteresis). */
  get physicalZoneExitDepth(): number {
    return this._physicalZoneDepth + PHYSICAL_ZONE_HYSTERESIS_CM
  }

  /** Sets the depth (cm) of the behind-plane tolerance zone. */
  set behindZoneDepth(depth: number) {
    this._behindZoneDepth = depth
    this.buildMeshShape()
  }

  /** Returns the depth (cm) of the behind-plane tolerance zone. */
  get behindZoneDepth(): number {
    return this._behindZoneDepth
  }

  /** Sets if the interaction zone should be drawn via debug gizmos. */
  set drawDebug(enabled: boolean) {
    this._drawDebug = enabled
    if (this.collider !== null) {
      this.collider.debugDrawEnabled = enabled
    }
  }

  /** Returns if the interaction zone should be drawn via debug gizmos. */
  get drawDebug(): boolean {
    return this._drawDebug
  }

  /** Sets the local-space offset of the interaction plane. */
  set offset(offset: vec3) {
    this._offset = offset
    this.buildMeshShape()
  }

  /** Returns the local-space offset of the interaction plane. */
  get offset(): vec3 {
    return this._offset
  }

  /** Returns the normal vector of the plane (local Z forward). */
  get normal(): vec3 {
    return this.getTransform().forward
  }

  /** Returns the up vector of the plane (local Y up). */
  get up(): vec3 {
    return this.getTransform().up
  }

  /** Returns the plane origin in world space (accounting for offset). */
  get planeOrigin(): vec3 {
    const transform = this.getTransform()
    const s = transform.getWorldScale()
    const r = transform.right
    const u = transform.up
    const n = transform.forward
    const baseOrigin = transform.getWorldPosition()
    const worldOffset = r
      .uniformScale(this._offset.x * s.x)
      .add(u.uniformScale(this._offset.y * s.y))
      .add(n.uniformScale(this._offset.z * s.z))
    return baseOrigin.add(worldOffset)
  }

  /** Returns the collider of the InteractionPlane after initialization. */
  get collider(): ColliderComponent | null {
    return this._collider
  }

  // ==========================================================================
  // DEPRECATED ALIASES (for backward compatibility)
  // ==========================================================================

  /** @deprecated Use nearFieldDepth instead */
  set proximityDistance(distance: number) {
    this.nearFieldDepth = distance
  }
  /** @deprecated Use nearFieldDepth instead */
  get proximityDistance(): number {
    return this.nearFieldDepth
  }

  /** @deprecated Use physicalZoneDepth instead */
  set directZoneDistance(distance: number) {
    this.physicalZoneDepth = distance
  }
  /** @deprecated Use physicalZoneDepth instead */
  get directZoneDistance(): number {
    return this.physicalZoneDepth
  }

  /** @deprecated Use physicalZoneExitDepth instead */
  get directZoneExitDistance(): number {
    return this.physicalZoneExitDepth
  }
  /** @deprecated Exit depth is now computed from physicalZoneDepth + hysteresis */
  set directZoneExitDistance(_distance: number) {
    // No-op: exit depth is now computed automatically
  }

  /** @deprecated Use behindZoneDepth instead */
  set behindDistance(distance: number) {
    this.behindZoneDepth = distance
  }
  /** @deprecated Use behindZoneDepth instead */
  get behindDistance(): number {
    return this.behindZoneDepth
  }

  /** @deprecated Use nearFieldDepth instead (entry threshold equals nearFieldDepth) */
  get nearFieldEntryDistance(): number {
    return this._nearFieldDepth
  }
  /** @deprecated Set nearFieldDepth instead */
  set nearFieldEntryDistance(distance: number) {
    this.nearFieldDepth = distance
  }

  /** @deprecated Use nearFieldExitDepth instead */
  get nearFieldExitDistance(): number {
    return this.nearFieldExitDepth
  }
  /** @deprecated Exit depth is now computed from nearFieldDepth + hysteresis */
  set nearFieldExitDistance(_distance: number) {
    // No-op: exit depth is now computed automatically
  }

  /** @deprecated No longer used (always 0) */
  get lerpOffset(): number {
    return 0
  }
  /** @deprecated No longer used */
  set lerpOffset(_distance: number) {
    // No-op: lerp offset is deprecated
  }

  /** @deprecated This property is no longer used. */
  enableDirectZone = true

  // ==========================================================================
  // PROJECTION
  // ==========================================================================

  /**
   * Project a 3D point in world space onto the InteractionPlane.
   *
   * @param point - A 3D point in world space
   * @returns A ZoneProjection with the projected point and zone membership, or null if projection fails.
   */
  projectPoint(point: vec3): ZoneProjection | null {
    if (!this.enabled || !this.sceneObject.isEnabledInHierarchy) {
      return null
    }

    const transform = this.sceneObject.getTransform()
    const n = transform.forward
    const r = transform.right
    const u = transform.up
    const s = transform.getWorldScale()

    // Calculate plane origin with offset
    const baseOrigin = transform.getWorldPosition()
    const worldOffset = r
      .uniformScale(this._offset.x * s.x)
      .add(u.uniformScale(this._offset.y * s.y))
      .add(n.uniformScale(this._offset.z * s.z))
    const planeOrigin = baseOrigin.add(worldOffset)

    // Project point onto plane using ray-plane intersection
    const v = planeOrigin.sub(point)
    const l = n.uniformScale(-1)
    const t = v.dot(n) / l.dot(n)
    const projectedPoint = point.add(l.uniformScale(t))

    // Get local coordinates within the plane (in world units)
    const d = projectedPoint.sub(planeOrigin)
    const x = d.dot(r)
    const y = d.dot(u)

    // Calculate signed distance from plane
    const distance = point.sub(projectedPoint).length * Math.sign(t)

    // Check zone membership (scale planeSize to world units)
    const halfWidthWorld = (this.planeSize.x / 2) * s.x
    const halfHeightWorld = (this.planeSize.y / 2) * s.y
    const withinXY = Math.abs(x) <= halfWidthWorld && Math.abs(y) <= halfHeightWorld

    const isInNearFieldZone = distance >= 0 && distance <= this._nearFieldDepth && withinXY

    const isInPhysicalZone = distance >= 0 && distance <= this._physicalZoneDepth && withinXY

    const isInBehindZone = distance < 0 && distance >= -this._behindZoneDepth && withinXY

    return {
      point: projectedPoint,
      distance: distance,
      isInNearFieldZone: isInNearFieldZone,
      isInPhysicalZone: isInPhysicalZone,
      isInBehindZone: isInBehindZone,
      withinXYBounds: withinXY,
      localX: x,
      localY: y,
      halfWidth: halfWidthWorld,
      halfHeight: halfHeightWorld,

      // Deprecated aliases
      isWithinInteractionZone: isInNearFieldZone,
      isWithinDirectZone: isInPhysicalZone,
      isWithinBehindZone: isInBehindZone,
      lerpValue: 1
    }
  }

  /**
   * Check if a ray intersects the plane within its bounds.
   *
   * @param rayStart - Ray origin in world space
   * @param rayEnd - Ray endpoint in world space
   * @param margin - Optional margin (cm) to extend the bounds check. Default 0.
   * @returns True if the ray intersects the plane within (planeSize + margin) bounds
   */
  checkRayIntersection(rayStart: vec3, rayEnd: vec3, margin: number = 0): boolean {
    const transform = this.sceneObject.getTransform()
    const n = transform.forward
    const r = transform.right
    const u = transform.up
    const s = transform.getWorldScale()

    // Calculate plane origin with offset (must match projectPoint calculation)
    const baseOrigin = transform.getWorldPosition()
    const worldOffset = r
      .uniformScale(this._offset.x * s.x)
      .add(u.uniformScale(this._offset.y * s.y))
      .add(n.uniformScale(this._offset.z * s.z))
    const planeOrigin = baseOrigin.add(worldOffset)

    const direction = rayEnd.sub(rayStart)
    const dot = direction.dot(n)

    if (Math.abs(dot) > 1e-6) {
      const w = rayStart.sub(planeOrigin)
      const t = -n.dot(w) / dot

      const intersectionPoint = rayStart.add(direction.uniformScale(t))

      // Inline bounds check (avoid duplicate transform calculations)
      const d = intersectionPoint.sub(planeOrigin)
      const x = d.dot(r)
      const y = d.dot(u)
      const halfWidth = (this.planeSize.x / 2) * s.x + margin
      const halfHeight = (this.planeSize.y / 2) * s.y + margin
      return Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight
    }

    return false
  }

  // ==========================================================================
  // DEBUG VISUALIZATION
  // ==========================================================================

  private drawDebugPlane() {
    if (!this.sceneObject || !this.drawDebug) return

    const transform = this.sceneObject.getTransform()
    const s = transform.getWorldScale()
    const r = transform.right
    const u = transform.up
    const n = transform.forward

    // Calculate plane origin with offset (must match projectPoint calculation)
    const baseOrigin = transform.getWorldPosition()
    const worldOffset = r
      .uniformScale(this._offset.x * s.x)
      .add(u.uniformScale(this._offset.y * s.y))
      .add(n.uniformScale(this._offset.z * s.z))
    const planeOrigin = baseOrigin.add(worldOffset)

    const halfX = (this.planeSize.x / 2) * s.x
    const halfY = (this.planeSize.y / 2) * s.y

    // Draw the plane rectangle (green)
    // corners[0] = bottom-left, [1] = bottom-right, [2] = top-right, [3] = top-left
    const corners = [
      planeOrigin.add(r.uniformScale(-halfX)).add(u.uniformScale(-halfY)),
      planeOrigin.add(r.uniformScale(halfX)).add(u.uniformScale(-halfY)),
      planeOrigin.add(r.uniformScale(halfX)).add(u.uniformScale(halfY)),
      planeOrigin.add(r.uniformScale(-halfX)).add(u.uniformScale(halfY))
    ]
    for (let i = 0; i < 4; i++) {
      global.debugRenderSystem.drawLine(corners[i], corners[(i + 1) % 4], new vec4(0, 1, 0, 1))
    }

    // Draw the nearFieldDepth box (cyan)
    // Zone extends from plane (0) to _nearFieldDepth IN FRONT (positive normal direction)
    // Note: _nearFieldDepth is in world units (cm), not scaled by object scale
    const boxCorners = []
    for (const dz of [0, this._nearFieldDepth]) {
      for (const dy of [-halfY, halfY]) {
        for (const dx of [-halfX, halfX]) {
          boxCorners.push(planeOrigin.add(r.uniformScale(dx)).add(u.uniformScale(dy)).add(n.uniformScale(dz)))
        }
      }
    }

    const edges = [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
      [4, 5],
      [5, 7],
      [7, 6],
      [6, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7]
    ]
    for (const [i, j] of edges) {
      global.debugRenderSystem.drawLine(boxCorners[i], boxCorners[j], new vec4(0, 0.5, 1, 1))
    }
  }
}
