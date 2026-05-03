/**
 * Creates a spherical sensor volume to track overlaps with other colliders.
 *
 * This component actively maintains a list of objects within its radius and can be queried to find the closest point on
 * those objects.
 */
@component
export class ProximitySensor extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Sensor Configuration</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Configure the spherical detection volume for tracking nearby colliders</span>'
  )

  /**
   * The radius of the spherical sensor in centimeters.
   */
  @input
  @label("Radius")
  @hint("The radius of the spherical sensor in centimeters.")
  radius: number = 1.0

  /**
   * Display debug rendering for the proximity sensor.
   * @internal
   */
  debugModeEnabled = false

  private sensorCollider: ColliderComponent | null = null
  private overlappingColliders: Set<ColliderComponent> = new Set()
  private transform!: Transform

  onAwake(): void {
    this.transform = this.getTransform()
    this.createSensorVolume()
  }

  /**
   * Updates the radius at runtime and automatically recalculates the larger detection radius needed for the buffer.
   * @param newRadius The new inner radius for the effect.
   */
  setRadius(newRadius: number): void {
    this.radius = newRadius

    if (this.sensorCollider && this.sensorCollider.shape) {
      const sphereShape = this.sensorCollider.shape as SphereShape
      sphereShape.radius = this.radius
    }
  }

  /**
   * Returns a list of all colliders currently inside the large detection volume.
   * @returns An array of the overlapping ColliderComponents.
   */
  getOverlappingColliders(): ColliderComponent[] {
    if (this.debugModeEnabled) {
      const sensorCenter = this.transform.getWorldPosition()
      global.debugRenderSystem.drawSphere(sensorCenter, this.radius, new vec4(0.7, 0.7, 0.7, 1))
    }

    return Array.from(this.overlappingColliders)
  }

  private createSensorVolume(): void {
    this.sensorCollider = this.getSceneObject().createComponent("Physics.ColliderComponent") as ColliderComponent

    const shape = Shape.createSphereShape()
    shape.radius = this.radius

    this.sensorCollider.shape = shape
    this.sensorCollider.intangible = true
    this.sensorCollider.debugDrawEnabled = false

    this.sensorCollider.onOverlapEnter.add(this.onOverlapEnter.bind(this))
    this.sensorCollider.onOverlapExit.add(this.onOverlapExit.bind(this))
  }

  private onOverlapEnter(args: OverlapEnterEventArgs): void {
    const otherCollider = args.overlap.collider
    if (otherCollider && otherCollider !== this.sensorCollider) {
      this.overlappingColliders.add(otherCollider)
    }
  }

  private onOverlapExit(args: OverlapExitEventArgs): void {
    const otherCollider = args.overlap.collider
    if (otherCollider) {
      this.overlappingColliders.delete(otherCollider)
    }
  }
}
