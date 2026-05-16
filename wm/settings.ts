import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { AcceleratorParse } from './acceleratorparse.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import type Meta from 'gi://Meta';

/**
    Settings utility shared between the running extension and the preference UI.
    settings.js shouldn't depend on other modules (e.g with `imports` for other modules
    at the top).
 */

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';
const RESTORE_KEYBINDS_KEY = 'restore-keybinds';

// This is the value mutter uses for the keyvalue of above_tab
const META_KEY_ABOVE_TAB = 0x2f7259c9;

// position to open window at (e.g. to the right of current window)
export const OpenWindowPositions = { RIGHT: 0, DOWN: 1 };

// Animation used when ensuring viewport on a window
export const EnsureViewportAnimation = { NONE: 0, TRANSLATE: 1, FADE: 2 };

export let prefs: { [pref: string]: unknown } | null;
let gsettings: Gio.Settings | null,
    keybindSettings: Gio.Settings,
    _overridingConflicts: boolean | null;
let acceleratorParse: AcceleratorParse | null;
export function enable(extension: Extension) {
    gsettings = extension.getSettings();
    keybindSettings = extension.getSettings(KEYBINDINGS_KEY);

    acceleratorParse = new AcceleratorParse();
    _overridingConflicts = false;
    prefs = {};
    [
        'window-gap',
        'vertical-margin',
        'vertical-margin-bottom',
        'horizontal-margin',
        'animation-time',
        'drift-speed',
        'drag-drift-speed',
        'default-show-top-bar',
        'swipe-sensitivity',
        'swipe-friction',
        'cycle-width-steps',
        'cycle-height-steps',
        'maximize-width-percent',
        'minimap-scale',
        'edge-preview-enable',
        'edge-preview-scale',
        'edge-preview-click-enable',
        'edge-preview-timeout-enable',
        'edge-preview-timeout',
        'edge-preview-timeout-continual',
        'window-switcher-preview-scale',
        'winprops',
        'show-focus-mode-icon',
        'show-open-position-icon',
        'topbar-mouse-scroll-enable',
        'default-focus-mode',
        'gesture-enabled',
        'gesture-horizontal-fingers',
        'open-window-position',
        'overview-ensure-viewport-animation',
        'overview-min-windows-per-row',
        'overview-max-window-scale',
        'minimap-shade-opacity',
    ].forEach(k => setState(null, k));
    Object.defineProperty(prefs, 'minimum_margin', {
        enumerable: true,
        configurable: true,
        get: () => Math.min(15, prefs!.horizontal_margin as number),
    });
    gsettings.connect('changed', setState);

    // connect to settings and update winprops array when it's updated
    gsettings.connect('changed::winprops', () => reloadWinpropsFromGSettings());

    // A intermediate window is created before the prefs dialog is created.
    // Prevent it from being inserted into the tiling causing flickering and general disorder
    defwinprop({
        wm_class: 'Gnome-shell-extension-prefs',
        scratch_layer: true,
        focus: true,
    });
    defwinprop({
        wm_class: /gnome-screenshot/i,
        scratch_layer: true,
        focus: true,
    });

    addWinpropsFromGSettings();
}

let conflictSettings: Gio.Settings[] | null;
export function disable() {
    gsettings = null;
    acceleratorParse = null;
    _overridingConflicts = null;
    prefs = null;
    conflictSettings = null;
}

function setState(_: Gio.Settings | null, key: string) {
    const value = gsettings!.get_value(key);
    const name = key.replace(/-/g, '_');
    if (prefs) {
        prefs[name] = value.deep_unpack();
    }
}

export function getConflictSettings() {
    if (!conflictSettings) {
        // Schemas that may contain conflicting keybindings
        conflictSettings = [];
        addSchemaToConflictSettings('org.gnome.mutter.keybindings');
        addSchemaToConflictSettings('org.gnome.mutter.wayland.keybindings');
        addSchemaToConflictSettings('org.gnome.desktop.wm.keybindings');
        addSchemaToConflictSettings('org.gnome.shell.keybindings');

        // below schemas are checked but may not exist in all distributions
        addSchemaToConflictSettings(
            'org.gnome.settings-daemon.plugins.media-keys',
            false
        );
        // ubuntu tiling-assistant (enabled by default on Ubuntu 23.10)
        addSchemaToConflictSettings(
            'org.gnome.shell.extensions.tiling-assistant',
            false
        );
    }

    return conflictSettings;
}

/**
 * Adds a Gio.Settings object to conflictSettings.  Fails gracefully.
 * @param {Gio.Settings} schemaId
 */
function addSchemaToConflictSettings(schemaId: string, warn = true) {
    try {
        conflictSettings!.push(new Gio.Settings({ schema_id: schemaId }));
    } catch (e) {
        if (warn) {
            console.warn(
                `Invalid schema_id '${schemaId}': could not add to keybind conflict checks: ${e}`
            );
        }
    }
}

// / Keybindings

export function parseAccelerator(keystr: string) {
    return acceleratorParse!.accelerator_parse(keystr);
}

/**
 * Two keystrings can represent the same key combination
 */
export function keystrToKeycombo(keystr: string) {
    // Above_Tab is a fake keysymbol provided by mutter
    let aboveTab = false;
    if (keystr.match(/Above_Tab/) || keystr.match(/grave/)) {
        keystr = keystr.replace('Above_Tab', 'a');
        aboveTab = true;
    }

    const [, key, mask] = parseAccelerator(keystr);
    // Since js doesn't have a mapable tuple type
    return `${aboveTab ? META_KEY_ABOVE_TAB : key}|${mask}`;
}

type KeycomboMap = { [key: string]: string[] };

function generateKeycomboMap(settings: Gio.Settings): KeycomboMap {
    const map: KeycomboMap = {};
    for (const name of settings.list_keys()) {
        const value = settings.get_value<'as'>(name);
        if (value.get_type_string() !== 'as') continue;

        for (const combo of value.deep_unpack().map(keystrToKeycombo)) {
            if (combo === '0|0') continue;
            if (map[combo]) {
                map[combo].push(name);
            } else {
                map[combo] = [name];
            }
        }
    }
    return map;
}

function findConflicts(schemas?: Gio.Settings[]) {
    schemas = schemas || getConflictSettings();
    const conflicts = [];
    const albumMap = generateKeycomboMap(keybindSettings);

    for (const settings of schemas) {
        const against = generateKeycomboMap(settings);
        for (const combo in albumMap) {
            if (against[combo]) {
                conflicts.push({
                    name: albumMap[combo][0],
                    conflicts: against[combo],
                    settings,
                    combo,
                });
            }
        }
    }
    return conflicts;
}

/** Single right-hand keybinding value */
type OverrideValue = {
    /** JSON.stringified list of binds */
    bind: string;
    schema_id: string;
};

/** Map of keybinding names to keybinding values */
type OverrideList = Map<string, OverrideValue>;

/**
 * Returns / reconstitutes saved overrides list.
 */
function getSavedOverrides() {
    const saveListJson = gsettings!.get_string(RESTORE_KEYBINDS_KEY);
    let saveList: OverrideList;
    try {
        saveList = new Map(Object.entries(JSON.parse(saveListJson)));
    } catch {
        saveList = new Map();
    }
    return saveList;
}

/**
 * Saves an overrides list.
 */
function saveOverrides(overrides: OverrideList) {
    gsettings!.set_string(
        RESTORE_KEYBINDS_KEY,
        JSON.stringify(Object.fromEntries(overrides))
    );
}

export function conflictKeyChanged(settings: Gio.Settings, key: string) {
    if (_overridingConflicts) {
        return false;
    }

    const newKeybind = settings.get_value(key).deep_unpack();
    if (Array.isArray(newKeybind) && newKeybind.length === 0) {
        return false;
    }

    const saveList = getSavedOverrides();
    saveList.delete(key);
    saveOverrides(saveList);

    // check for new conflicts
    return overrideConflicts(key);
}

/**
 * Override conflicts and save original values for restore.
 */
export function overrideConflicts(checkKey?: string) {
    if (_overridingConflicts) {
        return false;
    }

    _overridingConflicts = true;
    const saveList = getSavedOverrides();

    // restore orignal keybinds prior to conflict overriding
    restoreConflicts();

    const disableAll: (() => boolean)[] = [];
    const foundConflicts = findConflicts();
    for (const conflict of foundConflicts) {
        // save conflicts (list of names of conflicting keybinds)
        const { conflicts, settings } = conflict;

        conflicts.forEach(c => {
            // get current value
            const keybind = settings.get_value(c);
            saveList.set(c, {
                bind: JSON.stringify(keybind.deep_unpack()),
                schema_id: settings.schema_id,
            });

            // now disable conflict
            disableAll.push(() =>
                settings.set_value(c, new GLib.Variant('as', []))
            );
        });
    }

    // save override list
    saveOverrides(saveList);

    // now disable all conflicts
    disableAll.forEach(d => d());
    _overridingConflicts = false;

    return checkKey ? saveList.has(checkKey) : false;
}

/**
 * Update overrides to their current keybinds.
 */
export function updateOverrides() {
    const saveList = getSavedOverrides();
    saveList.forEach((saved, key) => {
        const settings = getConflictSettings().find(
            s => s.schema_id === saved.schema_id
        );
        if (settings) {
            const newKeybind = settings.get_value(key).deep_unpack();
            if (Array.isArray(newKeybind) && newKeybind.length === 0) {
                return;
            }

            saveList.set(key, {
                bind: JSON.stringify(newKeybind),
                schema_id: settings.schema_id,
            });
        }
    });

    // save override list
    saveOverrides(saveList);
}

/**
 * Restores previously overridden conflicts.
 */
export function restoreConflicts() {
    const saveList = getSavedOverrides();
    const toRemove: { key: string; remove: () => boolean }[] = [];
    saveList.forEach((saved, key) => {
        const settings = getConflictSettings().find(
            s => s.schema_id === saved.schema_id
        );
        if (settings) {
            const keybind = JSON.parse(saved.bind);
            toRemove.push({
                key,
                remove: () =>
                    settings.set_value(key, new GLib.Variant('as', keybind)),
            });
        }
    });

    // now remove retored keybinds from list
    toRemove.forEach(r => {
        r.remove();
        saveList.delete(r.key);
    });
    saveOverrides(saveList);
}

// / Winprops

type PreferredWidth = {
    value: number;
    unit: string;
};
type WinProp = {
    wm_class?: string | RegExp;
    title?: string | RegExp;
    scratch_layer?: boolean;
    focus?: boolean;
    preferredWidth?: PreferredWidth;
    spaceIndex?: number;
    gsetting?: boolean;
};
type WinPropSpec = {
    wm_class?: string | RegExp;
    title?: string | RegExp;
    scratch_layer?: boolean;
    focus?: boolean;
    preferredWidth?: string;
    spaceIndex?: number;
    gsetting?: boolean;
};

/**
   Modelled after notion/ion3's system

   Examples:

   defwinprop({
     wm_class: "Riot",
     scratch_layer: true
   })
*/
export let winprops: WinProp[] = [];
function winpropMatches(metaWindow: Meta.Window, prop: WinProp) {
    const wmClass = metaWindow.wm_class || '';
    const title = metaWindow.title;
    if (prop.wm_class) {
        if (prop.wm_class instanceof RegExp) {
            if (!wmClass.match(prop.wm_class)) return false;
        } else if (prop.wm_class !== wmClass) {
            return false;
        }
    }
    if (prop.title) {
        if (prop.title instanceof RegExp) {
            if (!title.match(prop.title)) return false;
        } else if (prop.title !== title) return false;
    }

    return true;
}

export function findWinprop(metaWindow: Meta.Window) {
    // sort by title first (prioritise title over wm_class)
    const props = winprops.filter(winpropMatches.bind(null, metaWindow));

    // if matching props found, return first one
    if (props.length > 0) {
        return props[0];
    }

    // fall back, if star (catch-all) winprop exists, return the first one
    const starProps = winprops.filter(
        w => w.wm_class === '*' || w.title === '*'
    );
    if (starProps.length > 0) {
        return starProps[0];
    }

    return null;
}

function defwinprop(spec: WinPropSpec) {
    const prop: WinProp = {
        wm_class: spec.wm_class,
        title: spec.title,
        scratch_layer: spec.scratch_layer,
        focus: spec.focus,
        spaceIndex: spec.spaceIndex,
        gsetting: spec.gsetting,
    };

    // process preferredWidth - expects inputs like 50% or 400px
    if (spec.preferredWidth) {
        prop.preferredWidth = {
            // value is first contiguous block of digits
            value: Number((spec.preferredWidth.match(/\d+/) ?? ['0'])[0]),
            // unit is first contiguous block of alpha chars or % char
            unit: (spec.preferredWidth.match(/[a-zA-Z%]+/) ?? ['NO_UNIT'])[0],
        };
    }

    /* gsetting winprops take precedence over hardcoded ones.
     * They're easier to add/remove and can be edited live without restarting
     * the shell. */
    winprops.push(prop);

    // now order winprops with gsettings first, then title over wm_class
    winprops.sort((a, b) => {
        let firstresult = 0;
        if (a.gsetting && !b.gsetting) {
            firstresult = -1;
        } else if (!a.gsetting && b.gsetting) {
            firstresult = 1;
        }

        // second compare, prioritise title
        let secondresult = 0;
        if (a.title && !b.title) {
            secondresult = -1;
        } else if (!a.title && b.title) {
            secondresult = 1;
        }

        return firstresult || secondresult;
    });
}

/**
 * Adds user-defined winprops from gsettings (as defined in
 * org.gnome.shell.extensions.albumwm.winprops) to the winprops array.
 */
function addWinpropsFromGSettings() {
    // add gsetting (user config) winprops
    gsettings!
        .get_value<'as'>('winprops')
        .deep_unpack()
        .map(value => JSON.parse(value))
        .forEach(prop => {
            // test if wm_class or title is a regex expression
            if (/^\/.+\/[igmsuy]*$/.test(prop.wm_class)) {
                // extract inner regex and flags from wm_class
                const matches = prop.wm_class.match(/^\/(.+)\/([igmsuy]*)$/);
                const inner = matches[1];
                const flags = matches[2];
                prop.wm_class = new RegExp(inner, flags);
            }
            if (/^\/.+\/[igmsuy]*$/.test(prop.title)) {
                // extract inner regex and flags from title
                const matches = prop.title.match(/^\/(.+)\/([igmsuy]*)$/);
                const inner = matches[1];
                const flags = matches[2];
                prop.title = new RegExp(inner, flags);
            }
            prop.gsetting = true; // set property that is from user gsettings
            defwinprop(prop);
        });
}

/**
 * Removes winprops with the `gsetting:true` property from the winprops array.
 */
function removeGSettingWinpropsFromArray() {
    winprops = winprops.filter(prop => !prop.gsetting);
}

/**
 * Effectively reloads winprops from gsettings.
 * This is a convenience function which removes gsetting winprops from winprops
 * array and then adds the currently defined
 * org.gnome.shell.extensions.albumwm.winprops winprops.
 */
function reloadWinpropsFromGSettings() {
    removeGSettingWinpropsFromArray();
    addWinpropsFromGSettings();
}
