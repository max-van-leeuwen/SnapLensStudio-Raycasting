import SIKLogLevelProvider from "../../Providers/InteractionConfigurationProvider/SIKLogLevelProvider"
import {InteractionManager} from "../InteractionManager/InteractionManager"
import {LogLevelConfiguration} from "./LogLevelConfiguration"

/**
 * Allows the user to select the log level filter for SIK types from a lens studio component.
 */
@component
export class SIKLogLevelConfiguration extends LogLevelConfiguration {
  // TODO: Should we rename this back to Configuration? Or keep the debug logic in InteractionManager (which isn't a component)?
  private SIKLogLevelProvider = SIKLogLevelProvider.getInstance()
  private interactionManager = InteractionManager.getInstance()

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug Mode</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Enable visual debugging for all SIK Interactors and Interactables</span>'
  )

  /**
   * When enabled, activates debug mode for all SIK interactors, drawing visual gizmos to help
   * visualize raycasts, colliders, and interaction geometry in the scene.
   */
  @input
  @label("Debug Mode Enabled")
  @hint(
    "When enabled, activates debug mode for all SIK Interactors and Interactables, drawing visual gizmos to help visualize raycasts, \
colliders, and interaction geometry in the scene. Useful for troubleshooting interaction issues during development."
  )
  private _debugModeEnabled: boolean = false

  onAwake() {
    this.SIKLogLevelProvider.logLevel = this.logLevelFilter
    this.debugModeEnabled = this._debugModeEnabled
  }

  set debugModeEnabled(enabled: boolean) {
    this._debugModeEnabled = enabled

    this.interactionManager.debugModeEnabled = enabled
  }

  get debugModeEnabled(): boolean {
    return this._debugModeEnabled
  }
}
