import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { DispatcherMode } from './utils.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Utils,
    Tiling,
    Keybindings,
    Topbar,
    Minimap,
    Grab,
} from './imports.js';

import type { SignalMethods } from '@girs/gjs/gjs';

/**
  Navigation and previewing functionality.

  This is a somewhat messy tangle of functionality relying on
  `SwitcherPopup.SwitcherPopup` when we really should just take full control.
 */

const { signals: Signals } = imports;
const display = global.display;

let grab: Clutter.Grab | null;
let dispatcher: ActionDispatcher | null, signals: Utils.Signals | null;
export let navigator: NavigatorClass | null, navigating: boolean;

export function enable() {
    navigating = false;

    /* Stop navigation before/after overview. */
    signals = new Utils.Signals();
    signals.connect(Main.overview, 'showing', () => {
        finishNavigation();
    });
    signals.connect(Main.overview, 'hidden', () => {
        finishNavigation();
    });
}

export function disable() {
    navigating = false;
    grab = null;
    dispatcher = null;
    signals!.destroy();
    signals = null;
}

// Added to the prototype by Signals.addSignalMethods below
export interface NavigatorClass extends SignalMethods {}
export class NavigatorClass {
    was_accepted: boolean;
    space: Tiling.Space;
    _startWindow: Tiling.Window | null;
    from: Tiling.Space;
    monitor: Tiling.Monitor;
    minimaps: Map<Tiling.Space, Minimap.Minimap | number>;

    constructor() {
        console.debug('#navigator', 'nav created');

        navigating = true;

        this.was_accepted = false;

        this.space = Tiling.spaces.activeSpace;

        this._startWindow = this.space.selectedWindow;
        this.from = this.space;
        this.monitor = this.space.monitor!;
        this.monitor.clickOverlay!.hide();
        this.minimaps = new Map();

        Topbar.fixTopBar();

        this.space.startAnimate();
    }

    showMinimap(space: Tiling.Space) {
        let minimap = this.minimaps.get(space);
        if (!minimap) {
            const minimapId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                200,
                () => {
                    minimap = new Minimap.Minimap(space, this.monitor);
                    space.startAnimate();
                    minimap.show(false);
                    this.minimaps.set(space, minimap);
                    return GLib.SOURCE_REMOVE;
                }
            );
            this.minimaps.set(space, minimapId);
        } else {
            if (typeof minimap !== 'number') minimap.show();
        }
    }

    accept() {
        this.was_accepted = true;
    }

    finish(force = false) {
        if (!force && grab) {
            return;
        }

        this.accept();
        this.destroy();
    }

    destroy() {
        this.minimaps.forEach(m => {
            if (typeof m === 'number') {
                Utils.timeoutRemove(m);
            } else {
                m.destroy();
            }
        });

        if (Tiling.inGrab instanceof Grab.MoveGrab && !Tiling.inGrab.dnd) {
            Tiling.inGrab?.beginDnD();
        }

        navigating = false;

        const space = Tiling.spaces.selectedSpace;
        this.space = space;

        const from = this.from;
        let selected = this.space.selectedWindow;
        if (!this.was_accepted) {
            // Abort the navigation
            this.space = from;
            if (this._startWindow && this._startWindow.get_compositor_private())
                selected = this._startWindow;
            else selected = display.focus_window as Tiling.Window | null;
        }

        if (this.space !== from) {
            if (
                Tiling.inGrab instanceof Grab.MoveGrab &&
                Tiling.inGrab.window
            ) {
                this.space.activateWithFocus(Tiling.inGrab.window);
            } else {
                this.space.activate();
            }
        }

        selected =
            this.space.columnOf(selected!) !== -1
                ? selected
                : this.space.selectedWindow;

        if (selected && !Tiling.inGrab) {
            let hasFocus = selected.has_focus();
            selected.foreach_transient(mw => {
                hasFocus = mw.has_focus() || hasFocus;
                return true;
            });
            if (hasFocus) {
                Tiling.focusHandler(selected);
            } else {
                Main.activateWindow(selected);
            }
        }
        if (selected && Tiling.inGrab && !this.was_accepted) {
            Tiling.focusHandler(selected);
        }
        if (selected) {
            Tiling.maybeWarpPointerToWindow(selected);
        }

        Topbar.fixTopBar();

        this.space.moveDone();

        this.emit('destroy', this.was_accepted);
        navigator = null;
    }
}
Signals.addSignalMethods(NavigatorClass.prototype);
export const Navigator = NavigatorClass;

export function primaryModifier(mask: number) {
    if (mask === 0) return 0;

    let primary = 1;
    while (mask > 1) {
        mask >>= 1;
        primary <<= 1;
    }
    return primary;
}

/**
   Handle catching keyevents and dispatching actions

   Adapted from SwitcherPopup, without any visual handling.
 */
export class ActionDispatcher {
    /** DispatcherMode bitmask */
    mode: number = DispatcherMode.NONE;

    signals: Utils.Signals;
    actor: Meta.BackgroundGroup;
    navigator: NavigatorClass;
    keyPressCallbacks: ((
        modmask: number,
        keysym: number,
        event: Clutter.Event
    ) => boolean)[] = [];
    keyReleaseCallbacks: (() => void)[] = [];
    _noModsTimeoutId: number | null = null;
    _doActionTimeout: number | null = null;
    _modifierMask: number | null = null;
    _destroy = false;

    constructor() {
        console.debug('#dispatch', 'created');
        this.signals = new Utils.Signals();
        this.actor = Tiling.spaces.spaceContainer;
        this.actor.reactive = true;
        this.navigator = getNavigator();

        if (grab) {
            console.debug('#dispatch', 'already in grab');
            return;
        }

        grab = Main.pushModal(this.actor);
        if (!grab) {
            console.error('Failed to grab modal');
            throw new Error('Could not grab modal');
        }

        this.signals.connect(
            this.actor,
            'key-press-event',
            this._keyPressEvent.bind(this)
        );
        this.signals.connect(
            this.actor,
            'key-release-event',
            this._keyReleaseEvent.bind(this)
        );
    }

    /**
     * Adds a signal to this dispatcher.  Will be destroyed when this
     * dispatcher is destroyed.
     */
    addKeypressCallback(
        handler: (
            modmask: number,
            keysym: number,
            event: Clutter.Event
        ) => boolean
    ) {
        this.keyPressCallbacks.push(handler);
        return this;
    }

    /**
     * Adds a signal to this dispatcher.  Will be destroyed when this
     * dispatcher is destroyed.
     */
    addKeyReleaseCallback(handler: () => void) {
        this.keyReleaseCallbacks.push(handler);
        return this;
    }

    show(_isReversed: boolean, bindingName: string, bindingMask: number) {
        this._modifierMask = primaryModifier(bindingMask);
        this.navigator = getNavigator();
        Topbar.fixTopBar();
        let actionId = Keybindings.idOf(bindingName);
        if (actionId === Meta.KeyBindingAction.NONE) {
            try {
                // Check for built-in actions
                actionId = Meta.prefs_get_keybinding_action(bindingName);
            } catch (e) {
                console.debug("Couldn't resolve action name: ", e);
                return false;
            }
        }

        this._doAction(actionId);

        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (straight from SwitcherPopup)
        if (this._modifierMask) {
            const [, , mods] = global.get_pointer();
            if (!(mods & this._modifierMask)) {
                this._finish(global.get_current_time());
                return false;
            }
        } else {
            this._resetNoModsTimeout();
        }

        return true;
    }

    _resetNoModsTimeout() {
        Utils.timeoutRemove(this._noModsTimeoutId);
        this._noModsTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            0,
            () => {
                this._finish(global.get_current_time());
                this._noModsTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _keyPressEvent(_actor: Clutter.Actor, event: Clutter.Event) {
        if (!this._modifierMask) {
            this._modifierMask = primaryModifier(event.get_state());
        }
        const keysym = event.get_key_symbol();
        const action = global.display.get_keybinding_action(
            event.get_key_code(),
            event.get_state()
        );

        // run callbacks and if any return true, stop bubbling
        if (
            this.keyPressCallbacks.some(callback => {
                return callback(this._modifierMask!, keysym, event);
            })
        ) {
            return Clutter.EVENT_STOP;
        }

        // Popping the modal on keypress doesn't work properly, as the release
        // event will leak to the active window. To work around this we initate
        // visual destruction on key-press and signal to the release handler
        // that we should destroy the dispactcher too
        // https://github.com/paperwm/PaperWM/issues/70
        if (keysym === Clutter.KEY_Escape) {
            this._destroy = true;
            getNavigator().accept();
            getNavigator().destroy();
            return Clutter.EVENT_STOP;
        }

        this._doAction(action);

        return Clutter.EVENT_STOP;
    }

    _keyReleaseEvent(_actor: Clutter.Actor, event: Clutter.Event) {
        if (this._destroy) {
            dismissDispatcher(DispatcherMode.KEYBOARD);
        }

        if (this._modifierMask) {
            const [, , mods] = global.get_pointer();
            const state = mods & this._modifierMask;

            if (state === 0) this._finish(event.get_time());
        } else {
            this._resetNoModsTimeout();
        }

        this.keyReleaseCallbacks.forEach(callback => callback());
        return Clutter.EVENT_STOP;
    }

    _doAction(mutterActionId: number | Meta.KeyBindingAction) {
        const action = Keybindings.byId(mutterActionId);
        const space = Tiling.spaces.selectedSpace;
        const metaWindow = space.selectedWindow;
        const nav = getNavigator();

        if (mutterActionId === Meta.KeyBindingAction.MINIMIZE) {
            metaWindow?.minimize();
        } else if (action && action.options.activeInNavigator) {
            // action is performed while navigator is open (e.g. focus-column-left)
            if (
                !metaWindow &&
                action.options.mutterFlags! & Meta.KeyBindingFlags.PER_WINDOW
            ) {
                return;
            }

            if (!Tiling.inGrab && action.options.opensMinimap) {
                nav.showMinimap(space);
            }
            action.handler(metaWindow!, space, { navigator: this.navigator });
            if (space !== Tiling.spaces.selectedSpace) {
                this.navigator.minimaps.forEach(m =>
                    typeof m === 'number' ? Utils.timeoutRemove(m) : m.hide()
                );
            }
            if (
                Tiling.inGrab instanceof Grab.MoveGrab &&
                !Tiling.inGrab.dnd &&
                Tiling.inGrab.window
            ) {
                Tiling.inGrab.beginDnD();
            }
        } else if (action) {
            // closes navigator and action is performed afterwards
            // (e.g. focus-monitor-left)
            this._resetNoModsTimeout();
            this._doActionTimeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                0,
                () => {
                    action.handler(metaWindow!, space);
                    this._doActionTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _finish(_timestamp: number) {
        const nav = getNavigator();
        nav.accept();
        if (!this._destroy) nav.destroy();
        dismissDispatcher(DispatcherMode.KEYBOARD);
    }

    destroy() {
        Utils.timeoutRemove(this._noModsTimeoutId);
        Utils.timeoutRemove(this._doActionTimeout);

        try {
            if (grab) {
                Main.popModal(grab);
                grab = null;
            }
        } catch (e) {
            console.debug('Failed to release grab: ', e);
        }

        this.actor.reactive = false;
        this.signals.destroy();
        // We have already destroyed the navigator
        getNavigator().destroy();
        dispatcher = null;
    }
}

export function getNavigator() {
    if (navigator) return navigator;

    navigator = new Navigator();
    return navigator;
}

/**
 * Finishes navigation if navigator exists.
 * Useful to call before disabling other modules.
 */
export function finishNavigation(force = true) {
    if (navigator) {
        navigator.finish(force);
    }
}

/**
 * @param mode - DispatcherMode bitmask
 */
export function getActionDispatcher(mode: number): ActionDispatcher {
    if (dispatcher) {
        dispatcher.mode |= mode;
        return dispatcher;
    }
    dispatcher = new ActionDispatcher();
    return getActionDispatcher(mode);
}

/**
 * Fishes current dispatcher (if any).
 */
export function finishDispatching() {
    dispatcher?._finish(global.get_current_time());
}

/**
 * @param mode - DispatcherMode bitmask
 */
export function dismissDispatcher(mode: number) {
    if (!dispatcher) {
        return;
    }

    dispatcher.mode ^= mode;
    if (dispatcher.mode === DispatcherMode.NONE) {
        dispatcher.destroy();
    }
}

export function previewNavigate(
    _metaWindow: Meta.Window | null,
    _space: Tiling.Space | null,
    options?: { binding?: Keybindings.KeyBindingLike }
) {
    const binding = options!.binding!;
    const tabPopup = getActionDispatcher(DispatcherMode.KEYBOARD);
    tabPopup.show(
        binding.is_reversed(),
        binding.get_name(),
        binding.get_mask()
    );
}
