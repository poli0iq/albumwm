import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Settings,
    Utils,
    Lib,
    Gestures,
    Navigator,
    Grab,
    Topbar,
    Floating,
} from './imports.js';
import { Easer } from './utils.js';
import { ClickOverlay } from './stackoverlay.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import type Mtk from 'gi://Mtk';
import type * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import type { SignalMethods } from '@girs/gjs/gjs';

const { signals: Signals } = imports;
const workspaceManager = global.workspace_manager;
const display = global.display;

export let spaces: Spaces;

// Mutter prevints windows from being placed further off the screen than 75 pixels.
export const stackMargin = 75;

const mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });

// Some features use this to determine if to sizes is considered equal. ie. `abs(w1 - w2) < sizeSlack`
const sizeSlack = 30;

// DEFAULT mode is normal/original AlbumWM window focus behaviour
export enum FocusModes {
    DEFAULT = 0,
    CENTER = 1,
    EDGE = 2,
}

export enum CycleWindowSizesDirection {
    FORWARD = 0,
    BACKWARDS = 1,
}

export enum SlurpInsertPosition {
    BOTTOM = 0,
    TOP = 1,
    ABOVE = 2,
    BELOW = 3,
}

/**
   Scrolled and tiled per monitor workspace.

   The tiling is composed of an array of columns. A column being an array of
   MetaWindows. Ie. the type being [[MetaWindow]].

   A Space also contains a visual representation of the tiling. The structure is
   currently like this:

   A @clip actor which spans the monitor and clips all its contents to the
   monitor. The clip lives along side all other space's clips in an actor
   spanning the whole global.workspaceManager

   An @actor to hold everything that's visible, it contains a @background
   and a @cloneContainer.

   The @cloneContainer holds clones of all the tiled windows, it's clipped
   by @cloneClip to avoid protruding into neighbouringing monitors.

   Clones are necessary due to restrictions mutter places on MetaWindowActors.
   WindowActors can only live in the `global.window_group` and can't be
   moved reliably outside the monitor. We create a Clutter.Clone for every window which
   live in @cloneContainer to avoid these problems. Scrolling to a window in
   the tiling is then done by simply moving the @cloneContainer.

   While eg. animating the cloneContainer WindowActors are all hidden, while the
   clones are shown. When animation is done, the MetaWindows are moved to their
   correct position and the WindowActors are shown.

   The clones are also useful when constructing the workspace stack as it's
   easier to scale and move the whole @actor in one go.

   # Coordinate system

   MetaWindows live in the stage (global) coordinate system. NB: This system
   covers all monitors - a window positioned top-left in a monitor might have
   non-zero coordinates.

   The space (technically the @clip) has it's own coordinate system relative to
   its monitor. Ie. 0,0 is the top-left corner of the monitor.

   To transform a stage point to space coordinates: `space.actor.transform_stage_point(aX, aY)`
 */

/** Saves current state for controlled restarts of AlbumWM. */
class SaveState {
    prevSpaces: Map<Meta.Workspace, Space>;

    constructor() {
        this.prevSpaces = new Map();
    }

    getPrevSpaceByUUID(uuid: string) {
        return [...this.prevSpaces.values()].find(s => uuid === s.uuid);
    }

    update() {
        this.prevSpaces = new Map(spaces);
    }

    /* Prepares state for restoring on next enable. */
    prepare() {
        this.update();
        this.prevSpaces.forEach(space => {
            const windows = space.getWindows();
            const selected = space.selectedWindow
                ? windows.indexOf(space.selectedWindow)
                : -1;
            if (selected === -1) return;
            /* Stack windows correctly for controlled restarts. */
            for (let i = selected; i < windows.length; i++) {
                windows[i].lower();
            }
            for (let i = selected; i >= 0; i--) {
                windows[i].lower();
            }
        });
    }
}

let saveState: SaveState;
let gsettings: Gio.Settings | null;
let signals: Utils.Signals | null, grabSignals: Utils.Signals | null;
let startupTimeoutId: number | null, timerId: number | null;
let monitorChangeTimeout: number | null;
export let inGrab: Grab.MoveGrab | Grab.ResizeGrab | null;
/**
 * The window a grab op or a move-to-monitor keybinding is moving.
 *
 * Tracks movement between monitors: insertWindow leaves such windows untiled
 * when they land on the primary.
 */
let movingWindow: Window | null = null;
// A secondary-monitor drop whose native grab op hasn't ended; see grabEnd.
let settlingDrop: {
    window: Window;
    rect: { x: number; y: number; width: number; height: number };
} | null = null;

/** Called by the drop handler; ignored if the native grab op already ended. */
export function setSettlingDrop(
    window: Window,
    rect: { x: number; y: number; width: number; height: number }
) {
    if (movingWindow !== window) return;
    settlingDrop = { window, rect };
}

export function enable(extension: Extension) {
    inGrab = null;
    movingWindow = null;
    settlingDrop = null;

    saveState = saveState ?? new SaveState();

    gsettings = extension.getSettings();

    signals = new Utils.Signals();
    grabSignals = new Utils.Signals();

    // setup actions on gap changes
    const marginsGapChanged = () => {
        Utils.timeoutRemove(timerId);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            spaces.mru().forEach(space => {
                space.layout(true, {
                    callback: () => {
                        const selected = spaces.activeSpace?.selectedWindow;
                        allocateClone(selected!);
                    },
                });
            });
            timerId = null;
            return false; // on return false destroys timeout
        });
    };
    gsettings.connect('changed::vertical-margin', marginsGapChanged);
    gsettings.connect('changed::column-gap', marginsGapChanged);

    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    spaces = new Spaces();
    const initWorkspaces = () => {
        try {
            spaces.init();
        } catch (e) {
            console.error(e);
        }

        // Fix the stack overlay
        spaces
            .mru()
            .reverse()
            .forEach(s => {
                // if s.selectedWindow exists and is in view, then use option moveto: false
                if (s.selectedWindow) {
                    const options = s.isFullyVisible(s.selectedWindow)
                        ? { moveto: false }
                        : { force: true };
                    ensureViewport(s.selectedWindow, s, options);
                }
                s.monitor!.clickOverlay!.show();
            });
        Topbar.fixTopBar();

        // on idle, reset viewports
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            spaces.forEach(s => {
                /**
                 * The below resolves https://github.com/paperwm/PaperWM/issues/758.
                 */
                const x = s.cloneContainer.x;
                s.viewportMoveToX(0);
                s.viewportMoveToX(x);
            });

            return GLib.SOURCE_REMOVE;
        });
    };

    if (Main.layoutManager._startingUp) {
        /* Defer workspace initialization until existing windows are accessible.
           Otherwise we're unable to restore the tiling-order on gnome-shell restart. */
        signals.connectOneShot(
            Main.layoutManager,
            'startup-complete',
            initWorkspaces
        );
    } else {
        /* Defer past Patches.enable(). */
        startupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            initWorkspaces();
            startupTimeoutId = null;
            return false;
        });
    }
}

export function disable() {
    Utils.timeoutRemove(startupTimeoutId);
    startupTimeoutId = null;
    Utils.timeoutRemove(timerId);
    timerId = null;
    Utils.timeoutRemove(monitorChangeTimeout);
    monitorChangeTimeout = null;

    grabSignals!.destroy();
    grabSignals = null;
    signals!.destroy();
    signals = null;

    saveState.prepare();
    spaces.destroy();
    inGrab = null;
    movingWindow = null;
    settlingDrop = null;
    gsettings = null;
}

/**
 * Exported inGrab is read-only from other modules.
 * This method allows other modules to change inGrab.
 */
export function setInGrab(value: null | Grab.MoveGrab | Grab.ResizeGrab) {
    inGrab = value;
}

/** Whether keyboard navigation or scroll gesture are in progress. */
export function inTransient() {
    return Navigator.navigating || Gestures.gestureInProgress;
}

/**
 * A GNOME Shell monitor, augmented by AlbumWM with a click overlay.
 */
export type Monitor = NonNullable<Layout.Monitor> & {
    clickOverlay?: ClickOverlay;
};

export type Clone = NonNullable<Clutter.Actor> & {
    cloneActor: Clutter.Clone;
    shade: St.Widget;
    targetX: number;
    targetY: number;
    // Used by `grab.ts`
    __oldOpacity?: number;
    // Used by `gestures.ts`
    meta_window: Window;
};

/**
 * Meta.Window with our extra fields
 */
export type Window = Meta.Window & {
    clone: Clone;
    preferredWidth?: Settings.PreferredWidth;
    unmaximizedRect?: Mtk.Rectangle | null;
    lastFrame?: Mtk.Rectangle;
    focusOnOpen?: boolean;
    floatOnOpen?: boolean;
    overwriteSpace?: number;
    unmapped?: boolean;
    redirected?: boolean;
    _targetWidth?: number | null;
    _targetHeight?: number | null;
    _resizeHandlerAdded?: boolean;
    _positionHandlerAdded?: boolean;
    _pos_mismatch_count?: number;
    _tiled_on_minimize?: boolean;
    _fullscreen_frame?: {
        x: number;
        y: number;
        width: number;
        height: number;
        tiledWidth?: number;
    };
    _fullscreen_lock?: boolean;
    _fullscreen_above?: boolean;
    // Floating window geometry, preserved across float/unfloat.
    _floatFrame?: Mtk.Rectangle;
};

type Allocator = (
    column: Window[],
    availableHeight: number,
    selectedInColumn: Window | null
) => number[];

type LayoutOptions = {
    ensure?: boolean;
    customAllocators?: Record<number, Allocator> & { ensure?: boolean };
    centerIfOne?: boolean;
    callback?: () => void;
};

export interface Space extends SignalMethods {}
export class Space extends Array<Array<Window>> {
    workspace: Meta.Workspace;
    signals: Utils.Signals;

    visible: Window[];
    _floating: Window[];
    _populated: boolean;

    focusMode: FocusModes;
    unfocusXPosition: number | null;

    clip: Clutter.Actor & { space: Space };
    _visible: boolean;
    actor: Clutter.Actor;
    cloneClip: Clutter.Actor;
    cloneContainer: St.Widget & { space: Space };

    targetX: number;
    uuid: string;
    selectedWindow: Window | null;
    columnsLastActiveWindows: WeakMap<Window[], Window>;
    leftStack: number;
    rightStack: number;

    background?: Clutter.Actor;
    monitor?: Monitor;
    width?: number;
    height?: number;

    // Added/used by `gestures.ts`
    vx?: number;
    hState?: Clutter.TouchpadGesturePhase;

    // Less used dynamic fields
    _inLayout?: boolean;
    showTopBar?: boolean;
    _layoutQueued?: boolean;
    _isAnimating?: boolean;

    constructor(
        workspace: Meta.Workspace,
        container: Meta.BackgroundGroup,
        doInit: boolean
    ) {
        super(0);
        this.workspace = workspace;
        this.signals = new Utils.Signals();

        // windows that should be represented by their WindowActor
        this.visible = [];
        this._floating = [];
        this._populated = false;

        // default focusMode (can be overriden by saved user pref in Space.init method)
        this.focusMode = FocusModes.DEFAULT;
        this.unfocusXPosition = null; // init

        const clip = Object.assign(new Clutter.Actor({ name: 'clip' }), {
            space: this,
        });
        this.clip = clip;
        const actor = new Clutter.Actor({ name: 'space-actor' });
        actor.set_pivot_point(0.5, 0);

        this._visible = true;
        this.hide(); // We keep the space actor hidden when inactive due to performance

        this.actor = actor;
        const cloneClip = new Clutter.Actor({ name: 'clone-clip' });
        this.cloneClip = cloneClip;
        const cloneContainer = Object.assign(
            new St.Widget({ name: 'clone-container' }),
            { space: this }
        );
        this.cloneContainer = cloneContainer;

        container.add_child(clip);
        clip.add_child(actor);
        actor.add_child(cloneClip);
        cloneClip.add_child(cloneContainer);

        this.targetX = 0;

        this.uuid = GLib.uuid_string_random();
        this.initWorkspaceState();

        this.selectedWindow = null;
        this.columnsLastActiveWindows = new WeakMap();
        this.leftStack = 0; // not implemented
        this.rightStack = 0; // not implemented

        this.createBackground();
        // primaryMonitor may be null at enable time; Spaces.init() will retry
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            this.setMonitor(monitor as Monitor);
        }

        if (doInit) {
            this.init();
        }
    }

    init() {
        if (this._populated || Main.layoutManager._startingUp) return;

        const workspace = this.workspace;
        const prevSpace = saveState.getPrevSpaceByUUID(this.uuid);
        console.info(`restore by uuid: ${this.uuid}`);

        // get previous focus mode (if exists)
        const focusMode = prevSpace?.focusMode;
        this.addAll(prevSpace);
        saveState.prevSpaces.delete(workspace);
        this._populated = true;

        // restore focus mode (or fallback to default)
        setFocusMode(focusMode ?? getDefaultFocusMode(), this);

        this.getWindows().forEach(w => {
            animateWindow(w);
        });

        this.layout(false);

        this.signals.connect(workspace, 'window-added', (ws, metawindow) =>
            addHandler(ws, metawindow)
        );
        this.signals.connect(workspace, 'window-removed', (ws, metawindow) =>
            removeHandler(ws, metawindow)
        );
        this.signals.connect(
            Main.overview,
            'showing',
            this.startAnimate.bind(this)
        );
        this.signals.connect(Main.overview, 'hidden', () => {
            if (!spaces.isActiveSpace(this)) {
                return;
            }

            Utils.laterAdd(Meta.LaterType.IDLE, () => {
                this.moveDone(() => {
                    ensureViewport(display.focus_window as Window, this, {
                        moveto: true,
                        force: true,
                        ensureAnimation:
                            Settings.prefs!.overview_ensure_viewport_animation,
                    });
                });

                return GLib.SOURCE_REMOVE;
            });
        });

        this.signals.connect(gsettings!, 'changed::default-focus-mode', () => {
            setFocusMode(getDefaultFocusMode(), this);
        });
    }

    /**
     * Returns the space index (which is equivalent to the workspace index).
     */
    get index() {
        return this.workspace.index();
    }

    activate() {
        this.workspace.activate(global.get_current_time());
    }

    activateWithFocus(metaWindow: Window) {
        if (metaWindow) {
            this.workspace.activate_with_focus(
                metaWindow,
                global.get_current_time()
            );
        } else {
            this.workspace.activate(global.get_current_time());
        }
    }

    show() {
        if (this._visible) return;
        this._visible = true;
        this.clip.show();
        for (const col of this) {
            for (const w of col) {
                const actor = w.get_compositor_private<Clutter.Actor>();
                w.clone.cloneActor.source = actor;
            }
        }
    }

    hide() {
        if (!this._visible) return;
        this._visible = false;
        this.clip.hide();
        for (const col of this) {
            for (const w of col) {
                w.clone.cloneActor.set_source(null);
            }
        }
    }

    /**
     * Returns current workArea parameters for this space.
     * @returns object with x, y, width, and height values for this WorkArea.
     */
    workArea() {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            this.monitor!.index
        );
        return {
            x: workArea.x - this.monitor!.x,
            y: workArea.y - this.monitor!.y + Settings.prefs!.vertical_margin,
            width: workArea.width,
            height: workArea.height - 2 * Settings.prefs!.vertical_margin,
        };
    }

    layoutGrabColumn(
        column: Window[],
        x: number,
        y0: number,
        targetWidth: number,
        availableHeight: number,
        time: number,
        grabWindow: Window
    ) {
        const mosh = (
            windows: Window[],
            height: number,
            baseY: number
        ): number => {
            const targetHeights = fitProportionally(
                windows.map(mw => mw.get_frame_rect().height),
                height
            );
            const [, y] = this.layoutColumnSimple(
                windows,
                x,
                baseY,
                targetWidth,
                targetHeights,
                time
            );
            return y;
        };

        const k = column.indexOf(grabWindow);
        if (k < 0) {
            throw new Error(
                `Anchor doesn't exist in column ${grabWindow?.title}`
            );
        }

        const gap = Settings.prefs!.column_gap;
        const f = grabWindow.get_frame_rect();
        const yGrabRel = f.y - this.monitor!.y;
        targetWidth = f.width;

        const H1 = yGrabRel - y0 - gap - (k - 1) * gap;
        const H2 =
            availableHeight -
            (yGrabRel + f.height - y0) -
            gap -
            (column.length - k - 2) * gap;
        if (k > 0) mosh(column.slice(0, k), H1, y0);
        const y = mosh(column.slice(k, k + 1), f.height, yGrabRel);
        if (k + 1 < column.length) mosh(column.slice(k + 1), H2, y);

        return targetWidth;
    }

    layoutColumnSimple(
        windows: Window[],
        x: number,
        y0: number,
        targetWidth: number,
        targetHeights: number[],
        time: number
    ) {
        let y = y0;

        for (let i = 0; i < windows.length; i++) {
            const mw = windows[i];
            let targetHeight = targetHeights[i];

            const f = mw.get_frame_rect();

            const resizable = !mw.fullscreen && !isMaximized(mw);

            if (mw.preferredWidth) {
                const prop = mw.preferredWidth;
                if (prop.value <= 0) {
                    console.warn('invalid preferredWidth value');
                } else if (prop.unit === 'px') {
                    targetWidth = prop.value;
                } else if (prop.unit === '%') {
                    const availableWidth =
                        this.workArea().width -
                        Settings.prefs!.horizontal_margin * 2 -
                        Settings.prefs!.column_gap;
                    targetWidth = Math.floor(
                        availableWidth * Math.min(prop.value / 100.0, 1.0)
                    );
                } else {
                    console.warn(
                        'invalid preferredWidth unit:',
                        `'${prop.unit}'`,
                        "(should be 'px' or '%')"
                    );
                }
            }

            if (resizable) {
                const hasNewTarget =
                    mw._targetWidth !== targetWidth ||
                    mw._targetHeight !== targetHeight;
                const targetReached =
                    f.width === targetWidth && f.height === targetHeight;

                // Update targets (NB: must happen before resize request)
                mw._targetWidth = targetWidth;
                mw._targetHeight = targetHeight;

                if (!targetReached && hasNewTarget) {
                    // Explanation for `hasNewTarget` check in commit message
                    mw.move_resize_frame(
                        true,
                        f.x,
                        f.y,
                        targetWidth,
                        targetHeight
                    );
                }
            } else {
                mw.move_frame(true, this.monitor!.x, this.monitor!.y);
                targetWidth = f.width;
                targetHeight = f.height;
            }
            if (mw.maximized_vertically) {
                /* NOTE: This should really be f.y - monitor.y, but eg. firefox
                   reports the wrong y coordinates at this point. */
                y -= Settings.prefs!.vertical_margin;
            }

            const c = mw.clone;
            if (c.x !== x || c.targetX !== x || c.y !== y || c.targetY !== y) {
                // console.debug("  Position window", mw.title, `y: ${c.targetY} -> ${y} x: ${c.targetX} -> ${x}`);
                c.targetX = x;
                c.targetY = y;
                if (time === 0) {
                    c.x = x;
                    c.y = y;
                } else {
                    Easer.addEase(c, {
                        x,
                        y,
                        time,
                        onComplete: this.moveDone.bind(this),
                    });
                }
            }

            y += targetHeight + Settings.prefs!.column_gap;
        }
        return [targetWidth, y];
    }

    /**
     * Lays out one column at horizontal position x, dispatching between the
     * grab-anchored and the plain allocator paths.
     * @returns the column's resulting width.
     */
    layoutColumn(
        column: Window[],
        selectedInColumn: Window | null,
        x: number,
        workArea: { y: number; width: number; height: number },
        time: number,
        allocator?: Allocator
    ): number {
        let targetWidth;
        if (selectedInColumn) {
            // if selected window - use tiledWidth or frame.width (fallback)
            targetWidth =
                selectedInColumn._fullscreen_frame?.tiledWidth ??
                selectedInColumn.get_frame_rect().width;
        } else {
            // otherwise get max of tiledWidth or frame.width (fallback)
            targetWidth = Math.max(
                ...column.map(
                    w =>
                        w._fullscreen_frame?.tiledWidth ??
                        w.get_frame_rect().width
                )
            );
        }

        // enforce minimum
        targetWidth = Math.min(
            targetWidth,
            workArea.width - 2 * Settings.prefs!.minimum_margin
        );

        if (
            inGrab instanceof Grab.MoveGrab &&
            inGrab.dnd &&
            column.includes(inGrab.window!) &&
            !allocator
        ) {
            return this.layoutGrabColumn(
                column,
                x,
                workArea.y,
                targetWidth,
                workArea.height,
                time,
                inGrab.window!
            );
        }

        const targetHeights = (allocator ?? allocateDefault)(
            column,
            workArea.height,
            selectedInColumn
        );
        const [resultingWidth] = this.layoutColumnSimple(
            column,
            x,
            workArea.y,
            targetWidth,
            targetHeights,
            time
        );
        return resultingWidth;
    }

    /**
     * Resizes cloneContainer to the new layout width and, if the viewport was
     * automatically positioned (fitted or centered), eases it back into such
     * a position.
     */
    layoutViewport(
        width: number,
        workArea: { x: number; width: number },
        time: number,
        animate: boolean
    ) {
        const oldWidth = this.cloneContainer.width;
        const min = workArea.x;
        const auto =
            (this.targetX + oldWidth >= min + workArea.width &&
                this.targetX <= 0) ||
            this.targetX === min + Math.round((workArea.width - oldWidth) / 2);

        this.cloneContainer.width = width;

        if (!auto || !animate) return;
        if (width < workArea.width) {
            this.targetX = min + Math.round((workArea.width - width) / 2);
        } else if (this.targetX + width < min + workArea.width) {
            this.targetX = min + workArea.width - width;
        } else if (this.targetX > min) {
            this.targetX = workArea.x;
        }
        Easer.addEase(this.cloneContainer, {
            x: this.targetX,
            time,
            onComplete: this.moveDone.bind(this),
        });
    }

    /**
     * Work area to lay out into: with the top bar hidden, or the selected
     * window fullscreen, it extends over the top bar's area.
     */
    layoutWorkArea() {
        const workArea = this.workArea();
        /* If current window is fullscreened, treat workarea as fullscreen (y = 0)
         * to avoid a "flash of topbar spacing" before the next layout call resolves. */
        if (this.selectedWindow?.fullscreen) {
            workArea.y = 0;
        } else if (!this.showTopBar) {
            const panelBoxHeight = Topbar.panelBox.height;
            workArea.y -= panelBoxHeight;
            workArea.height += panelBoxHeight;
        }
        return workArea;
    }

    layout(animate = true, options?: LayoutOptions) {
        // Guard against recursively calling layout
        if (!this._populated) return;
        if (this._inLayout) return;

        const {
            ensure = true,
            customAllocators: allocators,
            centerIfOne = true,
            callback,
        } = options ?? {};

        this._inLayout = true;
        this.startAnimate();

        const time = Settings.prefs!.animation_time;
        const gap = Settings.prefs!.column_gap;
        let x = gap; // init (ensures autostart apps in particular start properly gapped)
        const selectedIndex = this.selectedIndex();
        const workArea = this.layoutWorkArea();

        // Happens on monitors-changed
        if (workArea.width === 0) {
            this._inLayout = false;
            return;
        }

        for (let i = 0; i < this.length; i++) {
            let column = this[i];
            // Actorless windows are trouble. Layout could conceivable run while a window is dying or being born.
            column = column.filter(mw => mw.get_compositor_private());
            if (column.length === 0) continue;

            // selected window in column
            const selectedInColumn =
                i === selectedIndex ? this.selectedWindow : null;

            const resultingWidth = this.layoutColumn(
                column,
                selectedInColumn,
                x,
                workArea,
                time,
                allocators?.[i]
            );

            x += resultingWidth + gap;
        }
        // final gap add - required to resolve https://github.com/paperwm/PaperWM/issues/684
        x += gap;

        this._inLayout = false;
        // transforms break on width 1
        this.layoutViewport(Math.max(1, x - gap), workArea, time, animate);

        // moveDone must run even without a selected window.
        if (animate && ensure && this.selectedWindow) {
            ensureViewport(this.selectedWindow, this);
        } else {
            this.moveDone();
        }

        // if only one column on space, then center it
        if (centerIfOne && this.length === 1) {
            const mw = this.getWindows()[0];
            centerWindow(mw);
        }

        if (callback) callback();

        this.emit('layout', this);
    }

    queueLayout(
        animate = true,
        options?: LayoutOptions & { laterType?: Meta.LaterType }
    ) {
        if (this._layoutQueued) return;
        this._layoutQueued = true;

        const laterType = options?.laterType ?? Meta.LaterType.RESIZE;
        Utils.laterAdd(laterType, () => {
            this._layoutQueued = false;
            this.layout(animate, options);

            return GLib.SOURCE_REMOVE;
        });
    }

    // Space.prototype.isVisible = function
    isVisible(metaWindow: Window, margin = 0) {
        const clone = metaWindow.clone;
        const x = clone.x + this.cloneContainer.x;
        const workArea = this.workArea();
        const min = workArea.x;

        if (
            x - margin + clone.width < min ||
            x + margin > min + workArea.width
        ) {
            return false;
        } else {
            return true;
        }
    }

    isFullyVisible(metaWindow: Window) {
        const clone = metaWindow.clone;
        const x = this.visibleX(metaWindow);
        const workArea = this.workArea();
        const min = workArea.x;

        return min <= x && x + clone.width < min + workArea.width;
    }

    visibleRatio(metaWindow: Window) {
        const clone = metaWindow.clone;
        const x = this.visibleX(metaWindow);
        const workArea = this.workArea();
        const min = workArea.x;
        return min <= x && x + clone.width < min + workArea.width;
    }

    /** Whether less than stackMargin of the window is inside the work area. */
    isEdgeStacked(metaWindow: Window) {
        const clone = metaWindow.clone;
        const x = this.visibleX(metaWindow);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            this.monitor!.index
        );
        const min = workArea.x - this.monitor!.x;

        return (
            x + clone.width < min + stackMargin ||
            x > min + workArea.width - stackMargin
        );
    }

    isPlaceable(metaWindow: Window) {
        if (this.isEdgeStacked(metaWindow)) return false;

        const x = this.visibleX(metaWindow);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            this.monitor!.index
        );
        const min = workArea.x - this.monitor!.x;

        // Fullscreen windows are only placeable on the monitor origin
        if (
            (isMaximized(metaWindow) && x !== min) ||
            (metaWindow.fullscreen && x !== 0)
        ) {
            return false;
        }

        /* In workspaces-only-on-primary mutter force-stickies any window it
         * attributes to another monitor and reassigns its workspace once it
         * returns, so a position is only placeable if the real frame can sit
         * there without changing monitors. Non-placeable windows are shown
         * via their clone instead; moveDone keeps the frame on this.monitor. */
        if (mutterSettings.get_boolean('workspaces-only-on-primary')) {
            const frame = metaWindow.get_frame_rect();
            frame.x = this.monitor!.x + x;
            frame.y = this.visibleY(metaWindow);
            if (
                display.get_monitor_index_for_rect(frame) !==
                this.monitor!.index
            ) {
                return false;
            }
        }

        return true;
    }

    getWindows(): Window[] {
        return this.reduce((ws, column) => ws.concat(column), []);
    }

    getWindow(index: number, row: number) {
        if (!Lib.inBounds(this, index)) return null;
        const column = this[index];
        if (!Lib.inBounds(column, row)) return null;
        return column[row];
    }

    isWindowAtPoint(metaWindow: Window, x: number, y: number) {
        const clone = metaWindow.clone;
        const wX = clone.x + this.cloneContainer.x;
        return (
            x >= wX &&
            x <= wX + clone.width &&
            y >= clone.y &&
            y <= clone.y + clone.height
        );
    }

    getWindowAtPoint(x: number, y: number) {
        for (const column of this) {
            for (const w of column) {
                if (this.isWindowAtPoint(w, x, y)) return w;
            }
        }
        return null;
    }

    addWindow(metaWindow: Window, index: number, row?: number) {
        if (!this.selectedWindow) this.selectedWindow = metaWindow;
        if (this.columnOf(metaWindow) !== -1) return false;

        if (row !== undefined && this[index]) {
            const column = this[index];
            column.splice(row, 0, metaWindow);
        } else {
            this.splice(index, 0, [metaWindow]);
        }

        /*
         * Fix (still needed in 45) for bug where move_frame sometimes triggers
         * another move back to its original position. Make sure tiled windows are
         * always positioned correctly (synced with clone position).
         */
        this.signals.connect(metaWindow, 'position-changed', (w: Window) => {
            if (inGrab) return;

            const f = w.get_frame_rect();
            const clone = w.clone;
            let x = this.visibleX(w);
            const y = this.monitor!.y + clone.targetY;
            // Mirrors moveDone, see there.
            if (this.isPlaceable(w)) {
                x = Math.min(
                    this.width! - stackMargin,
                    Math.max(stackMargin - f.width, x)
                );
            } else {
                x = Math.max(0, Math.min(this.width! - f.width, x));
            }
            x += this.monitor!.x;

            // check if mismatch tracking needed, otherwise leave
            if (f.x === x && f.y === y) {
                // delete any mismatch counter (e.g. from previous attempt)
                delete w._pos_mismatch_count;
                return;
            }

            // guard against recursively calling this method
            // see https://github.com/paperwm/PaperWM/issues/769
            if (w._pos_mismatch_count && w._pos_mismatch_count > 1) {
                console.warn(
                    `clone/window position-changed recursive call: ${w.title}`
                );
                return;
            }

            // mismatch detected
            // move frame to ensure window position matches clone
            try {
                if (!w._pos_mismatch_count) {
                    w._pos_mismatch_count = 0;
                } else {
                    w._pos_mismatch_count += 1;
                }
                w.move_frame(true, x, y);
            } catch {}
        });

        Utils.actorReparent(metaWindow.clone, this.cloneContainer);

        // Make sure the cloneContainer is in a clean state (centered) before layout
        if (this.length === 1) {
            const workArea = this.workArea();
            this.targetX =
                workArea.x +
                Math.round((workArea.width - this.cloneContainer.width) / 2);
        }
        this.emit('window-added', metaWindow, index, row);
        return true;
    }

    removeWindow(metaWindow: Window) {
        const index = this.columnOf(metaWindow);
        if (index === -1) return this.removeFloating(metaWindow);

        this.signals.disconnect(metaWindow);

        if (this.selectedWindow === metaWindow) {
            // Select a new window using the stack ordering;
            const windows = this.getWindows();
            const i = windows.indexOf(metaWindow);
            const neighbours = [windows[i - 1], windows[i + 1]].filter(w => w);
            const stack = sortWindows(this, neighbours);
            this.selectedWindow = stack[stack.length - 1];
        }

        const column = this[index];
        const row = column.indexOf(metaWindow);
        column.splice(row, 1);
        if (column.length === 0) {
            this.splice(index, 1);
        }

        this.visible.splice(this.visible.indexOf(metaWindow), 1);

        const clone = metaWindow.clone;
        // this.cloneContainer.remove_child(clone);
        Utils.actorRemoveChild(this.cloneContainer, clone);

        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        if (actor) actor.remove_clip();

        this.layout();
        if (this.selectedWindow) {
            ensureViewport(this.selectedWindow, this);
        } else {
            // can also be undefined here, will set to null explicitly
            this.selectedWindow = null;
        }

        this.emit('window-removed', metaWindow, index, row);
        return true;
    }

    isFloating(metaWindow: Window) {
        return this._floating.indexOf(metaWindow) !== -1;
    }

    addFloating(metaWindow: Window) {
        if (
            this._floating.indexOf(metaWindow) !== -1 ||
            metaWindow.is_on_all_workspaces()
        )
            return false;
        this._floating.push(metaWindow);
        const clone = metaWindow.clone;
        Utils.actorReparent(clone, this.actor);
        return true;
    }

    removeFloating(metaWindow: Window) {
        const i = this._floating.indexOf(metaWindow);
        if (i === -1) return false;
        this._floating.splice(i, 1);
        // this.actor.remove_child(metaWindow.clone);
        Utils.actorRemoveChild(this.actor, metaWindow.clone);
        return true;
    }

    /** Lift a tiled window out of the strip into the floating layer. */
    floatWindow(metaWindow: Window) {
        const fromTiling = this.columnOf(metaWindow) !== -1;
        // Capture the on-screen position before the clone leaves the strip.
        const [seenX, seenY] = fromTiling
            ? metaWindow.clone.get_transformed_position().map(Math.round)
            : [0, 0];

        if (fromTiling) this.removeWindow(metaWindow);
        this.addFloating(metaWindow);
        metaWindow.make_above();
        showWindow(metaWindow);

        if (!fromTiling) {
            Main.activateWindow(metaWindow);
            return;
        }

        /* Restore the saved floating geometry, otherwise nudge the window down
         * and trim its height so it reads as floating. */
        const f = metaWindow.get_frame_rect();
        const saved = metaWindow._floatFrame;
        const onThisMonitor =
            saved &&
            Utils.monitorOfPoint(saved.x, saved.y)?.index ===
                this.monitor?.index;
        const vDisplacement = 30;
        const targetX = onThisMonitor ? saved.x : seenX;
        const targetY = onThisMonitor ? saved.y : seenY + vDisplacement;
        const targetWidth = onThisMonitor ? saved.width : f.width;
        const targetHeight = onThisMonitor
            ? saved.height
            : Math.min(f.height - vDisplacement, Math.floor(f.height * 0.9));

        metaWindow.move_resize_frame(true, f.x, f.y, targetWidth, targetHeight);
        /* Activate only once the ease settles: focusing mid-animation runs a
         * layout that snaps the still-floating clone back to its old frame. */
        Floating.easeFloating(metaWindow, targetX, targetY, {
            onComplete: () => {
                delete metaWindow._floatFrame;
                Main.activateWindow(metaWindow);
            },
        });
    }

    /** Drop a floating window back into the tiling strip. */
    unfloatWindow(metaWindow: Window) {
        /* Remember the floating geometry so a later float can restore it. */
        if (!metaWindow._floatFrame)
            metaWindow._floatFrame = metaWindow.get_frame_rect();

        /* Re-tile through the add path, like unminimize does: it slides the
         * clone from where the window floats into its column in one layout. */
        this.removeFloating(metaWindow);
        insertWindow(metaWindow, { existing: true });
    }

    /**
     * Returns true iff this space has a currently fullscreened window.
     */
    hasFullScreenWindow() {
        return this.getWindows().some(w => w.fullscreen);
    }

    swap(direction: Meta.MotionDirection, metaWindow?: Window) {
        metaWindow = metaWindow || this.selectedWindow!;

        const [index, row] = this.positionOf(metaWindow)!;
        let targetIndex = index;
        let targetRow = row;
        switch (direction) {
            case Meta.MotionDirection.LEFT:
                targetIndex--;
                break;
            case Meta.MotionDirection.RIGHT:
                targetIndex++;
                break;
            case Meta.MotionDirection.DOWN:
                targetRow++;
                break;
            case Meta.MotionDirection.UP:
                targetRow--;
                break;
        }
        const column = this[index];
        if (
            targetIndex < 0 ||
            targetIndex >= this.length ||
            targetRow < 0 ||
            targetRow >= column.length
        )
            return;

        Lib.swap(this[index], row, targetRow);
        Lib.swap(this, index, targetIndex);

        this.layout();
        this.emit('swapped', index, targetIndex, row, targetRow);
        ensureViewport(this.selectedWindow!, this, { force: true });
    }

    switchLinear(dir: number) {
        let index = this.selectedIndex();
        const column = this[index];
        if (!column) return false;
        let row = column.indexOf(this.selectedWindow!);
        if (Lib.inBounds(column, row + dir) === false) {
            index += dir;
            if (dir === 1) {
                if (index < this.length) row = 0;
            } else if (index >= 0) row = this[index].length - 1;
        } else {
            row += dir;
        }

        const metaWindow = this.getWindow(index, row);
        ensureViewport(metaWindow!, this);
        return true;
    }

    switchLeft() {
        return this.switch(Meta.MotionDirection.LEFT);
    }
    switchRight() {
        return this.switch(Meta.MotionDirection.RIGHT);
    }
    switchUp() {
        return this.switch(Meta.MotionDirection.UP);
    }
    switchDown() {
        return this.switch(Meta.MotionDirection.DOWN);
    }
    switch(direction: Meta.MotionDirection) {
        let index = this.selectedIndex();
        if (index === -1) {
            return false;
        }
        let row = this[index].indexOf(this.selectedWindow!);
        switch (direction) {
            case Meta.MotionDirection.RIGHT:
                index++;
                row = -1;
                break;
            case Meta.MotionDirection.LEFT:
                index--;
                row = -1;
        }
        if (!Lib.inBounds(this, index)) {
            return false;
        }

        const column = this[index];

        if (row === -1) {
            const selected =
                this.columnGetLastActive(column) ??
                sortWindows(this, column)[column.length - 1];
            row = column.indexOf(selected);
        }

        switch (direction) {
            case Meta.MotionDirection.UP:
                row--;
                break;
            case Meta.MotionDirection.DOWN:
                row++;
        }
        if (!Lib.inBounds(column, row)) {
            return false;
        }

        const metaWindow = this.getWindow(index, row);
        ensureViewport(metaWindow!, this);

        return true;
    }

    /**
     * Return the x position of the visible element of this window.
     */
    visibleX(metaWindow: Window) {
        return metaWindow.clone.targetX + this.targetX;
    }

    /**
     * Return the y position of the visible element of this window.
     */
    visibleY(metaWindow: Window) {
        return metaWindow.clone.targetY + this.monitor!.y;
    }

    /**
     * Stage rect of the AlbumWM clone for this window. Used by the
     * `WindowPreview.boundingBox` override in patches.js so the overview
     * open/close animation interpolates toward where the clone visually
     * sits in the tiling grid rather than `meta_window_get_frame_rect()`
     * (which lies for non-placeable / fullscreen / maximized windows).
     */
    cloneStageRect(metaWindow: Window) {
        const clone = metaWindow?.clone;
        if (!clone) return null;
        return {
            x: this.monitor!.x + this.cloneContainer.x + clone.x,
            y: this.monitor!.y + clone.y,
            width: clone.width,
            height: clone.height,
        };
    }

    positionOf(metaWindow?: Window) {
        metaWindow = metaWindow || this.selectedWindow!;
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow))
                return [i, this[i].indexOf(metaWindow)];
        }
        return null;
    }

    columnOf(metaWindow: Window) {
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow)) return i;
        }
        return -1;
    }

    /** Remember `metaWindow` as its column's last-focused window. */
    columnSetLastActive(metaWindow: Window) {
        const index = this.columnOf(metaWindow);
        if (index !== -1)
            this.columnsLastActiveWindows.set(this[index], metaWindow);
    }

    /** The window `column` last had focused, if still present; else null. */
    columnGetLastActive(column: Window[]): Window | null {
        const remembered = this.columnsLastActiveWindows.get(column);
        return remembered && column.includes(remembered) ? remembered : null;
    }

    rowOf(metaWindow: Window) {
        const column = this[this.columnOf(metaWindow)];
        return column.indexOf(metaWindow);
    }

    globalToViewport(gx: number, gy: number) {
        const [, vx, vy] = this.actor.transform_stage_point(gx, gy);
        return [Math.round(vx), Math.round(vy)];
    }

    /** Transform global coordinates to scroll cooridinates (cloneContainer relative) */
    globalToScroll(gx: number, gy: number, { useTarget = false } = {}) {
        // Use the smart transform on the actor, as that's the one we scale etc.
        // We can then use straight translation on the scroll which makes it possible to use target instead if wanted.
        const [vx, vy] = this.globalToViewport(gx, gy);
        const sx = vx - (useTarget ? this.targetX : this.cloneContainer.x);
        const sy = vy - this.cloneContainer.y;
        return [Math.round(sx), Math.round(sy)];
    }

    viewportToScroll(vx: number, vy = 0) {
        return [vx - this.cloneContainer.x, vy - this.cloneContainer.y];
    }

    /**
     * Moves the space viewport to position x.
     */
    viewportMoveToX(x: number) {
        this.targetX = x;
        this.cloneContainer.x = x;
        this.startAnimate();
        Easer.addEase(this.cloneContainer, {
            x,
            time: Settings.prefs!.animation_time,
            onComplete: this.moveDone.bind(this),
        });
    }

    moveDone(focusedWindowCallback = (_focusedWindow: Meta.Window) => {}) {
        if (
            this.cloneContainer.x !== this.targetX ||
            this.actor.y !== 0 ||
            inTransient() ||
            Main.overview.visible ||
            // Block when we're carrying a window in dnd
            (inGrab instanceof Grab.MoveGrab && inGrab.window)
        ) {
            return;
        }

        this.visible = [];
        const monitor = this.monitor!;
        this.getWindows().forEach(w => {
            const actor = w.get_compositor_private();
            if (!actor) return;

            const placeable = this.isPlaceable(w);
            if (placeable) this.visible.push(w);

            /* Guard against races between move_to and layout
               (moving can kill an ongoing resize). */
            if (Easer.isEasing(w.clone)) return;

            const unMovable = w.fullscreen || isMaximized(w);
            if (unMovable) return;

            const f = w.get_frame_rect();
            let x = this.visibleX(w);
            const y = this.visibleY(w);
            /* Non-placeable actors must stay on this.monitor or mutter
             * reassigns them; isPlaceable already rules out any position
             * that would change the window's monitor. */
            if (placeable) {
                x = Math.max(stackMargin - f.width, x);
                x = Math.min(this.width! - stackMargin, x);
            } else {
                x = Math.max(0, Math.min(this.width! - f.width, x));
            }
            x += monitor.x;
            // let b = w.get_frame_rect();
            if (f.x !== x || f.y !== y) {
                w.move_frame(true, x, y);
            }
        });

        this.visible.forEach(w => {
            if (Easer.isEasing(w.clone)) return;
            this.applyClipToClone(w);
            showWindow(w);
        });

        this._floating.forEach(showWindow);

        this.fixOverlays();

        // See startAnimate
        Main.layoutManager.untrackChrome(this.background!);

        this._isAnimating = false;

        if (
            this.selectedWindow &&
            this.selectedWindow === display.focus_window
        ) {
            const index = this.columnOf(this.selectedWindow);

            this[index].forEach(w => (w.lastFrame = w.get_frame_rect()));

            // callback on display.focusWindow window
            focusedWindowCallback(display.focus_window);
        }

        this.emit('move-done');
    }

    /**
     * Applies clipping to metaWindow's clone.
     */
    applyClipToClone(metaWindow: Window) {
        if (!metaWindow) {
            return;
        }

        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        if (!actor) {
            return;
        }

        // The actor's width/height is not correct right after resize
        const b = metaWindow.get_buffer_rect();
        const x = this.monitor!.x - b.x;
        const y = this.monitor!.y - b.y;
        const cw = this.monitor!.width;
        const ch = this.monitor!.height;
        actor.set_clip(x, y, cw, ch);
    }

    startAnimate() {
        if (!this._isAnimating) {
            // Tracking the background fixes issue #80
            // It also let us activate window clones clicked during animation
            // Untracked in moveDone
            Main.layoutManager.trackChrome(this.background!);
        }

        this.visible.forEach(w => {
            const actor = w.get_compositor_private<Clutter.Actor>();
            if (!actor) return;
            actor.remove_clip();
            if (inGrab instanceof Grab.MoveGrab && inGrab.window === w) return;
            animateWindow(w);
        });

        this._floating.forEach(w => {
            const f = w.get_frame_rect();
            if (!animateWindow(w)) return;
            w.clone.x = f.x - this.monitor!.x;
            w.clone.y = f.y - this.monitor!.y;
        });

        this._isAnimating = true;
    }

    fixOverlays(metaWindow?: Window) {
        metaWindow = metaWindow || this.selectedWindow!;
        const index = this.columnOf(metaWindow);
        const target = this.targetX;
        this.monitor!.clickOverlay!.reset();
        for (
            let overlay = this.monitor!.clickOverlay!.right, n = index + 1;
            n < this.length;
            n++
        ) {
            const mw = this[n][0];
            const clone = mw.clone;
            const x = clone.targetX + target;
            if (!overlay.target && x + clone.width > this.width!) {
                overlay.setTarget(this, n);
                break;
            }
        }

        for (
            let overlay = this.monitor!.clickOverlay!.left, n = index - 1;
            n >= 0;
            n--
        ) {
            const mw = this[n][0];
            const clone = mw.clone;
            const x = clone.targetX + target;
            if (!overlay.target && x < 0) {
                overlay.setTarget(this, n);
                break;
            }
        }
    }

    initWorkspaceState() {
        this.updateShowTopBar();

        this.signals.connect(
            gsettings!,
            'changed::default-show-top-bar',
            this.updateShowTopBar.bind(this)
        );
    }

    updateShowTopBar() {
        this.showTopBar = Settings.prefs!.default_show_top_bar;
        if (this._populated) Topbar.fixTopBar();
    }

    createBackground() {
        /* Transparent input actor for click/scroll on the empty area of the
           space. Mutter draws the actual wallpaper underneath. */
        this.background = new Clutter.Actor({
            name: 'background',
            reactive: true,
        });

        this.actor.insert_child_below(this.background, null);

        this.signals.connect(
            this.background,
            'button-press-event',
            (_actor: Clutter.Actor, _event: Clutter.Event) => {
                if (inGrab) {
                    return;
                }

                /* If user clicks on a window, ensureViewport on that window before exiting. */
                const [gx, gy] = global.get_pointer();
                const [, x, y] = this.actor.transform_stage_point(gx, gy);
                const windowAtPoint =
                    !Gestures.gliding && this.getWindowAtPoint(x, y);
                if (windowAtPoint) {
                    ensureViewport(windowAtPoint, this);
                }

                spaces.selectedSpace = this;
                Navigator.finishNavigation();
            }
        );

        // ensure this space is active if touched
        this.signals.connect(
            this.background,
            'touch-event',
            (_actor: Clutter.Actor, _event: Clutter.Event) => {
                this.activateWithFocus(this.selectedWindow!);
            }
        );

        this.signals.connect(
            this.background,
            'scroll-event',
            (_actor: Clutter.Actor, event: Clutter.Event) => {
                if (!inGrab && !inTransient()) return;
                const dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.SMOOTH) return;

                const [gx] = event.get_coords();
                if (!gx) {
                    return;
                }

                switch (dir) {
                    case Clutter.ScrollDirection.LEFT:
                    case Clutter.ScrollDirection.UP:
                        this.switchLeft();
                        break;
                    case Clutter.ScrollDirection.RIGHT:
                    case Clutter.ScrollDirection.DOWN:
                        this.switchRight();
                        break;
                }
            }
        );

        this.signals.connect(
            this.background,
            'captured-event',
            (actor: Clutter.Actor, event: Clutter.Event) => {
                return Gestures.horizontalScroll(this, actor, event);
            }
        );
    }

    setMonitor(monitor: Monitor) {
        this.monitor = monitor;
        this.width = monitor.width;
        this.height = monitor.height;

        this.actor.set_position(0, 0);
        this.actor.set_scale(1, 1);

        const clip = this.clip;
        clip.set_scale(1, 1);
        clip.set_position(monitor.x, monitor.y);
        clip.set_size(monitor.width, monitor.height);
        clip.set_clip(0, 0, monitor.width, monitor.height);

        this.background!.set_size(monitor.width, monitor.height);

        this.cloneClip.set_size(monitor.width, monitor.height);
        this.cloneClip.set_clip(0, 0, monitor.width, monitor.height);
        /* transforms break if there's no height */
        this.cloneContainer.height = monitor.height;

        this.layout(true, { centerIfOne: false });
        this.emit('monitor-changed');
    }

    /**
       Add existing windows on workspace to the space. Restore the
       layout of prevSpace if present.
    */
    addAll(prevSpace: Space | undefined) {
        // On gnome-shell-restarts the windows are moved into the viewport, but
        // they're moved minimally and the stacking is not changed, so the tiling
        // order is preserved (sans full-width windows..)
        const xzComparator = (windows: Window[]) => {
            // Seems to be the only documented way to get stacking order?
            // Could also rely on the MetaWindowActor's index in it's parent
            // children array: That seem to correspond to clutters z-index (note:
            // z_position is something else)
            const sortedZ = display.sort_windows_by_stacking(windows);
            const xkey = (mw: Window) => {
                const frame = mw.get_frame_rect();
                if (frame.x <= 0) return 0;
                if (frame.x + frame.width === this.width) {
                    return this.width;
                }
                return frame.x;
            };
            // xorder: a|b c|d
            // zorder: a d b c
            return (a: Window, b: Window) => {
                const ax = xkey(a);
                const bx = xkey(b);
                // Yes, this is not efficient
                const az = sortedZ.indexOf(a);
                const bz = sortedZ.indexOf(b);
                const xcmp = ax - bx;
                if (xcmp !== 0) return xcmp;

                if (ax === 0) {
                    // Left side: lower stacking first
                    return az - bz;
                } else {
                    // Right side: higher stacking first
                    return bz - az;
                }
            };
        };

        if (prevSpace) {
            for (let i = 0; i < prevSpace.length; i++) {
                const column = prevSpace[i];
                for (let j = 0; j < column.length; j++) {
                    const metaWindow = column[j];
                    // Prune removed windows
                    if (metaWindow.get_compositor_private()) {
                        this.addWindow(metaWindow, i, j);
                    } else {
                        column.splice(j, 1);
                        j--;
                    }
                }
                if (column.length === 0) {
                    prevSpace.splice(i, 1);
                    i--;
                }
            }
        }

        const workspace = this.workspace;
        const windows = (workspace.list_windows() as Window[]).sort(
            xzComparator(workspace.list_windows() as Window[])
        );

        windows.forEach(metaWindow => {
            if (metaWindow.minimized) {
                // Leave minimized windows minimized and untiled.
                return;
            }
            if (metaWindow.above) {
                /* Always-on-top windows (e.g. ones we previously floated)
                 * belong in the floating layer, which keeps them above tiling. */
                this.addFloating(metaWindow);
                metaWindow.make_above();
                showWindow(metaWindow);
                return;
            }
            if (this.columnOf(metaWindow) < 0 && addFilter(metaWindow)) {
                this.addWindow(metaWindow, this.length);
            }
        });

        const tabList = (
            display.get_tab_list(Meta.TabList.NORMAL, workspace) as Window[]
        ).filter(metaWindow => {
            return this.columnOf(metaWindow) !== -1;
        });
        if (tabList[0]) {
            this.selectedWindow = tabList[0];
        }
    }

    // Fix for eg. space.map, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes#Species
    static get [Symbol.species]() {
        return Array;
    }

    selectedIndex() {
        if (this.selectedWindow) {
            return this.columnOf(this.selectedWindow);
        } else {
            return -1;
        }
    }

    destroy() {
        this.getWindows().forEach(w => {
            removeAlbumWMFlags(w);
        });
        this.signals.destroy();
        this.background!.destroy();
        this.cloneContainer.destroy();
        this.clip.destroy();
    }
}

Signals.addSignalMethods(Space.prototype);

// Added to the prototype by Signals.addSignalMethods below
export interface Spaces extends SignalMethods {}
/**
 * A `Map` to store all `Spaces`'s, indexed by the corresponding workspace.
 */
export class Spaces extends Map<Meta.Workspace, Space> {
    _initDone: boolean;
    clickOverlays: ClickOverlay[];
    signals: Utils.Signals;
    stack: Space[];
    spaceContainer: Meta.BackgroundGroup;
    touchSignal?: number;
    _selectedSpace?: Space;

    // Fix for eg. space.map, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes#Species
    static get [Symbol.species]() {
        return Map;
    }
    constructor() {
        super();
        this._initDone = false;
        this.clickOverlays = [];
        this.signals = new Utils.Signals();
        this.stack = [];
        /* MetaBackgroundGroup so mutter's sync_actor_stacking lowers us along
           with _backgroundGroup; a plain Clutter.Actor would be ignored and
           drift to the top of window_group, blocking clicks to windows. */
        const spaceContainer = new Meta.BackgroundGroup({
            name: 'spaceContainer',
        });
        spaceContainer.hide();
        this.spaceContainer = spaceContainer;

        global.window_group.insert_child_above(
            this.spaceContainer,
            Main.layoutManager._backgroundGroup
        );

        // Hook up existing workspaces
        for (let i = 0; i < workspaceManager.n_workspaces; i++) {
            const workspace = workspaceManager.get_workspace_by_index(i)!;
            this.addSpace(workspace);
        }
        this.signals.connect(workspaceManager, 'notify::n-workspaces', () =>
            this.workspacesChanged()
        );

        this.signals.connect(workspaceManager, 'workspaces-reordered', () =>
            this.workspacesChanged()
        );
    }

    init() {
        // Create extra workspaces if required
        // @ts-expect-error not typed in girs
        Main.wm._workspaceTracker._checkWorkspaces();

        /* Monitors aren't set up properly on `enable`, so we need it enable here. */
        this.monitorsChanged();
        this.signals.connect(Main.layoutManager, 'monitors-changed', () =>
            this.monitorsChanged()
        );

        this.signals.connect(
            display,
            'window-created',
            (_display, metaWindow, _userData) => this.window_created(metaWindow)
        );

        this.signals.connect(display, 'grab-op-begin', (_display, mw, type) =>
            grabBegin(mw, type)
        );
        this.signals.connect(display, 'grab-op-end', (_display, mw, type) =>
            grabEnd(mw, type)
        );

        this.signals.connect(
            display,
            'window-entered-monitor',
            (_display: Meta.Display, _monitor: number, mw: Window) =>
                syncMonitorMembership(mw)
        );

        this.signals.connect(
            global.window_manager,
            'switch-workspace',
            (wm, from, to, _direction) => this.switchWorkspace(wm, from, to)
        );

        // Clone and hook up existing windows
        (
            display.get_tab_list(Meta.TabList.NORMAL_ALL, null) as Window[]
        ).forEach(w => {
            // remove flags
            removeAlbumWMFlags(w);

            registerWindow(w);
            // Fixup allocations on reload
            allocateClone(w);
            addResizeHandler(w);
            addPositionHandler(w);
        });
        this._initDone = true;

        // Initialize spaces _after_ monitors are set up
        this.forEach(space => space.init());

        // Bind to visible workspace when starting up
        this.touchSignal = signals!.connect(
            Main.panel,
            'touch-event',
            Gestures.horizontalTouchScroll.bind(this.activeSpace)
        );

        this.stack = this.mru();
    }

    monitorsChanged() {
        /* Can fire async (after delay) on disable, so use activeSpace as a liveness check. */
        if (!this.activeSpace) {
            return;
        }

        this.activeSpace.getWindows().forEach(w => animateWindow(w));
        this.spaceContainer.set_size(global.screen_width, global.screen_height);

        for (const overlay of this.clickOverlays) {
            overlay.destroy();
        }
        this.clickOverlays = [];

        const primary = Main.layoutManager.primaryMonitor as Monitor;
        if (!primary) {
            /* Cold path: mutter occasionally reports no primary monitor mid-hotplug.
               Retry layout 5 times at 1s intervals and bail. */
            monitorChangeTimeout = Utils.periodicTimeout({
                count: 5,
                init: () => Utils.timeoutRemove(monitorChangeTimeout),
                callback: () => this?.forEach(s => s.layout()),
                onContinue: called =>
                    console.warn(
                        `MONITORS_CHANGED: no primary monitor, 'layout' on spaces call ${called}`
                    ),
                onComplete: () => {
                    monitorChangeTimeout = null;
                },
            });
            return;
        }

        const overlay = new ClickOverlay(primary);
        primary.clickOverlay = overlay;
        this.clickOverlays.push(overlay);

        this.forEach(space => space.setMonitor(primary));

        const activeSpace = this.activeSpace;
        if (activeSpace) {
            activeSpace.activate();
            this.selectedSpace = activeSpace;
        }
        this.forEach(space => {
            if (space === activeSpace) {
                space.show();
                Utils.actorRaise(space.clip);
            } else {
                space.hide();
            }
        });

        this.spaceContainer.show();
    }

    destroy() {
        for (const overlay of this.clickOverlays) {
            overlay.destroy();
        }
        for (const monitor of Main.layoutManager.monitors as Monitor[]) {
            delete monitor.clickOverlay;
        }

        (
            display.get_tab_list(Meta.TabList.NORMAL_ALL, null) as Window[]
        ).forEach(metaWindow => {
            const actor = metaWindow.get_compositor_private<Clutter.Actor>();
            actor.remove_clip();

            if (metaWindow.clone) {
                metaWindow.clone.destroy();
                metaWindow.clone = null!;
            }

            metaWindow._targetHeight = null;
            metaWindow._targetWidth = null;

            if (
                metaWindow.get_workspace() ===
                    workspaceManager.get_active_workspace() &&
                !metaWindow.minimized
            ) {
                actor.show();
            } else {
                actor.hide();
            }
        });

        this.signals.destroy();

        // remove spaces
        for (const [, space] of this) {
            this.removeSpace(space);
        }

        this.spaceContainer.destroy();
    }

    workspacesChanged() {
        const nWorkspaces = workspaceManager.n_workspaces;

        // Identifying destroyed workspaces is rather bothersome,
        // as it will for example report having windows,
        // but will crash when looking at the workspace index

        // Gather all indexed workspaces for easy comparison
        const workspaces: Set<Meta.Workspace> = new Set();
        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = workspaceManager.get_workspace_by_index(i)!;
            workspaces.add(workspace);
            if (this.spaceOf(workspace) === undefined) {
                this.addSpace(workspace);
            }
        }

        for (const [, space] of this) {
            if (!workspaces.has(space.workspace)) {
                this.removeSpace(space);
            }
        }
    }

    switchWorkspace(_wm: Window, _fromIndex: number, toIndex: number) {
        /**
         * disable swipetrackers on workspace switch to avoid gesture confusion
         * see https://github.com/paperwm/PaperWM/issues/682
         */
        if (Gestures.gestureEnabled()) {
            // if in overview exit -> overview will disable swipetrackers when done
            if (!Main.overview.visible) {
                Gestures.swipeTrackersEnable(false);
            }
        }

        const to = workspaceManager.get_workspace_by_index(toIndex)!;
        const toSpace = this.spaceOf(to);

        if (inGrab instanceof Grab.MoveGrab && inGrab.window) {
            inGrab.window.change_workspace(toSpace.workspace);
        }

        for (const metaWindow of toSpace.getWindows()) {
            // Make sure all windows belong to the correct workspace.
            // Note: The 'switch-workspace' signal (this method) runs before mutter decides on focus window.
            // This simplifies other code moving windows between workspaces.
            // Eg.: The DnD-window defer changing its workspace until the workspace actually is activated.
            //      This ensures the DnD window keep focus the whole time.
            metaWindow.change_workspace(toSpace.workspace);
        }

        this.stack = this.stack.filter(s => s !== toSpace);
        this.stack = [toSpace, ...this.stack];

        this.showSpace(toSpace);

        // Update panel to handle target workspace
        signals!.disconnect(Main.panel, this.touchSignal);
        this.touchSignal = signals!.connect(
            Main.panel,
            'touch-event',
            Gestures.horizontalTouchScroll.bind(toSpace)
        );
    }

    showSpace(to: Space) {
        this.selectedSpace = to;
        to.show();
        const selected = to.selectedWindow;
        if (selected) ensureViewport(selected, to);

        Easer.removeEase(to.actor);
        to.actor.set_position(0, 0);
        to.actor.set_scale(1, 1);

        for (const space of this.values()) {
            if (space !== to) {
                Easer.removeEase(space.actor);
                space.hide();
            }
        }

        Utils.actorRaise(to.clip);
        to.startAnimate();
        to.moveDone();
    }

    addSpace(workspace: Meta.Workspace) {
        const space = new Space(workspace, this.spaceContainer, this._initDone);
        this.set(workspace, space);
        this.stack.push(space);
    }

    removeSpace(space: Space) {
        this.delete(space.workspace);
        this.stack.splice(this.stack.indexOf(space), 1);
        space.destroy();
    }

    /**
     * The space that manages metaWindow, i.e. has it tiled or in its
     * floating layer. Undefined for unmanaged windows.
     */
    spaceOfWindow(metaWindow: Window): Space | undefined {
        const space = this.get(metaWindow.get_workspace());
        if (
            space &&
            (space.columnOf(metaWindow) !== -1 || space.isFloating(metaWindow))
        ) {
            return space;
        }
        return undefined;
    }

    spaceOf(workspace: Meta.Workspace): Space {
        return this.get(workspace)!;
    }

    /**
     * Returns the space by it's workspace index value.
     */
    spaceOfIndex(workspaceIndex: number) {
        const workspace = [...this.keys()].find(
            w => workspaceIndex === w.index()
        );
        return this.spaceOf(workspace!);
    }

    /**
     * Returns the space of a specific uuid.
     */
    spaceOfUuid(uuid: string) {
        return [...this.values()].find(s => uuid === s.uuid);
    }

    get selectedSpace() {
        return this._selectedSpace ?? this.activeSpace;
    }

    set selectedSpace(space) {
        this._selectedSpace = space;
    }

    /**
     * Returns the currently active space.
     */
    get activeSpace() {
        return this.spaceOf(workspaceManager.get_active_workspace());
    }

    /**
     * Returns true if the space is the currently active space.
     */
    isActiveSpace(space: Space) {
        return space === this.activeSpace;
    }

    /**
       Return an array of Space's ordered in most recently used order.
     */
    mru(): Space[] {
        const seen = new Map(),
            out = [];
        const active = workspaceManager.get_active_workspace();
        out.push(this.get(active)!);
        seen.set(active, true);

        display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach((metaWindow, _i) => {
                const workspace = metaWindow.get_workspace();
                if (!seen.get(workspace)) {
                    out.push(this.get(workspace)!);
                    seen.set(workspace, true);
                }
            });

        const workspaces = workspaceManager.get_n_workspaces();
        for (let i = 0; i < workspaces; i++) {
            const workspace = workspaceManager.get_workspace_by_index(i)!;
            if (!seen.get(workspace)) {
                out.push(this.get(workspace)!);
                seen.set(workspace, true);
            }
        }

        return out;
    }

    window_created(metaWindow: Window) {
        if (!registerWindow(metaWindow)) {
            return;
        }

        metaWindow.unmapped = true;

        console.debug('window-created', metaWindow?.title);

        // Windows opening on a secondary monitor stay there, unmanaged.

        const actor = metaWindow.get_compositor_private();
        animateWindow(metaWindow);

        /* We need reliable 'window_type', 'wm_class' et al. to handle window
           insertion correctly. These are not stable before 'first-frame'. */
        signals!.connectOneShot(actor, 'first-frame', () => {
            allocateClone(metaWindow);
            insertWindow(metaWindow, { existing: false });
        });
    }
}
Signals.addSignalMethods(Spaces.prototype);

/**
 * Return true if a window is tiled (e.g. not floating, not transient).
 */
export function isTiled(metaWindow: Window) {
    if (
        !metaWindow ||
        metaWindow?.is_on_all_workspaces() ||
        isFloating(metaWindow) ||
        isTransient(metaWindow)
    ) {
        return false;
    }

    return true;
}

/**
 * Transient windows are connected to a parent window and take entire focus
 * (can't focus parent window while it's open).
 */
export function isTransient(metaWindow: Window) {
    if (!metaWindow) {
        return false;
    }
    if (metaWindow.get_transient_for()) {
        return true;
    } else {
        return false;
    }
}

/**
 * Returns true if a metaWindow has at least one transient window.
 */
export function hasTransient(metaWindow: Window) {
    if (!metaWindow) {
        return false;
    }
    let found = false;
    metaWindow.foreach_transient(_t => {
        found = true;
        return false;
    });

    return found;
}

/**
 * Conveniece method for checking if a window is floating.
 * Will determine what space this window is on.
 */
export function isFloating(metaWindow: Window) {
    if (!metaWindow) {
        return false;
    }
    return spaces.spaceOfWindow(metaWindow)?.isFloating(metaWindow) ?? false;
}

export function isMaximized(metaWindow: Window) {
    if (!metaWindow) {
        return false;
    }
    return metaWindow.is_maximized();
}

function isMaximizedHorizontal(metaWindow: Window) {
    if (!metaWindow) {
        return false;
    }
    return metaWindow.get_maximize_flags() === Meta.MaximizeFlags.HORIZONTAL;
}

function unmaximize(metaWindow: Window, flags: Meta.MaximizeFlags) {
    if (!metaWindow) {
        return false;
    }
    return metaWindow.set_unmaximize_flags(flags);
}

export function isOverrideRedirect(metaWindow: Window) {
    const windowType = metaWindow.windowType;
    return (
        metaWindow.is_override_redirect() ||
        windowType === Meta.WindowType.DROPDOWN_MENU ||
        windowType === Meta.WindowType.TOOLTIP
    );
}

export function registerWindow(metaWindow: Window) {
    if (isOverrideRedirect(metaWindow)) {
        return false;
    }

    if (metaWindow.clone) {
        // Can happen when setting session-modes to "unlock-dialog".
        console.warn('window already registered', metaWindow.title);
        return false;
    }

    // create shade
    const shade = new St.Widget({ style_class: 'albumwm-clone-shade' });
    // default opacity
    Utils.actorRaise(shade);
    shade.opacity = 0;
    shade.hide();

    const actor = metaWindow.get_compositor_private<Clutter.Actor>();
    const cloneActor = new Clutter.Clone({ source: actor });
    const clone: Clone = Object.assign(new Clutter.Actor(), {
        cloneActor: cloneActor,
        shade: shade,
        targetX: 0,
        targetY: 0,
        meta_window: metaWindow,
    });
    clone.add_child(cloneActor);
    clone.add_child(shade);

    metaWindow.clone = clone;

    signals!.connect(metaWindow, 'focus', (mw, _userData) => {
        focusHandler(mw);
    });
    /* Once 'unmanaging' fires the wayland shell surface is detached and
     * moving or resizing the window segfaults mutter, yet the refocus
     * runs before 'window-removed' evicts it from its space. Evict up
     * front so membership guards keep every handler off the window. */
    signals!.connect(metaWindow, 'unmanaging', mw => {
        spaces.spaceOfWindow(mw)?.removeWindow(mw);
    });
    signals!.connect(metaWindow, 'size-changed', allocateClone);
    // Note: runs before gnome-shell's minimize handling code
    signals!.connect(metaWindow, 'notify::fullscreen', () => {
        // if window is in a column, expel it
        barf(metaWindow, metaWindow);

        /**
         * Set fullscreen windows to "always on top".  This is to ensure
         * that the fullscreened window is "above" modal windows.
         */
        if (metaWindow.fullscreen) {
            // get current "above" value (for later restoring)
            metaWindow._fullscreen_above = metaWindow.is_above();
            metaWindow.make_above();
        } else if (metaWindow._fullscreen_above !== null) {
            if (!metaWindow._fullscreen_above) {
                metaWindow.unmake_above();
            }
            delete metaWindow._fullscreen_above;
        }
    });
    signals!.connect(metaWindow, 'notify::minimized', mw => {
        minimizeHandler(mw);
    });

    signals!.connect(actor, 'show', a => {
        showHandler(a);
    });

    /**
     * Check when moving window that it's targetHeight is correct.
     */
    signals!.connect(actor, 'stage-views-changed', _actor => {
        const f = metaWindow.get_frame_rect();
        if (metaWindow._targetHeight !== f.height) {
            resizeHandler(metaWindow);
        }
    });

    signals!.connect(actor, 'destroy', destroyHandler);
    return true;
}

export function allocateClone(metaWindow: Window) {
    if (!metaWindow?.clone) {
        return;
    }

    const frame = metaWindow.get_frame_rect();
    const buffer = metaWindow.get_buffer_rect();
    // Adjust the clone's origin to the north-west, so it will line up
    // with the frame.
    const clone = metaWindow.clone;
    const cloneActor = clone.cloneActor;
    cloneActor.set_position(buffer.x - frame.x, buffer.y - frame.y);
    cloneActor.set_size(buffer.width, buffer.height);
    clone.set_size(frame.width, frame.height);

    // update shade sizing too, we want it a little bigger
    const [width, height] = clone.get_size();
    metaWindow.clone.shade.set_position(-1, -1);
    metaWindow.clone.shade.set_size(width + 2, height + 2);
}

export function destroyHandler(actor: Clutter.Actor) {
    signals!.disconnect(actor);
}

/**
 * Removes resize, position, and other flags.  Used during cleanup etc.
 */
export function removeAlbumWMFlags(w: Window) {
    delete w._targetWidth;
    delete w._targetHeight;
    delete w._resizeHandlerAdded;
    delete w._positionHandlerAdded;
    delete w._pos_mismatch_count;
    delete w._tiled_on_minimize;
    delete w._fullscreen_frame;
    delete w._fullscreen_lock;
    delete w._fullscreen_above;
    delete w._floatFrame;
}

export function addPositionHandler(metaWindow: Window) {
    if (metaWindow._positionHandlerAdded) {
        return;
    }
    signals!.connect(metaWindow, 'position-changed', positionChangeHandler);
    metaWindow._positionHandlerAdded = true;
}

export function addResizeHandler(metaWindow: Window) {
    if (metaWindow._resizeHandlerAdded) {
        return;
    }
    signals!.connect(metaWindow, 'size-changed', mw => {
        Utils.laterAdd(Meta.LaterType.RESIZE, () => {
            resizeHandler(mw);

            return GLib.SOURCE_REMOVE;
        });
    });
    metaWindow._resizeHandlerAdded = true;
}

export function positionChangeHandler(metaWindow: Window) {
    // don't update saved position if fullscreen
    if (metaWindow.fullscreen || metaWindow?._fullscreen_lock) {
        return;
    }

    saveFullscreenFrame(metaWindow);
}

/**
 * Monitor policy (on "window-entered-monitor": a crossing fires no
 * workspace signal with workspaces-only-on-primary off): unmanaged windows
 * reaching the primary go above the strip; native move grabs leaving it
 * unmanage. Grab-gated since edge-stacked members hang past the monitor.
 */
function syncMonitorMembership(metaWindow: Window) {
    /* No actor means mid-construction: mutter emits window-entered-monitor
     * before stacking the window, and make_above here would stack it early,
     * tripping meta_stack_add's re-entry check (abort). */
    if (!metaWindow.get_compositor_private()) return;

    if (metaWindow === settlingDrop?.window) return;
    const primary = Main.layoutManager.primaryMonitor;
    if (!primary) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (metaWindow.get_monitor() === primary.index) {
        if (
            !space &&
            !metaWindow.is_on_all_workspaces() &&
            !metaWindow.is_above()
        ) {
            metaWindow.make_above();
        }
    } else if (space && !inGrab && metaWindow === movingWindow) {
        space.removeWindow(metaWindow);
        showWindow(metaWindow);
    }
}

export function resizeHandler(metaWindow: Window) {
    // if navigator is showing, reset/refresh it after a window has resized
    if (Navigator.navigating) {
        Navigator.getNavigator().minimaps.forEach(
            m => typeof m !== 'number' && m.reset()
        );
    }

    if (inGrab instanceof Grab.MoveGrab && inGrab.window === metaWindow) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) {
        return;
    }

    const f = metaWindow.get_frame_rect();
    metaWindow._targetWidth = null;
    metaWindow._targetHeight = null;

    if (space.columnOf(metaWindow) === -1) {
        nonTiledSizeHandler(metaWindow);
        return;
    }

    const mover = (mx: number, animate: boolean) => {
        moveTo(space, metaWindow, {
            x: mx,
            animate,
        });
    };

    // if window is fullscreened, then don't animate background space.container animation etc.
    if (metaWindow.fullscreen) {
        metaWindow._fullscreen_lock = true;
        space.layout(false, {
            callback: () => mover(0, false),
            centerIfOne: false,
        });
        return;
    }

    let x = (metaWindow._fullscreen_frame?.x ?? f.x) - space.monitor!.x;

    // for non-maximised windows, enforce horizontal margin in restore position
    if (!isMaximized(metaWindow) && !isMaximizedHorizontal(metaWindow)) {
        x = Math.max(x, Settings.prefs!.horizontal_margin);
    }

    const wasFullscreen = metaWindow._fullscreen_lock;
    if (wasFullscreen) {
        delete metaWindow._fullscreen_lock;
    } else {
        // save width for later exit-fullscreen restoring
        saveFullscreenFrame(metaWindow, true);
    }

    if (!space._inLayout) {
        // Restore window position when eg. exiting fullscreen
        let callback = () => {};
        if (
            wasFullscreen &&
            !inTransient() &&
            metaWindow === space.selectedWindow
        ) {
            callback = () => mover(x, true);
        }

        // Resizing from within a size-changed signal is trouble; queue instead.
        space.queueLayout(true, { callback, centerIfOne: false });
    }

    if (space.length === 1) {
        centerWindow(metaWindow);
    }
}

/**
 * ResizeHandler for non-tiled windows
 */
export function nonTiledSizeHandler(metaWindow: Window) {
    // if window is fullscreen ==> set lock
    if (metaWindow.fullscreen) {
        metaWindow._fullscreen_lock = true;
        return;
    }

    // if here then was previously in fullscreen (and came out of)
    if (metaWindow._fullscreen_lock) {
        delete metaWindow._fullscreen_lock;
        const fsf = metaWindow._fullscreen_frame;
        if (fsf) {
            metaWindow.move_resize_frame(
                true,
                fsf.x,
                fsf.y,
                fsf.width,
                fsf.height
            );
            delete metaWindow._fullscreen_frame;
        }
    } else {
        saveFullscreenFrame(metaWindow);
    }
}

/**
 * Saves a metaWindow's frame x, y ,width, and height for restoring
 * after exiting fullscreen mode.
 */
export function saveFullscreenFrame(metaWindow: Window, tiled?: boolean) {
    const f = metaWindow.get_frame_rect();
    const fsf =
        metaWindow._fullscreen_frame ??
        ({} as NonNullable<Window['_fullscreen_frame']>);
    metaWindow._fullscreen_frame = fsf;
    // offset by space's monitor.x
    fsf.x = f.x;
    fsf.y = f.y;
    fsf.width = f.width;
    fsf.height = f.height;

    // if from tiled, save tiledWidth for tiling width tracking
    if (tiled) {
        fsf.tiledWidth = f.width;
    }
}

/**
 * A window that opened fullscreen has no windowed frame to restore on exit,
 * so make one up: half the work area wide.
 */
export function seedFullscreenFrame(metaWindow: Window, space: Space) {
    const workArea = space.workArea();
    const width = Math.round(workArea.width / 2);
    metaWindow._fullscreen_frame = {
        x: space.monitor!.x + workArea.x + Settings.prefs!.horizontal_margin,
        y: space.monitor!.y + workArea.y,
        width,
        height: workArea.height,
        tiledWidth: width,
    };
}

/* Switch keyboard focus to a neighbouring monitor. Moving windows between
   monitors is handled by mutter's built-in move-to-monitor-* keybindings. */
export function switchMonitor(direction: Meta.DisplayDirection) {
    const i = display.get_current_monitor();
    const j = display.get_monitor_neighbor_index(i, direction);
    if (j === -1) return;
    const target = Main.layoutManager.monitors[j];

    /* Prefer the active space's selected window if its monitor matches,
       otherwise any window on the target monitor in the active workspace. */
    const activeSpace = spaces.activeSpace;
    let focusTarget: Window | undefined;
    if (activeSpace?.monitor === target && activeSpace.selectedWindow) {
        focusTarget = activeSpace.selectedWindow;
    }
    if (!focusTarget) {
        const ws = workspaceManager.get_active_workspace();
        focusTarget = ws
            .list_windows()
            .find(w => w.get_monitor() === j) as Window;
    }
    if (focusTarget) {
        Main.activateWindow(focusTarget);
    }
    /* Warp explicitly: focusHandler, skips unmanaged windows on secondary
     * monitors and never runs for an empty target monitor. */
    warpPointerToWindowOrMonitor(target, focusTarget);
}

/**
 * Move the focused window to a neighbouring monitor, preserving gnome-shell's
 * move-to-monitor animation. Counterpart to switchMonitor.
 */
export function moveWindowToMonitor(
    metaWindow: Window,
    direction: Meta.DisplayDirection
) {
    if (!metaWindow) return;
    const i = metaWindow.get_monitor();
    const j = display.get_monitor_neighbor_index(i, direction);
    if (j === -1) return;

    /* If it's managed on the primary, remove it from the tiling and reveal the
     * real actor so gnome-shell can animate it. removeWindow handles the
     * floating layer too. */
    const space = spaces.spaceOfWindow(metaWindow);
    if (space) {
        space.removeWindow(metaWindow);
        showWindow(metaWindow);
    }

    /* Pre-fit to the target work area: a window taller/wider than the target
     * is returned back by mutter. */
    const wa = Main.layoutManager.getWorkAreaForMonitor(j);
    const f = metaWindow.get_frame_rect();
    if (f.width > wa.width || f.height > wa.height) {
        metaWindow.move_resize_frame(
            true,
            f.x,
            f.y,
            Math.min(f.width, wa.width),
            Math.min(f.height, wa.height)
        );
    }

    /* With workspaces-only-on-primary, landing on the primary un-sticks the
     * window and fires window-added from within move_to_monitor. */
    movingWindow = metaWindow;
    // Emits META_SIZE_CHANGE_MONITOR_MOVE -> gnome-shell's fly animation.
    metaWindow.move_to_monitor(j);
    movingWindow = null;

    // Follow the window to its new monitor.
    warpPointerToWindowOrMonitor(Main.layoutManager.monitors[j], metaWindow);
}

/**
 * Convenience method to run a callback method when an actor is shown the stage.
 * Uses a `connectOneShot` signal.
 */
function callbackOnActorShow(
    actor: Clutter.Actor,
    callback: (...args: unknown[]) => unknown
) {
    signals!.connectOneShot(actor, 'show', callback);
}

/**
   Types of windows which never should be tiled.
 */
export function addFilter(metaWindow: Window) {
    if (isTransient(metaWindow)) {
        // Never add transient windows
        return false;
    }
    if (metaWindow.window_type !== Meta.WindowType.NORMAL) {
        // And only add Normal windows
        return false;
    }

    if (metaWindow.is_on_all_workspaces()) {
        return false;
    }
    if (metaWindow.floatOnOpen) {
        return false;
    }

    return true;
}

/**
   Handle windows leaving workspaces.
 */
export function removeHandler(workspace: Meta.Workspace, metaWindow: Window) {
    // Note: If `metaWindow` was closed and had focus at the time, the next
    // window has already received the `focus` signal at this point.
    // Not sure if we can check directly if _this_ window had focus when closed.

    const space = spaces.spaceOf(workspace);
    space.removeWindow(metaWindow);

    const actor = metaWindow.get_compositor_private();
    if (!actor) {
        signals!.disconnect(metaWindow);
        if (metaWindow.clone) {
            metaWindow.clone.destroy();
            metaWindow.clone = null!;
        }
    }
}

/**
   Handle windows entering workspaces.
*/
export function addHandler(_ws: Meta.Workspace, metaWindow: Window) {
    // Do not handle grabbed windows
    if (inGrab instanceof Grab.MoveGrab && inGrab.window === metaWindow) return;

    const actor = metaWindow.get_compositor_private();
    if (actor) {
        // Set position and hookup signals, with `existing` set to true
        insertWindow(metaWindow, { existing: !metaWindow.redirected });
        delete metaWindow.redirected;
    }
    // Otherwise we're dealing with a new window, so we let `window-created`
    // handle initial positioning.
}

/**
 * Hook up geometry tracking for a window entering management and mark it
 * as mapped.
 */
function connectSizeChanged(metaWindow: Window, tiled = false) {
    if (tiled) {
        animateWindow(metaWindow);
    }
    addResizeHandler(metaWindow);
    addPositionHandler(metaWindow);

    delete metaWindow.unmapped;
}

/**
 * Apply any matching winprop to a newly opened window.
 * @returns the validated target space index, if the winprop requests one.
 */
function applyOpenWinprops(metaWindow: Window): number | undefined {
    const winprop = Settings.findWinprop(metaWindow);
    if (!winprop) return undefined;

    if (winprop.oneshot) {
        Settings.winprops.splice(Settings.winprops.indexOf(winprop), 1);
    }
    if (winprop.float) {
        console.debug(
            '#winprops',
            `Opening ${metaWindow?.title} in the floating layer`
        );
        metaWindow.floatOnOpen = true;
    }
    if (winprop.focus) {
        console.debug(
            '#winprops',
            `setting ${metaWindow?.title} to focusOnOpen`
        );
        metaWindow.focusOnOpen = true;
    }

    // pass winprop properties to metaWindow
    metaWindow.preferredWidth = winprop.preferredWidth;

    let overwriteSpace = winprop.spaceIndex;
    if (overwriteSpace !== undefined) {
        if (typeof overwriteSpace !== 'number') {
            console.error(
                '#winprops',
                `${overwriteSpace} is not a valid index. Ignoring.`
            );
            overwriteSpace = undefined;
        }
        // save temporary as metaWindow property
        metaWindow.overwriteSpace = overwriteSpace;
    }

    return overwriteSpace;
}

/**
 * Move a window opened with a winprop space index onto that space and insert
 * it there.
 * @returns false if the space doesn't exist, falling back to normal insertion.
 */
function insertIntoWinpropSpace(metaWindow: Window, spaceIndex: number) {
    const newspace = spaces.spaceOfIndex(spaceIndex);
    if (!newspace) {
        Main.notify(
            `AlbumWM [winprop]: cannot open window on workspace ${spaceIndex} (index)`,
            `"${metaWindow?.title}" cannot be opened on workspace with index ${spaceIndex}
(workspace not found). Opening on current workspace instead.`
        );
        console.warn(
            '#winprops',
            `overwriteSpace with index ${spaceIndex} does not exist. \
Opening "${metaWindow?.title}" on current space.`
        );
        return false;
    }

    console.debug('#winprops', `inserting window into space ${newspace.index}`);
    metaWindow.change_workspace(newspace.workspace);
    metaWindow.foreach_transient(t => {
        newspace.addFloating(t as Window);
        return true;
    });
    connectSizeChanged(metaWindow, true);
    insertWindow(metaWindow, { existing: true });
    return true;
}

/**
 * AlbumWM only tiles the primary monitor. Windows on secondary monitors,
 * sticky windows, and a drop still settling into place are left alone.
 */
function staysUnmanaged(metaWindow: Window) {
    const primaryMonitor = Main.layoutManager.primaryMonitor;
    return (
        metaWindow.is_on_all_workspaces() ||
        metaWindow === settlingDrop?.window ||
        (!!primaryMonitor && metaWindow.get_monitor() !== primaryMonitor.index)
    );
}

/**
 * Position the clone over the window's current stage position, so tiling
 * animates from where the window actually is. Must run before the clone is
 * reparented into the space's cloneContainer.
 */
function alignCloneToWindow(metaWindow: Window, space: Space) {
    const clone = metaWindow.clone;
    let ok, x, y;
    if (isWindowAnimating(metaWindow)) {
        const point = clone.apply_transform_to_point(
            new Graphene.Point3D({ x: 0, y: 0 })
        );
        [ok, x, y] = space.cloneContainer.transform_stage_point(
            point.x,
            point.y
        );
    } else {
        const frame = metaWindow.get_frame_rect();
        [ok, x, y] = space.cloneContainer.transform_stage_point(
            frame.x,
            frame.y
        );
    }
    if (ok) clone.set_position(x, y);
}

/**
 * Give an already-existing window its focus/viewport treatment after
 * insertion, honoring a winprop focusOnOpen.
 */
function focusInsertedWindow(metaWindow: Window, space: Space) {
    if (metaWindow.overwriteSpace !== undefined) {
        delete metaWindow.overwriteSpace;
        if (!metaWindow.focusOnOpen) return;

        delete metaWindow.focusOnOpen;
        console.debug('#winprops', 'focusing space of inserted window');
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            spaces.spaceOfWindow(metaWindow)?.activateWithFocus(metaWindow);

            return GLib.SOURCE_REMOVE;
        });
    }

    if (metaWindow === display.focus_window) {
        focusHandler(metaWindow);
    } else if (space === spaces.activeSpace) {
        Main.activateWindow(metaWindow);
    } else {
        ensureViewport(space.selectedWindow!, space);
    }
}

/**
 * Send a newly created window to the space being previewed instead of its own
 * workspace.
 * @returns false if the window already belongs there (or is sticky).
 */
function redirectToSelectedSpace(metaWindow: Window) {
    if (
        metaWindow.is_on_all_workspaces() ||
        metaWindow.get_workspace() === spaces.selectedSpace.workspace
    ) {
        return false;
    }

    metaWindow.redirected = true;
    metaWindow.change_workspace(spaces.selectedSpace.workspace);
    return true;
}

/**
   Insert the window into its space if appropriate. Requires MetaWindowActor

   This gets called from `Workspace::window-added` if the window already exists,
   and `Display::window-created` through `WindowActor::show` if window is newly
   created to ensure that the WindowActor exists.
*/
export function insertWindow(
    metaWindow: Window,
    options?: { existing?: boolean }
) {
    const existing = options?.existing ?? false;

    if (!existing && redirectToSelectedSpace(metaWindow)) return;

    let overwriteSpace;
    if (!existing) {
        overwriteSpace = applyOpenWinprops(metaWindow);
    }

    if (staysUnmanaged(metaWindow)) {
        connectSizeChanged(metaWindow);
        showWindow(metaWindow);
        return;
    }

    /* Admission point: the window isn't a member of any space yet, so key
     * on its workspace. */
    const space = spaces.spaceOf(metaWindow.get_workspace());

    /* Dragged or moved in from a secondary monitor: stays unmanaged (the
     * float toggle readopts), just kept above the tiled strip. */
    if (existing && metaWindow === movingWindow) {
        connectSizeChanged(metaWindow);
        metaWindow.make_above();
        showWindow(metaWindow);
        return;
    }

    if (
        overwriteSpace !== undefined &&
        insertIntoWinpropSpace(metaWindow, overwriteSpace)
    ) {
        return;
    }

    if (!addFilter(metaWindow)) {
        /* Consume the open-time intent; floating state now lives in `_floating`
         * and (across rebuilds) in the window's always-on-top flag. */
        delete metaWindow.floatOnOpen;

        connectSizeChanged(metaWindow);
        space.addFloating(metaWindow);
        // Make sure the window is on the correct monitor
        metaWindow.move_to_monitor(space.monitor!.index);
        showWindow(metaWindow);
        // Make sure the window isn't hidden behind the space (eg. dialogs)
        if (!existing) metaWindow.make_above();
        return;
    }

    if (space.columnOf(metaWindow) !== -1) {
        return;
    }

    alignCloneToWindow(metaWindow, space);

    if (!space.addWindow(metaWindow, getOpenWindowPositionIndex(space))) return;

    if (metaWindow.fullscreen && !metaWindow._fullscreen_frame) {
        seedFullscreenFrame(metaWindow, space);
    }

    metaWindow.unmake_above();
    // Leave map-time maximized windows maximized; the strip holds them as a full-width column.

    // run a simple layout in pre-prepare layout
    space.layout(false);

    /**
     * If window is new, then setup and ensure is in view
     * after actor is shown on stage.
     */
    if (!existing) {
        const clone = metaWindow.clone;
        clone.x = clone.targetX;
        clone.y = clone.targetY;
        space.layout();

        // run focus and resize to ensure new window is correctly shown
        focusHandler(metaWindow);
        resizeHandler(metaWindow);
        connectSizeChanged(metaWindow, true);

        // remove winprop props after window shown
        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        callbackOnActorShow(actor, () => {
            delete metaWindow.preferredWidth;

            Main.activateWindow(metaWindow);
            ensureViewport(space.selectedWindow!, space);
            maybeWarpPointerToWindow(metaWindow);
        });

        return;
    }

    space.layout();
    animateWindow(metaWindow);
    focusInsertedWindow(metaWindow, space);
}

/**
 * Gets the window index to add a new window in the space: always a new column
 * to the right of the selected window.
 */
export function getOpenWindowPositionIndex(space: Space) {
    let index = -1;
    if (space?.selectedWindow) {
        index = space.columnOf(space.selectedWindow);
    }
    return index + 1;
}

export function animateDown(metaWindow: Window) {
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();
    Easer.addEase(metaWindow.clone, {
        y: workArea.y,
        time: Settings.prefs!.animation_time,
    });
}

export function ensuredX(metaWindow: Window, space: Space) {
    const index = space.columnOf(metaWindow);
    const last = space.selectedWindow!;
    const lastIndex = space.columnOf(last);
    const neighbour = Math.abs(lastIndex - index) <= 1;

    const monitor = space.monitor!;
    const frame = metaWindow.get_frame_rect();
    const clone = metaWindow.clone;

    let x;
    if (
        neighbour ||
        space.isVisible(metaWindow) ||
        metaWindow.lastFrame === undefined
    )
        x = Math.round(clone.targetX) + space.targetX;
    else x = metaWindow.lastFrame.x - monitor.x;
    const workArea = space.workArea();
    const min = workArea.x;
    const max = min + workArea.width;

    if (space.focusMode === FocusModes.CENTER) {
        // window switching should centre focus
        x = workArea.x + Math.round(workArea.width / 2 - frame.width / 2);
    } else if (metaWindow.fullscreen) {
        x = 0;
    } else if (space.focusMode === FocusModes.EDGE) {
        // Align to the closest edge, with special cases for
        // only (center), first (left), and last (right) windows
        if (index === 0 && space.length === 1)
            x = min + Math.round((workArea.width - frame.width) / 2);
        else if (
            index === 0 ||
            (Math.abs(x - min) < Math.abs(x + frame.width - max) &&
                index !== space.length - 1)
        )
            x = min + Settings.prefs!.horizontal_margin;
        else x = max - Settings.prefs!.horizontal_margin - frame.width;
    } else if (
        frame.width >
        workArea.width * 0.9 -
            2 * (Settings.prefs!.horizontal_margin + Settings.prefs!.column_gap)
    ) {
        // Consider the window to be wide and center it
        x = min + Math.round((workArea.width - frame.width) / 2);
    } else if (x + Settings.prefs!.horizontal_margin + frame.width > max) {
        // Align to the right prefs!.horizontal_margin
        x = max - Settings.prefs!.horizontal_margin - frame.width;
    } else if (x < min + Settings.prefs!.horizontal_margin) {
        // Align to the left prefs!.horizontal_margin
        x = min + Settings.prefs!.horizontal_margin;
    } else if (x + frame.width === max) {
        // When opening new windows at the end, in the background, we want to
        // show some minimup margin
        x = max - Settings.prefs!.minimum_margin - frame.width;
    } else if (x === min) {
        // Same for the start (though the case isn't as common)
        x = min + Settings.prefs!.minimum_margin;
    }

    return x;
}

/**
 * Make sure that `metaWindow` is in view, scrolling the space if needed.
 *
 * @param options.moveto if true, executes a moveTo animated action
 */
export function ensureViewport(
    metaWindow: Window,
    space?: Space,
    options?: {
        force?: boolean;
        moveto?: boolean;
        animate?: boolean;
        ensureAnimation?: Settings.EnsureViewportAnimation;
        callback?: () => void;
    }
) {
    space = space ?? spaces.spaceOfWindow(metaWindow);
    if (!space) return false;
    const force = options?.force ?? false;
    const moveto = options?.moveto ?? true;
    const animate = options?.animate ?? true;
    const ensureAnimation =
        options?.ensureAnimation ?? Settings.EnsureViewportAnimation.TRANSLATE;
    const callback = options?.callback ?? function () {};

    const index = space.columnOf(metaWindow);
    if (index === -1 || space.length === 0) return false;

    if (space.selectedWindow!.fullscreen && !metaWindow.fullscreen) {
        animateDown(space.selectedWindow!);
    }
    const x = ensuredX(metaWindow, space);

    space.selectedWindow = metaWindow;
    space.columnSetLastActive(metaWindow);
    const selected = space.selectedWindow;
    if (selected.fullscreen) {
        const y = 0;
        const ty = selected.clone.get_transition('y');
        if (!space.isVisible(selected)) {
            selected.clone.y = y;
        } else if (!ty || ty.get_interval().final !== y) {
            Easer.addEase(selected.clone, {
                y,
                time: Settings.prefs!.animation_time,
                onComplete: space.moveDone.bind(space),
            });
        }
    }

    if (moveto) {
        moveTo(space, metaWindow, {
            x,
            force,
            animate,
            ensureAnimation,
            callback,
        });
    }

    selected.raise();
    Utils.actorRaise(selected.clone);
    space.emit('select');

    return true;
}

/**
 * Move the column containing @metaWindow to x, y and propagate the change
 * in @space. Coordinates are relative to monitor and y is optional.
 */
export function moveTo(
    space: Space,
    metaWindow: Window,
    options: {
        x?: number;
        force?: boolean;
        animate?: boolean;
        ensureAnimation?: Settings.EnsureViewportAnimation;
        callback?: () => void;
    }
) {
    const x = options.x ?? 0;
    const force = options.force ?? false;
    const animate = options.animate ?? true;
    const ensureAnimation =
        options.ensureAnimation ?? Settings.EnsureViewportAnimation.TRANSLATE;
    const callback = options.callback ?? function () {};
    if (space.columnOf(metaWindow) === -1) return;

    const clone = metaWindow.clone;
    const target = x - clone.targetX;
    if (target === space.targetX && !force) {
        space.moveDone();
        callback();
        return;
    }

    const done = () => {
        space.moveDone();
        space.fixOverlays(metaWindow);
        callback();
    };

    space.targetX = target;
    if (space.cloneContainer.x === target || Main.overview.visible) {
        // Do the move immediately, and let the overview take care of animation
        space.cloneContainer.x = target;
        done();
        return;
    }

    // if here need to animate
    space.startAnimate();
    if (!animate || ensureAnimation === Settings.EnsureViewportAnimation.NONE) {
        space.cloneContainer.x = target;
        Easer.addEase(space.cloneContainer, {
            instant: true,
            onComplete: () => done(),
        });
    } else if (ensureAnimation === Settings.EnsureViewportAnimation.FADE) {
        space.cloneContainer.x = target;
        space.cloneContainer.opacity = 0;
        Easer.addEase(space.cloneContainer, {
            opacity: 255,
            time: Settings.prefs!.animation_time,
            onComplete: () => done(),
        });
    } else {
        Easer.addEase(space.cloneContainer, {
            x: target,
            time: Settings.prefs!.animation_time,
            onComplete: () => done(),
        });
    }
}

export function grabBegin(metaWindow: Window, type: Meta.GrabOp) {
    movingWindow = metaWindow;
    switch (type) {
        case Meta.GrabOp.KEYBOARD_MOVING:
            /* Floating and unmanaged windows move natively, like pointer
             * moves below. */
            if (!isTiled(metaWindow)) {
                return;
            }

            inGrab = new Grab.MoveGrab(metaWindow, type);

            // NOTE: Keyboard grab moves the cursor, but it happens after grab
            // signals have run. Simply delay the dnd so it will get the correct
            // pointer coordinates.
            Utils.laterAdd(Meta.LaterType.IDLE, () => {
                (inGrab as Grab.MoveGrab).begin();
                (inGrab as Grab.MoveGrab).beginDnD();

                return GLib.SOURCE_REMOVE;
            });
            break;
        case Meta.GrabOp.MOVING:
        case Meta.GrabOp.MOVING_UNCONSTRAINED: // introduced in Gnome 44
            if (!isTiled(metaWindow)) {
                return;
            }

            inGrab = new Grab.MoveGrab(metaWindow, type);

            if (Utils.getModiferState() & Clutter.ModifierType.CONTROL_MASK) {
                (inGrab as Grab.MoveGrab).begin();
                (inGrab as Grab.MoveGrab).beginDnD();
            } else if (
                (inGrab as Grab.MoveGrab).initialSpace &&
                (inGrab as Grab.MoveGrab).initialSpace.columnOf(metaWindow) > -1
            ) {
                (inGrab as Grab.MoveGrab).begin();
            }

            break;
        case Meta.GrabOp.RESIZING_NW:
        case Meta.GrabOp.RESIZING_N:
        case Meta.GrabOp.RESIZING_NE:
        case Meta.GrabOp.RESIZING_E:
        case Meta.GrabOp.RESIZING_SW:
        case Meta.GrabOp.RESIZING_S:
        case Meta.GrabOp.RESIZING_SE:
        case Meta.GrabOp.RESIZING_W:
        case Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN:
        case Meta.GrabOp.KEYBOARD_RESIZING_NW:
        case Meta.GrabOp.KEYBOARD_RESIZING_N:
        case Meta.GrabOp.KEYBOARD_RESIZING_NE:
        case Meta.GrabOp.KEYBOARD_RESIZING_E:
        case Meta.GrabOp.KEYBOARD_RESIZING_SW:
        case Meta.GrabOp.KEYBOARD_RESIZING_S:
        case Meta.GrabOp.KEYBOARD_RESIZING_SE:
        case Meta.GrabOp.KEYBOARD_RESIZING_W:
            inGrab = new Grab.ResizeGrab();
            break;
    }
}

export function grabEnd(_metaWindow: Window, _type: Meta.GrabOp) {
    if (settlingDrop) {
        /* Ending the op moves the window again and, while the drop resize is
         * unacked, mutter can shove it off the drop monitor. Re-assert. */
        const settling = settlingDrop;
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            const { x, y, width, height } = settling.rect;
            if (settling.window.get_workspace())
                settling.window.move_resize_frame(true, x, y, width, height);
            settlingDrop = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    movingWindow = null;
    if (
        !inGrab ||
        (inGrab instanceof Grab.MoveGrab && inGrab.dnd) ||
        Grab.grabbed
    )
        return;

    inGrab.end();
    inGrab = null;
}

/**
 * Returns the default focus mode (can be user-defined).
 */
export function getDefaultFocusMode(): FocusModes {
    // find matching focus mode
    const mode = Settings.prefs!.default_focus_mode;
    const modes = FocusModes;
    const result = modes[mode] as keyof typeof FocusModes | undefined;

    // if found return, otherwise return default
    if (result) {
        return modes[result];
    } else {
        return modes.DEFAULT;
    }
}

// `MetaWindow::focus` handling
export function focusHandler(metaWindow: Window) {
    console.debug('focus:', metaWindow?.title);
    if (isTransient(metaWindow)) {
        return;
    }

    /* Unmanaged window (e.g. on a secondary monitor): leave it and the
     * pointer over it alone. */
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) {
        return;
    }

    // Window is on another monitor: warp the pointer there.
    if (
        !Main.overview.visible &&
        Utils.monitorAtCurrentPoint() !== space.monitor
    ) {
        warpPointerToWindowOrMonitor(space.monitor!, metaWindow);
    }

    if (metaWindow.fullscreen) {
        if (!metaWindow.is_above()) {
            metaWindow.make_above();
        }
    } else {
        space
            .getWindows()
            .filter(w => w.fullscreen)
            .forEach(w => {
                if (w._fullscreen_above !== null && !w._fullscreen_above) {
                    w.unmake_above();
                }
            });

        let needLayout = false;
        /* When switching focus off a fullscreen window, re-layout so the previously
           fullscreened sibling shrinks back and any column proportions are restored. */
        if (space.hasFullScreenWindow()) {
            needLayout = true;
        }

        /**
         * if there then clone.y shouldn't be 0.  This can happen though if a window
         * is fullscreened when `layout` is called.  In this case, when we focuse on a
         * window that isn't fullscreen but has clone.y 0 ==> need a layout call.
         */
        if (
            metaWindow.clone.y === 0 &&
            Settings.prefs!.vertical_margin !== 0 &&
            Settings.prefs!.column_gap !== 0
        ) {
            needLayout = true;
        }

        if (needLayout) {
            space.layout(false);
        }
    }
    space.monitor!.clickOverlay!.show();

    /**
       Find the closest neighbours. Remove any dead windows in the process to
       work around the fact that `focus` runs before `window-removed` (and there
       doesn't seem to be a better signal to use)
     */
    const windows = space.getWindows();
    const around = windows.indexOf(metaWindow);
    if (around === -1) return;

    const neighbours = [];
    for (let i = around - 1; i >= 0; i--) {
        const w = windows[i];
        if (w.get_compositor_private()) {
            neighbours.push(windows[i]);
            break;
        }
        space.removeWindow(w);
    }
    for (let i = around + 1; i < windows.length; i++) {
        const w = windows[i];
        if (w.get_compositor_private()) {
            neighbours.push(windows[i]);
            break;
        }
        space.removeWindow(w);
    }

    /**
       We need to stack windows in mru order, since mutter picks from the
       stack, not the mru, when auto choosing focus after closing a window.
    */
    const stack = sortWindows(space, neighbours);
    stack.forEach(w => w.raise());
    metaWindow.raise();

    /**
     * Call to move viewport to metaWindow, except if in overview - if in
     * overview, we'll ensure viewport on focused window AFTER overview is
     * hidden.
     */
    ensureViewport(metaWindow, space, { moveto: !Main.overview.visible });

    Topbar.fixTopBar();
}

/**
 * Invoked by our callsites where the focus warp is appropriate
 * (focus movement keybindings, close-window, insertWindow etc.).
 * Checks if "warp-pointer-on-focus" is true, and has a lot of other safeguards
 * and logic.
 * @returns whether the pointer was warped.
 */
export function maybeWarpPointerToWindow(metaWindow: Window): boolean {
    if (!Settings.prefs!.warp_pointer_on_focus) return false;
    if (Main.overview.visible) return false;
    if (!metaWindow) return false;
    /* visibleX/Y read metaWindow.clone.targetX/targetY, which is only kept in
     * sync for tiled windows; skip the rest. */
    if (isTransient(metaWindow)) return false;
    if (isFloating(metaWindow)) return false;
    if (!metaWindow.clone) return false;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return false;

    /* Use post-scroll and post-resize coordinates: the frame_rect position
     * only catches up at moveDone (end of strip animation), and its size
     * only when the client acks a pending resize. */
    const f = metaWindow.get_frame_rect();
    const width = metaWindow._targetWidth ?? f.width;
    const height = metaWindow._targetHeight ?? f.height;
    const tx = space.visibleX(metaWindow) + space.monitor!.x;
    const ty = space.visibleY(metaWindow);
    const [px, py] = global.get_pointer();
    const inside = px >= tx && px < tx + width && py >= ty && py < ty + height;
    if (inside) return false;

    Utils.warpPointer(
        tx + Math.floor(width / 2),
        ty + Math.floor(height / 2),
        false
    );
    return true;
}

/**
 * Warp the pointer to `monitor`, or onto `metaWindow` instead if it's a tiled
 * window and warp-pointer-on-focus is on.
 */
function warpPointerToWindowOrMonitor(
    monitor: Layout.Monitor,
    metaWindow?: Window
) {
    if (metaWindow && maybeWarpPointerToWindow(metaWindow)) return;
    Utils.warpPointerToMonitor(monitor);
}

/**
 * Pull minimized windows out of the tiling so the strip closes up, and put
 * them back when unminimized.
 */
export function minimizeHandler(metaWindow: Window) {
    const space = spaces.spaceOfWindow(metaWindow);
    if (metaWindow.minimized) {
        console.debug('minimized', metaWindow?.title);
        if (space && space.columnOf(metaWindow) !== -1) {
            metaWindow._tiled_on_minimize = true;
            space.removeWindow(metaWindow);
        }
    } else {
        console.debug('unminimized', metaWindow?.title);
        if (metaWindow._tiled_on_minimize) {
            delete metaWindow._tiled_on_minimize;
            insertWindow(metaWindow, { existing: true });
        }
    }
}

/**
  `WindowActor::show` handling

  Kill any falsely shown WindowActor.
*/
export function showHandler(actor: Meta.WindowActor) {
    const metaWindow = actor.meta_window! as Window;
    const onActive =
        metaWindow.get_workspace() === workspaceManager.get_active_workspace();

    if (!metaWindow.clone.get_parent() && !metaWindow.unmapped) return;

    if (metaWindow.unmapped) {
        return;
    }

    if (
        !onActive ||
        isWindowAnimating(metaWindow) ||
        // The built-in workspace-change animation is running: suppress it
        actor.get_parent() !== global.window_group
    ) {
        animateWindow(metaWindow);
    }
}

export function showWindow(metaWindow: Window) {
    const actor = metaWindow.get_compositor_private<Clutter.Actor>();
    if (!actor) return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.hide();
        metaWindow.clone.cloneActor.set_source(null);
    }
    actor.show();
    return true;
}

export function animateWindow(metaWindow: Window) {
    const actor = metaWindow.get_compositor_private<Clutter.Actor>();
    if (!actor) return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.show();
        metaWindow.clone.cloneActor.source = actor;
    }
    actor.hide();
    return true;
}

export function isWindowAnimating(metaWindow: Window) {
    const clone = metaWindow.clone;
    return clone.get_parent() && clone.cloneActor.visible;
}

export function toggleMaximizeHorizontally(metaWindow: Window) {
    metaWindow = metaWindow || display.focus_window;

    if (isMaximized(metaWindow)) {
        // ASSUMPTION: MaximizeFlags.HORIZONTALLY is not used
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
        metaWindow.unmaximizedRect = null;
        return;
    }

    let maxWidthPrc = Settings.prefs!.maximize_column_width;
    // add some sane limits to width percents: 0.5 <= x <= 1.0
    maxWidthPrc = Math.max(0.5, maxWidthPrc);
    maxWidthPrc = Math.min(1.0, maxWidthPrc);

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();
    const frame = metaWindow.get_frame_rect();
    const reqWidth =
        maxWidthPrc * workArea.width - Settings.prefs!.horizontal_margin * 2;

    // Some windows only resize in increments > 1px so we can't rely on a precise width
    // Hopefully this heuristic is good enough
    const isFullWidth = reqWidth - frame.width < sizeSlack;

    if (isFullWidth && metaWindow.unmaximizedRect) {
        const unmaximizedRect = metaWindow.unmaximizedRect;
        metaWindow.move_resize_frame(
            true,
            unmaximizedRect.x,
            frame.y,
            unmaximizedRect.width,
            frame.height
        );

        metaWindow.unmaximizedRect = null;
    } else {
        const x =
            workArea.x + space.monitor!.x + Settings.prefs!.horizontal_margin;
        metaWindow.unmaximizedRect = frame;
        metaWindow.move_resize_frame(true, x, frame.y, reqWidth, frame.height);
    }
}

export function resizeHInc(metaWindow: Window) {
    metaWindow = metaWindow || display.focus_window;
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();

    const maxHeight =
        workArea.height -
        Settings.prefs!.horizontal_margin * 2 -
        Settings.prefs!.column_gap;
    const step = Math.floor(maxHeight * 0.1);
    const currentHeight = Math.round(frame.height / step) * step;
    const targetHeight = Math.min(currentHeight + step, maxHeight);
    const targetY = frame.y;

    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(
        true,
        frame.x,
        targetY,
        frame.width,
        targetHeight
    );
}

export function resizeHDec(metaWindow: Window) {
    metaWindow = metaWindow || display.focus_window;
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();

    const maxHeight =
        workArea.height -
        Settings.prefs!.horizontal_margin * 2 -
        Settings.prefs!.column_gap;
    const step = Math.floor(maxHeight * 0.1);
    const currentHeight = Math.round(frame.height / step) * step;
    const minHeight = step;
    const targetHeight = Math.max(currentHeight - step, minHeight);
    const targetY = frame.y;

    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(
        true,
        frame.x,
        targetY,
        frame.width,
        targetHeight
    );
}

export function resizeWInc(metaWindow: Window) {
    metaWindow = metaWindow || display.focus_window;
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();

    const maxWidth =
        workArea.width -
        Settings.prefs!.horizontal_margin * 2 -
        Settings.prefs!.column_gap;
    const step = Math.floor(maxWidth * 0.1);
    const currentWidth = Math.round(frame.width / step) * step;
    const targetWidth = Math.min(currentWidth + step, maxWidth);
    const targetX = frame.x;

    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(
        true,
        targetX,
        frame.y,
        targetWidth,
        frame.height
    );
}

export function resizeWDec(metaWindow: Window) {
    metaWindow = metaWindow || display.focus_window;
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();

    const maxWidth =
        workArea.width -
        Settings.prefs!.horizontal_margin * 2 -
        Settings.prefs!.column_gap;
    const step = Math.floor(maxWidth * 0.1);
    const currentWidth = Math.round(frame.width / step) * step;
    const minWidth = step;
    const targetWidth = Math.max(currentWidth - step, minWidth);
    const targetX = frame.x;

    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(
        true,
        targetX,
        frame.y,
        targetWidth,
        frame.height
    );
}

export function getCycleWindowWidths(metaWindow: Window) {
    const steps = Settings.prefs!.preset_column_widths;
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return [];
    const workArea = space.workArea();

    // Steps are ratios of the available width -> convert to pixels.
    // Make sure two windows of "compatible" width will have room:
    const availableWidth =
        workArea.width -
        Settings.prefs!.horizontal_margin * 2 -
        Settings.prefs!.column_gap;
    return steps.map(x => Math.floor(x * availableWidth));
}

export function cycleWindowWidth(metaWindow: Window) {
    return cycleWindowWidthDirection(
        metaWindow,
        CycleWindowSizesDirection.FORWARD
    );
}

export function cycleWindowWidthBackwards(metawindow: Window) {
    return cycleWindowWidthDirection(
        metawindow,
        CycleWindowSizesDirection.BACKWARDS
    );
}

export function cycleWindowWidthDirection(
    metaWindow: Window,
    direction: CycleWindowSizesDirection
) {
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const workArea = space.workArea();
    workArea.x += space.monitor!.x;

    const findFn =
        direction === CycleWindowSizesDirection.FORWARD
            ? Lib.findNext
            : Lib.findPrev;

    // 10px slack to avoid locking up windows that only resize in increments > 1px
    const targetWidth = Math.min(
        findFn(frame.width, getCycleWindowWidths(metaWindow), sizeSlack),
        workArea.width
    );

    let targetX = frame.x;

    if (isFloating(metaWindow)) {
        if (
            targetX + targetWidth >
            workArea.x + workArea.width - Settings.prefs!.minimum_margin
        ) {
            // Move the window so it remains fully visible
            targetX =
                workArea.x +
                workArea.width -
                Settings.prefs!.minimum_margin -
                targetWidth;
        }
    }

    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(
        true,
        targetX,
        frame.y,
        targetWidth,
        frame.height
    );
}

export function cycleWindowHeight(metaWindow: Window) {
    return cycleWindowHeightDirection(
        metaWindow,
        CycleWindowSizesDirection.FORWARD
    );
}

export function cycleWindowHeightBackwards(metaWindow: Window) {
    return cycleWindowHeightDirection(
        metaWindow,
        CycleWindowSizesDirection.BACKWARDS
    );
}

export function cycleWindowHeightDirection(
    metaWindow: Window,
    direction: CycleWindowSizesDirection
) {
    const steps = Settings.prefs!.preset_window_heights;
    const frame = metaWindow.get_frame_rect();

    const space = spaces.spaceOfWindow(metaWindow);
    const i = space ? space.columnOf(metaWindow) : -1;

    const findFn =
        direction === CycleWindowSizesDirection.FORWARD
            ? Lib.findNext
            : Lib.findPrev;

    function calcTargetHeight(available: number) {
        const targetR = findFn(
            frame.height / available,
            steps,
            sizeSlack / available
        );
        return Math.min(Math.floor(targetR * available), available);
    }

    if (space && i > -1) {
        const allocate = (column: Window[], available: number) => {
            // NB: important to not retrieve the frame size inside allocate. Allocation of
            // metaWindow should stay the same during a potential fixpoint evaluation.
            available -= (column.length - 1) * Settings.prefs!.column_gap;
            const targetHeight = calcTargetHeight(available);
            return column.map((mw: Window) => {
                if (mw === metaWindow) {
                    return targetHeight;
                } else {
                    return Math.floor(
                        (available - targetHeight) / (column.length - 1)
                    );
                }
            });
        };

        if (space[i].length > 1) {
            space.layout(false, { customAllocators: { [i]: allocate } });
        }
    } else {
        // Not in tiling
        const workspace = metaWindow.get_workspace();
        const available = workspace.get_work_area_for_monitor(
            metaWindow.get_monitor()
        ).height;
        const targetHeight = calcTargetHeight(available);
        metaWindow.move_resize_frame(
            true,
            frame.x,
            frame.y,
            frame.width,
            targetHeight
        );
    }
}

function activateNthWindow(n: number, space: Space) {
    space = space || spaces.activeSpace;
    const nth = space[n][0];
    ensureViewport(nth, space);
}

export function activateFirstWindow(_mw: Window, space: Space) {
    space = space || spaces.activeSpace;
    activateNthWindow(0, space);
}

export function activateLastWindow(_mw: Window, space: Space) {
    space = space || spaces.activeSpace;
    activateNthWindow(space.length - 1, space);
}

/**
 * Centers the currently selected window.
 */
export function centerWindow(
    metaWindow: Window,
    horizontal = true,
    vertical = false
) {
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const monitor = space.monitor!;
    const workArea = space.workArea();

    const targetX = horizontal
        ? workArea.x + Math.round((workArea.width - frame.width) / 2)
        : frame.x;
    let targetY = vertical
        ? workArea.y + Math.round((workArea.height - frame.height) / 2)
        : frame.y;
    targetY = Math.max(targetY, workArea.y);
    if (space.columnOf(metaWindow) === -1) {
        Floating.easeFloating(
            metaWindow,
            targetX + monitor.x,
            targetY + monitor.y
        );
    } else {
        moveTo(space, metaWindow, {
            x: targetX,
        });
    }
}

/**
 * Sets the focus mode for a space.
 */
export function setFocusMode(mode: FocusModes, space: Space) {
    space = space ?? spaces.activeSpace;
    space.focusMode = mode;
    Topbar.focusButton!.setFocusMode(mode);

    const workArea = space.workArea();
    const selectedWin = space.selectedWindow;
    // if centre also center selectedWindow
    switch (mode) {
        case FocusModes.CENTER:
            if (selectedWin) {
                // check it closer to min or max of workArea
                const frame = selectedWin.get_frame_rect();
                const winMidpoint =
                    space.visibleX(selectedWin) + frame.width / 2;
                const workAreaMidpoint = workArea.width / 2;
                if (winMidpoint <= workAreaMidpoint) {
                    space.unfocusXPosition = 0;
                } else {
                    space.unfocusXPosition = workArea.width;
                }
                centerWindow(selectedWin);
            }
            break;
        default:
            // for other modes run a `layout` call to action the mode
            space.layout();
            break;
    }

    // if normal and has saved x position from previous
    // eslint-disable-next-line eqeqeq
    if (mode === FocusModes.DEFAULT && space.unfocusXPosition != null) {
        // if window is first, move to left edge
        let position;
        // eslint-disable-next-line eqeqeq
        if (space.columnOf(selectedWin!) == 0) {
            position = 0;
        }
        // if windows is last, move to right edge
        // eslint-disable-next-line eqeqeq
        else if (space.columnOf(selectedWin!) == space.length - 1) {
            position = workArea.width;
        } else {
            position = space.unfocusXPosition;
        }
        // do the move
        moveTo(space, space.selectedWindow!, { x: position });
        ensureViewport(space.selectedWindow!, space, { force: true });
        space.unfocusXPosition = null;
    }
}

/**
 * Switches to the next focus mode for a space.
 */
export function switchToNextFocusMode(space?: Space) {
    space = space ?? spaces.activeSpace;
    // Object.values on a numeric enum also yields the reverse-mapping keys,
    // so keep only the numeric members.
    const modes = Object.values(FocusModes).filter(
        (v): v is FocusModes => typeof v === 'number'
    );
    const currMode = modes.indexOf(space.focusMode);
    const nextMode = modes[(currMode + 1) % modes.length];
    setFocusMode(nextMode, space);
}

/**
 * "Fit" values such that they sum to `targetSum`
 */
export function fitProportionally(values: number[], targetSum: number) {
    const sum = Lib.sum(values);
    const weights = values.map(v => v / sum);

    const fitted = Lib.zip(values, weights).map(([_h, w]) =>
        Math.round(targetSum * w)
    );
    const r = targetSum - Lib.sum(fitted);
    fitted[0] += r;
    return fitted;
}

export function allocateDefault(
    column: Window[],
    availableHeight: number,
    selectedWindow: Window | null
) {
    if (column.length === 1) {
        return [availableHeight];
    } else {
        // Distribute available height amongst non-selected windows in proportion to their existing height
        const gap = Settings.prefs!.column_gap;
        const minHeight = 50;

        const heightOf = (mw: Window) => {
            return mw._targetHeight || mw.get_frame_rect().height;
        };

        const k = selectedWindow && column.indexOf(selectedWindow);
        const selectedHeight = selectedWindow && heightOf(selectedWindow);

        const nonSelected = column.slice();
        if (selectedWindow) nonSelected.splice(k!, 1);

        const nonSelectedHeights = nonSelected.map(heightOf);
        const availableForNonSelected = Math.max(
            0,
            availableHeight -
                (column.length - 1) * gap -
                (selectedWindow ? selectedHeight! : 0)
        );

        const deficit = Math.max(
            0,
            nonSelected.length * minHeight - availableForNonSelected
        );

        const heights = fitProportionally(
            nonSelectedHeights,
            availableForNonSelected + deficit
        );

        if (selectedWindow) heights.splice(k!, 0, selectedHeight! - deficit);

        return heights;
    }
}

export function allocateEqualHeight(column: Window[], available: number) {
    available -= (column.length - 1) * Settings.prefs!.column_gap;
    return column.map(_ => Math.floor(available / column.length));
}

/**
 * "Slurps" a window into the currently active column, vertically
 * stacking it.
 */
export function slurp(
    metaWindow: Window,
    insertAt = SlurpInsertPosition.BOTTOM
) {
    if (!metaWindow) {
        return;
    }

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) {
        return;
    }

    const index = space.columnOf(metaWindow);

    if (space.length < 2) {
        return;
    }

    let to = index;
    const from = index + 1;

    const metaWindowToSlurp = space[from]?.[0];
    if (!metaWindowToSlurp) {
        return;
    }

    // slurping fullscreen windows is trouble, unfullscreen when slurping
    if (metaWindowToSlurp?.fullscreen) {
        metaWindowToSlurp.unmake_fullscreen();
    }

    const spaceTo = space[to];
    const rowIndex = spaceTo.indexOf(metaWindow);
    switch (insertAt) {
        case SlurpInsertPosition.ABOVE:
            spaceTo.splice(rowIndex, 0, metaWindowToSlurp);
            break;
        case SlurpInsertPosition.BELOW:
            spaceTo.splice(rowIndex + 1, 0, metaWindowToSlurp);
            break;
        case SlurpInsertPosition.TOP:
            spaceTo.unshift(metaWindowToSlurp);
            break;
        case SlurpInsertPosition.BOTTOM:
        default:
            spaceTo.push(metaWindowToSlurp);
            break;
    }

    {
        // Remove the slurped window
        const column = space[from];
        const row = column.indexOf(metaWindowToSlurp);
        column.splice(row, 1);

        // if from column is now empty, remove column from space
        if (column.length === 0) {
            space.splice(from, 1);
        }

        // with column removed, `to` column may have changed
        to = space.columnOf(metaWindow);
    }

    // after columns have slurped, "to" index may have changed
    space.layout(true, {
        customAllocators: {
            [to]: allocateEqualHeight,
        },
        ensure: false,
    });
}

/**
 * Barfs (expels) @expelWindow, or the bottom window of @metaWindow's
 * column, into its own new column to the right.
 */
export function barf(metaWindow: Window, expelWindow?: Window) {
    if (!metaWindow) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const index = space.columnOf(metaWindow);
    if (index === -1) return;

    const column = space[index];
    if (column.length < 2) return;

    if (expelWindow) {
        column.splice(column.indexOf(expelWindow), 1);
    } else {
        expelWindow = column.splice(-1, 1)[0];
    }
    space.splice(index + 1, 0, [expelWindow]);

    space.layout(true, {
        customAllocators: {
            [index]: allocateEqualHeight,
        },
        ensure: false,
    });
}

/**
 * Moves @metaWindow in and out of a column: a window alone in its column is
 * consumed into the bottom of the adjacent column in @direction, a window with
 * siblings is expelled into its own new column on that side.
 */
export function consumeOrExpel(
    metaWindow: Window,
    direction: Meta.MotionDirection
) {
    if (!metaWindow) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;
    const index = space.columnOf(metaWindow);
    if (index === -1) return;

    const left = direction === Meta.MotionDirection.LEFT;
    const column = space[index];

    if (column.length === 1) {
        // Consume into the adjacent column
        const target = space[left ? index - 1 : index + 1];
        if (!target) return;

        // Consuming fullscreen windows is trouble, unfullscreen first
        if (metaWindow.fullscreen) {
            metaWindow.unmake_fullscreen();
        }

        target.push(metaWindow);
        space.splice(index, 1);

        space.layout(true, {
            customAllocators: {
                [space.columnOf(metaWindow)]: allocateEqualHeight,
            },
        });
    } else {
        // Expel into a new column
        column.splice(column.indexOf(metaWindow), 1);
        space.splice(left ? index : index + 1, 0, [metaWindow]);

        space.layout(true);
    }
}

/**
   Sort the @windows based on their clone's stacking order
   in @space.cloneContainer.
 */
export function sortWindows(space: Space, windows: Window[]) {
    if (windows.length === 1) return windows;
    const clones = windows.map(w => w.clone);
    return (space.cloneContainer.get_children() as Clone[])
        .filter(c => clones.includes(c))
        .map(c => c.meta_window);
}
