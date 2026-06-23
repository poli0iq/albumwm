import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Settings,
    Utils,
    Tiling,
    Navigator,
    Scratch,
    Gestures,
} from './imports.js';
import { DispatcherMode, Easer } from './utils.js';

export let grabbed = false;

/**
 * Sets the cursor type to Grabbing or Default, going through each enum type.
 */
function setCursorGrabbing(cursorType: boolean) {
    global.stage.set_cursor_type(
        cursorType ? Clutter.CursorType.GRABBING : Clutter.CursorType.DEFAULT
    );
}

let dragDriftTimeout: number | null = null;
export function enable() {}

export function disable() {
    grabbed = false;
    Utils.timeoutRemove(dragDriftTimeout);
    dragDriftTimeout = null;
}

let virtualPointer: Clutter.VirtualInputDevice;
/**
 * Returns a virtual pointer (i.e. mouse) device that can be used to
 * "clickout" of a drag operation when `grab_end_op` is unavailable
 * (i.e. as of Gnome 44 where `grab_end_op` was removed).
 */
export function getVirtualPointer() {
    if (!virtualPointer) {
        virtualPointer = Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }

    return virtualPointer;
}

type DndTarget = {
    position: [number, number?];
    center: number;
    originProp: 'x' | 'y';
    sizeProp: 'width' | 'height';
    marginA: number;
    marginB: number;
    space: Tiling.Space;
    actorParams: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
    };
    actor?: Clutter.Actor;
};

export class MoveGrab {
    window: Tiling.Window | null;
    type: Meta.GrabOp;
    signals: Utils.Signals | null;
    dragDriftPx: number;
    initialSpace: Tiling.Space;
    zoneActors: Set<Clutter.Actor>;
    wasTiled: boolean;
    dndTargets: DndTarget[];
    dndTarget: DndTarget | null = null;
    dispatcher: Navigator.ActionDispatcher | null = null;
    actor: Clutter.Actor | null = null;
    initialY: number | null = null;
    pointerOffset: number[] | null = null;
    scrollAnchor: number | null = null;
    center?: boolean;
    dnd = false;

    constructor(
        metaWindow: Tiling.Window,
        type: Meta.GrabOp,
        space?: Tiling.Space
    ) {
        this.window = metaWindow;
        this.type = type;
        this.signals = new Utils.Signals();

        this.dragDriftPx = 12;

        this.initialSpace = space || Tiling.spaces.spaceOfWindow(metaWindow);
        this.zoneActors = new Set();

        // save whether this was tiled window at start of grab
        this.wasTiled = !(
            this.initialSpace.isFloating(metaWindow) ||
            Scratch.isScratchWindow(metaWindow)
        );

        this.dndTargets = [];
    }

    begin({ center }: { center?: boolean } = {}) {
        console.debug('#grab', 'begin');

        this.center = center;
        if (grabbed) return;

        grabbed = true;
        setCursorGrabbing(true);
        this.dispatcher = Navigator.getActionDispatcher(DispatcherMode.POINTER);
        this.actor = this.dispatcher.actor;

        const metaWindow = this.window!;
        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        const clone = metaWindow.clone;
        const space = this.initialSpace;
        const frame = metaWindow.get_frame_rect();

        this.initialY = clone.targetY;
        Easer.removeEase(clone);
        const [gx, gy] = Utils.getPointerCoords();

        let px = (gx - actor.x) / actor.width;
        let py = (gy - actor.y) / actor.height;
        actor.set_pivot_point(px, py);

        const [x, y] = space.globalToScroll(gx, gy);
        if (clone.get_parent() === this.initialSpace.cloneContainer) {
            this.pointerOffset = [x - clone.x, y - clone.y];
            px = (x - clone.x) / clone.width;
            py = (y - clone.y) / clone.height;
        } else {
            this.pointerOffset = [gx - frame.x, gy - frame.y];
            clone.x = frame.x;
            clone.y = frame.y;
            px = (gx - clone.x) / clone.width;
            py = (gy - clone.y) / clone.height;
        }
        if (!center) clone.set_pivot_point(px, py);
        else clone.set_pivot_point(0, 0);

        this.signals!.connect(
            this.actor,
            'button-release-event',
            this.end.bind(this)
        );
        this.signals!.connect(this.actor, 'touch-event', (act, evt) => {
            if (evt.type() === Clutter.EventType.TOUCH_END) {
                this.end();
            } else {
                this.motion(act, evt);
            }
        });
        this.signals!.connect(
            this.actor,
            'motion-event',
            this.motion.bind(this)
        );
        this.signals!.connect(
            global.display,
            'window-entered-monitor',
            this.beginDnD.bind(this)
        );

        this.scrollAnchor = x;
        space.startAnimate();
        // Make sure the window actor is visible
        Navigator.getNavigator();
        Tiling.animateWindow(metaWindow);
        Easer.removeEase(space.cloneContainer);
    }

    beginDnD({ center }: { center?: boolean } = {}) {
        if (this.dnd) {
            return;
        }

        this.center = center;
        this.dnd = true;
        console.debug('#grab', 'begin DnD');
        Navigator.getNavigator().minimaps.forEach(m =>
            typeof m === 'number' ? Utils.timeoutRemove(m) : m.hide()
        );
        setCursorGrabbing(true);
        const metaWindow = this.window!;
        const clone = metaWindow.clone;
        const space = this.initialSpace;

        const [gx, gy] = global.get_pointer();
        let point: Graphene.Point3D;
        if (center) {
            point = space.cloneContainer.apply_relative_transform_to_point(
                global.stage,
                new Graphene.Point3D({
                    x: Math.round(clone.x),
                    y: Math.round(clone.y),
                })
            );
        } else {
            // For some reason the above isn't smooth when DnD is triggered from dragging
            const [dx, dy] = this.pointerOffset!;
            point = new Graphene.Point3D({
                x: gx - dx,
                y: gy - dy,
            });
        }

        const i = space.columnOf(metaWindow);
        const single = i !== -1 && space[i].length === 1;
        space.removeWindow(metaWindow);
        Utils.actorReparent(clone, Main.layoutManager.uiGroup);
        clone.x = Math.round(point.x);
        clone.y = Math.round(point.y);
        const newScale = clone.scale_x * space.actor.scale_x;
        clone.set_scale(newScale, newScale);

        const params: Utils.EaserParams = {
            time: Settings.prefs!.animation_time,
            scaleX: 0.5,
            scaleY: 0.5,
            opacity: 240,
        };
        if (center) {
            this.pointerOffset = [0, 0];
            clone.set_pivot_point(0, 0);
            params.x = gx;
            params.y = gy;
        }

        clone.__oldOpacity = clone.opacity;
        Easer.addEase(clone, params);

        this.signals!.connect(
            global.stage,
            'button-press-event',
            this.end.bind(this)
        );

        const monitor = Utils.monitorAtPoint(gx, gy);
        const onSame = monitor === space.monitor;

        const [x] = space.globalToViewport(gx, gy);
        if (!this.center && onSame && single && space[i]) {
            Tiling.moveTo(space, space[i][0], {
                x: x + Settings.prefs!.column_gap / 2,
            });
        } else if (!this.center && onSame && single && space[i - 1]) {
            Tiling.moveTo(space, space[i - 1][0], {
                x:
                    x -
                    space[i - 1][0].clone.width -
                    Settings.prefs!.column_gap / 2,
            });
        } else if (!this.center && onSame && space.length === 0) {
            space.targetX = x;
            space.cloneContainer.x = x;
        }

        const [sx, sy] = space.globalToScroll(gx, gy, { useTarget: true });

        Tiling.spaces.forEach(s => {
            this.signals!.connect(
                s.background!,
                'motion-event',
                this.spaceMotion.bind(this, s)
            );
        });
        this.selectDndZone(space, sx, sy, single && onSame);
    }

    spaceMotion(
        space: Tiling.Space,
        _background: Clutter.Actor,
        _event: Clutter.Event
    ) {
        const [gx, gy] = global.get_pointer();
        const [sx, sy] = space.globalToScroll(gx, gy, { useTarget: true });
        this.selectDndZone(space, sx, sy);
    }

    /** x,y in scroll cooridinates */
    selectDndZone(space: Tiling.Space, x: number, y: number, initial = false) {
        const gap = Settings.prefs!.column_gap;
        const halfGap = gap / 2;
        const columnZoneMarginViz = 100 + halfGap;
        const columnZoneMargin =
            space.length > 0
                ? columnZoneMarginViz
                : Math.round(space.width! / 4);
        const rowZoneMargin = 250 + halfGap;

        let target: DndTarget | null = null;
        const tilingHeight = space.height! - Main.layoutManager.panelBox.height;

        // TODO maybe EaserParams
        const fakeClone: {
            targetX: number;
            targetY: number;
            width: number;
            height: number;
        } = {
            targetX: 0,
            targetY: 0,
            width: columnZoneMargin,
            height: tilingHeight,
        };
        if (space.length > 0) {
            const lastClone = space[space.length - 1][0].clone;
            fakeClone.targetX = lastClone.x + lastClone.width + gap;
        } else {
            const [sx] = space.viewportToScroll(
                Math.round(space.width! / 2),
                0
            );
            fakeClone.targetX = sx + halfGap;
        }

        const columns = [...space, [{ clone: fakeClone }]];
        for (let j = 0; j < columns.length; j++) {
            const column = columns[j];
            const metaWindow = column[0];
            const clone = metaWindow.clone;

            // FIXME: Non-uniform column width
            const colX = clone.targetX;
            const colW = clone.width;

            // Fast forward if pointer is not inside the column or the column zone
            if (x < colX - gap - columnZoneMargin) {
                continue;
            }
            if (colX + colW < x) {
                continue;
            }

            const cx = colX - halfGap;
            const l = cx - columnZoneMargin;
            const r = cx + columnZoneMargin;
            if (l <= x && x <= r) {
                target = {
                    position: [j],
                    center: cx,
                    originProp: 'x',
                    sizeProp: 'width',
                    marginA: columnZoneMarginViz,
                    marginB: columnZoneMarginViz,
                    space,
                    actorParams: {
                        y: Main.layoutManager.panelBox.height,
                        height: tilingHeight,
                    },
                };
                break;
            }

            // Must be strictly within the column to tile vertically
            if (x < colX) continue;

            // vertically tiled
            for (let i = 0; i < column.length + 1; i++) {
                let rowClone;
                if (i < column.length) {
                    rowClone = column[i].clone;
                } else {
                    const lastClone = column[i - 1].clone;
                    rowClone = {
                        targetX: lastClone.targetX,
                        targetY: lastClone.targetY + lastClone.height + gap,
                        width: lastClone.width,
                        height: 0,
                    };
                }
                const isFirst = i === 0;
                const isLast = i === column.length;
                const cy = rowClone.targetY - halfGap;
                const t = cy - rowZoneMargin;
                const b = cy + rowZoneMargin;
                if (t <= y && y <= b) {
                    target = {
                        position: [j, i],
                        center: cy,
                        originProp: 'y',
                        sizeProp: 'height',
                        marginA: isFirst ? 0 : rowZoneMargin,
                        marginB: isLast ? 0 : rowZoneMargin,
                        space,
                        actorParams: {
                            x: rowClone.targetX,
                            width: rowClone.width,
                        },
                    };
                    break;
                }
            }
        }

        const sameTarget = (a: DndTarget, b: DndTarget) => {
            if (a === b) {
                return true;
            }
            if (!a || !b) {
                return false;
            }
            if (a.space !== b.space) {
                return false;
            }
            if (a.position.length !== b.position.length) {
                return false;
            }
            return (
                a.position[0] === b.position[0] &&
                a.position[1] === b.position[1]
            );
        };

        if (!sameTarget(target!, this.dndTarget!)) {
            this.activateDndTarget(target!, initial);
        }
    }

    _dragDrift(space: Tiling.Space, dx: number, xfunc: (x: number) => boolean) {
        // only drift is more than one tiled window
        if (space.getWindows().filter(w => Tiling.isTiled(w)).length <= 0) {
            return;
        }

        Utils.timeoutRemove(dragDriftTimeout);
        dragDriftTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            const [px] = global.get_pointer();
            if (xfunc(px)) {
                return false;
            }
            if (space !== Tiling?.spaces?.activeSpace) {
                return false;
            }
            Gestures.update(space, dx, 1);
            return true;
        });
    }

    motion(_actor: Clutter.Actor, event: Clutter.Event) {
        const metaWindow = this.window!;
        let [gx, gy] = global.get_pointer();

        // drift move
        const monitor = Utils.monitorAtPoint(gx, gy)!;
        if (gx >= monitor.x && gx <= monitor.x + this.dragDriftPx) {
            this._dragDrift(
                this.initialSpace,
                -1 * Settings.prefs!.drag_drift_speed,
                x => x > monitor.x + this.dragDriftPx
            );
        }
        if (
            gx <= monitor.x + monitor.width &&
            gx >= monitor.x + monitor.width - this.dragDriftPx
        ) {
            this._dragDrift(
                this.initialSpace,
                Settings.prefs!.drag_drift_speed,
                x => x < monitor.x + monitor.width - this.dragDriftPx
            );
        }

        if (event.type() === Clutter.EventType.TOUCH_UPDATE) {
            [gx, gy] = event.get_coords();
            // We update global pointer to match touch event
            Utils.warpPointer(gx, gy, false);
        }
        const [dx] = this.pointerOffset!;
        let [, dy] = this.pointerOffset!;
        const clone = metaWindow?.clone;

        // check if window and clone exists
        if (!clone) {
            this.end();
            return;
        }

        const tx = clone.get_transition('x');
        const ty = clone.get_transition('y');

        if (this.dnd) {
            if (tx) {
                tx.set_to(gx - dx);
                ty!.set_to(gy - dy);
            } else {
                clone.x = gx - dx;
                clone.y = gy - dy;
            }
            /* spaceMotion only fires over primary, so the last zone stays
               armed when the pointer leaves it. Clear it so end() can fall
               through to scratch. */
            if (monitor !== this.initialSpace.monitor && this.dndTarget) {
                this.deactivateDndTarget(this.dndTarget);
                this.dndTarget = null;
                this.dndTargets = [];
            }
            return;
        }

        if (monitor !== this.initialSpace.monitor) {
            this.beginDnD();
            return;
        }

        if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            this.beginDnD();
            return;
        }

        const space = this.initialSpace;
        const [x, y] = space.globalToViewport(gx, gy);
        space.targetX = x - this.scrollAnchor!;
        space.cloneContainer.x = space.targetX;

        clone.y = y - dy;

        const threshold = 300;
        dy = Math.min(threshold, Math.abs(clone.y - this.initialY!));
        const s = 1 - Math.pow(dy / 500, 3);
        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        actor.set_scale(s, s);
        clone.set_scale(s, s);

        if (dy >= threshold) {
            this.beginDnD();
        }
    }

    end() {
        grabbed = false;
        Utils.timeoutRemove(dragDriftTimeout);
        console.debug('#grab', 'end');
        this.signals!.destroy();
        this.signals = null;

        const metaWindow = this.window!;
        const actor = metaWindow.get_compositor_private<Clutter.Actor>();
        const clone = metaWindow.clone;
        const [gx, gy] = global.get_pointer();

        this.zoneActors.forEach(zoneActor => zoneActor.destroy());
        const params: Utils.EaserParams = {
            time: Settings.prefs!.animation_time,
            scaleX: 1,
            scaleY: 1,
            opacity: clone?.__oldOpacity ?? 255,
        };

        if (clone && this.dnd) {
            const dndTarget = this.dndTarget;
            if (dndTarget) {
                const space = dndTarget.space;

                if (Scratch.isScratchWindow(metaWindow)) {
                    Scratch.unmakeScratch(metaWindow);
                }

                // Remember the global coordinates of the clone
                const [x] = clone.get_position();
                space.addWindow(metaWindow, ...dndTarget.position);

                const [sx, sy] = space.globalToScroll(gx, gy);
                const [dx, dy] = this.pointerOffset!;
                clone.x = sx - dx;
                clone.y = sy - dy;
                const newScale = clone.scale_x / space.actor.scale_x;
                clone.set_scale(newScale, newScale);

                actor.set_scale(1, 1);
                actor.set_pivot_point(0, 0);

                // Tiling.animateWindow(metaWindow);
                params.onStopped = () => {
                    space.moveDone();
                    clone.set_pivot_point(0, 0);
                };
                Easer.addEase(clone, params);

                space.targetX = space.cloneContainer.x;
                space.selectedWindow = metaWindow;
                if (dndTarget.position) {
                    space.layout(true, {
                        customAllocators: {
                            [dndTarget.position[0]]: Tiling.allocateEqualHeight,
                        },
                    });
                } else {
                    space.layout();
                }
                Tiling.moveTo(space, metaWindow, { x: x - space.monitor!.x });
                Tiling.ensureViewport(metaWindow, space);

                Utils.actorRaise(clone);
            } else if (clone) {
                metaWindow.move_frame(true, clone.x, clone.y);
                Scratch.makeScratch(metaWindow);
                this.initialSpace.moveDone();

                actor.set_scale(clone.scale_x, clone.scale_y);
                actor.opacity = clone.opacity;

                clone.opacity = clone.__oldOpacity || 255;
                clone.set_scale(1, 1);
                clone.set_pivot_point(0, 0);

                const halftime = 0.5 * Settings.prefs!.animation_time;
                params.time = halftime;
                // Drops off the tiled monitor stay scratch; only bounce back on primary.
                const dropMonitor = Utils.monitorAtPoint(gx, gy);
                if (dropMonitor === this.initialSpace.monitor) {
                    params.onComplete = () => {
                        Easer.addEase(actor, {
                            time: halftime,
                            onComplete: () => {
                                Scratch.unmakeScratch(metaWindow);
                            },
                        });
                    };
                }
                Easer.addEase(actor, params);
            }

            Navigator.getNavigator().accept();
        } else if (clone && this.initialSpace.columnOf(metaWindow) !== -1) {
            const space = this.initialSpace;
            space.targetX = space.cloneContainer.x;

            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);

            Tiling.animateWindow(metaWindow);
            params.onStopped = () => {
                space.moveDone();
                clone.set_pivot_point(0, 0);
            };
            Easer.addEase(clone, params);

            Tiling.ensureViewport(metaWindow, space);
            Navigator.getNavigator().accept();
        }

        // NOTE: we reset window here so `window-added` will handle the window,
        // and layout will work correctly etc.
        this.window = null;

        this.initialSpace.layout();
        // ensure window is properly activated after layout/ensureViewport tweens
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            if (metaWindow?.get_workspace()) Main.activateWindow(metaWindow);
            return GLib.SOURCE_REMOVE;
        });

        // // Make sure the window is on the correct workspace.
        // // If the window is transient this will take care of its parent too.
        Tiling.setInGrab(null);
        if (this.dispatcher) {
            Navigator.dismissDispatcher(DispatcherMode.POINTER);
        }

        setCursorGrabbing(false);

        /**
         * Gnome 44 removed the ability to manually end_grab_op.
         * Previously we would end the grab_op before doing
         * AlbumWM grabs.  In 44, we can't do this so the grab op
         * may still be in progress, which is okay, but won't be ended
         * until we "click out".  We do this here if needed.
         */
        Utils.laterAdd(Meta.LaterType.IDLE, () => {
            if (this.wasTiled) {
                // move to current cursor position
                const [x, y] = global.get_pointer();
                getVirtualPointer().notify_absolute_motion(
                    Clutter.get_current_event_time(),
                    x,
                    y
                );

                getVirtualPointer().notify_button(
                    Clutter.get_current_event_time(),
                    Clutter.BUTTON_PRIMARY,
                    Clutter.ButtonState.PRESSED
                );
                getVirtualPointer().notify_button(
                    Clutter.get_current_event_time(),
                    Clutter.BUTTON_PRIMARY,
                    Clutter.ButtonState.RELEASED
                );
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    activateDndTarget(zone: DndTarget, first: boolean) {
        if (!zone) {
            return;
        }
        const mkZoneActor = (props: DndTarget['actorParams']) => {
            const actor = new St.Widget({ style_class: 'tile-preview' });
            actor.x = props.x ?? 0;
            actor.y = props.y ?? 0;
            actor.width = props.width ?? 0;
            actor.height = props.height ?? 0;
            return actor;
        };

        zone.actor = mkZoneActor({ ...zone.actorParams });

        // deactivate previous target
        this.dndTargets
            .filter(t => t !== zone)
            .forEach(t => this.deactivateDndTarget(t));
        this.dndTargets = [zone];

        this.dndTarget = zone;
        this.zoneActors.add(zone.actor);
        const raise = () => Utils.actorRaise(zone.actor!);

        const params: Utils.EaserParams = {
            time: Settings.prefs!.animation_time,
            [zone.originProp]: zone.center - zone.marginA,
            [zone.sizeProp]: zone.marginA + zone.marginB,
            onComplete: raise,
        };

        if (first) {
            params.height = zone.actor.height;
            params.y = zone.actor.y;

            const clone = this.window!.clone;
            const space = zone.space;
            const [x, y] = space.globalToScroll(
                ...clone.get_transformed_position()
            );
            zone.actor.set_position(x, y);
            zone.actor.set_size(...clone.get_transformed_size());
        } else {
            zone.actor[zone.sizeProp] = 0;
            zone.actor[zone.originProp] = zone.center;
        }

        // zone.space.cloneContainer.add_child(zone.actor);
        Utils.actorAddChild(zone.space.cloneContainer, zone.actor);
        zone.actor.show();
        raise();
        Easer.addEase(zone.actor, params);
    }

    deactivateDndTarget(zone: DndTarget) {
        if (zone) {
            Easer.addEase(zone.actor!, {
                time: Settings.prefs!.animation_time,
                [zone.originProp]: zone.center,
                [zone.sizeProp]: 0,
                onComplete: () => {
                    zone.actor!.destroy();
                    this.zoneActors.delete(zone.actor!);
                },
            });
        }
    }
}

/**
 * Resize grab class currently used to identify window grab type.
 */
export class ResizeGrab {
    end() {}
}
