import {Interactor} from "../../../Core/Interactor/Interactor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {findComponentInSelfOrParents} from "../../../Utils/SceneObjectUtils"
import {InteractableManipulation} from "../InteractableManipulation/InteractableManipulation"
import BillboardRotationCalculator, {ALMOST_ONE} from "./BillboardRotationCalculator"

export type BillboardConfig = {
  script: ScriptComponent
  target: SceneObject
  xAxisEnabled?: boolean
  yAxisEnabled?: boolean
  zAxisEnabled?: boolean
  // We allow the user to set the buffer in degrees for ease of customizability as we expect this to be a field in a Custom Component.
  axisBufferDegrees?: vec3
  /**
   * Easing controls how quickly the billboard rotates to face the camera per axis (x, y, z).
   * Uses exponential decay for smooth, framerate-independent motion.
   *
   * Values range from 0 (no rotation) to 1 (instant/no easing):
   * - 1.0: Instant rotation (no lag)
   * - 0.2-0.3: Smooth, moderate lag (recommended for most use cases)
   * - 0.1-0.2: Slower, more laggy rotation
   * - 0.05-0.1: Very slow, heavy lag
   *
   * Each component (x, y, z) represents how much rotation error is eliminated per 33ms.
   * Smaller values = more lag/smoother motion. Larger values = faster/snappier motion.
   *
   * Example: vec3(0.2, 0.2, 0) means smooth lag on X and Y axes, Z axis instant (disabled easing)
   */
  axisEasing?: vec3
  // Duration is the expected duration of time between updates but can be configured, lower duration leads to faster rotation.
  duration?: number
}

export enum RotationAxis {
  X,
  Y,
  Z
}
const VEC_UP = vec3.up()
const VEC_DOWN = vec3.down()

// After this many consecutive buffer zone hits, skip more aggressively
const BUFFER_STABILITY_THRESHOLD = 3

// Split calculated rotation across two frames for smooth 60 FPS animation
// Calculation frame applies 50%, animation frame applies the remaining 50%
const ROTATION_SPLIT_FACTOR = 0.5

// Threshold for near-vertical detection (dot product with up/down)
// When camera is this close to vertical, disable Y-axis rotation to prevent gimbal lock
const VERTICAL_GIMBAL_LOCK_THRESHOLD = 0.95

// Distance thresholds for proximity deadzone (in world units, cm)
// When camera is closer than this to the target/pivot, disable rotation to prevent instability
// Uses hysteresis to prevent flickering at the boundary
const PROXIMITY_DEADZONE_ENTRY_DISTANCE = 10 // Enter deadzone when closer than 10cm
const PROXIMITY_DEADZONE_EXIT_DISTANCE = 15 // Exit deadzone when farther than 15cm

export default class BillboardController {
  private worldCameraProvider = WorldCameraFinderProvider.getInstance()

  // The angles along each axes will be calculated separately
  private xAxisCalculator: BillboardRotationCalculator
  private yAxisCalculator: BillboardRotationCalculator
  private zAxisCalculator: BillboardRotationCalculator

  // The target will be the SceneObject to rotate.
  private target: SceneObject
  private _targetTransform: Transform

  // The target will rotate according to the camera's position for X/Y-axes rotation, camera's rotation for Z-axis rotation.
  private cameraTransform: Transform = this.worldCameraProvider.getTransform()

  private updateEvent: SceneEvent

  // We wait until the first update to set the rotation due to an inaccuracy of transforms on first frame.
  private firstUpdate = true

  // Frame toggle for throttling updates (update every other frame)
  private shouldUpdateThisFrame = false

  // Accumulated delta time since last billboard update (for framerate-independent behavior when skipping frames)
  private accumulatedDeltaTime = 0

  // Track consecutive buffer zone hits for aggressive frame skipping
  private consecutiveBufferZoneHits = 0

  // Frame counter for aggressive skipping when stable in buffer
  private framesSinceLastCheck = 0

  // Store target rotation calculated every other frame for smooth interpolation
  private targetRotation: quat | null = null

  private manipulationComponent: InteractableManipulation | null = null

  // Track if camera is too close to target/pivot (proximity deadzone)
  // Uses hysteresis to prevent flickering at the boundary
  private isInProximityDeadzone = false

  private pivotPoint: vec3 = vec3.zero()

  public pivotingInteractor: Interactor | null = null

  // Related to animation to look at camera
  private isAnimatingToLookAtCamera = false
  private originalXEnabled: boolean = false
  private originalYEnabled: boolean = true
  private originalXBuffer: number = 0
  private originalYBuffer: number = 0
  private animationCompleteCallBack: (() => void) | null = null

  constructor(config: BillboardConfig) {
    this.target = config.target
    this._targetTransform = this.target.getTransform()

    this.manipulationComponent = this.findInteractableManipulation(this.target)

    // Set up the rotation calculators to rotate along the axes with specific behavior.
    this.xAxisCalculator = new BillboardRotationCalculator({
      axis: RotationAxis.X,
      axisEnabled: config.xAxisEnabled,
      axisBufferRadians: MathUtils.DegToRad * (config.axisBufferDegrees?.x ?? 0),
      axisEasing: config.axisEasing?.x ?? 1
    })
    this.yAxisCalculator = new BillboardRotationCalculator({
      axis: RotationAxis.Y,
      axisEnabled: config.yAxisEnabled,
      axisBufferRadians: MathUtils.DegToRad * (config.axisBufferDegrees?.y ?? 0),
      axisEasing: config.axisEasing?.y ?? 1
    })
    this.zAxisCalculator = new BillboardRotationCalculator({
      axis: RotationAxis.Z,
      axisEnabled: config.zAxisEnabled,
      axisBufferRadians: MathUtils.DegToRad * (config.axisBufferDegrees?.z ?? 0),
      axisEasing: config.axisEasing?.z ?? 1
    })
    this.updateEvent = config.script.createEvent("UpdateEvent")
    this.updateEvent.bind(this.onUpdate.bind(this))
  }

  public enableAxisRotation(axis: RotationAxis, enabled: boolean): void {
    let axisCalculator: BillboardRotationCalculator

    switch (axis) {
      case RotationAxis.X:
        axisCalculator = this.xAxisCalculator
        break
      case RotationAxis.Y:
        axisCalculator = this.yAxisCalculator
        break
      case RotationAxis.Z:
        axisCalculator = this.zAxisCalculator
        break
    }

    axisCalculator.axisEnabled = enabled
  }

  public get targetTransform(): Transform {
    return this._targetTransform
  }

  /**
   * Gets the easing values for each axis (x, y, z).
   * See BillboardConfig.axisEasing for detailed documentation.
   */
  public get axisEasing(): vec3 {
    return new vec3(this.xAxisCalculator.axisEasing, this.yAxisCalculator.axisEasing, this.zAxisCalculator.axisEasing)
  }
  /**
   * Sets the easing values for each axis (x, y, z).
   * Typical values: 0.2-0.3 for smooth lag, 1.0 for instant rotation.
   * See BillboardConfig.axisEasing for detailed documentation.
   */
  public set axisEasing(easing: vec3) {
    this.xAxisCalculator.axisEasing = easing.x
    this.yAxisCalculator.axisEasing = easing.y
    this.zAxisCalculator.axisEasing = easing.z
  }

  public get axisBufferDegrees(): vec3 {
    return new vec3(
      MathUtils.RadToDeg * this.xAxisCalculator.axisBufferRadians,
      MathUtils.RadToDeg * this.yAxisCalculator.axisBufferRadians,
      MathUtils.RadToDeg * this.zAxisCalculator.axisBufferRadians
    )
  }
  public set axisBufferDegrees(bufferDegrees: vec3) {
    this.xAxisCalculator.axisBufferRadians = MathUtils.DegToRad * bufferDegrees.x
    this.yAxisCalculator.axisBufferRadians = MathUtils.DegToRad * bufferDegrees.y
    this.zAxisCalculator.axisBufferRadians = MathUtils.DegToRad * bufferDegrees.z
  }

  /**
   * Set the pivot point and pivoting Interactor to control the Billboard's pivot axis.
   * To turn off pivoting about a point, reset the pivot point to vec3.zero()
   * @param pivotPoint - the pivot point to billboard the target about in local space.
   * @param interactor - the pivoting Interactor.
   */
  public setPivot(pivotPoint: vec3, interactor: Interactor) {
    this.pivotPoint = pivotPoint
    this.pivotingInteractor = interactor

    this.manipulationComponent = this.findInteractableManipulation(
      this.pivotingInteractor.currentInteractable?.sceneObject ?? null
    )
  }

  // The following functions aid with getting unit vectors relative to the target's current rotation.
  private getForwardVector() {
    return this.targetTransform.forward
  }

  private getUpVector() {
    return this.targetTransform.up
  }

  private getRightVector() {
    return this.targetTransform.right
  }

  // Returns a unit vector aligned with the line from the target's center to the camera for X/Y-axes rotation.
  private getTargetToCameraVector() {
    return this.cameraTransform.getWorldPosition().sub(this.targetTransform.getWorldPosition()).normalize()
  }

  // Returns the up vector of a camera for Z-axis rotation.
  private getCameraUpVector() {
    return this.cameraTransform.up
  }

  // Returns the distance from camera to the target center
  // Uses target center (not pivot) because rotation calculations are based on target center → camera vector
  private getDistanceToCamera(): number {
    const cameraPosition = this.cameraTransform.getWorldPosition()
    const targetPosition = this.targetTransform.getWorldPosition()
    return cameraPosition.sub(targetPosition).length
  }

  // Updates proximity deadzone state with hysteresis to prevent flickering
  private updateProximityDeadzone(): void {
    const distance = this.getDistanceToCamera()

    if (this.isInProximityDeadzone) {
      // Currently in deadzone - exit only if beyond exit threshold
      if (distance > PROXIMITY_DEADZONE_EXIT_DISTANCE) {
        this.isInProximityDeadzone = false
      }
    } else {
      // Currently not in deadzone - enter only if within entry threshold
      if (distance < PROXIMITY_DEADZONE_ENTRY_DISTANCE) {
        this.isInProximityDeadzone = true
      }
    }
  }

  /**
   * Checks if the object is currently being manipulated.
   * During manipulation, we need maximum responsiveness.
   */
  private isManipulating(): boolean {
    if (this.manipulationComponent === null) {
      return false
    }
    return this.manipulationComponent.isManipulating()
  }

  // Rotates the target about each enabled axis separately.
  private onUpdate(): void {
    if (this.firstUpdate) {
      this.firstUpdate = false
      this.targetRotation = null
      this.resetRotation()

      return
    }

    // Early exit if all axes are disabled - no work needed
    if (!this.xAxisCalculator.axisEnabled && !this.yAxisCalculator.axisEnabled && !this.zAxisCalculator.axisEnabled) {
      this.accumulatedDeltaTime = 0 // Reset accumulator even when disabled
      this.targetRotation = null
      return
    }

    // Check if object is being actively manipulated to determine which update path to use
    const isActivelyManipulating = this.isManipulating()

    if (isActivelyManipulating) {
      // ===== FAST PATH: During manipulation =====
      // When user is manipulating the object, we need maximum responsiveness to avoid stuttering.
      // Apply full rotation every frame with no frame skipping or interpolation.
      // This ensures billboard rotation stays perfectly in sync with manipulation translation.
      // Check proximity deadzone - skip rotation if camera is too close to prevent instability
      this.updateProximityDeadzone()
      if (this.isInProximityDeadzone) {
        // Still need to update manipulation transform even when not rotating
        // This ensures InteractableManipulation maintains 1:1 movement with the initial trigger point
        if (this.manipulationComponent !== null) {
          this.manipulationComponent.updateStartTransform()
        }
        return
      }
      this.performBillboardRotation(getDeltaTime(), true)
      return
    }

    // ===== STANDARD PATH: When not manipulating =====
    // Use performance optimizations: frame skipping and interpolation for smooth 60 FPS animation

    // Accumulate delta time across all frames (including skipped ones).
    // This is critical for framerate-independent rotation when skipping frames.
    // For example, if we update every other frame at 60fps:
    // - Frame 1 (skipped): accumulate 0.016s
    // - Frame 2 (processed): accumulate 0.016s, use total 0.032s for rotation
    // This ensures the same rotation speed as if we updated every frame.
    this.accumulatedDeltaTime += getDeltaTime()

    // Update every other frame for better performance
    this.shouldUpdateThisFrame = !this.shouldUpdateThisFrame
    if (!this.shouldUpdateThisFrame) {
      // Animation-only frame: complete the rotation (apply remaining 50%)
      // The rotation was calculated in the previous frame when we were outside the deadzone,
      // so it's a valid/stable rotation - safe to complete even if we're now in deadzone.
      // The next calculation frame will detect the deadzone and stop new rotations.
      if (this.targetRotation !== null) {
        this.applyInterpolatedRotation(1.0) // Complete rotation to target
      }

      return
    }

    // Check proximity deadzone before expensive calculations
    this.updateProximityDeadzone()
    if (this.isInProximityDeadzone) {
      // Reset accumulatedDeltaTime so rotation resumes normally when exiting deadzone
      // (prevents sudden large rotation from accumulated time while in deadzone)
      this.accumulatedDeltaTime = 0
      // Reset stability counter so we get responsive rotation when exiting deadzone
      this.consecutiveBufferZoneHits = 0
      this.framesSinceLastCheck = 0
      return
    }

    // Optimization: If we've been stable in buffer zone for multiple consecutive checks,
    // skip additional frames (update every 8th frame instead of every 2nd)
    if (!this.isAnimatingToLookAtCamera && this.consecutiveBufferZoneHits >= BUFFER_STABILITY_THRESHOLD) {
      this.framesSinceLastCheck++

      // When stable, only check every 4th iteration (8 frames total with the every-other-frame toggle)
      if (this.framesSinceLastCheck < 4) {
        return
      }

      this.framesSinceLastCheck = 0
    }

    // Use accumulated delta time for framerate-independent calculations
    const deltaTime = this.accumulatedDeltaTime
    this.accumulatedDeltaTime = 0 // Reset accumulator after use

    // Perform rotation with interpolation (standard path)
    this.performBillboardRotation(deltaTime, false)
  }

  /**
   * Performs the billboard rotation calculation and application.
   * @param deltaTime - Time delta for framerate-independent rotation
   * @param applyImmediately - If true, applies full rotation immediately (fast path for manipulation).
   *                           If false, uses split rotation with interpolation (standard path).
   */
  private performBillboardRotation(deltaTime: number, applyImmediately: boolean): void {
    // Cache transform vectors once per frame to reduce transform queries
    let forwardVector = this.getForwardVector()
    let upVector = this.getUpVector()
    let rightVector = this.getRightVector()
    const targetToCameraVector = this.getTargetToCameraVector()

    // Calculate rotations incrementally in Y->X->Z order, only for enabled axes
    // This order avoids gimbal lock at ~180° rotation (when camera is behind object)
    let combinedRotation = quat.quatIdentity()
    let didRotate = false

    // Y-axis rotation (yaw) - uses original camera vector to naturally handle 180° turns
    // BUT: Skip Y-axis when near vertical to prevent gimbal lock
    const isNearVertical =
      Math.abs(targetToCameraVector.dot(VEC_UP)) > VERTICAL_GIMBAL_LOCK_THRESHOLD ||
      Math.abs(targetToCameraVector.dot(VEC_DOWN)) > VERTICAL_GIMBAL_LOCK_THRESHOLD

    if (this.yAxisCalculator.axisEnabled && !isNearVertical) {
      const yUpVector = upVector.dot(VEC_DOWN) > ALMOST_ONE ? VEC_DOWN : VEC_UP
      const yRotation = this.yAxisCalculator.getRotation(
        yUpVector,
        forwardVector,
        targetToCameraVector,
        rightVector.uniformScale(-1),
        deltaTime
      )

      // Check if this axis actually rotated (not identity quaternion)
      if (!yRotation.equal(quat.quatIdentity())) {
        didRotate = true

        // Only update vectors if X or Z axes need them
        if (this.xAxisCalculator.axisEnabled || this.zAxisCalculator.axisEnabled) {
          forwardVector = yRotation.multiplyVec3(forwardVector)
          upVector = yRotation.multiplyVec3(upVector)
          rightVector = yRotation.multiplyVec3(rightVector)
        }
      }

      combinedRotation = yRotation
    }

    // X-axis rotation (pitch) - uses reflected camera vector when behind to prevent flipping
    if (this.xAxisCalculator.axisEnabled) {
      // Detect if camera is behind the object (after Y rotation)
      // When behind, reflect the camera vector to prevent X-axis from pitching backwards
      let xTargetVector = targetToCameraVector
      const isCameraBehind = forwardVector.dot(targetToCameraVector) < 0
      if (isCameraBehind) {
        // Reflect camera vector across the plane with normal = forwardVector
        // Formula: reflected = v - 2 * (v.dot(n)) * n
        const forwardComponent = targetToCameraVector.dot(forwardVector)
        xTargetVector = targetToCameraVector.sub(forwardVector.uniformScale(2 * forwardComponent))
      }

      const xRotation = this.xAxisCalculator.getRotation(rightVector, forwardVector, xTargetVector, upVector, deltaTime)

      // Check if this axis actually rotated
      if (!xRotation.equal(quat.quatIdentity())) {
        didRotate = true

        // Only update vectors if Z axis needs them
        if (this.zAxisCalculator.axisEnabled) {
          forwardVector = xRotation.multiplyVec3(forwardVector)
          upVector = xRotation.multiplyVec3(upVector)
          rightVector = xRotation.multiplyVec3(rightVector)
        }
      }

      combinedRotation = xRotation.multiply(combinedRotation)
    }

    // Z-axis rotation (roll)
    if (this.zAxisCalculator.axisEnabled) {
      const cameraUpVector = this.getCameraUpVector()
      const zRotation = this.zAxisCalculator.getRotation(
        forwardVector,
        upVector,
        cameraUpVector,
        rightVector,
        deltaTime
      )

      // Check if this axis actually rotated
      if (!zRotation.equal(quat.quatIdentity())) {
        didRotate = true
      }

      combinedRotation = zRotation.multiply(combinedRotation)
    }

    // If no rotation needed (in buffer zone), exit early to skip expensive transform operations
    if (!didRotate) {
      // Increment consecutive buffer hits for frame skip optimization
      this.consecutiveBufferZoneHits++

      // Clear target rotation since we're in buffer zone
      this.targetRotation = null

      // Check animation completion even when not rotating (to handle floating point precision edge cases)
      if (this.isAnimatingToLookAtCamera) {
        this.checkIsLookingAtCamera()
      }

      // Called once per frame even if not updating axis rotation.
      // This ensures InteractableManipulation maintains 1:1 movement with the initial trigger point.>>>>>>> main
      if (this.manipulationComponent !== null) {
        this.manipulationComponent.updateStartTransform()
      }

      return
    }

    // We rotated - reset consecutive buffer zone counter and frame skip counter
    this.consecutiveBufferZoneHits = 0
    this.framesSinceLastCheck = 0

    // Calculate the target rotation (but don't apply all of it yet for smooth animation in standard path)
    const newRotation = combinedRotation.multiply(this.targetTransform.getWorldRotation())

    // Store target rotation for both fast and standard paths
    this.targetRotation = newRotation

    if (applyImmediately) {
      // ===== FAST PATH: Apply full rotation immediately for maximum responsiveness =====
      // Used during manipulation to avoid stuttering from split-frame rotation updates.
      // Apply 100% of rotation (no interpolation) in a single frame.
      this.applyInterpolatedRotation(1.0)
    } else {
      // ===== STANDARD PATH: Use interpolation for smooth 60 FPS animation =====
      // Split calculated rotation across two frames for smooth 60 FPS animation
      // Calculation frame applies 50%, animation frame applies the remaining 50%
      this.applyInterpolatedRotation(ROTATION_SPLIT_FACTOR)
    }
    
    if (this.isAnimatingToLookAtCamera) {
      this.checkIsLookingAtCamera()
    }
  }

  /**
   * Applies rotation toward the target rotation, with optional interpolation.
   * Used by both fast path (manipulation) and standard path (idle).
   *
   * @param slerpAmount - Amount of rotation to apply:
   *                      - 1.0: Apply full rotation immediately (fast path during manipulation)
   *                      - 0.5: Apply half rotation (standard path, first frame of split animation)
   *                      - Any value: Slerp from current to target rotation
   */
  private applyInterpolatedRotation(slerpAmount: number): void {
    if (this.targetRotation === null) {
      return
    }

    const currentRotation = this.targetTransform.getWorldRotation()

    // Optimization: if slerpAmount is 1.0, directly use target rotation (skip slerp computation)
    const interpolatedRotation =
      slerpAmount >= 1.0 ? this.targetRotation : quat.slerp(currentRotation, this.targetRotation, slerpAmount)

    // Handle pivot point if set
    if (!this.pivotPoint.equal(vec3.zero())) {
      // Calculate the rotation delta to apply
      const rotationDelta = interpolatedRotation.multiply(currentRotation.invert())

      const worldPivotPoint = this.targetTransform.getWorldTransform().multiplyPoint(this.pivotPoint)
      const v = this.targetTransform.getWorldPosition().sub(worldPivotPoint)
      const rotatedV = rotationDelta.multiplyVec3(v)
      const position = rotatedV.add(worldPivotPoint)
      this.targetTransform.setWorldPosition(position)
    }

    // Apply the interpolated rotation
    this.targetTransform.setWorldRotation(interpolatedRotation)

    // Clear target rotation after completing it (when slerpAmount is 1.0)
    if (slerpAmount >= 1.0) {
      this.targetRotation = null
    }

    // To help InteractableManipulation ensure 1:1 movement with the initial trigger point, update the transform.
    if (this.manipulationComponent !== null) {
      this.manipulationComponent.updateStartTransform()
    }
  }

  private findInteractableManipulation(object: SceneObject | null): InteractableManipulation | null {
    if (!object) {
      return null
    }

    return findComponentInSelfOrParents<InteractableManipulation>(object, InteractableManipulation.getTypeName())
  }

  private checkIsLookingAtCamera() {
    const forwardVector = this.getForwardVector()
    const targetToCameraVector = this.getTargetToCameraVector()
    const alignment = forwardVector.dot(targetToCameraVector)

    // 0.9999 = ~0.8 degrees off
    if (alignment > 0.9999) {
      // Restore original settings
      this.xAxisCalculator.axisEnabled = this.originalXEnabled
      this.yAxisCalculator.axisEnabled = this.originalYEnabled
      this.xAxisCalculator.axisBufferRadians = this.originalXBuffer
      this.yAxisCalculator.axisBufferRadians = this.originalYBuffer
      this.isAnimatingToLookAtCamera = false

      // Callback
      if (this.animationCompleteCallBack !== null) {
        this.animationCompleteCallBack()
        this.animationCompleteCallBack = null
      }
    }
  }

  /**
   * Resets the pivot point to billboard the target about its own origin. Recommended to use after finishing
   * some spatial interaction that sets the pivotPoint of this component manually.
   */
  public resetPivotPoint() {
    this.pivotPoint = vec3.zero()
    this.pivotingInteractor = null
    this.manipulationComponent = null
  }

  public resetRotation(): void {
    // Cache transform vectors and camera vector once to reduce transform queries
    // After each axis rotation, the vectors are updated to the post-rotation orientation
    // This avoids overhead of setting the transform after each axis rotation
    const forwardVector = this.getForwardVector()
    const upVector = this.getUpVector()
    const rightVector = this.getRightVector()
    const targetToCameraVector = this.getTargetToCameraVector()
    const cameraUpVector = this.getCameraUpVector()

    // Calculate rotations incrementally in Y->X->Z order, updating vectors after each axis
    // Unlike onUpdate(), this uses resetRotation() to snap instantly without buffer/easing

    // Y-axis rotation (using original orientation)
    const yUpVector = upVector.dot(VEC_DOWN) > ALMOST_ONE ? VEC_DOWN : VEC_UP
    const yRotation = this.yAxisCalculator.resetRotation(
      yUpVector,
      forwardVector,
      targetToCameraVector,
      rightVector.uniformScale(-1)
    )

    // Simulate applying Y rotation to get updated vectors for X calculation
    const postYForward = yRotation.multiplyVec3(forwardVector)
    const postYUp = yRotation.multiplyVec3(upVector)
    const postYRight = yRotation.multiplyVec3(rightVector)

    // X-axis rotation (using post-Y orientation)
    const xRotation = this.xAxisCalculator.resetRotation(postYRight, postYForward, targetToCameraVector, postYUp)

    // Simulate applying Y+X rotation to get updated vectors for Z calculation
    const postYXRotation = xRotation.multiply(yRotation)
    const postYXForward = postYXRotation.multiplyVec3(forwardVector)
    const postYXUp = postYXRotation.multiplyVec3(upVector)
    const postYXRight = postYXRotation.multiplyVec3(rightVector)

    // Z-axis rotation (using post-Y+X orientation)
    const zRotation = this.zAxisCalculator.resetRotation(postYXForward, postYXUp, cameraUpVector, postYXRight)

    // Combine all rotations into a single quaternion (order matters: Y -> X -> Z)
    const combinedRotation = zRotation.multiply(xRotation).multiply(yRotation)

    // Apply the combined rotation once
    this.targetTransform.setWorldRotation(combinedRotation.multiply(this.targetTransform.getWorldRotation()))
  }

  /**
   * Immediately resets rotation to directly look at the camera, ignoring current axis enabled/disabled states, buffer degrees, and easing.
   */
  public resetRotationToLookAtCamera(): void {
    const lookAtQuaternion = quat.lookAt(this.getTargetToCameraVector(), vec3.up())
    this.targetTransform.setWorldRotation(lookAtQuaternion)
  }

  /**
   * Animates rotation to directly look at the camera, ignoring current axis enabled/disabled states, buffer degrees, and easing.
   */
  public animateToLookAtCamera(onComplete?: () => void): void {
    if (this.isAnimatingToLookAtCamera) return // Already animating

    // Original settings to restore after animation is complete
    this.originalXEnabled = this.xAxisCalculator.axisEnabled
    this.originalYEnabled = this.yAxisCalculator.axisEnabled
    this.originalXBuffer = this.xAxisCalculator.axisBufferRadians
    this.originalYBuffer = this.yAxisCalculator.axisBufferRadians
    this.animationCompleteCallBack = onComplete ?? null

    // Enable "pinching mode"
    this.xAxisCalculator.axisEnabled = true
    this.yAxisCalculator.axisEnabled = true
    this.xAxisCalculator.axisBufferRadians = 0
    this.yAxisCalculator.axisBufferRadians = 0

    this.isAnimatingToLookAtCamera = true
  }
}
