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
    Scratch,
} from './imports.js';
import { Easer, DispatcherMode } from './utils.js';
import { ClickOverlay } from './stackoverlay.js';

const { signals: Signals } = imports;
const workspaceManager = global.workspace_manager;
const display = global.display;

/** @type {Spaces} */
export let spaces;

// Mutter prevints windows from being placed further off the screen than 75 pixels.
export const stackMargin = 75;

const mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });

// Some features use this to determine if to sizes is considered equal. ie. `abs(w1 - w2) < sizeSlack`
let sizeSlack = 30;

// DEFAULT mode is normal/original AlbumWM window focus behaviour
export const FocusModes = { DEFAULT: 0, CENTER: 1, EDGE: 2 }; // export

export const CycleWindowSizesDirection = { FORWARD: 0, BACKWARDS: 1 };

export const SlurpInsertPosition = { BOTTOM: 0, TOP: 1, ABOVE: 2, BELOW: 3 };

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

/* Saves current state for controlled restarts of AlbumWM. */
class SaveState {
    constructor() {
        this.prevSpaces = new Map();
    }

    getPrevSpaceByUUID(uuid) {
        return [...this.prevSpaces.values()].find(s => uuid === s.uuid);
    }

    update() {
        this.prevSpaces = new Map(spaces);
    }

    /* Prepares state for restoring on next enable. */
    prepare() {
        this.update();
        this.prevSpaces.forEach(space => {
            let windows = space.getWindows();
            let selected = windows.indexOf(space.selectedWindow);
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

let saveState;
let gsettings;
let signals, grabSignals;
let startupTimeoutId,
    timerId,
    fullscreenStartTimeout,
    stackSlurpTimeout,
    workspaceChangeTimeouts;
let monitorChangeTimeout, driftTimeout;
export let inGrab;

export function enable(extension) {
    inGrab = false;

    saveState = saveState ?? new SaveState();

    gsettings = extension.getSettings();

    signals = new Utils.Signals();
    grabSignals = new Utils.Signals();

    workspaceChangeTimeouts = []; // init array to hold timeouts

    // setup actions on gap changes
    let marginsGapChanged = () => {
        Utils.timeoutRemove(timerId);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            spaces.mru().forEach(space => {
                space.layout(true, {
                    callback: () => {
                        const selected = spaces.activeSpace?.selectedWindow;
                        allocateClone(selected);
                    },
                });
            });
            timerId = null;
            return false; // on return false destroys timeout
        });
    };
    gsettings.connect('changed::vertical-margin', marginsGapChanged);
    gsettings.connect('changed::vertical-margin-bottom', marginsGapChanged);
    gsettings.connect('changed::window-gap', marginsGapChanged);

    // eslint-disable-next-line no-use-before-define
    spaces = new Spaces();
    let initWorkspaces = () => {
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
                    let options = s.isFullyVisible(s.selectedWindow)
                        ? { moveto: false }
                        : { force: true };
                    ensureViewport(s.selectedWindow, s, options);
                }
                s.monitor.clickOverlay.show();
            });
        Topbar.fixTopBar();

        // on idle update space name
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            spaces.forEach(s => {
                s.updateName();

                /**
                 * The below resolves https://github.com/paperwm/PaperWM/issues/758.
                 */
                const x = s.cloneContainer.x;
                s.viewportMoveToX(0);
                s.viewportMoveToX(x);
            });
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
    Utils.timeoutRemove(fullscreenStartTimeout);
    fullscreenStartTimeout = null;
    Utils.timeoutRemove(stackSlurpTimeout);
    stackSlurpTimeout = null;
    workspaceChangeTimeouts?.forEach(t => Utils.timeoutRemove(t));
    workspaceChangeTimeouts = null;
    Utils.timeoutRemove(monitorChangeTimeout);
    monitorChangeTimeout = null;
    Utils.timeoutRemove(driftTimeout);
    driftTimeout = null;

    grabSignals.destroy();
    grabSignals = null;
    signals.destroy();
    signals = null;

    saveState.prepare();
    spaces.destroy();
    inGrab = null;
    gsettings = null;
}

/**
 * Exported inGrab is read-only from other modules.
 * This method allows other modules to change inGrab.
 */
export function setInGrab(value) {
    inGrab = value;
}

/**
 * A GNOME Shell monitor, augmented by AlbumWM with a click overlay.
 * @typedef {NonNullable<import('@girs/gnome-shell/ui/layout').LayoutManager['primaryMonitor']> & {
 *     clickOverlay: import('./stackoverlay.js').ClickOverlay,
 * }} Monitor
 */

/**
 * Meta.Window with our extra fields
 * @typedef {Meta.Window & {
 *     clone: Clutter.Actor & {
 *         cloneActor: Clutter.Clone,
 *         shade: St.Widget,
 *         targetY: number,
 *         __oldOpacity: number, // Used by `grab.ts`
 *     },
 *     _scratch?: boolean, // Used by `scratch.ts`
 *     _scratchFrame?: import('@girs/mtk-18').default.Rectangle,
 * }} Window
 */

export class Space extends Array {
    /** @type {import('@gi-types/clutter10').Actor} */
    actor;

    /** @type {import('@gi-types/clutter').Actor} */
    background;

    /** @type {Window | null} */
    selectedWindow;

    /** @type {Monitor} */
    monitor;

    constructor(workspace, container, doInit) {
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

        let clip = new Clutter.Actor({ name: 'clip' });
        this.clip = clip;
        let actor = new Clutter.Actor({ name: 'space-actor' });
        actor.set_pivot_point(0.5, 0);

        this._visible = true;
        this.hide(); // We keep the space actor hidden when inactive due to performance

        this.actor = actor;
        let cloneClip = new Clutter.Actor({ name: 'clone-clip' });
        this.cloneClip = cloneClip;
        let cloneContainer = new St.Widget({ name: 'clone-container' });
        this.cloneContainer = cloneContainer;

        clip.space = this;
        cloneContainer.space = this;

        container.add_child(clip);
        clip.add_child(actor);
        actor.add_child(cloneClip);
        cloneClip.add_child(cloneContainer);

        this.targetX = 0;

        this.uuid = GLib.uuid_string_random();
        this.initWorkspaceState();

        this.selectedWindow = null;
        this.leftStack = 0; // not implemented
        this.rightStack = 0; // not implemented

        this.createBackground();
        // primaryMonitor may be null at enable time; Spaces.init() will retry
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            this.setMonitor(monitor);
        }

        if (doInit) {
            this.init();
        }
    }

    init() {
        if (this._populated || Main.layoutManager._startingUp) return;

        let workspace = this.workspace;
        let prevSpace = saveState.getPrevSpaceByUUID(this.uuid);
        console.info(
            `restore by uuid: ${this.uuid}, prevSpace name: ${prevSpace?.name}`
        );

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
                    ensureViewport(display.focus_window, this, {
                        moveto: true,
                        force: true,
                        ensureAnimation:
                            Settings.prefs.overview_ensure_viewport_animation,
                    });
                });
            });
        });

        this.signals.connect(gsettings, 'changed::default-focus-mode', () => {
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

    activateWithFocus(metaWindow) {
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
        for (let col of this) {
            for (let w of col) {
                let actor = w.get_compositor_private();
                w.clone.cloneActor.source = actor;
            }
        }
    }

    hide() {
        if (!this._visible) return;
        this._visible = false;
        this.clip.hide();
        for (let col of this)
            for (let w of col) w.clone.cloneActor.source = null;
    }

    /**
     * Returns current workArea parameters for this space.
     * @returns object with x, y, width, and height values for this WorkArea.
     */
    workArea() {
        let workArea = Main.layoutManager.getWorkAreaForMonitor(
            this.monitor.index
        );
        return {
            x: workArea.x - this.monitor.x,
            y: workArea.y - this.monitor.y + Settings.prefs.vertical_margin,
            width: workArea.width,
            height:
                workArea.height -
                Settings.prefs.vertical_margin -
                Settings.prefs.vertical_margin_bottom,
        };
    }

    layoutGrabColumn(
        column,
        x,
        y0,
        targetWidth,
        availableHeight,
        time,
        grabWindow
    ) {
        let space = this;

        function mosh(windows, height, baseY) {
            let targetHeights = fitProportionally(
                windows.map(mw => mw.get_frame_rect().height),
                height
            );
            let [, y] = space.layoutColumnSimple(
                windows,
                x,
                baseY,
                targetWidth,
                targetHeights,
                time
            );
            return y;
        }

        const k = column.indexOf(grabWindow);
        if (k < 0) {
            throw new Error(
                `Anchor doesn't exist in column ${grabWindow?.title}`
            );
        }

        const gap = Settings.prefs.window_gap;
        const f = grabWindow.get_frame_rect();
        let yGrabRel = f.y - this.monitor.y;
        targetWidth = f.width;

        const H1 = yGrabRel - y0 - gap - (k - 1) * gap;
        const H2 =
            availableHeight -
            (yGrabRel + f.height - y0) -
            gap -
            (column.length - k - 2) * gap;
        k > 0 && mosh(column.slice(0, k), H1, y0);
        let y = mosh(column.slice(k, k + 1), f.height, yGrabRel);
        k + 1 < column.length && mosh(column.slice(k + 1), H2, y);

        return targetWidth;
    }

    layoutColumnSimple(windows, x, y0, targetWidth, targetHeights, time) {
        let space = this;
        let y = y0;

        for (let i = 0; i < windows.length; i++) {
            let mw = windows[i];
            let targetHeight = targetHeights[i];

            let f = mw.get_frame_rect();

            let resizable = !mw.fullscreen && !isMaximized(mw);

            if (mw.preferredWidth) {
                let prop = mw.preferredWidth;
                if (prop.value <= 0) {
                    console.warn('invalid preferredWidth value');
                } else if (prop.unit === 'px') {
                    targetWidth = prop.value;
                } else if (prop.unit === '%') {
                    let availableWidth =
                        space.workArea().width -
                        Settings.prefs.horizontal_margin * 2 -
                        Settings.prefs.window_gap;
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
                mw.move_frame(true, space.monitor.x, space.monitor.y);
                targetWidth = f.width;
                targetHeight = f.height;
            }
            if (mw.maximized_vertically) {
                /* NOTE: This should really be f.y - monitor.y, but eg. firefox
                   reports the wrong y coordinates at this point. */
                y -= Settings.prefs.vertical_margin;
            }

            let c = mw.clone;
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

            y += targetHeight + Settings.prefs.window_gap;
        }
        return [targetWidth, y];
    }

    layout(animate = true, options = {}) {
        // Guard against recursively calling layout
        if (!this._populated) return;
        if (this._inLayout) return;

        // option properties
        const ensure = options?.ensure ?? true;
        const allocators = options?.customAllocators;
        const centerIfOne = options?.centerIfOne ?? true;
        const callback = options?.callback;

        this._inLayout = true;
        this.startAnimate();

        let time = Settings.prefs.animation_time;
        let gap = Settings.prefs.window_gap;
        let x = gap; // init (ensures autostart apps in particular start properly gapped)
        let selectedIndex = this.selectedIndex();
        let workArea = this.workArea();

        // Happens on monitors-changed
        if (workArea.width === 0) {
            this._inLayout = false;
            return;
        }

        /* If current window is fullscreened, treat workarea as fullscreen (y = 0)
           to avoid a "flash of topbar spacing" before the next layout call resolves. */
        if (this.selectedWindow?.fullscreen) {
            workArea.y = 0;
        } else if (!this.showTopBar) {
            const panelBoxHeight = Topbar.panelBox.height;
            workArea.y -= panelBoxHeight;
            workArea.height += panelBoxHeight;
        }

        let availableHeight = workArea.height;
        let y0 = workArea.y;

        for (let i = 0; i < this.length; i++) {
            let column = this[i];
            // Actorless windows are trouble. Layout could conceivable run while a window is dying or being born.
            column = column.filter(mw => mw.get_compositor_private());
            if (column.length === 0) continue;

            // selected window in column
            const selectedInColumn =
                i === selectedIndex ? this.selectedWindow : null;

            let targetWidth;
            if (selectedInColumn) {
                // if selected window - use tiledWidth or frame.width (fallback)
                targetWidth =
                    selectedInColumn?._fullscreen_frame?.tiledWidth ??
                    selectedInColumn.get_frame_rect().width;
            } else {
                // otherwise get max of tiledWith or frame.with (fallback)
                targetWidth = Math.max(
                    ...column.map(w => {
                        return (
                            w?._fullscreen_frame?.tiledWidth ??
                            w.get_frame_rect().width
                        );
                    })
                );
            }

            // enforce minimum
            targetWidth = Math.min(
                targetWidth,
                workArea.width - 2 * Settings.prefs.minimum_margin
            );

            let resultingWidth;
            let allocator = allocators && allocators[i];
            if (
                inGrab &&
                inGrab.dnd &&
                column.includes(inGrab.window) &&
                !allocator
            ) {
                resultingWidth = this.layoutGrabColumn(
                    column,
                    x,
                    y0,
                    targetWidth,
                    availableHeight,
                    time,
                    inGrab.window
                );
            } else {
                allocator = allocator || allocateDefault;
                let targetHeights = allocator(
                    column,
                    availableHeight,
                    selectedInColumn
                );
                [resultingWidth] = this.layoutColumnSimple(
                    column,
                    x,
                    y0,
                    targetWidth,
                    targetHeights,
                    time
                );
            }

            x += resultingWidth + gap;
        }
        // final gap add - required to resolve https://github.com/paperwm/PaperWM/issues/684
        x += gap;

        this._inLayout = false;
        let oldWidth = this.cloneContainer.width;
        let min = workArea.x;
        let auto =
            (this.targetX + oldWidth >= min + workArea.width &&
                this.targetX <= 0) ||
            this.targetX === min + Math.round((workArea.width - oldWidth) / 2);

        // transforms break on width 1
        let width = Math.max(1, x - gap);
        this.cloneContainer.width = width;

        if (auto && animate) {
            if (width < workArea.width) {
                this.targetX = min + Math.round((workArea.width - width) / 2);
            } else if (this.targetX + width < min + workArea.width) {
                this.targetX = min + workArea.width - width;
            } else if (this.targetX > workArea.min) {
                this.targetX = workArea.x;
            }
            Easer.addEase(this.cloneContainer, {
                x: this.targetX,
                time,
                onComplete: this.moveDone.bind(this),
            });
        }
        if (animate && ensure) {
            ensureViewport(this.selectedWindow, this);
        } else {
            this.moveDone();
        }

        // if only one column on space, then center it
        if (centerIfOne && this.length === 1) {
            const mw = this.getWindows()[0];
            centerWindow(mw);
        }

        callback && callback();

        this.emit('layout', this);
    }

    queueLayout(animate = true, options = {}) {
        if (this._layoutQueued) return;
        this._layoutQueued = true;

        const laterType = options.laterType ?? Meta.LaterType.RESIZE;
        Utils.laterAdd(laterType, () => {
            this._layoutQueued = false;
            this.layout(animate, options);
        });
    }

    // Space.prototype.isVisible = function
    isVisible(metaWindow, margin = 0) {
        let clone = metaWindow.clone;
        let x = clone.x + this.cloneContainer.x;
        let workArea = this.workArea();
        let min = workArea.x;

        if (
            x - margin + clone.width < min ||
            x + margin > min + workArea.width
        ) {
            return false;
        } else {
            return true;
        }
    }

    isFullyVisible(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = this.workArea();
        let min = workArea.x;

        return min <= x && x + clone.width < min + workArea.width;
    }

    visibleRatio(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = this.workArea();
        let min = workArea.x;
        return min <= x && x + clone.width < min + workArea.width;
    }

    isPlaceable(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = Main.layoutManager.getWorkAreaForMonitor(
            this.monitor.index
        );
        let min = workArea.x - this.monitor.x;

        if (
            x + clone.width < min + stackMargin ||
            x > min + workArea.width - stackMargin
        ) {
            return false;
        } else {
            // Fullscreen windows are only placeable on the monitor origin
            if (
                (isMaximized(metaWindow) && x !== min) ||
                (metaWindow.fullscreen && x !== 0)
            ) {
                return false;
            }
            return true;
        }
    }

    /** @returns {Window[]} */
    getWindows() {
        return this.reduce((ws, column) => ws.concat(column), []);
    }

    getWindow(index, row) {
        if (!Lib.inBounds(this, index)) return false;
        let column = this[index];
        if (!Lib.inBounds(column, row)) return false;
        return column[row];
    }

    isWindowAtPoint(metaWindow, x, y) {
        let clone = metaWindow.clone;
        let wX = clone.x + this.cloneContainer.x;
        return (
            x >= wX &&
            x <= wX + clone.width &&
            y >= clone.y &&
            y <= clone.y + clone.height
        );
    }

    getWindowAtPoint(x, y) {
        for (let column of this) {
            for (let w of column) {
                if (this.isWindowAtPoint(w, x, y)) return w;
            }
        }
        return null;
    }

    addWindow(metaWindow, index, row) {
        if (!this.selectedWindow) this.selectedWindow = metaWindow;
        if (this.indexOf(metaWindow) !== -1) return false;

        if (row !== undefined && this[index]) {
            let column = this[index];
            column.splice(row, 0, metaWindow);
        } else {
            this.splice(index, 0, [metaWindow]);
        }

        /*
         * Fix (still needed in 45) for bug where move_frame sometimes triggers
         * another move back to its original position. Make sure tiled windows are
         * always positioned correctly (synced with clone position).
         */
        this.signals.connect(metaWindow, 'position-changed', w => {
            if (inGrab) return;

            let f = w.get_frame_rect();
            let clone = w.clone;
            let x = this.visibleX(w);
            let y = this.monitor.y + clone.targetY;
            // Mirrors moveDone, see there.
            if (this.isPlaceable(w)) {
                if (mutterSettings.get_boolean('workspaces-only-on-primary')) {
                    const margin = Math.max(
                        stackMargin,
                        Math.ceil(f.width / 2) + 1
                    );
                    x = Math.max(
                        margin - f.width,
                        Math.min(this.width - margin, x)
                    );
                } else {
                    x = Math.min(
                        this.width - stackMargin,
                        Math.max(stackMargin - f.width, x)
                    );
                }
            } else {
                x = Math.max(0, Math.min(this.width - f.width, x));
            }
            x += this.monitor.x;

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
            let workArea = this.workArea();
            this.targetX =
                workArea.x +
                Math.round((workArea.width - this.cloneContainer.width) / 2);
        }
        this.emit('window-added', metaWindow, index, row);
        return true;
    }

    removeWindow(metaWindow) {
        const index = this.indexOf(metaWindow);
        if (index === -1) return this.removeFloating(metaWindow);

        this.signals.disconnect(metaWindow);

        if (this.selectedWindow === metaWindow) {
            // Select a new window using the stack ordering;
            let windows = this.getWindows();
            let i = windows.indexOf(metaWindow);
            let neighbours = [windows[i - 1], windows[i + 1]].filter(w => w);
            let stack = sortWindows(this, neighbours);
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

        const actor = metaWindow.get_compositor_private();
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

    isFloating(metaWindow) {
        return this._floating.indexOf(metaWindow) !== -1;
    }

    addFloating(metaWindow) {
        if (
            this._floating.indexOf(metaWindow) !== -1 ||
            metaWindow.is_on_all_workspaces()
        )
            return false;
        this._floating.push(metaWindow);
        let clone = metaWindow.clone;
        Utils.actorReparent(clone, this.actor);
        return true;
    }

    removeFloating(metaWindow) {
        let i = this._floating.indexOf(metaWindow);
        if (i === -1) return false;
        this._floating.splice(i, 1);
        // this.actor.remove_child(metaWindow.clone);
        Utils.actorRemoveChild(this.actor, metaWindow.clone);
        return true;
    }

    /**
     * Returns true iff this space has a currently fullscreened window.
     */
    hasFullScreenWindow() {
        return this.getWindows().some(w => w.fullscreen);
    }

    swap(direction, metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;

        let [index, row] = this.positionOf(metaWindow);
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
        let column = this[index];
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
        ensureViewport(this.selectedWindow, this, { force: true });
    }

    switchLinear(dir, loop) {
        let index = this.selectedIndex();
        let column = this[index];
        if (!column) return false;
        let row = column.indexOf(this.selectedWindow);
        if (Lib.inBounds(column, row + dir) === false) {
            index += dir;
            if (loop) {
                if (index >= this.length) {
                    index = 0;
                } else if (index < 0) {
                    index = this.length - 1;
                }
            }
            if (dir === 1) {
                if (index < this.length) row = 0;
            } else if (index >= 0) row = this[index].length - 1;
        } else {
            row += dir;
        }

        let metaWindow = this.getWindow(index, row);
        ensureViewport(metaWindow, this);
        return true;
    }

    switchLeft(loop) {
        return this.switch(Meta.MotionDirection.LEFT, loop);
    }
    switchRight(loop) {
        return this.switch(Meta.MotionDirection.RIGHT, loop);
    }
    switchUp(loop) {
        return this.switch(Meta.MotionDirection.UP, loop);
    }
    switchDown(loop) {
        return this.switch(Meta.MotionDirection.DOWN, loop);
    }
    switch(direction, loop) {
        let space = this;
        let index = space.selectedIndex();
        if (index === -1) {
            return false;
        }
        let row = space[index].indexOf(space.selectedWindow);
        switch (direction) {
            case Meta.MotionDirection.RIGHT:
                index++;
                row = -1;
                break;
            case Meta.MotionDirection.LEFT:
                index--;
                row = -1;
        }
        if (loop) {
            if (index < 0) {
                index = space.length - 1;
            } else if (index >= space.length) {
                index = 0;
            }
        } else if (!Lib.inBounds(space, index)) {
            return false;
        }

        let column = space[index];

        if (row === -1) {
            let selected = sortWindows(this, column)[column.length - 1];
            row = column.indexOf(selected);
        }

        switch (direction) {
            case Meta.MotionDirection.UP:
                row--;
                break;
            case Meta.MotionDirection.DOWN:
                row++;
        }
        if (loop) {
            if (row < 0) {
                row = column.length - 1;
            } else if (row >= column.length) {
                row = 0;
            }
        } else if (!Lib.inBounds(column, row)) {
            return false;
        }

        let metaWindow = space.getWindow(index, row);
        ensureViewport(metaWindow, space);

        return true;
    }

    switchGlobalLeft() {
        this.switchGlobal(Meta.MotionDirection.LEFT);
    }
    switchGlobalRight() {
        this.switchGlobal(Meta.MotionDirection.RIGHT);
    }
    switchGlobalUp() {
        this.switchGlobal(Meta.MotionDirection.UP);
    }
    switchGlobalDown() {
        this.switchGlobal(Meta.MotionDirection.DOWN);
    }
    switchGlobal(direction) {
        let space = this;
        let index = space.selectedIndex();
        if (index === -1) {
            return;
        }
        let row = space[index].indexOf(space.selectedWindow);

        switch (direction) {
            case Meta.MotionDirection.RIGHT:
                index++;
                break;
            case Meta.MotionDirection.LEFT:
                index--;
        }
        if (!Lib.inBounds(space, index)) return;

        let column = space[index];
        if (column.length <= row) row = column.length - 1;

        switch (direction) {
            case Meta.MotionDirection.UP:
                row--;
                break;
            case Meta.MotionDirection.DOWN:
                row++;
        }
        if (!Lib.inBounds(column, row)) return;

        let metaWindow = space.getWindow(index, row);
        ensureViewport(metaWindow, space);
    }

    _drift(dx) {
        if (dx === 0) {
            return;
        }
        if (this.drifting) {
            return;
        }
        this.drifting = true;

        // stop drifting on key_release
        Navigator.getActionDispatcher(
            DispatcherMode.KEYBOARD
        ).addKeyReleaseCallback(() => {
            Utils.timeoutRemove(driftTimeout);
            this.drifting = null;
        });

        Utils.timeoutRemove(driftTimeout);
        driftTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            Gestures.update(this, dx, 1);
            this.selectedWindow = Gestures.findTargetWindow(
                this,
                dx < 0 ? -1 : 1
            );
            ensureViewport(this.selectedWindow, this);
            return true;
        });
    }

    driftLeft() {
        this._drift(-1 * Settings.prefs.drift_speed);
    }
    driftRight() {
        this._drift(Settings.prefs.drift_speed);
    }

    /**
     * Return the x position of the visible element of this window.
     */
    visibleX(metaWindow) {
        return metaWindow.clone.targetX + this.targetX;
    }

    /**
     * Return the y position of the visible element of this window.
     */
    visibleY(metaWindow) {
        return metaWindow.clone.targetY + this.monitor.y;
    }

    /**
     * Stage rect of the AlbumWM clone for this window. Used by the
     * `WindowPreview.boundingBox` override in patches.js so the overview
     * open/close animation interpolates toward where the clone visually
     * sits in the tiling grid rather than `meta_window_get_frame_rect()`
     * (which lies for non-placeable / fullscreen / maximized windows).
     */
    cloneStageRect(metaWindow) {
        const clone = metaWindow?.clone;
        if (!clone) return null;
        return {
            x: this.monitor.x + this.cloneContainer.x + clone.x,
            y: this.monitor.y + clone.y,
            width: clone.width,
            height: clone.height,
        };
    }

    positionOf(metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow))
                return [i, this[i].indexOf(metaWindow)];
        }
        return false;
    }

    indexOf(metaWindow) {
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow)) return i;
        }
        return -1;
    }

    rowOf(metaWindow) {
        let column = this[this.indexOf(metaWindow)];
        return column.indexOf(metaWindow);
    }

    globalToViewport(gx, gy) {
        let [, vx, vy] = this.actor.transform_stage_point(gx, gy);
        return [Math.round(vx), Math.round(vy)];
    }

    /** Transform global coordinates to scroll cooridinates (cloneContainer relative) */
    globalToScroll(gx, gy, { useTarget = false } = {}) {
        // Use the smart transform on the actor, as that's the one we scale etc.
        // We can then use straight translation on the scroll which makes it possible to use target instead if wanted.
        let [vx, vy] = this.globalToViewport(gx, gy);
        let sx = vx - (useTarget ? this.targetX : this.cloneContainer.x);
        let sy = vy - this.cloneContainer.y;
        return [Math.round(sx), Math.round(sy)];
    }

    viewportToScroll(vx, vy = 0) {
        return [vx - this.cloneContainer.x, vy - this.cloneContainer.y];
    }

    /**
     * Moves the space viewport to position x.
     * @param {Number} x
     */
    viewportMoveToX(x, animate = true) {
        this.targetX = x;
        this.cloneContainer.x = x;
        this.startAnimate();
        if (animate) {
            Easer.addEase(this.cloneContainer, {
                x,
                time: Settings.prefs.animation_time,
                onComplete: this.moveDone.bind(this),
            });
        } else {
            this.moveDone.bind(this);
        }
    }

    moveDone(focusedWindowCallback = _focusedWindow => {}) {
        if (
            this.cloneContainer.x !== this.targetX ||
            this.actor.y !== 0 ||
            Navigator.navigating ||
            Main.overview.visible ||
            // Block when we're carrying a window in dnd
            (inGrab && inGrab.window)
        ) {
            return;
        }

        this.visible = [];
        const monitor = this.monitor;
        this.getWindows().forEach(w => {
            let actor = w.get_compositor_private();
            if (!actor) return;

            let placeable = this.isPlaceable(w);
            if (placeable) this.visible.push(w);

            /* Guard against races between move_to and layout
               (moving can kill an ongoing resize). */
            if (Easer.isEasing(w.clone)) return;

            let unMovable = w.fullscreen || isMaximized(w);
            if (unMovable) return;

            let f = w.get_frame_rect();
            let x = this.visibleX(w);
            let y = this.visibleY(w);
            /* Non-placeable actors must stay on this.monitor or mutter
               reassigns them. In workspaces-only-on-primary mutter additionally
               auto-stickies any tiled window whose center crosses to a
               neighbour, so cap placeable actors there too. The cap is a no-op
               in safe positions; it only kicks in for swap and mouse-drag
               cases where moveDone would otherwise park a window in the band
               that crosses the boundary. */
            if (placeable) {
                if (mutterSettings.get_boolean('workspaces-only-on-primary')) {
                    const margin = Math.max(
                        stackMargin,
                        Math.ceil(f.width / 2) + 1
                    );
                    x = Math.max(margin - f.width, x);
                    x = Math.min(this.width - margin, x);
                } else {
                    x = Math.max(stackMargin - f.width, x);
                    x = Math.min(this.width - stackMargin, x);
                }
            } else {
                x = Math.max(0, Math.min(this.width - f.width, x));
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
        Main.layoutManager.untrackChrome(this.background);

        this._isAnimating = false;

        if (
            this.selectedWindow &&
            this.selectedWindow === display.focus_window
        ) {
            let index = this.indexOf(this.selectedWindow);

            this[index].forEach(w => (w.lastFrame = w.get_frame_rect()));

            // callback on display.focusWindow window
            focusedWindowCallback(display.focus_window);
        }

        this.emit('move-done');
    }

    /**
     * Applies clipping to metaWindow's clone.
     * @param {Window} metaWindow
     */
    applyClipToClone(metaWindow) {
        if (!metaWindow) {
            return;
        }

        let actor = metaWindow.get_compositor_private();
        if (!actor) {
            return;
        }

        // The actor's width/height is not correct right after resize
        const b = metaWindow.get_buffer_rect();
        const x = this.monitor.x - b.x;
        const y = this.monitor.y - b.y;
        const cw = this.monitor.width;
        const ch = this.monitor.height;
        actor.set_clip(x, y, cw, ch);
    }

    startAnimate() {
        if (!this._isAnimating) {
            // Tracking the background fixes issue #80
            // It also let us activate window clones clicked during animation
            // Untracked in moveDone
            Main.layoutManager.trackChrome(this.background);
        }

        this.visible.forEach(w => {
            let actor = w.get_compositor_private();
            if (!actor) return;
            actor.remove_clip();
            if (inGrab && inGrab.window === w) return;
            animateWindow(w);
        });

        this._floating.forEach(w => {
            let f = w.get_frame_rect();
            if (!animateWindow(w)) return;
            w.clone.x = f.x - this.monitor.x;
            w.clone.y = f.y - this.monitor.y;
        });

        this._isAnimating = true;
    }

    fixOverlays(metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;
        let index = this.indexOf(metaWindow);
        let target = this.targetX;
        this.monitor.clickOverlay.reset();
        for (
            let overlay = this.monitor.clickOverlay.right, n = index + 1;
            n < this.length;
            n++
        ) {
            let mw = this[n][0];
            let clone = mw.clone;
            let x = clone.targetX + target;
            if (!overlay.target && x + clone.width > this.width) {
                overlay.setTarget(this, n);
                break;
            }
        }

        for (
            let overlay = this.monitor.clickOverlay.left, n = index - 1;
            n >= 0;
            n--
        ) {
            let mw = this[n][0];
            let clone = mw.clone;
            let x = clone.targetX + target;
            if (!overlay.target && x < 0) {
                overlay.setTarget(this, n);
                break;
            }
        }
    }

    initWorkspaceState() {
        this.updateName();
        this.updateShowTopBar();

        this.signals.connect(
            gsettings,
            'changed::default-show-top-bar',
            this.updateShowTopBar.bind(this)
        );
    }

    updateShowTopBar() {
        this.showTopBar = Settings.prefs.default_show_top_bar;
        this._populated && Topbar.fixTopBar();
    }

    updateName() {
        const name = `Workspace ${this.index + 1}`;
        Meta.prefs_change_workspace_name(this.index, name);
        this.name = name;
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
            (_actor, _event) => {
                if (inGrab) {
                    return;
                }

                /* If user clicks on a window, ensureViewport on that window before exiting. */
                let [gx, gy] = global.get_pointer();
                let [, x, y] = this.actor.transform_stage_point(gx, gy);
                let windowAtPoint =
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
            (_actor, _event) => {
                this.activateWithFocus(this.selectedWindow);
            }
        );

        this.signals.connect(
            this.background,
            'scroll-event',
            (_actor, event) => {
                if (!inGrab && !Navigator.navigating) return;
                let dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.SMOOTH) return;

                let [gx] = event.get_coords();
                if (!gx) {
                    return;
                }

                switch (dir) {
                    case Clutter.ScrollDirection.LEFT:
                    case Clutter.ScrollDirection.UP:
                        this.switchLeft(false);
                        break;
                    case Clutter.ScrollDirection.RIGHT:
                    case Clutter.ScrollDirection.DOWN:
                        this.switchRight(false);
                        break;
                }
            }
        );

        this.signals.connect(
            this.background,
            'captured-event',
            (actor, event) => {
                return Gestures.horizontalScroll(this, actor, event);
            }
        );
    }

    setMonitor(monitor) {
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

        this.background.set_size(monitor.width, monitor.height);

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
    addAll(prevSpace) {
        // On gnome-shell-restarts the windows are moved into the viewport, but
        // they're moved minimally and the stacking is not changed, so the tiling
        // order is preserved (sans full-width windows..)
        let xzComparator = windows => {
            // Seems to be the only documented way to get stacking order?
            // Could also rely on the MetaWindowActor's index in it's parent
            // children array: That seem to correspond to clutters z-index (note:
            // z_position is something else)
            let sortedZ = display.sort_windows_by_stacking(windows);
            let xkey = mw => {
                let frame = mw.get_frame_rect();
                if (frame.x <= 0) return 0;
                if (frame.x + frame.width === this.width) {
                    return this.width;
                }
                return frame.x;
            };
            // xorder: a|b c|d
            // zorder: a d b c
            return (a, b) => {
                let ax = xkey(a);
                let bx = xkey(b);
                // Yes, this is not efficient
                let az = sortedZ.indexOf(a);
                let bz = sortedZ.indexOf(b);
                let xcmp = ax - bx;
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
                let column = prevSpace[i];
                for (let j = 0; j < column.length; j++) {
                    let metaWindow = column[j];
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

        let workspace = this.workspace;
        let windows = workspace
            .list_windows()
            .sort(xzComparator(workspace.list_windows()));

        windows.forEach((metaWindow, _i) => {
            if (metaWindow.above || metaWindow.minimized) {
                // Rough heuristic to figure out if a window should float
                Scratch.makeScratch(metaWindow);
                return;
            }
            if (this.indexOf(metaWindow) < 0 && addFilter(metaWindow)) {
                this.addWindow(metaWindow, this.length);
            }
        });

        let tabList = display
            .get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(metaWindow => {
                return this.indexOf(metaWindow) !== -1;
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
            return this.indexOf(this.selectedWindow);
        } else {
            return -1;
        }
    }

    destroy() {
        this.getWindows().forEach(w => {
            removeAlbumWMFlags(w);
        });
        this.signals.destroy();
        this.signals = null;
        this.background.destroy();
        this.background = null;
        this.cloneContainer.destroy();
        this.cloneContainer = null;
        this.clip.destroy();
        this.clip = null;
    }
}

Signals.addSignalMethods(Space.prototype);

/**
 * A `Map` to store all `Spaces`'s, indexed by the corresponding workspace.
 * @extends {Map<Meta.Workspace, Space>}
 */
export class Spaces extends Map {
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
        let spaceContainer = new Meta.BackgroundGroup({
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
            let workspace = workspaceManager.get_workspace_by_index(i);
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
            global.window_manager,
            'switch-workspace',
            (wm, from, to, _direction) => this.switchWorkspace(wm, from, to)
        );

        // Clone and hook up existing windows
        display.get_tab_list(Meta.TabList.NORMAL_ALL, null).forEach(w => {
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
        this.touchSignal = signals.connect(
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

        for (let overlay of this.clickOverlays) {
            overlay.destroy();
        }
        this.clickOverlays = [];

        const primary = Main.layoutManager.primaryMonitor;
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
        for (let overlay of this.clickOverlays) {
            overlay.destroy();
        }
        for (let monitor of Main.layoutManager.monitors) {
            delete monitor.clickOverlay;
        }

        display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach(metaWindow => {
                let actor = metaWindow.get_compositor_private();
                actor.remove_clip();

                if (metaWindow.clone) {
                    metaWindow.clone.destroy();
                    metaWindow.clone = null;
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
        this.signals = null;

        // remove spaces
        for (let [, space] of this) {
            this.removeSpace(space);
        }

        this.spaceContainer.destroy();
        this.spaceContainer = null;
    }

    workspacesChanged() {
        let nWorkspaces = workspaceManager.n_workspaces;

        // Identifying destroyed workspaces is rather bothersome,
        // as it will for example report having windows,
        // but will crash when looking at the workspace index

        // Gather all indexed workspaces for easy comparison
        let workspaces = {};
        for (let i = 0; i < nWorkspaces; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            workspaces[workspace] = true;
            if (this.spaceOf(workspace) === undefined) {
                this.addSpace(workspace);
            }
        }

        for (let [, space] of this) {
            if (workspaces[space.workspace] !== true) {
                this.removeSpace(space);
            }
        }

        for (let [workspace, space] of this) {
            Meta.prefs_change_workspace_name(workspace.index(), space.name);
        }
    }

    switchWorkspace(wm, fromIndex, toIndex) {
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

        let to = workspaceManager.get_workspace_by_index(toIndex);
        let toSpace = this.spaceOf(to);

        if (inGrab && inGrab.window) {
            inGrab.window.change_workspace(toSpace.workspace);
        }

        for (let metaWindow of toSpace.getWindows()) {
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
        signals.disconnect(Main.panel, this.touchSignal);
        this.touchSignal = signals.connect(
            Main.panel,
            'touch-event',
            Gestures.horizontalTouchScroll.bind(toSpace)
        );
    }

    showSpace(to) {
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

    addSpace(workspace) {
        let space = new Space(workspace, this.spaceContainer, this._initDone);
        this.set(workspace, space);
        this.stack.push(space);
    }

    removeSpace(space) {
        this.delete(space.workspace);
        this.stack.splice(this.stack.indexOf(space), 1);
        space.destroy();
    }

    spaceOfWindow(metaWindow) {
        return this.get(metaWindow.get_workspace());
    }

    /**
     *
     * @param {import('@gi-types/meta').Workspace} workspace
     * @returns {Space}
     */
    spaceOf(workspace) {
        return this.get(workspace);
    }

    /**
     * Returns the space by it's workspace index value.
     */
    spaceOfIndex(workspaceIndex) {
        let workspace = [...this.keys()].find(
            w => workspaceIndex === w.index()
        );
        return this.spaceOf(workspace);
    }

    /**
     * Returns the space of a specific uuid.
     */
    spaceOfUuid(uuid) {
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
     * @param {Space} space
     * @returns
     */
    isActiveSpace(space) {
        return space === this.activeSpace;
    }

    /**
       Return an array of Space's ordered in most recently used order.
     */
    mru() {
        let seen = new Map(),
            out = [];
        let active = workspaceManager.get_active_workspace();
        out.push(this.get(active));
        seen.set(active, true);

        display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach((metaWindow, _i) => {
                let workspace = metaWindow.get_workspace();
                if (!seen.get(workspace)) {
                    out.push(this.get(workspace));
                    seen.set(workspace, true);
                }
            });

        let workspaces = workspaceManager.get_n_workspaces();
        for (let i = 0; i < workspaces; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            if (!seen.get(workspace)) {
                out.push(this.get(workspace));
                seen.set(workspace, true);
            }
        }

        return out;
    }

    /**
     * @param display
     * @param metaWindow {import("@gi-types/meta").Window}
     */
    window_created(metaWindow) {
        if (!registerWindow(metaWindow)) {
            return;
        }

        metaWindow.unmapped = true;

        console.debug('window-created', metaWindow?.title);

        /* Pull windows off secondary monitors before first-frame paints.
           workspaces-only-on-primary auto-sticks them; unstick so the move
           takes and downstream guards see a normal new window. */
        const primary = Main.layoutManager.primaryMonitor;
        if (primary && metaWindow.get_monitor() !== primary.index) {
            if (metaWindow.is_on_all_workspaces()) {
                metaWindow.unstick();
            }
            metaWindow.move_to_monitor(primary.index);
        }

        let actor = metaWindow.get_compositor_private();
        animateWindow(metaWindow);

        /* We need reliable 'window_type', 'wm_class' et al. to handle window
           insertion correctly. These are not stable before 'first-frame'. */
        signals.connectOneShot(actor, 'first-frame', () => {
            allocateClone(metaWindow);
            insertWindow(metaWindow, { existing: false });
        });
    }
}
Signals.addSignalMethods(Spaces.prototype);

/**
 * Return true if a window is tiled (e.g. not floating, not scratch, not transient).
 * @param metaWindow
 */
export function isTiled(metaWindow) {
    if (
        !metaWindow ||
        metaWindow?.is_on_all_workspaces() ||
        isFloating(metaWindow) ||
        isScratch(metaWindow) ||
        isTransient(metaWindow)
    ) {
        return false;
    }

    return true;
}

/**
 * Transient windows are connected to a parent window and take entire focus
 * (can't focus parent window while it's open).
 * @param metaWindow
 * @returns
 */
export function isTransient(metaWindow) {
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
 * @param metaWindow
 * @returns
 */
export function hasTransient(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    let found = false;
    metaWindow.foreach_transient(_t => {
        found = true;
    });

    return found;
}

/**
 * Conveniece method for checking if a window is floating.
 * Will determine what space this window is on.
 * @param metaWindow
 * @returns
 */
export function isFloating(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    let space = spaces.spaceOfWindow(metaWindow);
    return space.isFloating?.(metaWindow) ?? false;
}

export function isScratch(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    return Scratch.isScratchWindow(metaWindow);
}

export function isMaximized(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    if (typeof metaWindow.is_maximized === 'function')
        // GNOME >= 49
        return metaWindow.is_maximized();
    return metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH;
}

function isMaximizedHorizontal(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    if (typeof metaWindow.get_maximize_flags === 'function')
        // GNOME >= 49
        return (
            metaWindow.get_maximize_flags() === Meta.MaximizeFlags.Horizontal
        );
    return metaWindow.get_maximized() === Meta.MaximizeFlags.Horizontal;
}

function unmaximize(metaWindow, flags) {
    if (!metaWindow) {
        return false;
    }
    if (typeof metaWindow.set_unmaximize_flags === 'function')
        // GNOME >= 49
        return metaWindow.set_unmaximize_flags(flags);
    return metaWindow.unmaximize(flags);
}

export function isOverrideRedirect(metaWindow) {
    const windowType = metaWindow.windowType;
    return (
        metaWindow.is_override_redirect() ||
        windowType === Meta.WindowType.DROPDOWN_MENU ||
        windowType === Meta.WindowType.TOOLTIP
    );
}

/**
 * @param {Window} metaWindow
 */
export function registerWindow(metaWindow) {
    if (isOverrideRedirect(metaWindow)) {
        return false;
    }

    if (metaWindow.clone) {
        // Can happen when setting session-modes to "unlock-dialog".
        console.warn('window already registered', metaWindow.title);
        return false;
    }

    const actor = metaWindow.get_compositor_private();
    const cloneActor = new Clutter.Clone({ source: actor });
    const clone = new Clutter.Actor();
    clone.add_child(cloneActor);

    // create shade
    const shade = new St.Widget({ style_class: 'albumwm-clone-shade' });
    // default opacity
    clone.add_child(shade);
    Utils.actorRaise(shade);
    shade.opacity = 0;
    shade.hide();

    metaWindow.clone = clone;
    metaWindow.clone.cloneActor = cloneActor;
    metaWindow.clone.shade = shade;

    clone.targetX = 0;
    clone.meta_window = metaWindow;

    signals.connect(metaWindow, 'focus', (mw, userData) => {
        focusHandler(mw, userData);
    });
    signals.connect(metaWindow, 'size-changed', allocateClone);
    // Note: runs before gnome-shell's minimize handling code
    signals.connect(metaWindow, 'notify::fullscreen', () => {
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
    signals.connect(metaWindow, 'notify::minimized', mw => {
        minimizeHandler(mw);
    });

    signals.connect(actor, 'show', a => {
        showHandler(a);
    });

    /**
     * Check when moving window that it's targetHeight is correct.
     */
    signals.connect(actor, 'stage-views-changed', _actor => {
        const f = metaWindow.get_frame_rect();
        if (metaWindow._targetHeight !== f.height) {
            resizeHandler(metaWindow);
        }
    });

    /**
     * Not all applications (and application states) work well with `stage-views-change`
     * actor signal (and the resizeHandler).  For example, some apps if too wide
     * (e.g. full width of tiling window) won't get detected with `stage-views-changed`
     * signal when it's workspace has changed (e.g. keybind to move to another monitor).
     * The below works around this issue by continually (up to a number of tries)
     * checking the height and resizing.
     */
    const done = t => {
        const index = workspaceChangeTimeouts.indexOf(t);
        workspaceChangeTimeouts.splice(index, 1);
        // console.log(`num workspaceChangeTimeouts ${workspaceChangeTimeouts.length}`);
    };
    signals.connect(metaWindow, 'workspace-changed', mw => {
        if (!isTiled(mw)) {
            return;
        }

        const timeout = Utils.periodicTimeout({
            period_ms: 100,
            count: 10,
            callback: () => {
                const f = metaWindow.get_frame_rect();
                if (metaWindow._targetHeight !== f.height) {
                    if (!isNaN(metaWindow._targetHeight)) {
                        metaWindow.move_resize_frame(
                            true,
                            f.x,
                            f.y,
                            f.width,
                            metaWindow._targetHeight
                        );
                    }
                }
            },
            onComplete: () => {
                done(timeout);
            },
        });
        workspaceChangeTimeouts.push(timeout);
    });

    signals.connect(actor, 'destroy', destroyHandler);
    return true;
}

export function allocateClone(metaWindow) {
    if (!metaWindow?.clone) {
        return;
    }

    let frame = metaWindow.get_frame_rect();
    let buffer = metaWindow.get_buffer_rect();
    // Adjust the clone's origin to the north-west, so it will line up
    // with the frame.
    let clone = metaWindow.clone;
    let cloneActor = clone.cloneActor;
    cloneActor.set_position(buffer.x - frame.x, buffer.y - frame.y);
    cloneActor.set_size(buffer.width, buffer.height);
    clone.set_size(frame.width, frame.height);

    // update shade sizing too, we want it a little bigger
    const [width, height] = clone.get_size();
    metaWindow.clone.shade.set_position(-1, -1);
    metaWindow.clone.shade.set_size(width + 2, height + 2);
}

export function destroyHandler(actor) {
    signals.disconnect(actor);
}

/**
 * Removes resize, position, and other flags.  Used during cleanup etc.
 * @param {Window} metaWindow
 */
export function removeAlbumWMFlags(w) {
    delete w._targetWidth;
    delete w._targetHeight;
    delete w._resizeHandlerAdded;
    delete w._positionHandlerAdded;
    delete w._pos_mismatch_count;
    delete w._tiled_on_minimize;
    delete w._fullscreen_frame;
    delete w._fullscreen_lock;
    delete w._fullscreen_above;
    delete w._scratch;
    delete w._scratchFrame;
}

export function addPositionHandler(metaWindow) {
    if (metaWindow._positionHandlerAdded) {
        return;
    }
    signals.connect(metaWindow, 'position-changed', positionChangeHandler);
    metaWindow._positionHandlerAdded = true;
}

export function addResizeHandler(metaWindow) {
    if (metaWindow._resizeHandlerAdded) {
        return;
    }
    signals.connect(metaWindow, 'size-changed', mw => {
        Utils.laterAdd(Meta.LaterType.RESIZE, () => {
            resizeHandler(mw);
        });
    });
    metaWindow._resizeHandlerAdded = true;
}

export function positionChangeHandler(metaWindow) {
    // don't update saved position if fullscreen
    if (metaWindow.fullscreen || metaWindow?._fullscreen_lock) {
        return;
    }

    saveFullscreenFrame(metaWindow);
}

export function resizeHandler(metaWindow) {
    // if navigator is showing, reset/refresh it after a window has resized
    if (Navigator.navigating) {
        Navigator.getNavigator().minimaps.forEach(
            m => typeof m !== 'number' && m.reset()
        );
    }

    if (inGrab && inGrab.window === metaWindow) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) {
        return;
    }

    const f = metaWindow.get_frame_rect();
    metaWindow._targetWidth = null;
    metaWindow._targetHeight = null;

    if (space.indexOf(metaWindow) === -1) {
        nonTiledSizeHandler(metaWindow);
        return;
    }

    const fsf = metaWindow?._fullscreen_frame;
    const selected = metaWindow === space.selectedWindow;
    let addCallback = false;
    let x;

    let needLayout = false;
    // if target width differs ==> layout
    if (
        metaWindow._targetWidth !== f.width ||
        metaWindow._targetHeight !== f.height
    ) {
        needLayout = true;
    }

    // if saved size differs ==> layout
    if (fsf) {
        if (fsf.width !== f.width || fsf.height !== f.height) {
            needLayout = true;
        }
    }

    const mover = (mx, animate) => {
        moveTo(space, metaWindow, {
            x: mx,
            animate,
        });
    };

    // if window is fullscreened, then don't animate background space.container animation etc.
    if (metaWindow.fullscreen) {
        metaWindow._fullscreen_lock = true;
        space.layout(false, { callback: mover(0, false), centerIfOne: false });
        return;
    }

    x = metaWindow?._fullscreen_frame?.x ?? f.x;
    x -= space.monitor.x;

    // for non-maximised windows, enforce horizontal margin in restore position
    if (!isMaximized(metaWindow) && !isMaximizedHorizontal(metaWindow)) {
        x = Math.max(x, Settings.prefs.horizontal_margin);
    }

    // if pwm fullscreen previously
    if (metaWindow._fullscreen_lock) {
        delete metaWindow._fullscreen_lock;
        needLayout = true;
        addCallback = true;
    } else {
        // save width for later exit-fullscreen restoring
        saveFullscreenFrame(metaWindow, true);
    }

    if (needLayout && !space._inLayout) {
        // Restore window position when eg. exiting fullscreen
        let callback = () => {};
        if (addCallback && !Navigator.navigating && selected) {
            callback = () => {
                mover(x, true);
            };
        }

        // Resizing from within a size-changed signal is troube (#73). Queue instead.
        space.queueLayout(true, { callback, centerIfOne: false });
    }

    if (space.length === 1) {
        centerWindow(metaWindow);
    }
}

/**
 * ResizeHandler for non-tiled windows
 * @param {*} metaWindow
 */
export function nonTiledSizeHandler(metaWindow) {
    // if window is fullscreen ==> set lock
    if (metaWindow.fullscreen) {
        metaWindow._fullscreen_lock = true;
        return;
    }

    // if here then was previously in fullscreen (and came out of)
    if (metaWindow._fullscreen_lock) {
        delete metaWindow._fullscreen_lock;
        let fsf = metaWindow._fullscreen_frame;
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
 * @param {Window} metaWindow
 */
export function saveFullscreenFrame(metaWindow, tiled) {
    const f = metaWindow.get_frame_rect();
    const fsf = metaWindow._fullscreen_frame ?? {};
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

/* Switch keyboard focus to a neighbouring monitor. Moving windows between
   monitors is handled by mutter's built-in move-to-monitor-* keybindings. */
export function switchMonitor(direction) {
    const i = display.get_current_monitor();
    const j = display.get_monitor_neighbor_index(i, direction);
    if (j === -1) return;
    const target = Main.layoutManager.monitors[j];

    /* Prefer the active space's selected window if its monitor matches,
       otherwise any window on the target monitor in the active workspace. */
    const activeSpace = spaces.activeSpace;
    let focusTarget = null;
    if (activeSpace?.monitor === target && activeSpace.selectedWindow) {
        focusTarget = activeSpace.selectedWindow;
    }
    if (!focusTarget) {
        const ws = workspaceManager.get_active_workspace();
        focusTarget = ws.list_windows().find(w => w.get_monitor() === j);
    }
    if (focusTarget) {
        Main.activateWindow(focusTarget);
        maybeWarpPointerToWindow(focusTarget);
    } else {
        Utils.warpPointerToMonitor(target);
    }
}

/**
 * Convenience method to run a callback method when an actor is shown the stage.
 * Uses a `connectOneShot` signal.
 * @param actor
 * @param callback
 */
function callbackOnActorShow(actor, callback) {
    signals.connectOneShot(actor, 'show', callback);
}

/**
   Types of windows which never should be tiled.
 */
export function addFilter(metaWindow) {
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
    if (Scratch.isScratchWindow(metaWindow)) {
        return false;
    }

    return true;
}

/**
   Handle windows leaving workspaces.
 */
export function removeHandler(workspace, metaWindow) {
    // Note: If `metaWindow` was closed and had focus at the time, the next
    // window has already received the `focus` signal at this point.
    // Not sure if we can check directly if _this_ window had focus when closed.

    let space = spaces.spaceOf(workspace);
    space.removeWindow(metaWindow);

    let actor = metaWindow.get_compositor_private();
    if (!actor) {
        signals.disconnect(metaWindow);
        if (metaWindow.clone && metaWindow.clone.mapped) {
            metaWindow.clone.destroy();
            metaWindow.clone = null;
        }
    }
}

/**
   Handle windows entering workspaces.
*/
export function addHandler(_ws, metaWindow) {
    // Do not handle grabbed windows
    if (inGrab && inGrab.window === metaWindow) return;

    let actor = metaWindow.get_compositor_private();
    if (actor) {
        // Set position and hookup signals, with `existing` set to true
        insertWindow(metaWindow, { existing: !metaWindow.redirected });
        delete metaWindow.redirected;
    }
    // Otherwise we're dealing with a new window, so we let `window-created`
    // handle initial positioning.
}

/**
   Insert the window into its space if appropriate. Requires MetaWindowActor

   This gets called from `Workspace::window-added` if the window already exists,
   and `Display::window-created` through `WindowActor::show` if window is newly
   created to ensure that the WindowActor exists.
*/
export function insertWindow(metaWindow, options = {}) {
    const existing = options?.existing ?? false;
    const dropping = options?.dropping ?? false;
    const dropCallback = options?.dropCallback ?? function () {};

    // Mirrors window_created's monitor pull, for the addHandler path.
    const primaryMonitor = Main.layoutManager.primaryMonitor;
    if (
        !existing &&
        primaryMonitor &&
        metaWindow.get_monitor() !== primaryMonitor.index
    ) {
        if (metaWindow.is_on_all_workspaces()) {
            metaWindow.unstick();
        }
        metaWindow.move_to_monitor(primaryMonitor.index);
    }

    // Add newly created windows to the space being previewed
    if (
        !existing &&
        !metaWindow.is_on_all_workspaces() &&
        metaWindow.get_workspace() !== spaces.selectedSpace.workspace
    ) {
        metaWindow.redirected = true;
        metaWindow.change_workspace(spaces.selectedSpace.workspace);
        return;
    }

    const connectSizeChanged = tiled => {
        if (tiled) {
            animateWindow(metaWindow);
        }
        addResizeHandler(metaWindow);
        addPositionHandler(metaWindow);

        delete metaWindow.unmapped;
    };

    const actor = metaWindow.get_compositor_private();

    let overwriteSpace;
    if (!existing) {
        let addToScratch = false;

        let winprop = Settings.findWinprop(metaWindow);
        if (winprop) {
            if (winprop.oneshot) {
                Settings.winprops.splice(Settings.winprops.indexOf(winprop), 1);
            }
            if (winprop.scratch_layer) {
                console.debug(
                    '#winprops',
                    `Move ${metaWindow?.title} to scratch`
                );
                addToScratch = true;
            }

            // pass winprop properties to metaWindow
            metaWindow.preferredWidth = winprop.preferredWidth;

            overwriteSpace = winprop.spaceIndex;
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

            if (winprop.focus) {
                console.debug(
                    '#winprops',
                    `setting ${metaWindow?.title} to focusOnOpen`
                );
                metaWindow.focusOnOpen = true;
            }
        }

        if (addToScratch) {
            connectSizeChanged();
            Scratch.makeScratch(metaWindow);
            activateWindowAfterRendered(actor, metaWindow);
            return;
        }

        /**
         * Address inserting windows that are already fullscreen: windows will be inserted
         * as normal (non-fullscreen) and will be fullscreened after a timeout on actor show.
         * see https://github.com/paperwm/PaperWM/issues/638
         */
        if (metaWindow.fullscreen) {
            animateWindow(metaWindow);
            callbackOnActorShow(actor, () => {
                fullscreenStartTimeout = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    100,
                    () => {
                        metaWindow.unmake_fullscreen();
                        showWindow(metaWindow);
                        metaWindow.make_fullscreen();
                        fullscreenStartTimeout = null;
                        return false; // on return false destroys timeout
                    }
                );
            });
        }
    }

    if (metaWindow.is_on_all_workspaces()) {
        // Only connect the necessary signals and show windows on shared
        // secondary monitors.
        connectSizeChanged();
        showWindow(metaWindow);
        return;
    } else if (Scratch.isScratchWindow(metaWindow)) {
        // And make sure scratch windows are stuck
        Scratch.makeScratch(metaWindow);
        return;
    }

    const space = spaces.spaceOfWindow(metaWindow);

    if (overwriteSpace !== undefined) {
        const newspace = spaces.spaceOfIndex(overwriteSpace);
        if (!newspace) {
            Main.notify(
                `AlbumWM [winprop]: cannot open window on workspace ${overwriteSpace} (index)`,
                `"${metaWindow?.title}" cannot be opened on workspace with index ${overwriteSpace}
(workspace not found). Opening on current workspace instead.`
            );
            console.warn(
                '#winprops',
                `overwriteSpace with index ${overwriteSpace} does not exist. \
Opening "${metaWindow?.title}" on current space.`
            );
        } else {
            console.debug(
                '#winprops',
                `inserting window into space ${newspace.name}`
            );
            metaWindow.change_workspace(newspace.workspace);
            metaWindow.foreach_transient(t => {
                space.addFloating(t);
            });
            connectSizeChanged(true);
            insertWindow(metaWindow, { existing: true });
            return;
        }
    }
    const active = space.selectedWindow;

    if (!addFilter(metaWindow)) {
        connectSizeChanged();
        space.addFloating(metaWindow);
        // Make sure the window is on the correct monitor
        metaWindow.move_to_monitor(space.monitor.index);
        showWindow(metaWindow);
        // Make sure the window isn't hidden behind the space (eg. dialogs)
        !existing && metaWindow.make_above();
        return;
    }

    if (space.indexOf(metaWindow) !== -1) {
        return;
    }

    let clone = metaWindow.clone;
    let ok, x, y;
    // Figure out the matching coordinates before the clone is reparented.
    if (isWindowAnimating(metaWindow)) {
        let point = clone.apply_transform_to_point(
            new Graphene.Point3D({ x: 0, y: 0 })
        );
        [ok, x, y] = space.cloneContainer.transform_stage_point(
            point.x,
            point.y
        );
    } else {
        let frame = metaWindow.get_frame_rect();
        [ok, x, y] = space.cloneContainer.transform_stage_point(
            frame.x,
            frame.y
        );
    }
    ok && clone.set_position(x, y);

    if (!space.addWindow(metaWindow, getOpenWindowPositionIndex(space))) return;

    metaWindow.unmake_above();
    if (isMaximized(metaWindow)) {
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
        toggleMaximizeHorizontally(metaWindow);
    }

    // run a simple layout in pre-prepare layout
    space.layout(false);

    const slurpCheck = timeout => {
        const slurpPosition =
            Settings.prefs.open_window_position ===
            Settings.OpenWindowPositions.DOWN
                ? SlurpInsertPosition.BELOW
                : null;

        if (!slurpPosition) {
            dropCallback(metaWindow);
            return;
        }

        // has slurpPosition but no timeout
        if (!timeout) {
            slurp(active, slurpPosition);
            dropCallback(metaWindow);
            return;
        }

        // if need to slurp (i.e. vertical stack)
        stackSlurpTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            slurp(active, slurpPosition);
            dropCallback(metaWindow);
            return false; // on return false destroys timeout
        });
    };

    /**
     * If window is new, then setup and ensure is in view
     * after actor is shown on stage.
     */
    if (!existing) {
        clone.x = clone.targetX;
        clone.y = clone.targetY;
        space.layout();

        // run focus and resize to ensure new window is correctly shown
        focusHandler(metaWindow);
        resizeHandler(metaWindow);
        connectSizeChanged(true);

        // // remove winprop props after window shown
        callbackOnActorShow(actor, () => {
            delete metaWindow.preferredWidth;

            Main.activateWindow(metaWindow);
            ensureViewport(space.selectedWindow, space);
            maybeWarpPointerToWindow(metaWindow);

            slurpCheck(true);
        });

        return;
    }

    space.layout();
    animateWindow(metaWindow);
    if (metaWindow.overwriteSpace !== undefined) {
        delete metaWindow.overwriteSpace;
        if (!metaWindow.focusOnOpen) {
            return;
        } else {
            delete metaWindow.focusOnOpen;
            console.debug('#winprops', 'focusing space of inserted window');
            Utils.laterAdd(Meta.LaterType.IDLE, () => {
                spaces.spaceOfWindow(metaWindow)?.activateWithFocus(metaWindow);
            });
        }
    }

    if (metaWindow === display.focus_window) {
        focusHandler(metaWindow);
    } else if (space === spaces.activeSpace) {
        Main.activateWindow(metaWindow);
    } else {
        ensureViewport(space.selectedWindow, space);
    }

    if (dropping) {
        slurpCheck(false);
    }
}

/**
 * Gets the window index to add a new window in the space (always to the right
 * of the selected window — DOWN position handles its placement via slurp).
 */
export function getOpenWindowPositionIndex(space) {
    let index = -1;
    if (space?.selectedWindow) {
        index = space.indexOf(space.selectedWindow);
    }
    return index + 1;
}

export function animateDown(metaWindow) {
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    Easer.addEase(metaWindow.clone, {
        y: workArea.y,
        time: Settings.prefs.animation_time,
    });
}

export function ensuredX(metaWindow, space) {
    let index = space.indexOf(metaWindow);
    let last = space.selectedWindow;
    let lastIndex = space.indexOf(last);
    let neighbour = Math.abs(lastIndex - index) <= 1;

    let monitor = space.monitor;
    let frame = metaWindow.get_frame_rect();
    let clone = metaWindow.clone;

    let x;
    if (
        neighbour ||
        space.isVisible(metaWindow) ||
        metaWindow.lastFrame === undefined
    )
        x = Math.round(clone.targetX) + space.targetX;
    else x = metaWindow.lastFrame.x - monitor.x;
    let workArea = space.workArea();
    let min = workArea.x;
    let max = min + workArea.width;

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
            x = min + Settings.prefs.horizontal_margin;
        else x = max - Settings.prefs.horizontal_margin - frame.width;
    } else if (
        frame.width >
        workArea.width * 0.9 -
            2 * (Settings.prefs.horizontal_margin + Settings.prefs.window_gap)
    ) {
        // Consider the window to be wide and center it
        x = min + Math.round((workArea.width - frame.width) / 2);
    } else if (x + Settings.prefs.horizontal_margin + frame.width > max) {
        // Align to the right prefs.horizontal_margin
        x = max - Settings.prefs.horizontal_margin - frame.width;
    } else if (x < min + Settings.prefs.horizontal_margin) {
        // Align to the left prefs.horizontal_margin
        x = min + Settings.prefs.horizontal_margin;
    } else if (x + frame.width === max) {
        // When opening new windows at the end, in the background, we want to
        // show some minimup margin
        x = max - Settings.prefs.minimum_margin - frame.width;
    } else if (x === min) {
        // Same for the start (though the case isn't as common)
        x = min + Settings.prefs.minimum_margin;
    }

    return x;
}

/**
   Make sure that `metaWindow` is in view, scrolling the space if needed.
 * @param metaWindow
 * @param {Space} space
 * @param {Object} options
 * @param {boolean} options.force
 * @param {boolean} options.moveto if true, executes a moveTo animated action
 * @returns
 */
export function ensureViewport(metaWindow, space, options = {}) {
    space = space ?? spaces.spaceOfWindow(metaWindow);
    let force = options?.force ?? false;
    let moveto = options?.moveto ?? true;
    let animate = options?.animate ?? true;
    let ensureAnimation =
        options.ensureAnimation ?? Settings.EnsureViewportAnimation.TRANSLATE;
    let callback = options.callback ?? function () {};

    let index = space.indexOf(metaWindow);
    if (index === -1 || space.length === 0) return false;

    if (space.selectedWindow.fullscreen && !metaWindow.fullscreen) {
        animateDown(space.selectedWindow);
    }
    let x = ensuredX(metaWindow, space);

    space.selectedWindow = metaWindow;
    let selected = space.selectedWindow;
    if (selected.fullscreen) {
        let y = 0;
        let ty = selected.clone.get_transition('y');
        if (!space.isVisible(selected)) {
            selected.clone.y = y;
        } else if (!ty || ty.get_interval().final !== y) {
            Easer.addEase(selected.clone, {
                y,
                time: Settings.prefs.animation_time,
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
export function moveTo(space, metaWindow, options = {}) {
    let x = options.x ?? 0;
    let force = options.force ?? false;
    let animate = options.animate ?? true;
    let ensureAnimation =
        options.ensureAnimation ?? Settings.EnsureViewportAnimation.TRANSLATE;
    let callback = options.callback ?? function () {};
    if (space.indexOf(metaWindow) === -1) return;

    let clone = metaWindow.clone;
    let target = x - clone.targetX;
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
            time: Settings.prefs.animation_time,
            onComplete: () => done(),
        });
    } else {
        Easer.addEase(space.cloneContainer, {
            x: target,
            time: Settings.prefs.animation_time,
            onComplete: () => done(),
        });
    }
}

export function grabBegin(metaWindow, type) {
    switch (type) {
        case Meta.GrabOp.COMPOSITOR:
        case Meta.GrabOp.FRAME_BUTTON:
            // Don't handle pushModal grabs and SCD button (close/minimize/etc.) grabs
            break;
        case Meta.GrabOp.KEYBOARD_MOVING:
            inGrab = new Grab.MoveGrab(metaWindow, type);
            if (!isTiled(metaWindow)) {
                return;
            }

            // NOTE: Keyboard grab moves the cursor, but it happens after grab
            // signals have run. Simply delay the dnd so it will get the correct
            // pointer coordinates.
            Utils.laterAdd(Meta.LaterType.IDLE, () => {
                inGrab.begin();
                inGrab.beginDnD();
            });
            break;
        case Meta.GrabOp.MOVING:
        case Meta.GrabOp.MOVING_UNCONSTRAINED: // introduced in Gnome 44
            if (!isTiled(metaWindow)) {
                return;
            }

            inGrab = new Grab.MoveGrab(metaWindow, type);

            if (Utils.getModiferState() & Clutter.ModifierType.CONTROL_MASK) {
                inGrab.begin();
                inGrab.beginDnD();
            } else if (
                inGrab.initialSpace &&
                inGrab.initialSpace.indexOf(metaWindow) > -1
            ) {
                inGrab.begin();
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

export function grabEnd(_metaWindow, _type) {
    if (!inGrab || inGrab.dnd || inGrab.grabbed) return;

    inGrab.end();
    inGrab = false;
}

/**
 * Returns the default focus mode (can be user-defined).
 */
export function getDefaultFocusMode() {
    // find matching focus mode
    const mode = Settings.prefs.default_focus_mode;
    const modes = FocusModes;
    let result = null;
    Object.entries(modes).forEach(([k, v]) => {
        if (v === mode) {
            result = k;
        }
    });

    // if found return, otherwise return default
    if (result) {
        return modes[result];
    } else {
        return modes.DEFAULT;
    }
}

// `MetaWindow::focus` handling
export function focusHandler(metaWindow) {
    console.debug('focus:', metaWindow?.title);
    if (Scratch.isScratchWindow(metaWindow)) {
        Scratch.makeScratch(metaWindow);
        Topbar.fixTopBar();
        return;
    }

    if (isTransient(metaWindow)) {
        return;
    }

    let space = spaces.spaceOfWindow(metaWindow);

    // if window is on another monitor then warp pointer there
    if (
        !Main.overview.visible &&
        Utils.monitorAtCurrentPoint() !== space.monitor
    ) {
        Utils.warpPointerToMonitor(space.monitor);
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
            Settings.prefs.vertical_margin !== 0 &&
            Settings.prefs.window_gap !== 0
        ) {
            needLayout = true;
        }

        if (needLayout) {
            space.layout(false);
        }
    }
    space.monitor.clickOverlay.show();

    /**
       Find the closest neighbours. Remove any dead windows in the process to
       work around the fact that `focus` runs before `window-removed` (and there
       doesn't seem to be a better signal to use)
     */
    let windows = space.getWindows();
    let around = windows.indexOf(metaWindow);
    if (around === -1) return;

    let neighbours = [];
    for (let i = around - 1; i >= 0; i--) {
        let w = windows[i];
        if (w.get_compositor_private()) {
            neighbours.push(windows[i]);
            break;
        }
        space.removeWindow(w);
    }
    for (let i = around + 1; i < windows.length; i++) {
        let w = windows[i];
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
    let stack = sortWindows(space, neighbours);
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
 * (focus movement keybindings, close-window, insertWindow, LiveAltTab etc.).
 * Checks if "warp-pointer-on-focus" is true, and has a lot of other safeguards
 * and logic.
 */
export function maybeWarpPointerToWindow(metaWindow) {
    if (!Settings.prefs.warp_pointer_on_focus) return;
    if (Main.overview.visible) return;
    if (!metaWindow) return;
    /* visibleX/Y read metaWindow.clone.targetX/targetY, which is only kept in
     * sync for tiled windows; skip the rest. */
    if (Scratch.isScratchWindow(metaWindow)) return;
    if (isTransient(metaWindow)) return;
    if (isFloating(metaWindow)) return;
    if (!metaWindow.clone) return;

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) return;

    /* Use post-scroll coordinates instead of the current frame_rect, which
     * only catches up at moveDone (end of strip animation). */
    const f = metaWindow.get_frame_rect();
    const tx = space.visibleX(metaWindow) + space.monitor.x;
    const ty = space.visibleY(metaWindow);
    const [px, py] = global.get_pointer();
    const inside =
        px >= tx && px < tx + f.width && py >= ty && py < ty + f.height;
    if (inside) return;

    Utils.warpPointer(
        tx + Math.floor(f.width / 2),
        ty + Math.floor(f.height / 2),
        false
    );
}

/**
   Push all minimized windows to the scratch layer
 */
export function minimizeHandler(metaWindow) {
    if (metaWindow.minimized) {
        console.debug('minimized', metaWindow?.title);
        // check if was tiled
        if (isTiled(metaWindow)) {
            metaWindow._tiled_on_minimize = true;
        }
        Scratch.makeScratch(metaWindow);
    } else {
        console.debug('unminimized', metaWindow?.title);
        if (metaWindow._tiled_on_minimize) {
            delete metaWindow._tiled_on_minimize;
            Utils.laterAdd(Meta.LaterType.IDLE, () => {
                Scratch.unmakeScratch(metaWindow);
            });
        }
    }
}

/**
  `WindowActor::show` handling

  Kill any falsely shown WindowActor.
*/
export function showHandler(actor) {
    let metaWindow = actor.meta_window;
    let onActive =
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

export function showWindow(metaWindow) {
    let actor = metaWindow.get_compositor_private();
    if (!actor) return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.hide();
        metaWindow.clone.cloneActor.source = null;
    }
    actor.show();
    return true;
}

export function animateWindow(metaWindow) {
    let actor = metaWindow.get_compositor_private();
    if (!actor) return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.show();
        metaWindow.clone.cloneActor.source = actor;
    }
    actor.hide();
    return true;
}

export function isWindowAnimating(metaWindow) {
    let clone = metaWindow.clone;
    return clone.get_parent() && clone.cloneActor.visible;
}

export function toggleMaximizeHorizontally(metaWindow) {
    metaWindow = metaWindow || display.focus_window;

    if (isMaximized(metaWindow)) {
        // ASSUMPTION: MaximizeFlags.HORIZONTALLY is not used
        unmaximize(metaWindow, Meta.MaximizeFlags.BOTH);
        metaWindow.unmaximizedRect = null;
        return;
    }

    let maxWidthPrc = Settings.prefs.maximize_width_percent;
    // add some sane limits to width percents: 0.5 <= x <= 1.0
    maxWidthPrc = Math.max(0.5, maxWidthPrc);
    maxWidthPrc = Math.min(1.0, maxWidthPrc);

    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    let frame = metaWindow.get_frame_rect();
    let reqWidth =
        maxWidthPrc * workArea.width - Settings.prefs.horizontal_margin * 2;

    // Some windows only resize in increments > 1px so we can't rely on a precise width
    // Hopefully this heuristic is good enough
    let isFullWidth = reqWidth - frame.width < sizeSlack;

    if (isFullWidth && metaWindow.unmaximizedRect) {
        let unmaximizedRect = metaWindow.unmaximizedRect;
        metaWindow.move_resize_frame(
            true,
            unmaximizedRect.x,
            frame.y,
            unmaximizedRect.width,
            frame.height
        );

        metaWindow.unmaximizedRect = null;
    } else {
        let x = workArea.x + space.monitor.x + Settings.prefs.horizontal_margin;
        metaWindow.unmaximizedRect = frame;
        metaWindow.move_resize_frame(true, x, frame.y, reqWidth, frame.height);
    }
}

export function resizeHInc(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxHeight =
        workArea.height -
        Settings.prefs.horizontal_margin * 2 -
        Settings.prefs.window_gap;
    let step = Math.floor(maxHeight * 0.1);
    let currentHeight = Math.round(frame.height / step) * step;
    let targetHeight = Math.min(currentHeight + step, maxHeight);
    let targetY = frame.y;

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

export function resizeHDec(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxHeight =
        workArea.height -
        Settings.prefs.horizontal_margin * 2 -
        Settings.prefs.window_gap;
    let step = Math.floor(maxHeight * 0.1);
    let currentHeight = Math.round(frame.height / step) * step;
    let minHeight = step;
    let targetHeight = Math.max(currentHeight - step, minHeight);
    let targetY = frame.y;

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

export function resizeWInc(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxWidth =
        workArea.width -
        Settings.prefs.horizontal_margin * 2 -
        Settings.prefs.window_gap;
    let step = Math.floor(maxWidth * 0.1);
    let currentWidth = Math.round(frame.width / step) * step;
    let targetWidth = Math.min(currentWidth + step, maxWidth);
    let targetX = frame.x;

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

export function resizeWDec(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxWidth =
        workArea.width -
        Settings.prefs.horizontal_margin * 2 -
        Settings.prefs.window_gap;
    let step = Math.floor(maxWidth * 0.1);
    let currentWidth = Math.round(frame.width / step) * step;
    let minWidth = step;
    let targetWidth = Math.max(currentWidth - step, minWidth);
    let targetX = frame.x;

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

export function getCycleWindowWidths(metaWindow) {
    let steps = Settings.prefs.cycle_width_steps;
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    if (steps[0] <= 1) {
        // Steps are specifed as ratios -> convert to pixels
        // Make sure two windows of "compatible" width will have room:
        let availableWidth =
            workArea.width -
            Settings.prefs.horizontal_margin * 2 -
            Settings.prefs.window_gap;
        steps = steps.map(x => Math.floor(x * availableWidth));
    }

    return steps;
}

export function cycleWindowWidth(metawindow) {
    return cycleWindowWidthDirection(
        metawindow,
        CycleWindowSizesDirection.FORWARD
    );
}

export function cycleWindowWidthBackwards(metawindow) {
    return cycleWindowWidthDirection(
        metawindow,
        CycleWindowSizesDirection.BACKWARDS
    );
}

export function cycleWindowWidthDirection(metaWindow, direction) {
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    workArea.x += space.monitor.x;

    let findFn =
        direction === CycleWindowSizesDirection.FORWARD
            ? Lib.findNext
            : Lib.findPrev;

    // 10px slack to avoid locking up windows that only resize in increments > 1px
    let targetWidth = Math.min(
        findFn(frame.width, getCycleWindowWidths(metaWindow), sizeSlack),
        workArea.width
    );

    let targetX = frame.x;

    if (Scratch.isScratchWindow(metaWindow)) {
        if (
            targetX + targetWidth >
            workArea.x + workArea.width - Settings.prefs.minimum_margin
        ) {
            // Move the window so it remains fully visible
            targetX =
                workArea.x +
                workArea.width -
                Settings.prefs.minimum_margin -
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

export function cycleWindowHeight(metawindow) {
    return cycleWindowHeightDirection(
        metawindow,
        CycleWindowSizesDirection.FORWARD
    );
}

export function cycleWindowHeightBackwards(metawindow) {
    return cycleWindowHeightDirection(
        metawindow,
        CycleWindowSizesDirection.BACKWARDS
    );
}

export function cycleWindowHeightDirection(metaWindow, direction) {
    let steps = Settings.prefs.cycle_height_steps;
    let frame = metaWindow.get_frame_rect();

    let space = spaces.spaceOfWindow(metaWindow);
    let i = space.indexOf(metaWindow);

    let findFn =
        direction === CycleWindowSizesDirection.FORWARD
            ? Lib.findNext
            : Lib.findPrev;

    function calcTargetHeight(available) {
        let targetHeight;
        if (steps[0] <= 1) {
            // ratio steps
            let targetR = findFn(
                frame.height / available,
                steps,
                sizeSlack / available
            );
            targetHeight = Math.floor(targetR * available);
        } else {
            // pixel steps
            targetHeight = findFn(frame.height, steps, sizeSlack);
        }
        return Math.min(targetHeight, available);
    }

    if (i > -1) {
        const allocate = (column, available) => {
            // NB: important to not retrieve the frame size inside allocate. Allocation of
            // metaWindow should stay the same during a potential fixpoint evaluation.
            available -= (column.length - 1) * Settings.prefs.window_gap;
            let targetHeight = calcTargetHeight(available);
            return column.map(mw => {
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
        let workspace = metaWindow.get_workspace();
        let available = workspace.get_work_area_for_monitor(
            metaWindow.get_monitor()
        ).height;
        let targetHeight = calcTargetHeight(available);
        metaWindow.move_resize_frame(
            true,
            frame.x,
            frame.y,
            frame.width,
            targetHeight
        );
    }
}

export function activateNthWindow(n, space) {
    space = space || spaces.activeSpace;
    let nth = space[n][0];
    ensureViewport(nth, space);
}

export function activateFirstWindow(_mw, space) {
    space = space || spaces.activeSpace;
    activateNthWindow(0, space);
}

export function activateLastWindow(_mw, space) {
    space = space || spaces.activeSpace;
    activateNthWindow(space.length - 1, space);
}

/**
 * Calls `activateWindow` only after an actor is visible and rendered on the stage.
 * The standard `Main.activateWindow(mw)` should be used in general, but this method
 * may be requried under certain use cases (such as activating a floating window
 * programmatically before it's rendered, see
 * https://github.com/paperwm/PaperWM/issues/448 for details).
 */
function activateWindowAfterRendered(actor, mw) {
    callbackOnActorShow(actor, () => {
        Main.activateWindow(mw);
    });
}

/**
 * Centers the currently selected window.
 */
export function centerWindow(metaWindow, horizontal = true, vertical = false) {
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    const monitor = space.monitor;
    const workArea = space.workArea();

    const targetX = horizontal
        ? workArea.x + Math.round((workArea.width - frame.width) / 2)
        : frame.x;
    let targetY = vertical
        ? workArea.y + Math.round((workArea.height - frame.height) / 2)
        : frame.y;
    targetY = Math.max(targetY, workArea.y);
    if (space.indexOf(metaWindow) === -1) {
        Scratch.easeScratch(
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
 * Activates the window under the mouse cursor, if any.
 */
export function activateWindowUnderCursor(metaWindow, space) {
    const [gx, gy] = global.get_pointer();
    const [, x, y] = space.actor.transform_stage_point(gx, gy);
    const mw = space?.getWindowAtPoint(x, y);
    if (mw) {
        ensureViewport(mw, space);
    }
}

/**
 * Sets the focus mode for a space.
 * @param {FocusModes} mode
 * @param {Space} space
 */
export function setFocusMode(mode, space) {
    space = space ?? spaces.activeSpace;
    space.focusMode = mode;
    Topbar.focusButton.setFocusMode(mode);

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
        if (space.indexOf(selectedWin) == 0) {
            position = 0;
        }
        // if windows is last, move to right edge
        // eslint-disable-next-line eqeqeq
        else if (space.indexOf(selectedWin) == space.length - 1) {
            position = workArea.width;
        } else {
            position = space.unfocusXPosition;
        }
        // do the move
        moveTo(space, space.selectedWindow, { x: position });
        ensureViewport(space.selectedWindow, space, { force: true });
        space.unfocusXPosition = null;
    }
}

/**
 * Switches to the next focus mode for a space.
 * @param {Space=} space
 */
export function switchToNextFocusMode(space) {
    space = space ?? spaces.activeSpace;
    const numModes = Object.keys(FocusModes).length;
    // for currMode we switch to 1-based to use it validly in remainder operation
    const currMode = Object.values(FocusModes).indexOf(space.focusMode) + 1;
    const nextMode = currMode % numModes;
    setFocusMode(nextMode, space);
}

/**
 * "Fit" values such that they sum to `targetSum`
 */
export function fitProportionally(values, targetSum) {
    let sum = Lib.sum(values);
    let weights = values.map(v => v / sum);

    let fitted = Lib.zip(values, weights).map(([_h, w]) =>
        Math.round(targetSum * w)
    );
    let r = targetSum - Lib.sum(fitted);
    fitted[0] += r;
    return fitted;
}

export function allocateDefault(column, availableHeight, selectedWindow) {
    if (column.length === 1) {
        return [availableHeight];
    } else {
        // Distribute available height amongst non-selected windows in proportion to their existing height
        const gap = Settings.prefs.window_gap;
        const minHeight = 50;

        const heightOf = mw => {
            return mw._targetHeight || mw.get_frame_rect().height;
        };

        const k = selectedWindow && column.indexOf(selectedWindow);
        const selectedHeight = selectedWindow && heightOf(selectedWindow);

        let nonSelected = column.slice();
        if (selectedWindow) nonSelected.splice(k, 1);

        const nonSelectedHeights = nonSelected.map(heightOf);
        let availableForNonSelected = Math.max(
            0,
            availableHeight -
                (column.length - 1) * gap -
                (selectedWindow ? selectedHeight : 0)
        );

        const deficit = Math.max(
            0,
            nonSelected.length * minHeight - availableForNonSelected
        );

        let heights = fitProportionally(
            nonSelectedHeights,
            availableForNonSelected + deficit
        );

        if (selectedWindow) heights.splice(k, 0, selectedHeight - deficit);

        return heights;
    }
}

export function allocateEqualHeight(column, available) {
    available -= (column.length - 1) * Settings.prefs.window_gap;
    return column.map(_ => Math.floor(available / column.length));
}

/**
 * "Slurps" a window into the currently active column, vertically
 * stacking it.
 * @param {Window} metaWindow
 * @param {Boolean} below
 * @returns
 */
export function slurp(metaWindow, insertAt = SlurpInsertPosition.BOTTOM) {
    if (!metaWindow) {
        return;
    }

    const space = spaces.spaceOfWindow(metaWindow);
    if (!space) {
        return;
    }

    const index = space.indexOf(metaWindow);
    let to, from, metaWindowToSlurp;

    if (space.length < 2) {
        return;
    }

    to = index;
    from = index + 1;

    metaWindowToSlurp = space[from]?.[0];
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
        to = space.indexOf(metaWindow);
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
 * Barfs (expels) a specific window from a column.
 * @param {Window} metaWindow
 * @returns
 */
export function barf(metaWindow, expelWindow) {
    if (!metaWindow) return;

    const space = spaces.spaceOfWindow(metaWindow);
    const index = space.indexOf(metaWindow);
    if (index === -1) return;

    const column = space[index];
    if (column.length < 2) return;

    const to = index + 1;

    // // remove metawindow from column
    if (expelWindow) {
        // remove expelWindow from current column
        const indexOfWindow = column.indexOf(expelWindow);
        column.splice(indexOfWindow, 1);
    } else {
        // remove from bottom
        expelWindow = column.splice(-1, 1)[0];
    }
    space.splice(to, 0, [expelWindow]);

    space.layout(true, {
        customAllocators: {
            [space.indexOf(metaWindow)]: allocateEqualHeight,
            ensure: false,
        },
    });
}

/**
   Detach the @metaWindow, storing it at the bottom right corner while
   navigating. When done, insert all the detached windows again.
 */
export function takeWindow(metaWindow, space, options = {}) {
    space = space ?? spaces.selectedSpace;
    metaWindow = metaWindow ?? space.selectedWindow;
    const navigator = options?.navigator ?? Navigator.getNavigator();
    const existing = options?.existing ?? false;

    if (!existing && !space.removeWindow(metaWindow)) return;

    // setup animate function
    const animateTake = (mw, isExisting) => {
        navigator._moving.push(mw);
        const container = spaces.spaceContainer;
        if (!isExisting) {
            Utils.actorAddChild(container, metaWindow.clone);
        }

        const lowest = navigator._moving[navigator._moving.length - 2];
        lowest && container.set_child_below_sibling(mw.clone, lowest.clone);
        const point = space.cloneContainer.apply_relative_transform_to_point(
            container,
            new Graphene.Point3D({
                x: mw.clone.x,
                y: mw.clone.y,
            })
        );

        if (!isExisting) {
            mw.clone.set_position(point.x, point.y);
        }

        let x = Math.round(
            space.monitor.x +
                space.monitor.width -
                0.08 * space.monitor.width * (1 + navigator._moving.length)
        );
        let y =
            Math.round(space.monitor.y + (space.monitor.height * 2) / 3) +
            16 * navigator._moving.length;
        animateWindow(mw);
        Easer.addEase(mw.clone, {
            x,
            y,
            time: Settings.prefs.animation_time,
        });
    };

    if (!navigator._moving) {
        navigator.showTakeHint(true);
        navigator._moving = [];

        const selectedSpace = () => spaces.selectedSpace;
        const changeSpace = mw => {
            const target = selectedSpace();
            if (spaces.spaceOfWindow(mw) !== target) {
                mw.change_workspace(target.workspace);
            }
        };

        /**
         * Cycling function which orders the navigator._moving
         * array according to direction.
         */
        const cycler = order => {
            order(navigator._moving);
            const temparr = [...navigator._moving];
            navigator._moving = [];
            temparr.forEach(w => {
                animateTake(w, true);
            });
        };

        // get the action dispatcher signal to connect to
        Navigator.getActionDispatcher(
            DispatcherMode.KEYBOARD
        ).addKeypressCallback((_modmask, keysym, _event) => {
            switch (keysym) {
                case Clutter.KEY_space: {
                    // remove the last window you got
                    const pop = navigator._moving.pop();
                    if (pop) {
                        changeSpace(pop);
                        insertWindow(pop, { existing: true, dropping: true });
                        // make space selectedWindow (keeps index for next insert)
                        selectedSpace().selectedWindow = pop;
                        ensureViewport(pop);
                    }
                    // return true if this was actioned
                    return true;
                }

                // cycle forwards through taken windows
                case Clutter.KEY_Tab: {
                    cycler(moving => moving.unshift(moving.pop()));
                    return true;
                }

                // cycle backwards through taken windows (shift+tab)
                case Clutter.KEY_ISO_Left_Tab: {
                    cycler(moving => moving.push(moving.shift()));
                    return true;
                }

                // close all taken windows
                case Clutter.KEY_q: {
                    navigator._moving.forEach(w => {
                        changeSpace(w);
                        insertWindow(w, {
                            existing: true,
                            dropping: true,
                            dropCallback: mw => {
                                mw.delete(global.get_current_time());
                            },
                        });
                    });

                    navigator._moving = [];
                    return true;
                }

                default:
                    return false;
            }
        });

        signals.connectOneShot(navigator, 'destroy', () => {
            // ensure keyboard grabstate is dimissed (in case moving stopped via pointer)
            Navigator.dismissDispatcher(DispatcherMode.KEYBOARD);
            navigator.showTakeHint(false);

            let target = spaces.selectedSpace;
            navigator._moving.forEach(w => {
                changeSpace(w);
                insertWindow(w, { existing: true, dropping: true });

                // make space selectedWindow (keeps index for next insert)
                target.selectedWindow = w;
            });

            // activate last metaWindow after taken windows inserted
            let firstWindow = navigator._moving.find(v => v !== undefined);
            if (firstWindow) {
                Utils.laterAdd(Meta.LaterType.IDLE, () => {
                    Main.activateWindow(firstWindow);
                });
            }

            // clean up after move
            navigator._moving = [];
        });
    }

    animateTake(metaWindow, false);
}

/**
   Sort the @windows based on their clone's stacking order
   in @space.cloneContainer.
 */
export function sortWindows(space, windows) {
    if (windows.length === 1) return windows;
    let clones = windows.map(w => w.clone);
    return space.cloneContainer
        .get_children()
        .filter(c => clones.includes(c))
        .map(c => c.meta_window);
}
