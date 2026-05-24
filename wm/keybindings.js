import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Settings,
    Utils,
    Tiling,
    Navigator,
    Scratch,
    LiveAltTab,
    Topbar,
} from './imports.js';

const Seat = Clutter.get_default_backend().get_default_seat();
const Display = global.display;

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';

let signals, actions, nameMap, actionIdMap, keycomboMap;
let keybindSettings;
/**
 * Pending close-window invocations, keyed by fail-safe timeout id. Tracked
 * so disable() can cancel the timeout and disconnect the `unmanaging`
 * signal we connected on the window being closed.
 * @type {Map<number, {metaWindow: Meta.Window, unmanagingId: number, sourceMonitor: number}>}
 */
let pendingCloses;

export function enable(extension) {
    // restore previous keybinds (in case failed to restore last time, e.g. gnome crash etc)
    Settings.updateOverrides();

    keybindSettings = extension.getSettings(KEYBINDINGS_KEY);
    setupActions(keybindSettings);
    signals.connect(
        Display,
        'accelerator-activated',
        (display, actionId, deviceId, timestamp) => {
            handleAccelerator(display, actionId, deviceId, timestamp);
        }
    );
    actions.forEach(enableAction);
    Settings.overrideConflicts();

    let schemas = [
        ...Settings.getConflictSettings(),
        extension.getSettings(KEYBINDINGS_KEY),
    ];
    schemas.forEach(schema => {
        signals.connect(schema, 'changed', (settings, key) => {
            const overrode = Settings.conflictKeyChanged(settings, key);
            if (overrode) {
                Main.notifyError(
                    `AlbumWM: overriding '${key}' keybind`,
                    `this Gnome Keybind will be restored when AlbumWM is disabled`
                );
            }
        });
    });
}

export function disable() {
    signals.destroy();
    signals = null;
    actions.forEach(disableAction);
    Settings.restoreConflicts();

    pendingCloses.forEach((entry, id) => {
        Utils.timeoutRemove(id);
        if (entry.metaWindow?.get_compositor_private()) {
            entry.metaWindow.disconnect(entry.unmanagingId);
        }
    });
    pendingCloses = null;

    keybindSettings = null;
    actions = null;
    nameMap = null;
    actionIdMap = null;
    keycomboMap = null;
}

export function registerAlbumAction(actionName, handler, flags) {
    registerAction(actionName, handler, {
        settings: keybindSettings,
        mutterFlags: flags,
        activeInNavigator: true,
    });
}

export function registerNavigatorAction(name, handler) {
    registerAction(name, handler, {
        settings: keybindSettings,
        opensNavigator: true,
    });
}

export function registerMinimapAction(name, handler) {
    registerAction(name, handler, {
        settings: keybindSettings,
        opensNavigator: true,
        opensMinimap: true,
        mutterFlags: Meta.KeyBindingFlags.PER_WINDOW,
    });
}

export function setupActions(settings) {
    signals = new Utils.Signals();
    pendingCloses = new Map();
    actions = [];
    nameMap = {}; // mutter keybinding action name -> action
    actionIdMap = {}; // actionID   -> action
    keycomboMap = {}; // keycombo   -> action

    /* Initialize keybindings */
    registerAction('live-alt-tab', LiveAltTab.liveAltTab, { settings });
    registerAction('live-alt-tab-backward', LiveAltTab.liveAltTab, {
        settings,
        mutterFlags: Meta.KeyBindingFlags.IS_REVERSED,
    });

    registerAction('live-alt-tab-scratch', LiveAltTab.liveAltTabScratch, {
        settings,
    });
    registerAction(
        'live-alt-tab-scratch-backward',
        LiveAltTab.liveAltTabScratch,
        { settings, mutterFlags: Meta.KeyBindingFlags.IS_REVERSED }
    );

    registerAction(
        'switch-monitor-right',
        () => {
            Tiling.switchMonitor(Meta.DisplayDirection.RIGHT);
        },
        { settings }
    );
    registerAction(
        'switch-monitor-left',
        () => {
            Tiling.switchMonitor(Meta.DisplayDirection.LEFT);
        },
        { settings }
    );
    registerAction(
        'switch-monitor-above',
        () => {
            Tiling.switchMonitor(Meta.DisplayDirection.UP);
        },
        { settings }
    );
    registerAction(
        'switch-monitor-below',
        () => {
            Tiling.switchMonitor(Meta.DisplayDirection.DOWN);
        },
        { settings }
    );

    registerNavigatorAction('take-window', Tiling.takeWindow);

    registerMinimapAction('switch-next', (mw, space) =>
        space.switchLinear(1, false)
    );
    registerMinimapAction('switch-previous', (mw, space) =>
        space.switchLinear(-1, false)
    );
    registerMinimapAction('switch-next-loop', (mw, space) =>
        space.switchLinear(1, true)
    );
    registerMinimapAction('switch-previous-loop', (mw, space) =>
        space.switchLinear(-1, true)
    );

    registerMinimapAction('switch-right', (mw, space) =>
        space.switchRight(false)
    );
    registerMinimapAction('switch-left', (mw, space) =>
        space.switchLeft(false)
    );
    registerMinimapAction('switch-up', (mw, space) => space.switchUp(false));
    registerMinimapAction('switch-down', (mw, space) =>
        space.switchDown(false)
    );

    registerNavigatorAction('drift-left', (mw, space) => space.driftLeft());
    registerNavigatorAction('drift-right', (mw, space) => space.driftRight());

    registerMinimapAction('switch-right-loop', (mw, space) =>
        space.switchRight(true)
    );
    registerMinimapAction('switch-left-loop', (mw, space) =>
        space.switchLeft(true)
    );
    registerMinimapAction('switch-up-loop', (mw, space) =>
        space.switchUp(true)
    );
    registerMinimapAction('switch-down-loop', (mw, space) =>
        space.switchDown(true)
    );

    registerMinimapAction('switch-first', Tiling.activateFirstWindow);
    registerMinimapAction('switch-second', (mw, space) =>
        Tiling.activateNthWindow(1, space)
    );
    registerMinimapAction('switch-third', (mw, space) =>
        Tiling.activateNthWindow(2, space)
    );
    registerMinimapAction('switch-fourth', (mw, space) =>
        Tiling.activateNthWindow(3, space)
    );
    registerMinimapAction('switch-fifth', (mw, space) =>
        Tiling.activateNthWindow(4, space)
    );
    registerMinimapAction('switch-sixth', (mw, space) =>
        Tiling.activateNthWindow(5, space)
    );
    registerMinimapAction('switch-seventh', (mw, space) =>
        Tiling.activateNthWindow(6, space)
    );
    registerMinimapAction('switch-eighth', (mw, space) =>
        Tiling.activateNthWindow(7, space)
    );
    registerMinimapAction('switch-ninth', (mw, space) =>
        Tiling.activateNthWindow(8, space)
    );
    registerMinimapAction('switch-tenth', (mw, space) =>
        Tiling.activateNthWindow(9, space)
    );
    registerMinimapAction('switch-eleventh', (mw, space) =>
        Tiling.activateNthWindow(10, space)
    );
    registerMinimapAction('switch-last', Tiling.activateLastWindow);

    registerMinimapAction('switch-global-right', (mw, space) =>
        space.switchGlobalRight()
    );
    registerMinimapAction('switch-global-left', (mw, space) =>
        space.switchGlobalLeft()
    );
    registerMinimapAction('switch-global-up', (mw, space) =>
        space.switchGlobalUp()
    );
    registerMinimapAction('switch-global-down', (mw, space) =>
        space.switchGlobalDown()
    );

    registerMinimapAction('move-left', (_mw, space) =>
        space.swap(Meta.MotionDirection.LEFT)
    );
    registerMinimapAction('move-right', (_mw, space) =>
        space.swap(Meta.MotionDirection.RIGHT)
    );
    registerMinimapAction('move-up', (_mw, space) =>
        space.swap(Meta.MotionDirection.UP)
    );
    registerMinimapAction('move-down', (_mw, space) =>
        space.swap(Meta.MotionDirection.DOWN)
    );

    registerAlbumAction('toggle-scratch-window', Scratch.toggleScratchWindow);

    registerAlbumAction('toggle-scratch-layer', Scratch.toggleScratch);

    registerAlbumAction(
        'toggle-scratch',
        Scratch.toggle,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'activate-window-under-cursor',
        Tiling.activateWindowUnderCursor
    );

    registerAlbumAction('switch-focus-mode', Tiling.switchToNextFocusMode);

    registerAlbumAction(
        'switch-open-window-position',
        Topbar.switchToNextOpenPositionMode
    );
    registerAlbumAction('open-window-position-right', (_mw, _space) =>
        Topbar.setOpenPositionMode(Settings.OpenWindowPositions.RIGHT)
    );
    registerAlbumAction('open-window-position-down', (_mw, _space) =>
        Topbar.setOpenPositionMode(Settings.OpenWindowPositions.DOWN)
    );

    registerAlbumAction(
        'resize-h-inc',
        Tiling.resizeHInc,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'resize-h-dec',
        Tiling.resizeHDec,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'resize-w-inc',
        Tiling.resizeWInc,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'resize-w-dec',
        Tiling.resizeWDec,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'cycle-width',
        Tiling.cycleWindowWidth,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'cycle-width-backwards',
        Tiling.cycleWindowWidthBackwards,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'cycle-height',
        Tiling.cycleWindowHeight,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'cycle-height-backwards',
        Tiling.cycleWindowHeightBackwards,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'center-horizontally',
        (mw, _space) => Tiling.centerWindow(mw, true, false),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'center-vertically',
        (mw, _space) => Tiling.centerWindow(mw, false, true),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'center',
        (mw, _space) => Tiling.centerWindow(mw, true, true),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'close-window',
        metaWindow => {
            /* Warp the pointer to the next window.
             * Wait until the window is actually unmanaged, because trying to
             * close the window isn't guaranteed to succeed (e.g. a save-changes
             * dialog could pop up). */
            const sourceMonitor = metaWindow.get_monitor();
            let timeoutId = 0;
            const unmanagingId = metaWindow.connect('unmanaging', () => {
                metaWindow.disconnect(unmanagingId);
                if (timeoutId) {
                    pendingCloses.delete(timeoutId);
                    Utils.timeoutRemove(timeoutId);
                    timeoutId = 0;
                }
                Utils.laterAdd(Meta.LaterType.IDLE, () => {
                    /* Could fire after disable. */
                    if (!Settings.prefs) return GLib.SOURCE_REMOVE;
                    const next = global.display.focus_window;
                    /* Skip cross-monitor mutter MRU fallbacks: warping pointer
                     * to a window on a different monitor is disorienting. */
                    if (
                        next &&
                        next !== metaWindow &&
                        next.get_monitor() === sourceMonitor
                    ) {
                        Tiling.maybeWarpPointerToWindow(next);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                pendingCloses.delete(timeoutId);
                metaWindow.disconnect(unmanagingId);
                timeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });
            pendingCloses.set(timeoutId, {
                metaWindow,
                unmanagingId,
                sourceMonitor,
            });
            metaWindow.delete(global.get_current_time());
        },
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'slurp-in',
        (mw, _space) => Tiling.slurp(mw),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'barf-out',
        (mw, _space) => Tiling.barf(mw),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'barf-out-active',
        (mw, _space) => Tiling.barf(mw, mw),
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'toggle-maximize-width',
        Tiling.toggleMaximizeHorizontally,
        Meta.KeyBindingFlags.PER_WINDOW
    );

    registerAlbumAction(
        'album-toggle-fullscreen',
        metaWindow => {
            if (metaWindow.fullscreen) {
                metaWindow.unmake_fullscreen();
            } else {
                metaWindow.make_fullscreen();
            }
            Tiling.resizeHandler(metaWindow);
        },
        Meta.KeyBindingFlags.PER_WINDOW
    );
}

export function idOf(mutterName) {
    let action = byMutterName(mutterName);
    if (action) {
        return action.id;
    } else {
        return Meta.KeyBindingAction.NONE;
    }
}

export function byMutterName(name) {
    return nameMap[name];
}

export function byId(mutterId) {
    return actionIdMap[mutterId];
}

/**
 * Minimal binding shape consumed by action handlers invoked through
 * `asKeyHandler`. Satisfied both by a real `Meta.KeyBinding` and by the
 * synthetic binding built in `openNavigatorHandler`.
 * @typedef {{
 *     get_name(): string,
 *     get_mask(): number,
 *     is_reversed(): boolean,
 * }} KeyBindingLike
 */

export function asKeyHandler(actionHandler) {
    return (display, mw, evt, binding) =>
        actionHandler(mw, Tiling.spaces.selectedSpace, {
            display,
            binding,
        });
}

export function impliedOptions(options) {
    options = Object.assign(
        { mutterFlags: Meta.KeyBindingFlags.NONE },
        options
    );

    if (options.opensMinimap) options.opensNavigator = true;

    if (options.opensNavigator) options.activeInNavigator = true;

    return options;
}

/**
 * handler: function(metaWindow, space, {binding, display, screen}) -> ignored
 * options: {
 *   opensMinimap:      true|false Start navigation and open the minimap
 *   opensNavigator:    true|false Start navigation (eg. Esc will restore selected space and window)
 *   activeInNavigator: true|false Action is available during navigation
 *   ...
 * }
 */
export function registerAction(actionName, handler, options) {
    options = impliedOptions(options);

    const { settings, opensNavigator } = options;

    let mutterName, keyHandler;
    if (settings) {
        Utils.assert(actionName, 'Schema action must have a name');
        mutterName = actionName;
        keyHandler = opensNavigator
            ? asKeyHandler(Navigator.previewNavigate)
            : asKeyHandler(handler);
    } else {
        // actionId, mutterName and keyHandler will be set if/when the action is bound
    }

    const action = {
        id: Meta.KeyBindingAction.NONE,
        name: actionName,
        mutterName,
        keyHandler,
        handler,
        options,
    };

    actions.push(action);
    if (actionName) nameMap[actionName] = action;

    return action;
}

/**
 * Bind a key to an action (possibly creating a new action)
 */
export function bindkey(
    keystr,
    actionName = null,
    handler = null,
    options = {}
) {
    Utils.assert(
        !options.settings,
        "Can only bind schemaless actions - change action's settings instead",
        actionName
    );

    let action = actionName && actions.find(a => a.name === actionName);
    let keycombo = Settings.keystrToKeycombo(keystr);

    if (!action) {
        action = registerAction(actionName, handler, options);
    } else {
        let boundAction = keycomboMap[keycombo];
        if (boundAction && boundAction !== action) {
            console.debug(
                'Rebinding',
                keystr,
                'to',
                actionName,
                'from',
                boundAction?.name
            );
            disableAction(boundAction);
        }

        disableAction(action);

        action.handler = handler;
        action.options = impliedOptions(options);
    }

    action.keystr = keystr;
    action.keycombo = keycombo;

    if (enableAction(action) === Meta.KeyBindingAction.NONE) {
        // Keybinding failed: try to supply a useful error message
        let message;
        let boundAction = keycomboMap[keycombo];
        if (boundAction) {
            message = `${keystr} already bound to albumwm action: ${boundAction.name}`;
        } else {
            let boundId = getBoundActionId(keystr);
            if (boundId !== Meta.KeyBindingAction.NONE) {
                let builtInAction = Object.entries(Meta.KeyBindingAction).find(
                    ([_name, id]) => id === boundId
                );
                if (builtInAction) {
                    message = `${keystr} already bound to built-in action: ${builtInAction[0]}`;
                } else {
                    message = `${keystr} already bound to unknown action with id: ${boundId}`;
                }
            }
        }

        if (!message) {
            message =
                'Usually caused by the binding already being taken, but could not identify which action';
        }

        Main.notifyError(
            'AlbumWM: Could not enable keybinding',
            `Tried to bind ${keystr} to ${actionName}\n${message}`
        );
    }

    return action.id;
}

export function unbindkey(actionIdOrKeystr) {
    let actionId;
    if (typeof actionIdOrKeystr === 'string') {
        const action = keycomboMap[Settings.keystrToKeycombo(actionIdOrKeystr)];
        actionId = action && action.id;
    } else {
        actionId = actionIdOrKeystr;
    }

    disableAction(actionIdMap[actionId]);
}

export function devirtualizeMask(gdkVirtualMask) {
    const keymap = Seat.get_keymap();
    let [success, rawMask] = keymap.map_virtual_modifiers(gdkVirtualMask);
    if (!success)
        throw new Error(`Couldn't devirtualize mask ${gdkVirtualMask}`);
    return rawMask;
}

export function rawMaskOfKeystr(keystr) {
    let [, , mask] = Settings.parseAccelerator(keystr);
    return devirtualizeMask(mask);
}

export function openNavigatorHandler(actionName, keystr) {
    const mask = rawMaskOfKeystr(keystr) & 0xff;

    const binding = {
        get_name: () => actionName,
        get_mask: () => mask,
        is_reversed: () => false,
    };
    return function (display, screen, metaWindow) {
        return Navigator.previewNavigate(metaWindow, null, {
            screen,
            display,
            binding,
        });
    };
}

export function getBoundActionId(keystr) {
    let [, keycodes, mask] = Settings.parseAccelerator(keystr);
    if (keycodes.length > 1) {
        throw new Error(`Multiple keycodes ${keycodes} ${keystr}`);
    }
    const rawMask = devirtualizeMask(mask);
    return Display.get_keybinding_action(keycodes[0], rawMask);
}

export function handleAccelerator(display, actionId, _deviceId, _timestamp) {
    const action = actionIdMap[actionId];
    if (action) {
        console.debug(
            '#keybindings',
            'Schemaless keybinding activated',
            actionId,
            action.name
        );
        action.keyHandler(display, display.focus_window);
    }
}

export function disableAction(action) {
    if (action.id === Meta.KeyBindingAction.NONE) {
        return;
    }

    const oldId = action.id;
    if (action.options.settings) {
        Main.wm.removeKeybinding(action.mutterName);
        action.id = Meta.KeyBindingAction.NONE;
        delete actionIdMap[oldId];
    } else {
        Display.ungrab_accelerator(action.id);
        action.id = Meta.KeyBindingAction.NONE;

        delete nameMap[action.mutterName];
        delete actionIdMap[oldId];
        delete keycomboMap[action.keycombo];

        action.mutterName = undefined;
    }
}

export function enableAction(action) {
    if (action.id !== Meta.KeyBindingAction.NONE) return action.id; // Already enabled (happens on enable right after init)

    if (action.options.settings) {
        let actionId = Main.wm.addKeybinding(
            action.mutterName,
            action.options.settings,
            action.options.mutterFlags || Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            action.keyHandler
        );

        if (actionId !== Meta.KeyBindingAction.NONE) {
            action.id = actionId;
            actionIdMap[actionId] = action;
            return action.id;
        } else {
            console.warn('Could not enable action', action.name);
            return null;
        }
    } else {
        if (keycomboMap[action.keycombo]) {
            console.warn(
                'Other action bound to',
                action.keystr,
                keycomboMap[action.keycombo].name
            );
            return Meta.KeyBindingAction.NONE;
        }

        let actionId = Utils.grabAccelerator(action.keystr);
        if (actionId === Meta.KeyBindingAction.NONE) {
            console.warn('Failed to grab. Binding probably already taken');
            return Meta.KeyBindingAction.NONE;
        }

        let mutterName = Meta.external_binding_name_for_action(actionId);

        action.id = actionId;
        action.mutterName = mutterName;

        actionIdMap[actionId] = action;
        keycomboMap[action.keycombo] = action;
        nameMap[mutterName] = action;

        if (action.options.opensNavigator) {
            action.keyHandler = openNavigatorHandler(mutterName, action.keystr);
        } else {
            action.keyHandler = asKeyHandler(action.handler);
        }

        Main.wm.allowKeybinding(action.mutterName, Shell.ActionMode.ALL);

        return action.id;
    }
}
