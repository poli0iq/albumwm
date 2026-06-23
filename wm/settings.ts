import Gio from 'gi://Gio';

import { AcceleratorParse } from './acceleratorparse.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import type Meta from 'gi://Meta';

/**
    Settings utility shared between the running extension and the preference UI.
    settings.js shouldn't depend on other modules (e.g with `imports` for other modules
    at the top).
 */

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';

// This is the value mutter uses for the keyvalue of above_tab
const META_KEY_ABOVE_TAB = 0x2f7259c9;

// Animation used when ensuring viewport on a window
export enum EnsureViewportAnimation {
    NONE = 0,
    TRANSLATE = 1,
    FADE = 2,
}

export type Prefs = {
    column_gap: number;
    vertical_margin: number;
    horizontal_margin: number;
    animation_time: number;
    drag_drift_speed: number;
    default_show_top_bar: boolean;
    swipe_sensitivity: number[];
    swipe_friction: number[];
    preset_column_widths: number[];
    preset_window_heights: number[];
    maximize_column_width: number;
    minimap_scale: number;
    minimap_shade_opacity: number;
    edge_preview_enable: boolean;
    edge_preview_scale: number;
    edge_preview_click_enable: boolean;
    edge_preview_timeout_enable: boolean;
    edge_preview_timeout: number;
    edge_preview_timeout_continual: boolean;
    window_switcher_preview_scale: number;
    warp_pointer_on_focus: boolean;
    show_focus_mode_icon: boolean;
    topbar_mouse_scroll_enable: boolean;
    default_focus_mode: number;
    gesture_enabled: boolean;
    gesture_horizontal_fingers: number;
    overview_ensure_viewport_animation: number;
    overview_min_windows_per_row: number;
    overview_max_window_scale: number;
    readonly minimum_margin: number;
};

export let prefs: Prefs | null;
let gsettings: Gio.Settings | null, keybindSettings: Gio.Settings;
let acceleratorParse: AcceleratorParse | null;
export function enable(extension: Extension) {
    gsettings = extension.getSettings();
    keybindSettings = extension.getSettings(KEYBINDINGS_KEY);

    acceleratorParse = new AcceleratorParse();
    prefs = {} as Prefs;
    for (const key of gsettings.list_keys()) {
        if (key.startsWith('restore-') || key === 'winprops') continue;
        setState(null, key);
    }
    Object.defineProperty(prefs, 'minimum_margin', {
        enumerable: true,
        configurable: true,
        get: () => Math.min(15, prefs!.horizontal_margin),
    });
    gsettings.connect('changed', setState);

    // connect to settings and update winprops array when it's updated
    gsettings.connect('changed::winprops', () => reloadWinpropsFromGSettings());

    // A intermediate window is created before the prefs dialog is created.
    // Prevent it from being inserted into the tiling causing flickering and general disorder
    defwinprop({
        wm_class: 'Gnome-shell-extension-prefs',
        float: true,
        focus: true,
    });
    defwinprop({
        wm_class: '/gnome-screenshot/i',
        float: true,
        focus: true,
    });

    addWinpropsFromGSettings();
}

let conflictSettings: Gio.Settings[] | null;
export function disable() {
    gsettings = null;
    acceleratorParse = null;
    prefs = null;
    conflictSettings = null;
}

function setState(_: Gio.Settings | null, key: string) {
    const value = gsettings!.get_value(key);
    const name = key.replace(/-/g, '_');
    if (prefs) {
        (prefs as Record<string, unknown>)[name] = value.deep_unpack();
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

export type KeycomboMap = { [key: string]: string[] };

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

export function findConflicts(schemas?: Gio.Settings[]) {
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

// / Winprops

export type PreferredWidth = {
    value: number;
    unit: string;
};
type WinProp = {
    wm_class?: string | RegExp;
    title?: string | RegExp;
    float?: boolean;
    focus?: boolean;
    preferredWidth?: PreferredWidth;
    spaceIndex?: number;
    gsetting?: boolean;
    /** TODO: only used in `tiling.ts`, might be dead */
    oneshot?: boolean;
};
export type WinPropSpec = {
    wm_class?: string;
    title?: string;
    float?: boolean;
    focus?: boolean;
    preferredWidth?: string;
    spaceIndex?: number;
    gsetting?: boolean;
};

function maybeRegex(value: string | undefined): string | RegExp | undefined {
    if (!value) return value;
    const match = value.match(/^\/(.+)\/([igmsuy]*)$/);
    return match ? new RegExp(match[1], match[2]) : value;
}

/**
   Modelled after notion/ion3's system

   Examples:

   defwinprop({
     wm_class: "Riot",
     float: true
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

/* Both hardcoded and gsettings specs come in as strings; values matching
 * /foo/flags get parsed into a real RegExp. */
function defwinprop(spec: WinPropSpec) {
    const prop: WinProp = {
        wm_class: maybeRegex(spec.wm_class),
        title: maybeRegex(spec.title),
        float: spec.float,
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
            prop.gsetting = true;
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
