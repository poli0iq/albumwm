import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
// @ts-expect-error not typed in girs
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import { Gestures, Grab, Tiling, Utils } from './imports.js';
import { Easer } from './utils.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/*
 * Mutter's sloppy/mouse focus modes act on pointer crossings into real
 * window surfaces, so they never reach windows AlbumWM renders as clones
 * (real actor hidden, frame elsewhere). While "focus-mode" isn't "click",
 * watch the pointer and focus hovered clone-rendered windows ourselves;
 * real windows stay mutter's business, and edge-stacked windows keep the
 * stack overlay's click/preview behavior. Focus only, like mutter: raising
 * is governed by "auto-raise".
 */

/* Mutter's pointer-rest check interval, reused as both the poll interval
 * and the rest delay to match native hover focus latency. */
const FOCUS_TIMEOUT_DELAY = 25;

let wmPreferences: Gio.Settings | null;
let signals: Utils.Signals | null;
// Not typed in girs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let watch: any | null;
let restTimeout: number | null;

export function enable(_extension: Extension) {
    wmPreferences = new Gio.Settings({
        schema_id: 'org.gnome.desktop.wm.preferences',
    });
    signals = new Utils.Signals();
    signals.connect(wmPreferences, 'changed::focus-mode', syncWatch);
    syncWatch();
}

export function disable() {
    signals!.destroy();
    signals = null;
    wmPreferences = null;
    stopWatch();
}

function syncWatch() {
    const followsMouse = wmPreferences!.get_string('focus-mode') !== 'click';
    if (followsMouse && !watch) {
        watch = PointerWatcher.getPointerWatcher().addWatch(
            FOCUS_TIMEOUT_DELAY,
            onPointerMoved
        );
    } else if (!followsMouse) {
        stopWatch();
    }
}

function stopWatch() {
    watch?.remove();
    watch = null;
    Utils.timeoutRemove(restTimeout);
    restTimeout = null;
}

function onPointerMoved(x: number, y: number) {
    Utils.timeoutRemove(restTimeout);
    restTimeout = null;
    if (!getCloneWindowAtPoint(x, y)) return;

    restTimeout = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        FOCUS_TIMEOUT_DELAY,
        () => {
            restTimeout = null;
            /* Resolve the target at fire time: the pointer or the space may
             * have moved since the timeout was armed. */
            const [px, py] = global.get_pointer();
            getCloneWindowAtPoint(px, py)?.focus(global.get_current_time());
            return GLib.SOURCE_REMOVE;
        }
    );
}

function getCloneWindowAtPoint(x: number, y: number): Tiling.Window | null {
    if (
        Main.overview.visible ||
        Tiling.inGrab ||
        Grab.grabbed ||
        Tiling.inTransient() ||
        Gestures.gliding
    ) {
        return null;
    }

    const space = Tiling.spaces?.selectedSpace;
    if (!space) return null;
    // Mid-scroll: what is under the pointer is about to change.
    if (space.cloneContainer.x !== space.targetX || space.actor.y !== 0) {
        return null;
    }

    /* Clones aren't reactive, so over one the pick falls through to the
     * space background; anything else means a real window or chrome sits
     * above the point and must not have focus stolen from under it. */
    const picked = global.stage.get_actor_at_pos(
        Clutter.PickMode.REACTIVE,
        x,
        y
    );
    if (picked !== space.background) return null;

    const [onSpace, sx, sy] = space.actor.transform_stage_point(x, y);
    if (!onSpace) return null;

    const metaWindow = space.getWindowAtPoint(sx, sy);
    if (
        !metaWindow ||
        metaWindow === global.display.focus_window ||
        !Tiling.isWindowAnimating(metaWindow) ||
        Easer.isEasing(metaWindow.clone) ||
        space.isEdgeStacked(metaWindow)
    ) {
        return null;
    }
    return metaWindow;
}
