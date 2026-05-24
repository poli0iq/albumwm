import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';

import { Settings, Utils, Tiling, Topbar } from './imports.js';
import { Easer, EaserParams } from './utils.js';

let originalBuildMenu: ((window: Tiling.Window) => void) | null;
export function enable() {
    originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;
    WindowMenu.WindowMenu.prototype._buildMenu = function (
        window: Tiling.Window
    ) {
        const item = this.addAction(_('Scratch'), () => {
            toggle(window);
        });
        if (isScratchWindow(window)) item.setOrnament(PopupMenu.Ornament.CHECK);

        originalBuildMenu!.call(this, window);
    };
}

export function disable() {
    WindowMenu.WindowMenu.prototype._buildMenu = originalBuildMenu!;
    originalBuildMenu = null;
}

/**
   Tween window to "frame-coordinate" (targetX, targetY).
   The frame is moved once the tween is done.

   The actual window actor (not clone) is tweened to ensure it's on top of the
   other windows/clones (clones if the space animates)
 */
export function easeScratch(
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

export function makeScratch(metaWindow: Tiling.Window) {
    const fromNonScratch = !metaWindow._scratch;
    let fromTiling = false;
    // Relevant when called while navigating. Use the position the user actually sees.
    let windowPositionSeen: number[];

    if (fromNonScratch) {
        // Figure out some stuff before the window is removed from the tiling
        const space = Tiling.spaces.spaceOfWindow(metaWindow);
        fromTiling = space.indexOf(metaWindow) > -1;
        if (fromTiling) {
            windowPositionSeen = metaWindow.clone
                .get_transformed_position()
                .map(Math.round);
        }
    }

    metaWindow._scratch = true;
    metaWindow.make_above();
    metaWindow.stick(); // NB! Removes the window from the tiling (synchronously)

    if (!metaWindow.minimized) Tiling.showWindow(metaWindow);

    if (fromTiling) {
        const f = metaWindow.get_frame_rect();
        let targetFrame = null;

        if (metaWindow._scratchFrame) {
            const sf = metaWindow._scratchFrame;
            if (
                Utils.monitorOfPoint(sf.x, sf.y) ===
                Main.layoutManager.primaryMonitor
            ) {
                targetFrame = sf;
            }
        }

        if (!targetFrame) {
            // Default to moving the window slightly down and reducing the height
            const vDisplacement = 30;
            const [x, y] = windowPositionSeen!; // The window could be non-placable so can't use frame

            targetFrame = new Mtk.Rectangle({
                x,
                y: y + vDisplacement,
                width: f.width,
                height: Math.min(
                    f.height - vDisplacement,
                    Math.floor(f.height * 0.9)
                ),
            });
        }

        if (!metaWindow.minimized) {
            metaWindow.move_resize_frame(
                true,
                f.x,
                f.y,
                targetFrame.width,
                targetFrame.height
            );
            easeScratch(metaWindow, targetFrame.x, targetFrame.y, {
                onComplete: () => {
                    delete metaWindow._scratchFrame;
                    Main.activateWindow(metaWindow);
                },
            });
        } else {
            // Can't restore the scratch geometry immediately since it distort the minimize animation
            // ASSUMPTION: minimize animation is not disabled and not already done
            const actor = metaWindow.get_compositor_private();
            const signal = actor.connect('effects-completed', () => {
                metaWindow.move_resize_frame(
                    true,
                    targetFrame.x,
                    targetFrame.y,
                    targetFrame.width,
                    targetFrame.height
                );
                actor.disconnect(signal);
            });
        }
    }

    (
        Main.layoutManager.primaryMonitor as Tiling.Monitor | null
    )?.clickOverlay?.hide();
}

export function unmakeScratch(metaWindow: Tiling.Window) {
    if (!metaWindow._scratchFrame)
        metaWindow._scratchFrame = metaWindow.get_frame_rect();
    metaWindow._scratch = false;
    metaWindow.unmake_above();
    metaWindow.unstick();
}

export function toggle(metaWindow: Tiling.Window) {
    if (isScratchWindow(metaWindow)) {
        unmakeScratch(metaWindow);
    } else {
        makeScratch(metaWindow);
    }
}

export function isScratchWindow(metaWindow: Meta.Window) {
    return metaWindow && (metaWindow as Tiling.Window)._scratch;
}

/** Return scratch windows in MRU order */
export function getScratchWindows(): Tiling.Window[] {
    return global.display
        .get_tab_list(Meta.TabList.NORMAL, null)
        .filter(isScratchWindow) as Tiling.Window[];
}

export function isScratchActive() {
    return getScratchWindows().some(metaWindow => !metaWindow.minimized);
}

export function toggleScratch() {
    if (isScratchActive()) hide();
    else show();
}

export function toggleScratchWindow() {
    const focus = global.display.focus_window;
    if (isScratchWindow(focus)) hide();
    else show(true);
}

export function show(top?: boolean) {
    let windows = getScratchWindows();
    if (windows.length === 0) {
        return;
    }
    if (top) windows = windows.slice(0, 1);

    Topbar.fixTopBar();

    windows
        .slice()
        .reverse()
        .forEach(metaWindow => {
            metaWindow.unminimize();
            metaWindow.make_above();
            metaWindow.get_compositor_private<Meta.WindowActor>().show();
        });
    windows[0].activate(global.get_current_time());

    (
        Main.layoutManager.primaryMonitor as Tiling.Monitor | null
    )?.clickOverlay?.hide();
}

export function hide() {
    const windows = getScratchWindows();
    windows.forEach(metaWindow => {
        metaWindow.minimize();
    });
}

export function animateWindows() {
    let ws = getScratchWindows().filter(w => !w.minimized);
    ws = global.display.sort_windows_by_stacking(ws) as Tiling.Window[];
    for (const w of ws) {
        // let parent = w.clone.get_parent();
        // parent && parent.remove_child(w.clone);
        Utils.actorRemoveParent(w.clone);

        Main.layoutManager.uiGroup.insert_child_above(
            w.clone,
            global.window_group
        );
        const f = w.get_frame_rect();
        w.clone.set_position(f.x, f.y);
        Tiling.animateWindow(w);
    }
}

export function showWindows() {
    const ws = getScratchWindows().filter(w => !w.minimized);
    ws.forEach(Tiling.showWindow);
}
