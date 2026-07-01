import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';

import { Settings, Tiling } from './imports.js';
import { Easer, EaserParams } from './utils.js';

let originalBuildMenu: ((window: Tiling.Window) => void) | null;
export function enable() {
    originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;
    WindowMenu.WindowMenu.prototype._buildMenu = function (
        window: Tiling.Window
    ) {
        const item = this.addAction(_('Float'), () => {
            toggleWindowFloating(window);
        });
        if (Tiling.isFloating(window))
            item.setOrnament(PopupMenu.Ornament.CHECK);

        originalBuildMenu!.call(this, window);
    };
}

export function disable() {
    WindowMenu.WindowMenu.prototype._buildMenu = originalBuildMenu!;
    originalBuildMenu = null;
}

/**
 * Tween window to "frame-coordinate" (targetX, targetY).
 * The frame is moved once the tween is done.
 *
 * The actual window actor (not clone) is tweened to ensure it's on top of the
 * other windows/clones (clones if the space animates).
 */
export function easeFloating(
    metaWindow: Tiling.Window,
    targetX: number,
    targetY: number,
    params: EaserParams = {}
) {
    const complete = params?.onComplete ?? function () {};
    const f = metaWindow.get_frame_rect();
    const b = metaWindow.get_buffer_rect();
    const dx = f.x - b.x;
    const dy = f.y - b.y;

    Easer.addEase(metaWindow.get_compositor_private(), {
        x: targetX - dx,
        y: targetY - dy,
        time: Settings.prefs!.animation_time,
        onComplete: () => {
            metaWindow.move_frame(true, targetX, targetY);
            complete();
        },
    });
}

/** Move the focused window between the tiling and floating layers. */
export function toggleWindowFloating(metaWindow: Tiling.Window) {
    if (!metaWindow) return;
    const space = Tiling.spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    // Both methods activate the window themselves once their animation settles.
    if (Tiling.isFloating(metaWindow)) {
        space.unfloatWindow(metaWindow);
    } else {
        space.floatWindow(metaWindow);
    }
}

/**
 * Move keyboard focus between the floating and tiling layers.
 * No-op if the target layer is empty; each layer keeps its own focus.
 */
export function switchFocusBetweenFloatingAndTiling(
    _mw: Tiling.Window,
    space: Tiling.Space
) {
    const focus = global.display.focus_window as Tiling.Window;
    if (space.isFloating(focus)) {
        const target = space.selectedWindow ?? space.getWindows()[0];
        if (target) Main.activateWindow(target);
    } else {
        const target = global.display
            .get_tab_list(Meta.TabList.NORMAL, null)
            .find(w => space.isFloating(w as Tiling.Window)) as
            | Tiling.Window
            | undefined;
        if (target) Main.activateWindow(target);
    }
}
