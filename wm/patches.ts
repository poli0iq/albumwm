import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as WindowManager from 'resource:///org/gnome/shell/ui/windowManager.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';

import { Utils, Tiling, Scratch, Settings, OverviewLayout } from './imports.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import type GObject from 'gi://GObject?version=2.0';
import type Meta from 'gi://Meta';

/*
 * Some of Gnome Shell's default behavior is really sub-optimal when using
 * albumWM. Other features are simply not possible to implement without monkey
 * patching. This is a collection of monkey patches and preferences which works
 * around these problems and facilitates new features.
 */

type PropOverride<T> =
    | {
          isAccessor?: false;
          saved: T;
          override: T;
      }
    | {
          isAccessor: true;
          saved: PropertyDescriptor;
          override: PropertyDescriptor;
      };
let savedProps: Map<object, Record<string, PropOverride<unknown>>> | null;
export function registerOverrideProp<
    T extends object,
    K extends keyof T & string,
>(obj: T, name: K, override: T[K], warn = true) {
    if (!obj) return;

    // check if prop exists
    const exists = obj?.[name];
    if (!exists && warn) {
        console.warn(
            `#AlbumWM: attempt to override prop for '${name}' failed: is null or undefined`
        );
    }

    const saved = getSavedProp(obj, name) ?? obj[name];
    let props = savedProps!.get(obj);
    if (!props) {
        props = {};
        savedProps!.set(obj, props);
    }
    props[name] = {
        saved,
        override,
    };
}

export function registerOverridePrototype<
    P extends object,
    K extends keyof P & string,
>(obj: { prototype: P }, name: K, override: P[K]) {
    // check if method for prototype exists
    const exists = obj?.prototype?.[name];
    if (!exists) {
        console.warn(
            `#AlbumWM: attempt to override prototype for '${name}' failed: is null or undefined`
        );
    }

    registerOverrideProp(obj.prototype, name, override);
}

/**
 * Override an accessor property (getter). registerOverrideProp can't handle
 * this because it reads obj[name] (invoking the getter) and restores by
 * assignment, which would replace the getter with a plain value.
 */
export function registerOverrideGetter<
    T extends object,
    K extends keyof T & string,
>(obj: T, name: K, getter: (this: T) => T[K]) {
    const saved = Object.getOwnPropertyDescriptor(obj, name);
    if (!saved || typeof saved.get !== 'function') {
        console.warn(
            `#AlbumWM: attempt to override getter for '${name}' failed: not an accessor property`
        );
        return;
    }

    let props = savedProps!.get(obj);
    if (!props) {
        props = {};
        savedProps!.set(obj, props);
    }
    props[name] = {
        saved,
        override: { configurable: true, get: getter },
        isAccessor: true,
    };
}

export function getSavedProp<T extends object, K extends keyof T & string>(
    obj: T,
    name: K
): T[K] | undefined {
    const props = savedProps!.get(obj);
    if (!props) return undefined;
    const prop = props[name] as PropOverride<T[K]>;
    if (!prop) return undefined;
    return !prop.isAccessor ? prop.saved : undefined;
}

export function getSavedPrototype<P extends object, K extends keyof P & string>(
    obj: { prototype: P },
    name: K
): P[K] | undefined {
    return getSavedProp(obj.prototype, name);
}

/**
 * The saved descriptor behind an accessor override. getSavedProp can't return
 * this: it yields plain values and reports undefined for accessors, whereas a
 * getter override still needs the original descriptor to fall back to.
 */
export function getSavedDescriptor<
    T extends object,
    K extends keyof T & string,
>(obj: T, name: K): PropertyDescriptor | undefined {
    const prop = savedProps!.get(obj)?.[name];
    return prop?.isAccessor ? prop.saved : undefined;
}

export function disableOverride<T extends object, K extends keyof T & string>(
    obj: T,
    name: K
) {
    const prop = savedProps!.get(obj)?.[name] as PropOverride<T[K]> | undefined;
    if (prop?.isAccessor) {
        Object.defineProperty(obj, name, prop.saved);
        return;
    }
    obj[name] = getSavedProp(obj, name)!;
}

export function enableOverride<T extends object, K extends keyof T & string>(
    obj: T,
    name: K
) {
    const props = savedProps!.get(obj)!;
    const prop = props[name] as PropOverride<T[K]>;
    if (prop.isAccessor) {
        Object.defineProperty(obj, name, prop.override);
        return;
    }
    const override = prop.override;
    if (override !== undefined) {
        obj[name] = override;
    }
}

/**
 * Sets up AlbumWM overrides (needed for operations).  These overrides are registered and restored
 * on AlbumWM disable.
 */
let gsettings: Gio.Settings | null;
export function setupOverrides() {
    /**
     * Used on overview layout.  UnalignedLayoutStrategy is not exported in Gnome 45, and hence
     * we need to override this function and call AlbumWM customised UnalignedLayoutStrategy found
     * in overlayout.js.
     */
    registerOverridePrototype(
        Workspace.WorkspaceLayout,
        '_createBestLayout',
        function (this: Workspace.WorkspaceLayout, area: Workspace.Rect) {
            const [rowSpacing, columnSpacing] = this._adjustSpacingAndPadding(
                this._spacing,
                this._spacing,
                null
            );

            // We look for the largest scale that allows us to fit the
            // largest row/tallest column on the workspace.
            this._layoutStrategy = new OverviewLayout.UnalignedLayoutStrategy({
                monitor: Main.layoutManager.monitors[this._monitorIndex],
                rowSpacing,
                columnSpacing,
            });

            let lastLayout = null;
            let lastNumColumns = -1;
            let lastScale = 0;
            let lastSpace = 0;

            for (let numRows = 1; ; numRows++) {
                const numColumns = Math.ceil(
                    this._sortedWindows.length / numRows
                );

                // If adding a new row does not change column count just stop
                // (for instance: 9 windows, with 3 rows -> 3 columns, 4 rows ->
                // 3 columns as well => just use 3 rows then)
                if (numColumns === lastNumColumns) break;

                const layout = this._layoutStrategy.computeLayout(
                    this._sortedWindows,
                    {
                        numRows,
                    }
                );

                const [scale, space] =
                    this._layoutStrategy.computeScaleAndSpace(layout, area);

                if (
                    lastLayout &&
                    !this._isBetterScaleAndSpace(
                        lastScale,
                        lastSpace,
                        scale,
                        space
                    )
                )
                    break;

                lastLayout = layout;
                lastNumColumns = numColumns;
                lastScale = scale;
                lastSpace = space;
            }

            return lastLayout;
        }
    );

    registerOverridePrototype(
        Workspace.Workspace,
        '_isOverviewWindow',
        function (this: Workspace.Workspace, win: Meta.Window) {
            // Should be a Meta.Window, unwrap a clone if we get one
            win = (win as { meta_window?: Meta.Window }).meta_window ?? win;
            // upstream (gnome value result - what it would have done)
            const saved = getSavedPrototype(
                Workspace.Workspace,
                '_isOverviewWindow'
            );
            const upstreamValue = saved?.call(this, win) ?? !win.skip_taskbar;

            if (Scratch.isScratchWindow(win)) {
                if (gsettings!.get_boolean('only-scratch-in-overview')) {
                    return upstreamValue;
                }

                if (gsettings!.get_boolean('disable-scratch-in-overview')) {
                    return false;
                }
            }

            // if here then not scratch
            if (gsettings!.get_boolean('only-scratch-in-overview')) {
                return false;
            }

            return upstreamValue;
        }
    );

    /**
     * Make the overview open/close animation interpolate to the AlbumWM
     * clone's stage rect instead of `meta_window_get_frame_rect()`. The
     * upstream getter targets `frame_rect`, which lies for non-placeable
     * windows (clone sits off-monitor while frame is clamped on-monitor)
     * and for fullscreen/maximized windows (frame fills the whole
     * monitor while the clone occupies a smaller column slot).
     */
    registerOverrideGetter(
        WindowPreview.WindowPreview.prototype,
        'boundingBox',
        function () {
            const w = this.metaWindow;
            const rect = Tiling.spaces?.spaceOfWindow(w)?.cloneStageRect(w);
            if (rect) return rect;
            const saved = getSavedDescriptor(
                WindowPreview.WindowPreview.prototype,
                'boundingBox'
            );
            return saved!.get!.call(this);
        }
    );

    /**
     * Always show workspace thumbnails in overview if more than one workspace.
     * See original function at:
     * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-44/js/ui/workspaceThumbnail.js#L690
     */
    registerOverridePrototype(
        WorkspaceThumbnail.ThumbnailsBox,
        '_updateShouldShow',
        function (this: WorkspaceThumbnail.ThumbnailsBox) {
            const { nWorkspaces } = global.workspace_manager;
            const shouldShow = nWorkspaces > 1;

            if (this._shouldShow === shouldShow) return;

            this._shouldShow = shouldShow;
            this.notify('should-show');
        }
    );

    /**
     * Provides ability to set AltTab window preview sizes (which is a little harder in 45+).
     * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/altTab.js#L1002
     */
    registerOverridePrototype(
        AltTab.WindowIcon,
        '_init',
        function (this: AltTab.WindowIcon, window: Meta.Window, mode: number) {
            const saved = getSavedPrototype(AltTab.WindowIcon, '_init');
            saved!.call(this, window, mode);

            const WINDOW_PREVIEW_SIZE = 128;
            const AppIconMode = {
                THUMBNAIL_ONLY: 1,
                APP_ICON_ONLY: 2,
                BOTH: 3,
            };
            const APP_ICON_SIZE = 96;
            const APP_ICON_SIZE_SMALL = 48;

            const mutterWindow =
                this.window.get_compositor_private<Clutter.Actor>();

            this._icon.destroy_all_children();

            const monitor = Tiling.spaces.selectedSpace.monitor;
            const _createWindowClone = (
                windowActor: Clutter.Actor,
                size: number
            ) => {
                const [width, height] = windowActor.get_size();
                const scale = Math.min(1.0, size / width, size / height);
                return new Clutter.Clone({
                    source: windowActor,
                    width: width * scale,
                    height: height * scale,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    // usual hack for the usual bug in ClutterBinLayout...
                    x_expand: true,
                    y_expand: true,
                });
            };

            let size;
            const scaleFactor = St.ThemeContext.get_for_stage(
                global.stage
            ).scale_factor;
            const scale = Settings.prefs!.window_switcher_preview_scale;
            // scale size based on AlbumWM's minimap-scale
            if (scale > 0) {
                size = Math.round(monitor.height * scale);
            } else {
                size = WINDOW_PREVIEW_SIZE;
            }
            switch (mode) {
                case AppIconMode.THUMBNAIL_ONLY:
                    this._icon.add_child(
                        _createWindowClone(mutterWindow, size * scaleFactor)
                    );
                    break;

                case AppIconMode.BOTH:
                    this._icon.add_child(
                        _createWindowClone(mutterWindow, size * scaleFactor)
                    );

                    if (this.app) {
                        this._icon.add_child(
                            this._createAppIcon(this.app, APP_ICON_SIZE_SMALL)
                        );
                    }
                    break;

                case AppIconMode.APP_ICON_ONLY:
                    size = APP_ICON_SIZE;
                    this._icon.add_child(this._createAppIcon(this.app, size));
            }

            this._icon.set_size(size * scaleFactor, size * scaleFactor);
        }
    );

    registerOverridePrototype(
        Screenshot.ScreenshotUI,
        'open',
        async function (this: Screenshot.ScreenshotUI, mode: number) {
            const saved = getSavedPrototype(Screenshot.ScreenshotUI, 'open');

            if (!Main.overview.visible) {
                Tiling?.spaces.forEach(s => {
                    s.visible.forEach(w => {
                        w.get_compositor_private()?.remove_clip();
                    });
                });
            }

            await saved!.call(this, mode);
        }
    );

    registerOverridePrototype(
        Screenshot.ScreenshotUI,
        'close',
        function (this: Screenshot.ScreenshotUI, instantly?: boolean) {
            const saved = getSavedPrototype(Screenshot.ScreenshotUI, 'close');

            if (!Main.overview.visible) {
                Tiling?.spaces.forEach(s => {
                    s.visible.forEach(w => {
                        s.applyClipToClone(w);
                    });
                });
            }

            saved!.call(this, instantly);
        }
    );
}

/**
 * Enables any registered overrides.
 */
export function enableOverrides() {
    for (const [obj, props] of savedProps!) {
        for (const name in props) {
            enableOverride(obj as Record<string, unknown>, name);
        }
    }
}

export function disableOverrides() {
    for (const [obj, props] of savedProps!) {
        for (const name in props) {
            disableOverride(obj as Record<string, unknown>, name);
        }
    }
}

const runtimeDisables: (() => void)[] = [];
/**
 * Saves the original setting value (boolean) to restore on disable.
 * We save a backup of the user's setting to AlbumWM settings (schema)
 * for safety (in case gnome terminates etc.).  This ensures original
 * user settings will be restored on next AlbumWM disable.
 */
export function saveRuntimeDisable(
    schemaSettings: Gio.Settings,
    key: string,
    disableValue: boolean
) {
    try {
        const origValue = schemaSettings.get_boolean(key);
        schemaSettings.set_boolean(key, disableValue);

        // save a backup copy to AlbumWM settings (for restore)
        const pkey = `restore-${key}`;

        /**
         * Now if albumwm settings has restore values, it means
         * that they weren't previously restore properly (since on
         * successful restore we clear the values).
         */
        if (gsettings!.get_string(pkey) === '') {
            gsettings!.set_string(pkey, origValue.toString());
        }

        // we want to restore from AlbumWM back settings (safer)
        const restore = () => {
            const value = gsettings!.get_string(pkey);
            // if value is empty, do nothing
            if (value === '') {
                return;
            }

            const bvalue = value === 'true';
            schemaSettings.set_boolean(key, bvalue);

            // after restore, empty albumwm saved value
            gsettings!.set_string(pkey, '');
        };

        runtimeDisables.push(restore);
    } catch (e) {
        console.error(e);
    }
}

/**
 * AlbumWM disables certain behaviours during runtime.
 * The user original settings are saved to AlbumWM's settings (schema) for restoring
 * purposes (we save to AlbumWM's setting just in gnome terminates before AlbumWM can
 * restore the original user settings).  These settings are then restored on disable().
 */
let mutterSettings: Gio.Settings | null;
export function setupRuntimeDisables() {
    saveRuntimeDisable(mutterSettings!, 'attach-modal-dialogs', false);
    saveRuntimeDisable(mutterSettings!, 'edge-tiling', false);
}

/**
 * Restores the runtime settings that were disabled when
 * AlbumWM was enabled.
 */
export function restoreRuntimeDisables() {
    if (Main.sessionMode.isLocked) {
        return;
    }
    runtimeDisables.forEach(restore => {
        try {
            restore();
        } catch (e) {
            console.error(e);
        }
    });
}

/**
 * Swipetrackers that should be disabled.  Locations of swipetrackers may
 * move from gnome version to gnome version.  Next to the swipe tracker locations
 * below are the gnome versions when they were first (or last) seen.
 */
export let swipeTrackers: (GObject.Object & { enabled: boolean })[] | null; // exported
export function setupSwipeTrackers() {
    swipeTrackers = [
        Main?.overview?._overview?._controls?._appDisplay?._swipeTracker, // gnome 49+
        Main?.overview?._swipeTracker, // gnome 40+
        Main?.overview?._overview?._controls?._workspacesDisplay?._swipeTracker, // gnome 40+
        // @ts-expect-error property missing in girs
        Main?.wm?._workspaceAnimation?._swipeTracker, // gnome 40+
    ].filter(t => typeof t !== 'undefined');
}

let actions: Clutter.Action[] | null;
export function setupActions() {
    /*
     * Some actions work rather poorly.
     * In particular the 3-finger hold + tap can randomly activate a minimized
     * window when tapping after a 3-finger swipe
     */
    actions = global.stage.get_actions().filter(a => {
        switch (a.constructor) {
            // @ts-expect-error not typed in girs
            case WindowManager.AppSwitchAction:
                return true;
            default:
                return false;
        }
    });
    actions.forEach(a => global.stage.remove_action(a));
}

let signals: Utils.Signals | null;
export function enable(extension: Extension) {
    savedProps = new Map();
    gsettings = extension.getSettings();

    mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    signals = new Utils.Signals();
    setupSwipeTrackers();
    setupOverrides();
    enableOverrides();
    setupRuntimeDisables();
    setupActions();
}

export function disable() {
    disableOverrides();
    restoreRuntimeDisables();
    actions!.forEach(a => global.stage.add_action(a));
    actions = null;

    signals!.destroy();

    savedProps = null;
    swipeTrackers = null;
    gsettings = null;
    mutterSettings = null;
    signals = null;
}
