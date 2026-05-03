import {ProximitySensor} from "../../../Components/Helpers/ProximitySensor"
import {HandInteractor} from "../../../Core/HandInteractor/HandInteractor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {HandInputData} from "../../../Providers/HandInputData/HandInputData"
import {HandType} from "../../../Providers/HandInputData/HandType"
import TrackedHand from "../../../Providers/HandInputData/TrackedHand"
import {LensConfig} from "../../../Utils/LensConfig"
import {DispatchedUpdateEvent, IUpdateDispatcher} from "../../../Utils/UpdateDispatcher"
import {validate} from "../../../Utils/validate"
import {GlowEffectViewModel, GlowEffectViewModelConfig, PinchProperties, PokeProperties} from "./GlowEffectViewModel"
import {HandVisual, HandVisualSelection} from "./HandVisual"

const POKE_DEPTH_MASK_START = 0.65
const POKE_DEPTH_MASK_RANGE = 0.35
const POKE_HIGHLIGHT_GRADIENT_MASK_MIN = 0.0
const POKE_HIGHLIGHT_GRADIENT_MASK_MAX = 0.3
const POKE_OCCLUDE_GRADIENT_MASK_MIN = 0.0
const POKE_OCCLUDE_GRADIENT_MASK_MAX = 0.32
const POKE_GRADIENT_MASK_LERP_SPEED = 10
const POKE_GRADIENT_MASK_CUTOFF = 0.01

const INDEX_GLOW_UP_OFFSET = -0.36
const INDEX_GLOW_FORWARD_OFFSET = -0.25

export type GlowEffectViewStyle = {
  hoverColor: vec4
  triggerColor: vec4
  tipGlowMaterial: Material
  pinchBrightnessMax: number
  pinchGlowBrightnessMax: number
  pinchBrightnessMaxStrength: number
  pinchTriggeredMult: number
  pinchExponent: number
  pinchExponentTriggered: number
  pinchHighlightThresholdFar: number
  pinchHighlightThresholdNear: number
  pokeBrightnessMax: number
  pokeGlowBrightnessMax: number
  pokeTriggeredMult: number
  pokeHighlightThresholdFar: number
  pokeHighlightThresholdNear: number
  pokeOccludeThresholdFar: number
  pokeOccludeThresholdNear: number
  pokeExponent: number
  pokeExponentTriggered: number
  tipGlowRenderOrder: number
  tipGlowWorldScale: number
  triggeredLerpDurationSeconds: number
  pinchValidLerpDurationSeconds: number
  pokeValidLerpDurationSeconds: number
}

export type GlowEffectViewConfig = {
  debugModeEnabled: boolean
  handVisuals: HandVisual
  handType: HandType
  unitPlaneMesh: RenderMesh
  handInteractor: HandInteractor
  handVisualSelection: HandVisualSelection
  proximitySensor: ProximitySensor
  style: GlowEffectViewStyle
}

/**
 * GlowEffectView controls the glow effect that happens when pinching and poking.
 * It works with a ViewModel to separate presentation from logic.
 */
export class GlowEffectView {
  get isMeshVisibilityDesired(): boolean {
    return this.viewModel.isMeshVisibilityDesired
  }

  get isIndexGlowVisible(): boolean {
    return this.viewModel.isIndexGlowVisible
  }

  get isThumbGlowVisible(): boolean {
    return this.viewModel.isThumbGlowVisible
  }

  get indexGlowSceneObject(): SceneObject {
    return this._indexGlowSceneObject
  }

  get thumbGlowSceneObject(): SceneObject {
    return this._thumbGlowSceneObject
  }

  // View-specific properties
  private handVisuals: HandVisual
  private _indexGlowSceneObject!: SceneObject
  private _indexGlowTransform!: Transform
  private _indexGlowMaterial!: Material
  private _thumbGlowSceneObject!: SceneObject
  private _thumbGlowTransform!: Transform
  private _thumbGlowMaterial!: Material
  private debugModeEnabled: boolean

  // Dependencies
  private camera = WorldCameraFinderProvider.getInstance()
  private cameraTransform = this.camera.getTransform()
  private updateDispatcher: IUpdateDispatcher = LensConfig.getInstance().updateDispatcher
  private updateEvent: DispatchedUpdateEvent
  private viewModel: GlowEffectViewModel
  private hand: TrackedHand
  private handInputData = HandInputData.getInstance()

  // Caching
  private lastPinchProps: PinchProperties
  private lastPokeProps: PokeProperties
  private lastPokePinchBlend: number = -1
  private lastIndexGlowEnabled: boolean = false
  private lastThumbGlowEnabled: boolean = false
  private lastMeshVisibilityDesired: boolean = true

  // Event handlers
  private onHandFoundCallback!: () => void
  private onHandLostCallback!: () => void

  constructor(private config: GlowEffectViewConfig) {
    this.debugModeEnabled = config.debugModeEnabled
    this.handVisuals = config.handVisuals
    this.hand = this.handInputData.getHand(config.handType)

    // Setup scene objects and materials
    this._indexGlowSceneObject = this.setupGlowSceneObject(
      this.handVisuals.indexTip,
      "indexTipGlowSceneObject",
      new vec3(0, INDEX_GLOW_UP_OFFSET, INDEX_GLOW_FORWARD_OFFSET)
    )
    this._indexGlowTransform = this._indexGlowSceneObject.getTransform()
    this._indexGlowMaterial = this._indexGlowSceneObject.getComponent("Component.RenderMeshVisual").mainMaterial

    this._thumbGlowSceneObject = this.setupGlowSceneObject(this.handVisuals.thumbTip, "thumbTipGlowSceneObject")
    this._thumbGlowTransform = this._thumbGlowSceneObject.getTransform()
    this._thumbGlowMaterial = this._thumbGlowSceneObject.getComponent("Component.RenderMeshVisual").mainMaterial
    // Thumb does not have poke glow
    this._thumbGlowMaterial.mainPass["pokeGlowBrightness"] = 0

    config.proximitySensor.debugModeEnabled = config.debugModeEnabled
    config.proximitySensor.setRadius(
      Math.max(
        config.style.pokeHighlightThresholdFar,
        config.style.pokeOccludeThresholdFar,
        config.style.pinchHighlightThresholdFar,
        config.proximitySensor.radius
      )
    )

    // Create the ViewModel
    const viewModelConfig: GlowEffectViewModelConfig = {
      handInteractor: config.handInteractor,
      handType: config.handType,
      initialHandVisualSelection: config.handVisualSelection,
      style: {
        hoverColor: config.style.hoverColor,
        triggerColor: config.style.triggerColor,
        pinchBrightnessMax: config.style.pinchBrightnessMax,
        pinchGlowBrightnessMax: config.style.pinchGlowBrightnessMax,
        pinchBrightnessMaxStrength: config.style.pinchBrightnessMaxStrength,
        pinchTriggeredMult: config.style.pinchTriggeredMult,
        pinchExponent: config.style.pinchExponent,
        pinchExponentTriggered: config.style.pinchExponentTriggered,
        pinchHighlightThresholdFar: config.style.pinchHighlightThresholdFar,
        pinchHighlightThresholdNear: config.style.pinchHighlightThresholdNear,
        pokeBrightnessMax: config.style.pokeBrightnessMax,
        pokeGlowBrightnessMax: config.style.pokeGlowBrightnessMax,
        pokeTriggeredMult: config.style.pokeTriggeredMult,
        pokeDepthMaskStart: POKE_DEPTH_MASK_START,
        pokeDepthMaskRange: POKE_DEPTH_MASK_RANGE,
        pokeHighlightThresholdFar: config.style.pokeHighlightThresholdFar,
        pokeHighlightThresholdNear: config.style.pokeHighlightThresholdNear,
        pokeOccludeThresholdFar: config.style.pokeOccludeThresholdFar,
        pokeOccludeThresholdNear: config.style.pokeOccludeThresholdNear,
        pokeHighlightGradientMaskMin: POKE_HIGHLIGHT_GRADIENT_MASK_MIN,
        pokeHighlightGradientMaskMax: POKE_HIGHLIGHT_GRADIENT_MASK_MAX,
        pokeOccludeGradientMaskMin: POKE_OCCLUDE_GRADIENT_MASK_MIN,
        pokeOccludeGradientMaskMax: POKE_OCCLUDE_GRADIENT_MASK_MAX,
        pokeGradientMaskLerpSpeed: POKE_GRADIENT_MASK_LERP_SPEED,
        pokeGradientMaskCutoff: POKE_GRADIENT_MASK_CUTOFF,
        pokeExponent: config.style.pokeExponent,
        pokeExponentTriggered: config.style.pokeExponentTriggered,
        triggeredLerpDurationSeconds: config.style.triggeredLerpDurationSeconds,
        pinchValidLerpDurationSeconds: config.style.pinchValidLerpDurationSeconds,
        pokeValidLerpDurationSeconds: config.style.pokeValidLerpDurationSeconds
      },
      debugModeEnabled: config.debugModeEnabled,
      proximitySensor: config.proximitySensor,
      indexTipSceneObject: this.handVisuals.indexTip,
      overrideMap: this.handVisuals.overrideMap,
      handVisuals: this.handVisuals
    }
    this.viewModel = new GlowEffectViewModel(viewModelConfig)

    // Initialize cached properties
    this.lastPinchProps = {
      brightness: -1,
      color: new vec4(0, 0, 0, 0),
      glowBrightness: -1,
      glowColor: new vec4(0, 0, 0, 0),
      exponent: -1
    }
    this.lastPokeProps = {
      brightness: -1,
      color: new vec4(0, 0, 0, 0),
      glowBrightness: -1,
      glowColor: new vec4(0, 0, 0, 0),
      depthFactor: -1,
      highlightGradientMaskPosition: -1,
      occludeGradientMaskPosition: -1,
      exponent: -1
    }

    this.updateEvent = this.updateDispatcher.createUpdateEvent("GlowEffectViewUpdate", () => this.onUpdate())

    this.hand.onHandFound.add(
      (this.onHandFoundCallback = () => {
        this.updateEvent.enabled = true
      })
    )
    this.hand.onHandLost.add(
      (this.onHandLostCallback = () => {
        this.forceHideGlows()
        this.updateEvent.enabled = false
      })
    )

    this.updateEvent.enabled = this.hand.isTracked()
    if (!this.hand.isTracked()) {
      this.forceHideGlows()
    } else {
      this.syncGlowEnabledStates()
    }
  }

  /**
   * Clean up GlowEffectView
   */
  destroy(): void {
    this.hand.onHandFound.remove(this.onHandFoundCallback)
    this.hand.onHandLost.remove(this.onHandLostCallback)
    this.viewModel.destroy()
    this._indexGlowSceneObject.destroy()
    this._thumbGlowSceneObject.destroy()
    this.updateDispatcher.removeEvent(this.updateEvent)
  }

  private forceHideGlows(): void {
    if (this.lastIndexGlowEnabled) {
      this._indexGlowSceneObject.enabled = false
      this.lastIndexGlowEnabled = false
    }
    if (this.lastThumbGlowEnabled) {
      this._thumbGlowSceneObject.enabled = false
      this.lastThumbGlowEnabled = false
    }

    // Clear index glow material
    for (let i = 0; i < this._indexGlowMaterial.getPassCount(); i++) {
      const pass = this._indexGlowMaterial.getPass(i)
      pass["pinchGlowBrightness"] = 0
      pass["pokeGlowBrightness"] = 0
    }

    // Clear thumb glow material
    for (let i = 0; i < this._thumbGlowMaterial.getPassCount(); i++) {
      const pass = this._thumbGlowMaterial.getPass(i)
      pass["pinchGlowBrightness"] = 0
      pass["pokeGlowBrightness"] = 0
    }

    // Clear hand mesh materials
    const handMaterialFull = this.handVisuals.handMeshFull.mainMaterial
    if (handMaterialFull.getPassCount() > 1) {
      handMaterialFull.getPass(1)["pinchBrightness"] = 0
      handMaterialFull.getPass(1)["pokeBrightness"] = 0
    }

    const handMaterialIndexThumb = this.handVisuals.handMeshIndexThumb.mainMaterial
    if (handMaterialIndexThumb.getPassCount() > 1) {
      handMaterialIndexThumb.getPass(1)["pinchBrightness"] = 0
      handMaterialIndexThumb.getPass(1)["pokeBrightness"] = 0
    }

    // Reset cache
    this.lastPinchProps.brightness = 0
    this.lastPinchProps.color.x = 0
    this.lastPinchProps.color.y = 0
    this.lastPinchProps.color.z = 0
    this.lastPinchProps.color.w = 0
    this.lastPinchProps.glowBrightness = 0
    this.lastPinchProps.glowColor.x = 0
    this.lastPinchProps.glowColor.y = 0
    this.lastPinchProps.glowColor.z = 0
    this.lastPinchProps.glowColor.w = 0
    this.lastPinchProps.exponent = 0

    this.lastPokeProps.brightness = 0
    this.lastPokeProps.color.x = 0
    this.lastPokeProps.color.y = 0
    this.lastPokeProps.color.z = 0
    this.lastPokeProps.color.w = 0
    this.lastPokeProps.glowBrightness = 0
    this.lastPokeProps.glowColor.x = 0
    this.lastPokeProps.glowColor.y = 0
    this.lastPokeProps.glowColor.z = 0
    this.lastPokeProps.glowColor.w = 0
    this.lastPokeProps.depthFactor = 0
    this.lastPokeProps.highlightGradientMaskPosition = 0
    this.lastPokeProps.occludeGradientMaskPosition = 0
    this.lastPokeProps.exponent = 0

    this.lastPokePinchBlend = 0
    this.lastMeshVisibilityDesired = false
  }

  /**
   * Sets the visual selection mode via the ViewModel.
   */
  setVisualSelection(handVisualSelection: HandVisualSelection): void {
    this.viewModel.setVisualSelection(handVisualSelection)
  }

  /**
   * Sets the palm tapping state for the glow effect.
   * @param isPalmTapping - Whether the palm is currently tapping
   */
  setPalmTapping(isPalmTapping: boolean): void {
    this.viewModel.isPalmTapping = isPalmTapping
  }

  private setupGlowSceneObject(
    parentSceneObject: SceneObject | undefined,
    sceneObjectName: string,
    offset: vec3 | undefined = undefined
  ): SceneObject {
    validate(parentSceneObject)

    const glowSceneObject = global.scene.createSceneObject(sceneObjectName)
    glowSceneObject.setParent(parentSceneObject)
    const glowSceneObjectTransform = glowSceneObject.getTransform()
    glowSceneObjectTransform.setWorldScale(
      new vec3(
        this.config.style.tipGlowWorldScale,
        this.config.style.tipGlowWorldScale,
        this.config.style.tipGlowWorldScale
      )
    )
    if (offset) {
      glowSceneObjectTransform.setLocalPosition(offset)
    }

    const quadComponent = glowSceneObject.createComponent("Component.RenderMeshVisual")
    quadComponent.mesh = this.config.unitPlaneMesh
    quadComponent.setRenderOrder(this.config.style.tipGlowRenderOrder)

    const tipGlowMaterial = this.config.style.tipGlowMaterial.clone()
    tipGlowMaterial.mainPass.depthTest = false
    tipGlowMaterial.mainPass.depthWrite = false
    quadComponent.mainMaterial = tipGlowMaterial

    glowSceneObject.enabled = false
    return glowSceneObject
  }

  private onUpdate(): void {
    if (!this.hand.isTracked()) {
      this.forceHideGlows()
      return
    }

    this.applyViewModelProperties()

    this.syncGlowEnabledStates()
    this.syncHandMeshVisibility()

    if (this.isIndexGlowVisible || this.isThumbGlowVisible) {
      const cameraRotation = this.cameraTransform.getWorldRotation()

      if (this.isIndexGlowVisible) {
        this._indexGlowTransform.setWorldRotation(cameraRotation)
      }
      if (this.isThumbGlowVisible) {
        this._thumbGlowTransform.setWorldRotation(cameraRotation)
      }
    }

    if (this.debugModeEnabled) {
      this.drawDebugLines()
    }
  }

  private syncGlowEnabledStates(): void {
    const indexGlowShouldBeEnabled = this.isIndexGlowVisible && this.hand.isTracked()
    if (this.lastIndexGlowEnabled !== indexGlowShouldBeEnabled) {
      this._indexGlowSceneObject.enabled = indexGlowShouldBeEnabled
      this.lastIndexGlowEnabled = indexGlowShouldBeEnabled
    }

    const thumbGlowShouldBeEnabled = this.isThumbGlowVisible && this.hand.isTracked()
    if (this.lastThumbGlowEnabled !== thumbGlowShouldBeEnabled) {
      this._thumbGlowSceneObject.enabled = thumbGlowShouldBeEnabled
      this.lastThumbGlowEnabled = thumbGlowShouldBeEnabled
    }
  }

  private syncHandMeshVisibility(): void {
    if (this.lastMeshVisibilityDesired && !this.isMeshVisibilityDesired) {
      this.clearHandMeshBrightness()
    }
    this.lastMeshVisibilityDesired = this.isMeshVisibilityDesired
  }

  private clearHandMeshBrightness(): void {
    const handMaterialFull = this.handVisuals.handMeshFull.mainMaterial
    if (handMaterialFull.getPassCount() > 1) {
      handMaterialFull.getPass(1)["pinchBrightness"] = 0
      handMaterialFull.getPass(1)["pokeBrightness"] = 0
    }

    const handMaterialIndexThumb = this.handVisuals.handMeshIndexThumb.mainMaterial
    if (handMaterialIndexThumb.getPassCount() > 1) {
      handMaterialIndexThumb.getPass(1)["pinchBrightness"] = 0
      handMaterialIndexThumb.getPass(1)["pokeBrightness"] = 0
    }

    this.lastPinchProps.brightness = 0
    this.lastPokeProps.brightness = 0
  }

  private drawDebugLines(): void {
    for (const line of this.viewModel.debugLines) {
      global.debugRenderSystem.drawLine(line.start, line.end, line.color)
    }
  }

  private applyViewModelProperties(): void {
    const {pinchProps, pokeProps, pokePinchBlend} = this.viewModel

    this.applyBrightnessProps(pinchProps, pokeProps, pokePinchBlend)
    this.applyColorProps(pinchProps, pokeProps)

    if (this.isMeshVisibilityDesired) {
      this.lastPinchProps.brightness = pinchProps.brightness
      this.lastPinchProps.color.x = pinchProps.color.x
      this.lastPinchProps.color.y = pinchProps.color.y
      this.lastPinchProps.color.z = pinchProps.color.z
      this.lastPinchProps.color.w = pinchProps.color.w
      this.lastPinchProps.exponent = pinchProps.exponent

      this.lastPokeProps.brightness = pokeProps.brightness
      this.lastPokeProps.color.x = pokeProps.color.x
      this.lastPokeProps.color.y = pokeProps.color.y
      this.lastPokeProps.color.z = pokeProps.color.z
      this.lastPokeProps.color.w = pokeProps.color.w
      this.lastPokeProps.depthFactor = pokeProps.depthFactor
      this.lastPokeProps.highlightGradientMaskPosition = pokeProps.highlightGradientMaskPosition
      this.lastPokeProps.occludeGradientMaskPosition = pokeProps.occludeGradientMaskPosition
      this.lastPokeProps.exponent = pokeProps.exponent
    }

    if (this.isIndexGlowVisible || this.isThumbGlowVisible) {
      this.lastPinchProps.glowBrightness = pinchProps.glowBrightness
      this.lastPinchProps.glowColor.x = pinchProps.glowColor.x
      this.lastPinchProps.glowColor.y = pinchProps.glowColor.y
      this.lastPinchProps.glowColor.z = pinchProps.glowColor.z
      this.lastPinchProps.glowColor.w = pinchProps.glowColor.w
      this.lastPokeProps.glowBrightness = pokeProps.glowBrightness
      this.lastPokeProps.glowColor.x = pokeProps.glowColor.x
      this.lastPokeProps.glowColor.y = pokeProps.glowColor.y
      this.lastPokeProps.glowColor.z = pokeProps.glowColor.z
      this.lastPokeProps.glowColor.w = pokeProps.glowColor.w
      this.lastPokePinchBlend = pokePinchBlend
    }
  }

  private updateMaterialProperty<T>(pass: Pass, key: string, newValue: T, lastValue: T | undefined | null): void {
    if (newValue !== lastValue) {
      pass[key] = newValue
    }
  }

  private updateMaterialColorProperty(
    pass: Pass,
    key: string,
    newColor: vec4,
    lastColor: vec4 | undefined | null
  ): void {
    if (!lastColor || !newColor.equal(lastColor)) {
      pass[key] = newColor
    }
  }

  private applyBrightnessProps(pinchProps: PinchProperties, pokeProps: PokeProperties, pokePinchBlend: number): void {
    // Apply properties to the hand mesh materials
    if (this.isMeshVisibilityDesired) {
      const applyToHandPass = (pass0: Pass, pass1: Pass) => {
        this.updateMaterialProperty(
          pass0,
          "pokeOccludeGradientMaskPosition",
          pokeProps.occludeGradientMaskPosition,
          this.lastPokeProps.occludeGradientMaskPosition
        )

        this.updateMaterialProperty(pass1, "pinchBrightness", pinchProps.brightness, this.lastPinchProps.brightness)
        this.updateMaterialProperty(pass1, "pokeBrightness", pokeProps.brightness, this.lastPokeProps.brightness)
        this.updateMaterialProperty(pass1, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
        this.updateMaterialProperty(pass1, "pinchExponent", pinchProps.exponent, this.lastPinchProps.exponent)
        this.updateMaterialProperty(
          pass1,
          "pokeHighlightGradientMaskPosition",
          pokeProps.highlightGradientMaskPosition,
          this.lastPokeProps.highlightGradientMaskPosition
        )
        this.updateMaterialProperty(pass1, "pokeExponent", pokeProps.exponent, this.lastPokeProps.exponent)
      }

      const handMaterialFull = this.handVisuals.handMeshFull.mainMaterial
      if (handMaterialFull.getPassCount() > 1) {
        applyToHandPass(handMaterialFull.getPass(0), handMaterialFull.getPass(1))
      }

      const handMaterialIndexThumb = this.handVisuals.handMeshIndexThumb.mainMaterial
      if (handMaterialIndexThumb.getPassCount() > 1) {
        applyToHandPass(handMaterialIndexThumb.getPass(0), handMaterialIndexThumb.getPass(1))
      }
    }

    // Apply properties to the glow materials
    if (this.isIndexGlowVisible) {
      const indexGlowPass = this._indexGlowMaterial.mainPass
      this.updateMaterialProperty(
        indexGlowPass,
        "pinchGlowBrightness",
        pinchProps.glowBrightness,
        this.lastPinchProps.glowBrightness
      )
      this.updateMaterialProperty(
        indexGlowPass,
        "pokeGlowBrightness",
        pokeProps.glowBrightness,
        this.lastPokeProps.glowBrightness
      )
      this.updateMaterialProperty(indexGlowPass, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
    }

    if (this.isThumbGlowVisible) {
      const thumbGlowPass = this._thumbGlowMaterial.mainPass
      this.updateMaterialProperty(
        thumbGlowPass,
        "pinchGlowBrightness",
        pinchProps.glowBrightness,
        this.lastPinchProps.glowBrightness
      )
      this.updateMaterialProperty(thumbGlowPass, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
    }
  }

  private applyColorProps(pinchProps: PinchProperties, pokeProps: PokeProperties): void {
    // Apply to hand mesh materials
    if (this.isMeshVisibilityDesired) {
      const applyToHandPass = (pass: Pass) => {
        this.updateMaterialColorProperty(pass, "pinchColor", pinchProps.color, this.lastPinchProps.color)
        this.updateMaterialColorProperty(pass, "pokeColor", pokeProps.color, this.lastPokeProps.color)
      }

      const handMaterialFull = this.handVisuals.handMeshFull.mainMaterial
      if (handMaterialFull.getPassCount() > 1) {
        applyToHandPass(handMaterialFull.getPass(1))
      }

      const handMaterialIndexThumb = this.handVisuals.handMeshIndexThumb.mainMaterial
      if (handMaterialIndexThumb.getPassCount() > 1) {
        applyToHandPass(handMaterialIndexThumb.getPass(1))
      }
    }

    // Apply to glow materials
    if (this.isIndexGlowVisible) {
      for (let i = 0; i < this._indexGlowMaterial.getPassCount(); i++) {
        const pass = this._indexGlowMaterial.getPass(i)
        this.updateMaterialColorProperty(pass, "pinchGlowColor", pinchProps.glowColor, this.lastPinchProps.glowColor)
        this.updateMaterialColorProperty(pass, "pokeGlowColor", pokeProps.glowColor, this.lastPokeProps.glowColor)
      }
    }

    if (this.isThumbGlowVisible) {
      for (let i = 0; i < this._thumbGlowMaterial.getPassCount(); i++) {
        const pass = this._thumbGlowMaterial.getPass(i)
        this.updateMaterialColorProperty(pass, "pinchGlowColor", pinchProps.glowColor, this.lastPinchProps.glowColor)
        this.updateMaterialColorProperty(pass, "pokeGlowColor", pokeProps.glowColor, this.lastPokeProps.glowColor)
      }
    }
  }
}
