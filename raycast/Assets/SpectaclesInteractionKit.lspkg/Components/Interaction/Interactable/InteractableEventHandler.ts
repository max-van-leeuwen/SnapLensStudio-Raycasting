import {InteractorInputType} from "../../../Core/Interactor/Interactor"

/**
 * Minimum fields required from event arguments for the handler to process events.
 * The generic type parameter allows the full event type to flow through to callbacks.
 */
export type InteractableEventHandlerArgs = {
  interactor: {
    inputType: InteractorInputType
    currentDragVector: vec3 | null
    previousDragVector: vec3 | null
    planecastDragVector: vec3 | null
  }
  connectionId?: string | null
}

/**
 * Extended args for drag events.
 */
export type DragEventArgs<T extends InteractableEventHandlerArgs> = T & {
  dragVector: vec3
}

/**
 * Callbacks that the event handler will invoke.
 * Generic type T allows the full event args to flow through.
 */
export type InteractableEventCallbacks<T extends InteractableEventHandlerArgs> = {
  // Local hover events
  onHoverEnter: (args: T) => void
  onInteractorHoverEnter: (args: T) => void
  onHoverUpdate: (args: T) => void
  onInteractorHoverExit: (args: T) => void
  onHoverExit: (args: T) => void

  // Local trigger events
  onTriggerStart: (args: T) => void
  onInteractorTriggerStart: (args: T) => void
  onTriggerUpdate: (args: T) => void
  onInteractorTriggerEnd: (args: T) => void
  onTriggerEnd: (args: T) => void
  onInteractorTriggerEndOutside: (args: T) => void
  onTriggerEndOutside: (args: T) => void
  onTriggerCanceled: (args: T) => void

  // Drag events
  onDragStart: (args: DragEventArgs<T>) => void
  onDragUpdate: (args: DragEventArgs<T>) => void
  onDragEnd: (args: DragEventArgs<T>) => void

  // Sync versions (for remote user events)
  onSyncHoverEnter: (args: T) => void
  onSyncInteractorHoverEnter: (args: T) => void
  onSyncHoverUpdate: (args: T) => void
  onSyncInteractorHoverExit: (args: T) => void
  onSyncHoverExit: (args: T) => void
  onSyncTriggerStart: (args: T) => void
  onSyncInteractorTriggerStart: (args: T) => void
  onSyncTriggerUpdate: (args: T) => void
  onSyncInteractorTriggerEnd: (args: T) => void
  onSyncTriggerEnd: (args: T) => void
  onSyncInteractorTriggerEndOutside: (args: T) => void
  onSyncTriggerEndOutside: (args: T) => void
  onSyncTriggerCanceled: (args: T) => void
  onSyncDragStart: (args: DragEventArgs<T>) => void
  onSyncDragUpdate: (args: DragEventArgs<T>) => void
  onSyncDragEnd: (args: DragEventArgs<T>) => void
}

/**
 * Manages the event handling logic for Interactables:
 * - Tracking which interactors are hovering/triggering (via bitflags)
 * - Determining compound events (first hover vs additional hover)
 * - Connection ID filtering for multi-user scenarios
 * - Local vs sync event routing
 *
 * The generic type T allows the full event args type to flow through
 * to callbacks while the handler only accesses the fields it needs.
 */
export class InteractableEventHandler<T extends InteractableEventHandlerArgs> {
  private _hoveringInteractor: InteractorInputType = InteractorInputType.None
  private _triggeringInteractor: InteractorInputType = InteractorInputType.None
  private _triggeringConnectionId: string | null = null

  private readonly callbacks: InteractableEventCallbacks<T>
  private readonly getLocalConnectionId: () => string | null

  constructor(callbacks: InteractableEventCallbacks<T>, getLocalConnectionId: () => string | null) {
    this.callbacks = callbacks
    this.getLocalConnectionId = getLocalConnectionId
  }

  get hoveringInteractor(): InteractorInputType {
    return this._hoveringInteractor
  }

  get triggeringInteractor(): InteractorInputType {
    return this._triggeringInteractor
  }

  get triggeringConnectionId(): string | null {
    return this._triggeringConnectionId
  }

  hoverEnter(eventArgs: T): void {
    const isLocal = this.isLocalEvent(eventArgs)

    if (this._hoveringInteractor === InteractorInputType.None) {
      ;(isLocal ? this.callbacks.onHoverEnter : this.callbacks.onSyncHoverEnter)(eventArgs)
    }

    this._hoveringInteractor |= eventArgs.interactor.inputType
    ;(isLocal ? this.callbacks.onInteractorHoverEnter : this.callbacks.onSyncInteractorHoverEnter)(eventArgs)
  }

  hoverUpdate(eventArgs: T): void {
    if (this._hoveringInteractor === InteractorInputType.None) {
      return
    }

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onHoverUpdate : this.callbacks.onSyncHoverUpdate)(eventArgs)
  }

  hoverExit(eventArgs: T): void {
    this._hoveringInteractor &= ~eventArgs.interactor.inputType

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onInteractorHoverExit : this.callbacks.onSyncInteractorHoverExit)(eventArgs)

    if (this._hoveringInteractor === InteractorInputType.None) {
      ;(isLocal ? this.callbacks.onHoverExit : this.callbacks.onSyncHoverExit)(eventArgs)
    }
  }

  triggerStart(eventArgs: T): void {
    // Lock to first triggering connection
    if (this._triggeringConnectionId === null) {
      this._triggeringConnectionId = eventArgs.connectionId ?? null
    } else if (this._triggeringConnectionId !== eventArgs.connectionId) {
      return
    }

    const isLocal = this.isLocalEvent(eventArgs)

    if (this._triggeringInteractor === InteractorInputType.None) {
      ;(isLocal ? this.callbacks.onTriggerStart : this.callbacks.onSyncTriggerStart)(eventArgs)
    }

    this._triggeringInteractor |= eventArgs.interactor.inputType
    ;(isLocal ? this.callbacks.onInteractorTriggerStart : this.callbacks.onSyncInteractorTriggerStart)(eventArgs)
  }

  triggerUpdate(eventArgs: T): void {
    // Normalize connectionId to handle null vs undefined consistently
    const normalizedConnectionId = eventArgs.connectionId ?? null
    if (this._triggeringConnectionId !== normalizedConnectionId) {
      return
    }

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onTriggerUpdate : this.callbacks.onSyncTriggerUpdate)(eventArgs)

    this.dragStartOrUpdate(eventArgs)
  }

  triggerEnd(eventArgs: T): void {
    if (!this.validateAndClearConnection(eventArgs)) {
      return
    }

    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onInteractorTriggerEnd : this.callbacks.onSyncInteractorTriggerEnd)(eventArgs)

    if (this._triggeringInteractor === InteractorInputType.None) {
      ;(isLocal ? this.callbacks.onTriggerEnd : this.callbacks.onSyncTriggerEnd)(eventArgs)
    }

    this.dragEnd(eventArgs)
  }

  triggerEndOutside(eventArgs: T): void {
    if (!this.validateAndClearConnection(eventArgs)) {
      return
    }

    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onInteractorTriggerEndOutside : this.callbacks.onSyncInteractorTriggerEndOutside)(
      eventArgs
    )

    if (this._triggeringInteractor === InteractorInputType.None) {
      ;(isLocal ? this.callbacks.onTriggerEndOutside : this.callbacks.onSyncTriggerEndOutside)(eventArgs)
    }

    this.dragEnd(eventArgs)
  }

  triggerCanceled(eventArgs: T): void {
    if (!this.validateAndClearConnection(eventArgs)) {
      return
    }

    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onTriggerCanceled : this.callbacks.onSyncTriggerCanceled)(eventArgs)

    this.dragEnd(eventArgs)
  }

  reset(): void {
    this._hoveringInteractor = InteractorInputType.None
    this._triggeringInteractor = InteractorInputType.None
    this._triggeringConnectionId = null
  }

  /**
   * Validates connection ID matches and clears it. Returns false if validation fails.
   */
  private validateAndClearConnection(eventArgs: T): boolean {
    // Normalize connectionId to handle null vs undefined consistently
    const normalizedConnectionId = eventArgs.connectionId ?? null
    if (this._triggeringConnectionId === normalizedConnectionId) {
      this._triggeringConnectionId = null
      return true
    }
    return false
  }

  private dragStartOrUpdate(eventArgs: T): void {
    const currentDrag = eventArgs.interactor.currentDragVector
    if (currentDrag === null) {
      return
    }

    const isLocal = this.isLocalEvent(eventArgs)
    const dragArgs = {...eventArgs, dragVector: currentDrag} as DragEventArgs<T>

    if (eventArgs.interactor.previousDragVector === null) {
      ;(isLocal ? this.callbacks.onDragStart : this.callbacks.onSyncDragStart)(dragArgs)
    } else {
      ;(isLocal ? this.callbacks.onDragUpdate : this.callbacks.onSyncDragUpdate)(dragArgs)
    }
  }

  private dragEnd(eventArgs: T): void {
    const previousDrag = eventArgs.interactor.previousDragVector
    if (previousDrag === null) {
      return
    }

    const isLocal = this.isLocalEvent(eventArgs)
    ;(isLocal ? this.callbacks.onDragEnd : this.callbacks.onSyncDragEnd)({
      ...eventArgs,
      dragVector: previousDrag
    } as DragEventArgs<T>)
  }

  private isLocalEvent(eventArgs: T): boolean {
    const localId = this.getLocalConnectionId()
    return !eventArgs.connectionId || localId === eventArgs.connectionId
  }
}
