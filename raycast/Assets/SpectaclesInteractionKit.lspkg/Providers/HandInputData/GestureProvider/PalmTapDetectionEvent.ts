/**
 * Describes the state of Palm Tap API
 *
 * @deprecated as PalmTap interactions are being deprecated to ensure consistent system-level interactions
 * and prevent conflicts with core OS functionality. This gesture is now reserved for system navigation
 * and accessibility features. Please consider alternative interaction patterns such as pinch gestures,
 * air tap, or voice commands for your application's user interface.
 */
export type PalmTapDetectionEvent =
  | {
      state: "unsupported"
    }
  | {
      state: "available"
      data: {isTapping: boolean}
    }
