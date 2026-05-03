import {RotationAxis} from "./BillboardController"

export type RotationCalculatorConfig = {
  axis: RotationAxis
  axisEnabled?: boolean
  axisBufferRadians?: number
  /**
   * Easing controls how quickly the billboard rotates to face the camera.
   * Uses exponential decay for framerate-independent smooth motion.
   *
   * Values range from 0 (no rotation) to 1 (instant/no easing):
   * - 1.0: Instant rotation (no lag)
   * - 0.2-0.3: Smooth, moderate lag (recommended for most use cases)
   * - 0.1-0.2: Slower, more laggy rotation
   * - 0.05-0.1: Very slow, heavy lag
   *
   * Note: The value represents how much rotation error is eliminated per DEFAULT_DURATION.
   * Smaller values = more lag/smoother motion. Larger values = faster/snappier motion.
   */
  axisEasing?: number
}

// Default time duration (in seconds) used for framerate-independent easing calculations.
// This represents a single frame at 30fps and is used to normalize rotation speeds.
export const DEFAULT_DURATION = 0.033
export const EPSILON = 1e-6
export const ALMOST_ONE = 1 - EPSILON
const IDENTITY_QUAT = quat.quatIdentity()

/**
 * BillboardRotationCalculator is used to calculate the quaternion to rotate an object by to align with a new vector along an axis.
 * More specifically, this calculator is used along a SceneObject's local X/Z-axes and global Y-axis.
 * These calculators only take in vec3's as SceneObject manipulation is handled in BillboardController.
 */
export default class BillboardRotationCalculator {
  private axis: RotationAxis
  private _axisEnabled: boolean = false

  private _axisBufferRadians: number = 0

  // Use an estimated time for the duration between each update to prevent FPS issues from slowing down billboarding effect.
  private duration: number = 0
  private _axisEasing: number = 1

  constructor(config: RotationCalculatorConfig) {
    this.axis = config.axis
    this.axisEnabled = config.axisEnabled ?? false
    this.axisBufferRadians = config.axisBufferRadians ?? 0
    this.axisEasing = config.axisEasing ?? 1
  }

  get axisEnabled(): boolean {
    return this._axisEnabled
  }
  set axisEnabled(enabled: boolean) {
    this._axisEnabled = enabled
  }

  get axisBufferRadians(): number {
    return this._axisBufferRadians
  }
  set axisBufferRadians(radians: number) {
    this._axisBufferRadians = radians
  }

  /**
   * Gets the axis easing value (0-1).
   * See RotationCalculatorConfig.axisEasing for detailed documentation.
   */
  get axisEasing(): number {
    return this._axisEasing
  }
  /**
   * Sets the axis easing value (0-1).
   * Typical values: 0.2-0.3 for smooth lag, 1.0 for instant rotation.
   * See RotationCalculatorConfig.axisEasing for detailed documentation.
   */
  set axisEasing(easing: number) {
    this._axisEasing = easing
  }

  /**
   * Returns the exact angle to rotate the target by along the given axis.
   * Applies buffer tolerance and easing for smooth, framerate-independent rotation.
   *
   * @param angle - The full angle needed to align with the target
   * @param deltaTime - Time elapsed since last rotation update (accumulated across skipped frames)
   * @returns The angle to rotate this frame, after applying buffer and easing
   */
  private calculateAxisRotation(angle: number, deltaTime: number): number {
    if (!this.axisEnabled || Math.abs(angle) < this.axisBufferRadians) {
      return 0
    }

    // Calculate the angle to rotate just enough to keep the camera within the buffer cone.
    const bufferAngle = angle - Math.sign(angle) * this.axisBufferRadians

    if (this.axisEasing !== 1) {
      // Use exponential decay for framerate-independent easing.
      // Formula: easingFactor = 1 - (1 - easing)^(deltaTime / DEFAULT_DURATION)
      //
      // This ensures consistent visual behavior regardless of:
      // - Frame rate (60fps vs 30fps)
      // - Frame skipping (updating every other frame)
      // - Variable frame times
      //
      // The easing value represents how much error is eliminated per DEFAULT_DURATION (33ms).
      // Example: easing=0.2 means 20% of the angle is rotated per 33ms.
      // After 33ms: rotates 20% of bufferAngle
      // After 66ms: rotates 36% of bufferAngle (not 40%, due to exponential decay)
      // After 99ms: rotates 49% of bufferAngle
      const easingFactor = 1.0 - Math.pow(1.0 - this.axisEasing, deltaTime / DEFAULT_DURATION)
      return bufferAngle * easingFactor
    } else {
      // If we are not easing along this axis, just return the angle to maintain buffer zone.
      return bufferAngle
    }
  }

  /**
   * Returns the angle about specified axis to rotate the target to align with the camera.
   * By projecting the forward/up vector onto planes defined by the relevant axis as the normal, we can separately calculate the angles of each axis.
   * The separate calculations allow for each axis to have its own buffer / interpolation values.
   * Because the user is expected to walk around freely, we use local X and Z axes for calculation, but global Y axis as the user's perception of 'up' is constant.
   */
  private calculateAxisAngle(axisVector: vec3, forwardVector: vec3, cameraVector: vec3, originVector: vec3): number {
    const forwardVectorOnPlane = forwardVector.projectOnPlane(axisVector)
    const cameraVectorOnPlane = cameraVector.projectOnPlane(axisVector)

    let angle = forwardVectorOnPlane.angleTo(cameraVectorOnPlane)

    // Origin vector describes the position on the unit circle where radian = 0.
    // We use this vector to compare if we should flip the sign of the angle to rotate in the correct direction.
    const forwardAngleOnPlane = originVector.angleTo(forwardVectorOnPlane)
    const cameraAngleOnPlane = originVector.angleTo(cameraVectorOnPlane)
    if (forwardAngleOnPlane > cameraAngleOnPlane) {
      angle = -angle
    }

    return angle
  }

  // Rotates the target about each enabled axis separately.
  public getRotation(
    axisVector: vec3,
    forwardVector: vec3,
    cameraVector: vec3,
    originVector: vec3,
    deltaTime: number
  ): quat {
    if (!this._axisEnabled) {
      return IDENTITY_QUAT
    }

    const forwardDot = Math.abs(axisVector.dot(forwardVector))
    const cameraDot = Math.abs(axisVector.dot(cameraVector))
    if (forwardDot >= ALMOST_ONE || cameraDot >= ALMOST_ONE) {
      return IDENTITY_QUAT
    }

    const angle = this.calculateAxisAngle(axisVector, forwardVector, cameraVector, originVector)
    const rotationRadians = this.calculateAxisRotation(angle, deltaTime)

    // Early exit if no rotation is needed (within buffer zone or disabled)
    if (rotationRadians === 0) {
      return IDENTITY_QUAT
    }

    return quat.angleAxis(rotationRadians, axisVector)
  }

  /**
   * Used to snap the target immediately into proper rotation according to configuration.
   * @param axisVector - the vector to rotate about
   * @param forwardVector - the forward vector of the target
   * @param cameraVector - the vector from camera to target
   * @param originVector - the origin of rotation as a reference to ensure proper rotation
   * @returns the rotation about the given axis to align the target's forward vector with the camera.
   */
  public resetRotation(axisVector: vec3, forwardVector: vec3, cameraVector: vec3, originVector: vec3) {
    if (!this._axisEnabled) {
      return IDENTITY_QUAT
    }

    const forwardDot = Math.abs(axisVector.dot(forwardVector))
    const cameraDot = Math.abs(axisVector.dot(cameraVector))
    if (forwardDot >= ALMOST_ONE || cameraDot >= ALMOST_ONE) {
      return IDENTITY_QUAT
    }

    const angle = this.calculateAxisAngle(axisVector, forwardVector, cameraVector, originVector)

    return this.axisEnabled ? quat.angleAxis(angle, axisVector) : IDENTITY_QUAT
  }
}
