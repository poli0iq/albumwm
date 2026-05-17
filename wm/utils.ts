import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Ripples from 'resource:///org/gnome/shell/ui/ripples.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import type GObject from 'gi://GObject?version=2.0';
import type St from 'gi://St';
import type { Monitor } from 'resource:///org/gnome/shell/ui/layout.js';

const Display = global.display;
export const version = Config.PACKAGE_VERSION.split('.').map(Number);

let warpRipple: Ripples.Ripples | null;

let touchSignals: Signals | null = null;
let touchCoords: [number, number] | undefined;
let inTouch = false;

export class Signals extends Map<GObject.Object, number[]> {
    static get [Symbol.species]() {
        return Map;
    }

    _getOrCreateSignals(object: GObject.Object) {
        let signals = this.get(object);
        if (!signals) {
            signals = [];
            this.set(object, signals);
        }
        return signals;
    }

    connectOneShot(
        object: GObject.Object,
        signal: string,
        handler: Parameters<GObject.Object['connect']>[1]
    ) {
        const id = this.connect(object, signal, (...args) => {
            this.disconnect(object, id);
            return handler(...args);
        });
    }

    connect(
        object: GObject.Object,
        signal: string,
        handler: Parameters<GObject.Object['connect']>[1]
    ): number {
        const id = object.connect(signal, handler);
        const signals = this._getOrCreateSignals(object);
        signals.push(id);
        return id;
    }

    disconnect(object: GObject.Object, id: number | null = null) {
        const ids = this.get(object);
        if (!ids) return;
        if (id === null) {
            for (const sigId of ids) object.disconnect(sigId);
            this.delete(object);
            return;
        }
        object.disconnect(id);
        const i = ids.indexOf(id);
        if (i > -1) ids.splice(i, 1);
        if (ids.length === 0) this.delete(object);
    }

    destroy() {
        for (const [object, signals] of this) {
            for (const id of signals) object.disconnect(id);
            this.delete(object);
        }
    }
}

export function enable() {
    warpRipple = new Ripples.Ripples(0.5, 0.5, 'ripple-pointer-location');
    // @ts-expect-error @girs types addTo's argument as Clutter.Stage, but
    // in the actual gnome-shell code it just does stage.add_child(),
    // and even upstream gnome-shell itself passes uiGroup here.
    warpRipple.addTo(Main.layoutManager.uiGroup);

    touchSignals = new Signals();
    touchSignals.connect(
        global.stage,
        'touch-event',
        (_actor: Clutter.Actor, event: Clutter.Event) => {
            switch (event.type()) {
                case Clutter.EventType.TOUCH_BEGIN:
                case Clutter.EventType.TOUCH_UPDATE:
                    inTouch = true;
                    break;
                case Clutter.EventType.TOUCH_END:
                case Clutter.EventType.TOUCH_CANCEL:
                    inTouch = false;
                    break;
                default:
                    return Clutter.EVENT_PROPAGATE;
            }

            // was one of our touch events
            touchCoords = event.get_coords();
            return Clutter.EVENT_PROPAGATE;
        }
    );
}

export function disable() {
    warpRipple!.destroy();
    warpRipple = null;

    touchSignals!.destroy();
    touchSignals = null;
}

export function assert(
    condition: unknown,
    message: string,
    options?: ErrorOptions
): asserts condition {
    if (!condition) {
        throw new Error(`${message}\n`, options);
    }
}

/**
 * Internal mode tracking for ActionDispatcher.
 * Tracks whether the dispatcher was requested for keyboard, pointer, or both.
 * Replaces the removed Clutter.GrabState enum (GNOME 50+).
 */
export const DispatcherMode = { NONE: 0, POINTER: 1, KEYBOARD: 2 };

/**
 * Legacy wrapper, was used for falling back to Clutter.Color.
 * TODO: drop
 */
export function colorFromString(colorString: string) {
    return Cogl.Color.from_string(colorString);
}

export function isInRect(x: number, y: number, r: Monitor) {
    return r.x <= x && x < r.x + r.width && r.y <= y && y < r.y + r.height;
}

/**
 * Retrieves global pointer coordinates taking into account touch screen events.
 * May not work for continuous tracking, see #766.
 */
export function getPointerCoords(): [number, number] {
    if (inTouch) {
        // Safe: touchCoords is set by the same handler that flips inTouch
        return touchCoords!;
    } else {
        const [x, y] = global.get_pointer();
        return [x, y];
    }
}

/**
 * Returns monitor a pointer co-ordinates.
 */
export function monitorAtPoint(gx: number, gy: number) {
    for (const monitor of Main.layoutManager.monitors) {
        if (isInRect(gx, gy, monitor)) return monitor;
    }
    return null;
}

/**
 * Returns the monitor current pointer coordinates.
 */
export function monitorAtCurrentPoint() {
    const [gx, gy] = getPointerCoords();
    return monitorAtPoint(gx, gy);
}

/**
 * Warps pointer to the center of a monitor.
 */
export function warpPointerToMonitor(
    monitor: Monitor,
    params = { center: false, ripple: true }
) {
    const center = params?.center ?? false;
    const ripple = params?.ripple ?? true;

    // no need to warp if already on this monitor
    const currMonitor = monitorAtCurrentPoint();
    if (!currMonitor || currMonitor === monitor) {
        return;
    }

    const [x, y] = global.get_pointer();
    if (center) {
        warpPointer(
            monitor.x + Math.floor(monitor.width / 2),
            monitor.y + Math.floor(monitor.height / 2),
            ripple
        );
        return;
    }

    const proportionalX = (x - currMonitor.x) / currMonitor.width;
    const proportionalY = (y - currMonitor.y) / currMonitor.height;
    warpPointer(
        monitor.x + Math.floor(proportionalX * monitor.width),
        monitor.y + Math.floor(proportionalY * monitor.height),
        ripple
    );
}

/**
 * Warps pointer to x, y coordinates.
 * Optionally shows a ripple effect after warp.
 */
export function warpPointer(x: number, y: number, ripple = true) {
    const seat = Clutter.get_default_backend().get_default_seat();
    seat.warp_pointer(x, y);
    if (ripple) {
        warpRipple!.playAnimation(x, y);
    }
}

/**
 * Return current modifiers state (or'ed Clutter.ModifierType.*)
 */
export function getModiferState() {
    const [, , mods] = global.get_pointer();
    return mods;
}

export function monitorOfPoint(x: number, y: number) {
    // get_monitor_index_for_rect "helpfully" returns the primary monitor index for out of bounds rects..
    for (const monitor of Main.layoutManager.monitors) {
        if (
            monitor.x <= x &&
            x <= monitor.x + monitor.width &&
            monitor.y <= y &&
            y <= monitor.y + monitor.height
        ) {
            return monitor;
        }
    }

    return null;
}

export function actorRaise(actor: Clutter.Actor, above?: Clutter.Actor) {
    const parent = actor.get_parent();
    if (!parent) {
        return;
    }
    // needs to be null (not undefined) for valid second argument
    parent.set_child_above_sibling(actor, above ?? null);
}

export function actorReparent(actor: Clutter.Actor, newParent: St.Widget) {
    actorRemoveParent(actor);
    newParent.add_child(actor);
}

/**
 * Removes a child from a parent actor.  Checks child
 * exists in parent first.
 */
export function actorRemoveChild(parent: Clutter.Actor, child: Clutter.Actor) {
    if (parent.get_children().includes(child)) {
        parent.remove_child(child);
    }
}

/**
 * Removes the parent from this actor (if it has one).
 */
export function actorRemoveParent(actor: Clutter.Actor) {
    const parent = actor.get_parent();
    if (parent) {
        parent.remove_child(actor);
    }
}

/**
 * Adds a child from a parent actor.  Checks child if is already
 * attached.
 */
export function actorAddChild(parent: Clutter.Actor, child: Clutter.Actor) {
    // check if already a child of this parent
    if (parent.get_children().includes(child)) {
        return;
    }

    actorRemoveParent(child);
    parent.add_child(child);
}

/**
 * Backwards compatible (no longer) later_add function.
 * TODO: remove
 */
export function laterAdd(when: Meta.LaterType, func: GLib.SourceFunc) {
    global.compositor.get_laters().add(when, func);
}

/**
 * Legacy Display.grab_accelerator wrapper that was providing a fallback
 * to the old one-argument version.
 * TODO: remove
 */
export function grabAccelerator(
    keystr: string,
    keyBindingFlags = Meta.KeyBindingFlags.NONE
) {
    return Display.grab_accelerator(keystr, keyBindingFlags);
}

/**
 * Convenience method for removing timeout source(s) from Mainloop.
 */
export function timeoutRemove(...timeouts: (number | null)[]) {
    timeouts.forEach(t => {
        if (t) {
            GLib.source_remove(t);
        }
    });
}

/**
 * Specifies timeout options for periodicTimeout().
 * Also contains parameters for init (call for initialisation),
 * onContinue (callback when continuing),
 * onComplete (callback when completed last callback).
 */
export type TimeoutOptions = {
    period_ms?: number;
    count?: number;
    init?: (..._args: unknown[]) => unknown;
    callback?: (..._args: unknown[]) => unknown;
    onContinue?: (..._args: unknown[]) => unknown;
    onComplete?: (..._args: unknown[]) => unknown;
};

/**
 * Calls a period timeout (GLib.timeout_add) that calls a callback function.
 * Accepts a TimeoutOptions parameter.
 */
export function periodicTimeout(options?: TimeoutOptions) {
    const operiod = options?.period_ms ?? 1000;
    const ocount = options?.count ?? 1;
    const oinit = options?.init ?? function () {};
    const ocallback = options?.callback ?? function () {};
    const ocontinue = options?.onContinue ?? function () {};
    const ocomplete = options?.onComplete ?? function () {};

    oinit();
    let called = 0;
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, operiod, () => {
        // check for early exit (if callback returns false)
        if (ocallback() === false) {
            ocomplete();
            return false;
        }

        if (called < ocount) {
            called++;
            ocontinue(called);
            return true;
        }

        ocomplete();
        return false; // on return false destroys timeout
    });
}

/**
 * Note the name 'Tweener' used previously was just a legacy name, we're actually using
 * Widget.ease here.  This was renamed to avoid confusion with the deprecated `Tweener`
 * module.
 */
export const Easer = {
    /**
     * Safer time setting to essentiall disable easer animation.
     * Setting to values lower than this can have some side-effects
     * like "jumpy" three-finger left/right swiping etc.
     */
    ANIMATION_SAFE_TIME: 0.03,

    /**
     * Can set animation to instant time.  Used for to override animation
     * time to effectively "disable" an animation.  Setting to 0 can have
     * some side-effects and cause race aconditions
     */
    ANIMATION_INSTANT_TIME: 0.0001,

    addEase(
        actor: Clutter.Actor,
        params: Parameters<Clutter.Actor['ease']>[0] & {
            time?: number;
            instant?: boolean;
        }
    ) {
        if (params.time) {
            params.duration = this._safeDuration(params.time, params.instant);
            delete params.time;
        }

        if (!params.mode) {
            params.mode = Clutter.AnimationMode.EASE_IN_OUT_QUAD;
        }

        actor.ease(params);
    },

    /**
     * Returns a safe animation time to avoid timing
     * race conditions etc.
     */
    _safeDuration(time: number, instant?: boolean) {
        let duration = Math.max(time, this.ANIMATION_SAFE_TIME);
        if (instant) {
            duration = this.ANIMATION_INSTANT_TIME;
        }

        return duration * 1000;
    },

    removeEase(actor: Clutter.Actor) {
        actor.remove_all_transitions();
    },

    isEasing(actor: Clutter.Actor) {
        return (
            actor.get_transition('x') ||
            actor.get_transition('y') ||
            actor.get_transition('scale-x') ||
            actor.get_transition('scale-x')
        );
    },
};
