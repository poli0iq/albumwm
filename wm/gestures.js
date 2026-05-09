import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Patches, Settings, Tiling, Utils, Lib, Navigator } from './imports.js';
import { Easer } from './utils.js';

const DIRECTIONS = {
    Horizontal: true,
    Vertical: false,
};

let navigator, direction, signals;
// 1 is natural scrolling, -1 is unnatural
let natural = 1;
export let gliding = false; // exported

let touchpadSettings;
export function enable(extension) {
    signals = new Utils.Signals();

    touchpadSettings = new Gio.Settings({
        schema_id: 'org.gnome.desktop.peripherals.touchpad',
    });

    // monitor gesture-enabled for changes
    const gsettings = extension.getSettings();
    signals.connect(gsettings, 'changed::gesture-enabled', () => {
        gestureEnabled() ? swipeTrackersEnable(false) : swipeTrackersEnable();
    });

    /**
     * Swipetrackers are reset by gnome during overview, once exits overview
     * ensure swipe trackers are reset.
     */
    signals.connect(Main.overview, 'hidden', () => {
        if (gestureEnabled()) {
            swipeTrackersEnable(false);
        }
    });

    /*
     * Stage-level capture so 3-finger swipes are seen no matter what's under
     * the cursor. The handler only sets up state on BEGIN; horizontal
     * scrolling is delegated to each space.background via horizontalScroll.
     */
    signals.connect(global.stage, 'captured-event', (actor, event) => {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE) {
            return Clutter.EVENT_PROPAGATE;
        }

        const fingers = event.get_touchpad_gesture_finger_count();
        if (fingers <= 2 || (Main.actionMode & Shell.ActionMode.OVERVIEW) > 0) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (!gestureEnabled()) {
            swipeTrackersEnable();
        }

        if (event.get_gesture_phase() === Clutter.TouchpadGesturePhase.BEGIN) {
            if (shouldPropagate(fingers)) {
                return Clutter.EVENT_PROPAGATE;
            }
            natural = touchpadSettings.get_boolean('natural-scroll') ? 1 : -1;
            direction = undefined;
            navigator = Navigator.getNavigator();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

function shouldPropagate(fingers) {
    if (
        // gestures disabled ==> gnome default behaviour
        !gestureEnabled()
    ) {
        swipeTrackersEnable();
        return true;
    } else if (fingers === 3 && gestureHorizontalFingers() !== 3) {
        swipeTrackersEnable();
        return true;
    } else if (
        // if gesure enabled AND finger 4 AND horizontal finger != 4
        fingers === 4 &&
        gestureHorizontalFingers() !== 4
    ) {
        return true;
    } else {
        return false;
    }
}

export function disable() {
    signals.destroy();
    signals = null;
    touchpadSettings = null;
}

export function gestureEnabled() {
    return Settings.prefs.gesture_enabled;
}

export function gestureHorizontalFingers() {
    return Settings.prefs.gesture_horizontal_fingers;
}

/**
   Handle scrolling horizontally in a space. The handler is meant to be
   connected from each space.background and bound to the space.
 */
let start,
    dxs = [],
    dts = [];
export function horizontalScroll(space, _actor, event) {
    if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE) {
        return Clutter.EVENT_PROPAGATE;
    }

    const fingers = event.get_touchpad_gesture_finger_count();
    if (fingers <= 2 || gestureHorizontalFingers() !== fingers) {
        return Clutter.EVENT_PROPAGATE;
    } else if (
        /**
         * If gestures are disabled AND doing a 3-finger swipe (gnome default)
         * AND horizontal fingers are set to 3, then propagate.
         */
        !gestureEnabled() &&
        fingers === 3
    ) {
        return Clutter.EVENT_PROPAGATE;
    }

    const phase = event.get_gesture_phase();
    const [dx] = event.get_gesture_motion_delta();
    switch (phase) {
        case Clutter.TouchpadGesturePhase.UPDATE:
            if (
                direction !== undefined &&
                direction !== DIRECTIONS.Horizontal
            ) {
                return Clutter.EVENT_PROPAGATE;
            }

            if (direction === undefined) {
                space.vx = 0;
                dxs = [];
                dts = [];
                space.hState = phase;
                start = space.targetX;
                Easer.removeEase(space.cloneContainer);
                direction = DIRECTIONS.Horizontal;
            }
            return update(
                space,
                -dx * natural * Settings.prefs.swipe_sensitivity[0],
                event.get_time()
            );
        case Clutter.TouchpadGesturePhase.CANCEL:
        case Clutter.TouchpadGesturePhase.END:
            if (direction !== DIRECTIONS.Horizontal) {
                return Clutter.EVENT_PROPAGATE;
            }
            space.hState = phase;
            done(space, event);
            dxs = [];
            dts = [];
            direction = undefined;
            return Clutter.EVENT_STOP;
    }
}

/**
   Handle scrolling horizontally using a touchscreen. This handler is meant to
   be connected to the global Panel and recreated every time the active space
   is changed.
 */
let walk = 0;
let sdx = null;
export function horizontalTouchScroll(_actor, event) {
    const type = event.type();
    const [myx] = event.get_coords();

    switch (type) {
        case Clutter.EventType.TOUCH_BEGIN:
            this.vx = 0;
            dxs = [];
            dts = [];
            sdx = myx;
            walk = 0;
            start = this.targetX;
            this.hState = Clutter.TouchpadGesturePhase.UPDATE;
            Easer.removeEase(this.cloneContainer);
            navigator = Navigator.getNavigator();
            direction = DIRECTIONS.Horizontal;
            update(this, 0, event.get_time());
            return Clutter.EVENT_PROPAGATE;
        case Clutter.EventType.TOUCH_UPDATE: {
            let dx = 0;
            if (sdx !== null) {
                dx = myx - sdx;
            }
            sdx = myx;
            walk += Math.abs(dx);

            /**
             * Here, we ignore the friction setting and reduce the reported time
             * scale, because the distances involved on a touch screen would make
             * the flick motion as understood by the trackpad handler impractical.
             */
            update(this, -dx, event.get_time() * 0.75);
            return Clutter.EVENT_PROPAGATE;
        }
        case Clutter.EventType.TOUCH_CANCEL:
        case Clutter.EventType.TOUCH_END:
            done(this, event);
            dxs = [];
            dts = [];
            sdx = null;
            walk = 0;
            this.hState = Clutter.TouchpadGesturePhase.END;
            if (walk < 20)
                return Clutter.EVENT_PROPAGATE; // Don't steal non-swipe events
            else return Clutter.EVENT_STOP;
    }
}

export function update(space, dx, t) {
    dxs.push(dx);
    dts.push(t);

    space.cloneContainer.x -= dx;
    space.targetX = space.cloneContainer.x;

    // Check which target window will be selected if we release the swipe at this
    // moment
    dx = Lib.sum(dxs.slice(-3));
    let v = dx / (t - dts.slice(-3)[0]);
    if (Number.isFinite(v)) {
        space.vx = v;
    }

    let accel = Settings.prefs.swipe_friction[0] / 16; // px/ms^2
    accel = space.vx > 0 ? -accel : accel;
    let duration = -space.vx / accel;
    let d = space.vx * duration + 0.5 * accel * duration ** 2;
    let target = Math.round(space.targetX - d);

    space.targetX = target;
    const selected = findTargetWindow(space, start - space.targetX > 0);
    space.targetX = space.cloneContainer.x;
    space.selectedWindow = selected;
    space.emit('select');

    return Clutter.EVENT_STOP;
}

export function done(space) {
    if (!Number.isFinite(space.vx) || space.length === 0) {
        navigator?.finish();
        space.hState = -1;
        return Clutter.EVENT_STOP;
    }

    let startGlide = space.targetX;

    // timetravel
    let accel = Settings.prefs.swipe_friction[0] / 16; // px/ms^2
    accel = space.vx > 0 ? -accel : accel;
    let t = -space.vx / accel;
    let d = space.vx * t + 0.5 * accel * t ** 2;
    let target = Math.round(space.targetX - d);

    let mode = Clutter.AnimationMode.EASE_OUT_QUAD;
    let first;
    let last;

    let full = space.cloneContainer.width > space.width;
    // Only snap to the edges if we started gliding when the viewport is fully covered
    let snap = !(
        space.targetX >= 0 ||
        space.targetX + space.cloneContainer.width <= space.width
    );
    if ((snap && target > 0) || (full && target > space.width * 2)) {
        // Snap to left edge
        first = space[0][0];
        target = 0;
        mode = Clutter.AnimationMode.EASE_OUT_BACK;
    } else if (
        (snap && target + space.cloneContainer.width < space.width) ||
        (full && target + space.cloneContainer.width < -space.width)
    ) {
        // Snap to right edge
        last = space[space.length - 1][0];
        target = space.width - space.cloneContainer.width;
        mode = Clutter.AnimationMode.EASE_OUT_BACK;
    }

    // Adjust for target window
    let selected;
    space.targetX = Math.round(target);
    selected = last || first || findTargetWindow(space, start - target > 0);
    delete selected.lastFrame; // Invalidate frame information
    let x = Tiling.ensuredX(selected, space);
    target = x - selected.clone.targetX;

    // Scale down travel time if we've cut down the discance to travel
    let newD = Math.abs(startGlide - target);
    if (newD < Math.abs(d)) t *= Math.abs(newD / d);

    // Use a minimum duration if we've adjusted travel
    if (
        target !== space.targetX ||
        mode === Clutter.AnimationMode.EASE_OUT_BACK
    ) {
        t = Math.max(t, 200);
    }
    space.targetX = target;

    space.selectedWindow = selected;
    space.emit('select');
    gliding = true;
    Easer.addEase(space.cloneContainer, {
        x: space.targetX,
        duration: t,
        mode,
        onStopped: () => {
            gliding = false;
        },
        onComplete: () => {
            Navigator.getNavigator().finish();
        },
    });
}

/**
 * Finds a target window given a space and direction (-1 is left, 1 is right)
 * @param {Tiling.Space} space
 * @param {Boolean} direction
 * @returns
 */
export function findTargetWindow(space, direction) {
    let selected = space.selectedWindow?.clone;
    if (!selected) {
        return;
    }

    if (
        selected.x + space.targetX >= 0 &&
        selected.x + selected.width + space.targetX <= space.width
    ) {
        return selected.meta_window;
    }
    selected = selected && space.selectedWindow;
    let workArea = space.workArea();
    let min = workArea.x;

    let windows = space.getWindows().filter(w => {
        let clone = w.clone;
        let x = clone.targetX + space.targetX;
        return !(x + clone.width < min || x > min + workArea.width);
    });
    if (!direction)
        // scroll left
        windows.reverse();
    let visible = windows.filter(w => {
        let clone = w.clone;
        let x = clone.targetX + space.targetX;
        return x >= 0 && x + clone.width <= min + workArea.width;
    });
    if (visible.length > 0) {
        return visible[0];
    }

    if (windows.length === 0) {
        let first = space.getWindow(0, 0);
        let last = space.getWindow(space.length - 1, 0);
        if (direction) {
            return last;
        } else {
            return first;
        }
    }

    if (windows.length === 1) return windows[0];

    let closest = windows[0].clone;
    let next = windows[1].clone;
    let r1, r2;
    if (direction) {
        // ->
        r1 =
            Math.abs(closest.targetX + closest.width + space.targetX) /
            closest.width;
        r2 = Math.abs(next.targetX + space.targetX - space.width) / next.width;
    } else {
        r1 =
            Math.abs(closest.targetX + space.targetX - space.width) /
            closest.width;
        r2 = Math.abs(next.targetX + next.width + space.targetX) / next.width;
    }
    // Choose the window the most visible width (as a ratio)
    if (r1 > r2) return closest.meta_window;
    else return next.meta_window;
}

/**
 * Enables (or disables) gnome swipe trackers which take care of the
 * default 3 finger swipe actions.
 * @param {Boolean} option
 */
export function swipeTrackersEnable(option) {
    let enable = option ?? true;
    Patches.swipeTrackers.forEach(t => (t.enabled = enable));
}
