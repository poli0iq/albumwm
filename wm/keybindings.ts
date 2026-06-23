import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {
    Settings,
    Utils,
    Tiling,
    Navigator,
    Scratch,
    LiveAltTab,
    GnomeSettings,
} from './imports.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import type Gio from 'gi://Gio?version=2.0';

const Display = global.display;

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';

type KeyBindingHandler = (
    mw: Tiling.Window,
    space: Tiling.Space,
    options?: {
        binding?: KeyBindingLike;
        display?: Meta.Display;
        navigator?: Navigator.NavigatorClass;
    }
) => void;

type KeyBindingAction = {
    id: Meta.KeyBindingAction;
    name: string;
    keystr?: string;
    keycombo?: string;
    mutterName?: string;
    keyHandler?: StoredKeyHandler;
    handler: KeyBindingHandler;
    options: KeyBindingOptions;
};

let signals: Utils.Signals | null,
    actions: KeyBindingAction[] | null,
    nameMap: { [mutterKeybindingActionName: string]: KeyBindingAction } | null,
    actionIdMap: { [metaKeyBindingActionId: number]: KeyBindingAction } | null,
    keycomboMap: { [keycombo: string]: KeyBindingAction } | null;
let keybindSettings: Gio.Settings | null;
/**
 * Pending close-window invocations, keyed by fail-safe timeout id. Tracked
 * so disable() can cancel the timeout and disconnect the `unmanaging`
 * signal we connected on the window being closed.
 */
let pendingCloses: Map<
    number,
    { metaWindow: Meta.Window; unmanagingId: number; sourceMonitor: number }
> | null;

export function enable(extension: Extension) {
    keybindSettings = extension.getSettings(KEYBINDINGS_KEY);
    setupActions(keybindSettings);
    signals!.connect(
        Display,
        'accelerator-activated',
        (display, actionId, deviceId, timestamp) => {
            handleAccelerator(display, actionId, deviceId, timestamp);
        }
    );
    actions!.forEach(enableAction);

    notifyConflicts(extension, Settings.findConflicts());

    Settings.getConflictSettings().forEach(schema => {
        signals!.connect(schema, 'changed', (settings, key) => {
            const conflicts = Settings.findConflicts([settings]).filter(c =>
                c.conflicts.includes(key)
            );
            notifyConflicts(extension, conflicts);
        });
    });
}

export function disable() {
    signals!.destroy();
    signals = null;
    actions!.forEach(disableAction);

    pendingCloses!.forEach((entry, id) => {
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

function notifyConflicts(
    extension: Extension,
    conflicts: ReturnType<typeof Settings.findConflicts>
) {
    if (!conflicts.length) return;
    const source = MessageTray.getSystemSource();
    for (const { name, conflicts: gnomeKeys, settings } of conflicts) {
        const accel = keybindSettings!.get_strv(name)[0] ?? '';
        const album = `“${
            keybindSettings!.settings_schema.get_key(name).get_summary() || name
        }”`;
        const gnome = gnomeKeys
            .map(k => settings.settings_schema.get_key(k).get_summary() || k)
            .map(g => `“${g}”`)
            .join(', ');

        const n = new MessageTray.Notification({
            source,
            title: 'AlbumWM keybinding conflict',
            body: `${album} (<b>${accel}</b>) conflicts with GNOME ${gnome}. Click to open extension preferences.`,
            useBodyMarkup: true,
        });
        n.connect('activated', () => extension.openPreferences());
        n.addAction('Delete GNOME shortcut', () => {
            for (const k of gnomeKeys) {
                settings.set_value(k, new GLib.Variant('as', []));
            }
        });
        n.addAction('Open GNOME settings', () =>
            GnomeSettings.openPanel('keyboard')
        );
        source.addNotification(n);
    }
}

export function registerAlbumAction(
    actionName: string,
    handler: KeyBindingHandler,
    flags?: Meta.KeyBindingFlags
) {
    registerAction(actionName, handler, {
        settings: keybindSettings!,
        mutterFlags: flags,
        activeInNavigator: true,
    });
}

export function registerMinimapAction(
    name: string,
    handler: KeyBindingHandler
) {
    registerAction(name, handler, {
        settings: keybindSettings!,
        opensNavigator: true,
        opensMinimap: true,
        mutterFlags: Meta.KeyBindingFlags.PER_WINDOW,
    });
}

export function setupActions(settings: Gio.Settings) {
    signals = new Utils.Signals();
    pendingCloses = new Map();
    actions = [];
    nameMap = {};
    actionIdMap = {}; // actionID   -> action
    keycomboMap = {};

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

    registerMinimapAction('switch-next', (_mw, space) => space.switchLinear(1));
    registerMinimapAction('switch-previous', (_mw, space) =>
        space.switchLinear(-1)
    );

    registerMinimapAction('switch-right', (_mw, space) => space.switchRight());
    registerMinimapAction('switch-left', (_mw, space) => space.switchLeft());
    registerMinimapAction('switch-up', (_mw, space) => space.switchUp());
    registerMinimapAction('switch-down', (_mw, space) => space.switchDown());

    registerMinimapAction('switch-first', Tiling.activateFirstWindow);
    registerMinimapAction('switch-last', Tiling.activateLastWindow);

    registerMinimapAction('switch-global-right', (_mw, space) =>
        space.switchGlobalRight()
    );
    registerMinimapAction('switch-global-left', (_mw, space) =>
        space.switchGlobalLeft()
    );
    registerMinimapAction('switch-global-up', (_mw, space) =>
        space.switchGlobalUp()
    );
    registerMinimapAction('switch-global-down', (_mw, space) =>
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

    registerAlbumAction('switch-focus-mode', (_mw, space) =>
        Tiling.switchToNextFocusMode(space)
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
                    pendingCloses!.delete(timeoutId);
                    Utils.timeoutRemove(timeoutId);
                    timeoutId = 0;
                }
                Utils.laterAdd(Meta.LaterType.IDLE, () => {
                    /* Could fire after disable. */
                    if (!Settings.prefs) return GLib.SOURCE_REMOVE;
                    const next = global.display.focus_window as Tiling.Window;
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
                pendingCloses!.delete(timeoutId);
                metaWindow.disconnect(unmanagingId);
                timeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });
            pendingCloses!.set(timeoutId, {
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

export function idOf(mutterName: string) {
    const action = byMutterName(mutterName);
    if (action) {
        return action.id;
    } else {
        return Meta.KeyBindingAction.NONE;
    }
}

export function byMutterName(name: string) {
    return nameMap![name];
}

export function byId(mutterId: number) {
    return actionIdMap![mutterId];
}

/**
 * Minimal binding shape consumed by action handlers invoked through
 * `asKeyHandler`. Satisfied both by a real `Meta.KeyBinding` and by the
 * synthetic binding built in `openNavigatorHandler`.
 */
export interface KeyBindingLike {
    get_name(): string;
    get_mask(): number;
    is_reversed(): boolean;
}

type StoredKeyHandler = (
    display: Meta.Display,
    window: Meta.Window,
    event?: Clutter.Event,
    binding?: Meta.KeyBinding
) => void;

export function asKeyHandler(
    actionHandler: KeyBindingHandler
): StoredKeyHandler {
    return (display, mw, _evt, binding) =>
        actionHandler(mw as Tiling.Window, Tiling.spaces.selectedSpace, {
            display,
            binding,
        });
}

/**
 * Action behavior flags. `settings` distinguishes a schema-backed action
 * (bound via Main.wm.addKeybinding) from a schemaless one.
 */
type KeyBindingOptions = {
    settings?: Gio.Settings;
    /** Start navigation and open the minimap. Implies `opensNavigator`. */
    opensMinimap?: boolean;
    /**
     * Start navigation (e.g. Esc restores the selected space and window).
     * Implies `activeInNavigator`.
     * */
    opensNavigator?: boolean;
    /** Action stays available during navigation. */
    activeInNavigator?: boolean;
    mutterFlags?: Meta.KeyBindingFlags;
};

export function impliedOptions(options: KeyBindingOptions) {
    options = Object.assign(
        { mutterFlags: Meta.KeyBindingFlags.NONE },
        options
    );

    if (options.opensMinimap) options.opensNavigator = true;

    if (options.opensNavigator) options.activeInNavigator = true;

    return options;
}

export function registerAction(
    actionName: string,
    handler: KeyBindingHandler,
    options: KeyBindingOptions
) {
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

    const action: KeyBindingAction = {
        id: Meta.KeyBindingAction.NONE,
        name: actionName,
        mutterName,
        keyHandler,
        handler,
        options,
    };

    actions!.push(action);
    if (actionName) nameMap![actionName] = action;

    return action;
}

/**
 * Bind a key to an action (possibly creating a new action)
 */
export function bindkey(
    keystr: string,
    actionName?: string,
    handler?: KeyBindingHandler,
    options: KeyBindingOptions = {}
) {
    Utils.assert(
        !options.settings,
        `Can only bind schemaless actions - change action's settings instead (${actionName})`
    );

    let action = actionName && actions!.find(a => a.name === actionName);
    const keycombo = Settings.keystrToKeycombo(keystr);

    if (!action) {
        action = registerAction(actionName!, handler!, options);
    } else {
        const boundAction = keycomboMap![keycombo];
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

        action.handler = handler!;
        action.options = impliedOptions(options);
    }

    action.keystr = keystr;
    action.keycombo = keycombo;

    if (enableAction(action) === Meta.KeyBindingAction.NONE) {
        // Keybinding failed: try to supply a useful error message
        let message;
        const boundAction = keycomboMap![keycombo];
        if (boundAction) {
            message = `${keystr} already bound to albumwm action: ${boundAction.name}`;
        } else {
            const boundId = getBoundActionId(keystr);
            if (boundId !== Meta.KeyBindingAction.NONE) {
                const builtInAction = Object.entries(
                    Meta.KeyBindingAction
                ).find(([_name, id]) => id === boundId);
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

export function unbindkey(actionIdOrKeystr: Meta.KeyBindingAction | string) {
    let actionId;
    if (typeof actionIdOrKeystr === 'string') {
        const action =
            keycomboMap![Settings.keystrToKeycombo(actionIdOrKeystr)];
        actionId = action && action.id;
    } else {
        actionId = actionIdOrKeystr;
    }

    disableAction(actionIdMap![actionId]);
}

/**
 * TODO: drop together with the schemaless keybindings subsystem.
 */
export function devirtualizeMask(_gdkVirtualMask: number): number {
    throw new Error(
        'devirtualizeMask: map_virtual_modifiers was removed from Clutter.Keymap'
    );
}

export function rawMaskOfKeystr(keystr: string) {
    const [, , mask] = Settings.parseAccelerator(keystr);
    return devirtualizeMask(mask);
}

export function openNavigatorHandler(actionName: string, keystr: string) {
    const mask = rawMaskOfKeystr(keystr) & 0xff;

    const binding: KeyBindingLike = {
        get_name: () => actionName,
        get_mask: () => mask,
        is_reversed: () => false,
    };
    return function (_display: Meta.Display, metaWindow: Meta.Window) {
        return Navigator.previewNavigate(metaWindow, null, {
            binding,
        });
    };
}

export function getBoundActionId(keystr: string) {
    const [, keyval, mask] = Settings.parseAccelerator(keystr);
    const rawMask = devirtualizeMask(mask);
    return Display.get_keybinding_action(keyval, rawMask);
}

export function handleAccelerator(
    display: Meta.Display,
    actionId: number,
    _deviceId: number,
    _timestamp: number
) {
    const action = actionIdMap![actionId];
    if (action) {
        console.debug(
            '#keybindings',
            'Schemaless keybinding activated',
            actionId,
            action.name
        );
        action.keyHandler!(display, display.focus_window);
    }
}

export function disableAction(action: KeyBindingAction) {
    if (action.id === Meta.KeyBindingAction.NONE) {
        return;
    }

    const oldId = action.id;
    if (action.options.settings) {
        Main.wm.removeKeybinding(action.mutterName!);
        action.id = Meta.KeyBindingAction.NONE;
        delete actionIdMap![oldId];
    } else {
        Display.ungrab_accelerator(action.id);
        action.id = Meta.KeyBindingAction.NONE;

        delete nameMap![action.mutterName!];
        delete actionIdMap![oldId];
        delete keycomboMap![action.keycombo!];

        action.mutterName = undefined;
    }
}

export function enableAction(action: KeyBindingAction) {
    if (action.id !== Meta.KeyBindingAction.NONE) return action.id; // Already enabled (happens on enable right after init)

    if (action.options.settings) {
        const actionId = Main.wm.addKeybinding(
            action.mutterName!,
            action.options.settings,
            action.options.mutterFlags || Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            action.keyHandler!
        );

        if (actionId !== Meta.KeyBindingAction.NONE) {
            action.id = actionId;
            actionIdMap![actionId] = action;
            return action.id;
        } else {
            console.warn('Could not enable action', action.name);
            return null;
        }
    } else {
        if (keycomboMap![action.keycombo!]) {
            console.warn(
                'Other action bound to',
                action.keystr,
                keycomboMap![action.keycombo!].name
            );
            return Meta.KeyBindingAction.NONE;
        }

        const actionId = Utils.grabAccelerator(action.keystr!);
        if (actionId === Meta.KeyBindingAction.NONE) {
            console.warn('Failed to grab. Binding probably already taken');
            return Meta.KeyBindingAction.NONE;
        }

        const mutterName = Meta.external_binding_name_for_action(actionId);

        action.id = actionId;
        action.mutterName = mutterName;

        actionIdMap![actionId] = action;
        keycomboMap![action.keycombo!] = action;
        nameMap![mutterName] = action;

        if (action.options.opensNavigator) {
            action.keyHandler = openNavigatorHandler(
                mutterName,
                action.keystr!
            );
        } else {
            action.keyHandler = asKeyHandler(action.handler);
        }

        Main.wm.allowKeybinding(action.mutterName, Shell.ActionMode.ALL);

        return action.id;
    }
}
