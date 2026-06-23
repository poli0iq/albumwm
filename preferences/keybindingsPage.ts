import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { AcceleratorParse } from '../wm/acceleratorparse.js';
import { getConflictSettings } from '../wm/settings.js';

import type { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const _ = (s: string) => s;

/** A single conflicting shortcut, labelled with where it comes from. */
type ConflictEntry = { description: string; source: 'albumwm' | 'gnome' };

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';

const actions = {
    windows: [
        'close-window',
        'focus-column-left',
        'focus-column-right',
        'focus-window-up',
        'focus-window-down',
        'focus-column-first',
        'focus-column-last',
        'cycle-focus-modes',
        'move-column-left',
        'move-column-right',
        'move-window-up',
        'move-window-down',
        'consume-window-into-column',
        'expel-window-from-column',
        'expel-window-right',
        'center-column',
        'fullscreen-window-toggle',
        'maximize-column-toggle',
        'inc-window-height',
        'dec-window-height',
        'inc-column-width',
        'dec-column-width',
        'cycle-preset-column-width',
        'cycle-preset-column-width-backwards',
        'cycle-preset-window-height',
        'cycle-preset-window-height-backwards',
        'focus-window-down-or-column-right',
        'focus-window-up-or-column-left',
    ],
    monitors: [
        'focus-monitor-right',
        'focus-monitor-left',
        'focus-monitor-above',
        'focus-monitor-below',
    ],
    floating: [
        'toggle-window-floating',
        'switch-focus-between-floating-and-tiling',
    ],
};

const forbiddenKeyvals = [
    Gdk.KEY_Home,
    Gdk.KEY_Left,
    Gdk.KEY_Up,
    Gdk.KEY_Right,
    Gdk.KEY_Down,
    Gdk.KEY_Page_Up,
    Gdk.KEY_Page_Down,
    Gdk.KEY_End,
    Gdk.KEY_Tab,
    Gdk.KEY_KP_Enter,
    Gdk.KEY_Return,
    Gdk.KEY_Mode_switch,
];

const printableKeyvalRanges = [
    [Gdk.KEY_a, Gdk.KEY_z],
    [Gdk.KEY_A, Gdk.KEY_Z],
    [Gdk.KEY_0, Gdk.KEY_9],
    [Gdk.KEY_kana_fullstop, Gdk.KEY_semivoicedsound],
    [Gdk.KEY_Arabic_comma, Gdk.KEY_Arabic_sukun],
    [Gdk.KEY_Serbian_dje, Gdk.KEY_Cyrillic_HARDSIGN],
    [Gdk.KEY_Greek_ALPHAaccent, Gdk.KEY_Greek_omega],
    [Gdk.KEY_hebrew_doublelowline, Gdk.KEY_hebrew_taf],
    [Gdk.KEY_Thai_kokai, Gdk.KEY_Thai_lekkao],
    [Gdk.KEY_Hangul_Kiyeog, Gdk.KEY_Hangul_J_YeorinHieuh],
];

function isValidBinding(combo: Combo) {
    if (
        (combo.mods === 0 || combo.mods === Gdk.ModifierType.SHIFT_MASK) &&
        combo.keycode !== 0
    ) {
        const keyval = combo.keyval;
        const isPrintable = printableKeyvalRanges.some(
            ([lo, hi]) => keyval >= lo && keyval <= hi
        );
        if (
            isPrintable ||
            (keyval === Gdk.KEY_space && combo.mods === 0) ||
            forbiddenKeyvals.includes(keyval)
        ) {
            return false;
        }
    }

    // Allow Tab in addition to accelerators allowed by GTK
    if (
        !Gtk.accelerator_valid(combo.keyval, combo.mods) &&
        (combo.keyval !== Gdk.KEY_Tab || combo.mods === 0)
    ) {
        return false;
    }

    return true;
}

function isEmptyBinding(combo: Combo) {
    return combo.keyval === 0 && combo.mods === 0 && combo.keycode === 0;
}

class Combo extends GObject.Object {
    static {
        GObject.registerClass(
            {
                GTypeName: 'Combo',
                Properties: {
                    keycode: GObject.ParamSpec.uint(
                        'keycode',
                        'Keycode',
                        'Key code',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        0,
                        GLib.MAXUINT32,
                        0
                    ),
                    keyval: GObject.ParamSpec.uint(
                        'keyval',
                        'Keyval',
                        'Key value',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        0,
                        GLib.MAXUINT32,
                        0
                    ),
                    mods: GObject.ParamSpec.uint(
                        'mods',
                        'Mods',
                        'Key modifiers',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        0,
                        GLib.MAXUINT32,
                        0
                    ),
                    keystr: GObject.ParamSpec.string(
                        'keystr',
                        'Keystr',
                        'Key string',
                        GObject.ParamFlags.READABLE,
                        null
                    ),
                    label: GObject.ParamSpec.string(
                        'label',
                        'Label',
                        'Key label',
                        GObject.ParamFlags.READABLE,
                        null
                    ),
                    disabled: GObject.ParamSpec.boolean(
                        'disabled',
                        'Disabled',
                        'Disabled sentinel',
                        GObject.ParamFlags.READABLE,
                        false
                    ),
                },
            },
            this
        );
    }

    declare _keycode: number;
    declare keyval: number;
    declare mods: number;

    constructor(props?: Partial<Combo.ConstructorProps>) {
        super(props);
    }

    get keycode() {
        return this._keycode;
    }

    get keystr() {
        if (this.disabled) return '';
        else return Gtk.accelerator_name(this.keyval, this.mods);
    }

    get label() {
        if (this.disabled) return _('Disabled');
        else return Gtk.accelerator_get_label(this.keyval, this.mods);
    }

    get disabled() {
        return !this.keyval && !this.mods;
    }

    toString() {
        return `Combo(keycode=${this.keycode}, keyval=${this.keyval}, mods=${this.mods})`;
    }
}

declare namespace Combo {
    interface ConstructorProps extends GObject.Object.ConstructorProps {
        keycode: number;
        keyval: number;
        mods: number;
    }
}

class Keybinding extends GObject.Object implements Gio.ListModel<Combo> {
    static {
        GObject.registerClass(
            {
                GTypeName: 'Keybinding',
                Implements: [Gio.ListModel],
                Properties: {
                    section: GObject.ParamSpec.string(
                        'section',
                        'Section',
                        'Keybinding section title',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        null
                    ),
                    action: GObject.ParamSpec.string(
                        'action',
                        'Action',
                        'Keybinding action ID',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        null
                    ),
                    description: GObject.ParamSpec.string(
                        'description',
                        'Description',
                        'Keybinding action description',
                        GObject.ParamFlags.READABLE,
                        null
                    ),
                    label: GObject.ParamSpec.string(
                        'label',
                        'Label',
                        'Keybinding combo label',
                        GObject.ParamFlags.READABLE,
                        null
                    ),
                    combos: GObject.ParamSpec.object(
                        'combos',
                        'Combos',
                        'Key combos',
                        GObject.ParamFlags.READABLE,
                        Gio.ListModel.$gtype
                    ),
                    modified: GObject.ParamSpec.boolean(
                        'modified',
                        'Modified',
                        'True if the user has modified the shortcut from its default value',
                        GObject.ParamFlags.READABLE,
                        false
                    ),
                    enabled: GObject.ParamSpec.boolean(
                        'enabled',
                        'Enabled',
                        'True if this keybinding has any shortcuts',
                        GObject.ParamFlags.READABLE,
                        false
                    ),
                },
                Signals: {
                    changed: {},
                },
            },
            this
        );
    }

    declare section: keyof typeof actions;
    declare action: string;
    declare _description: string;
    declare _combos: Gio.ListStore<Combo>;
    declare _modified: boolean;
    declare _enabled: boolean;

    declare _settings: Gio.Settings;
    declare acceleratorParse: AcceleratorParse;

    declare get_item_type: () => GObject.GType;
    declare get_n_items: () => number;
    declare get_item: (_position: number) => Combo | null;
    declare items_changed: (
        _position: number,
        _removed: number,
        _added: number
    ) => void;

    _init(
        settings: Gio.Settings,
        acceleratorParse: AcceleratorParse,
        params = {}
    ) {
        super._init(params);
        this._settings = settings;
        this.acceleratorParse = acceleratorParse;
        this._description = _(
            this._settings.settings_schema.get_key(this.action).get_summary()!
        );

        this._combos = new Gio.ListStore();
        this._combos.connect(
            'items-changed',
            (_combos, position, removed, added) => {
                this.items_changed(position, removed, added);
                this.notify('label');
                this.notify('modified');
            }
        );

        this._settings.connect(`changed::${this.action}`, () => this._load());
        GLib.idle_add(0, () => {
            this._load();
            return GLib.SOURCE_REMOVE;
        });
    }

    get description() {
        return this._description;
    }

    get label() {
        const labels = [...this.combos]
            .filter(c => !isEmptyBinding(c))
            .map(c => c.label);

        let label = labels.length === 0 ? _('Disabled') : labels.join(', ');

        if (this.modified) {
            label = `<b>${label}</b>`;
        }

        return label;
    }

    get combos() {
        return this._combos;
    }

    get modified() {
        return this._settings.get_user_value(this.action) !== null;
    }

    get enabled() {
        return [...this.combos].some(c => !c.disabled);
    }

    vfunc_get_item_type() {
        return Combo.$gtype;
    }

    vfunc_get_item(position: number) {
        return this.combos.get_item(position);
    }

    vfunc_get_n_items() {
        return this.combos.get_n_items();
    }

    add(combo: Combo) {
        const pos = this.find(combo);
        if (pos !== null) return;
        this.combos.append(combo);
        if (!combo.disabled) {
            this._store();
        }
    }

    remove(combo: Combo) {
        const pos = this.find(combo);
        if (pos === null) return;
        this.combos.remove(pos);
        if (this.combos.get_n_items() === 0) this.combos.append(new Combo());
        this._store();
    }

    replace(oldCombo: Combo, newCombo: Combo) {
        const newPos = this.find(newCombo);
        if (newPos !== null) return;
        const oldPos = this.find(oldCombo);
        if (oldPos !== null) {
            this.combos.splice(oldPos, 1, [newCombo]);
        } else {
            this.combos.append(newCombo);
        }
        this._store();
    }

    disable() {
        this._settings.set_strv(this.action, ['']);
    }

    reset() {
        if (this._settings.get_user_value(this.action)) {
            this._settings.reset(this.action);
        }
    }

    find(combo: Combo): number | null {
        const pos = [...this.combos].findIndex(c => c.keystr === combo.keystr);
        if (pos === -1) {
            return null;
        } else {
            return pos;
        }
    }

    _load() {
        const keystrs = this._settings.get_strv(this.action) || [];
        const combos = keystrs
            .map(translateAboveTab)
            .map((keystr): [boolean, number, number] => {
                if (keystr !== '')
                    return this.acceleratorParse.accelerator_parse(keystr);
                else return [true, 0, 0];
            })
            .map(([, keyval, mods]) => new Combo({ keyval, mods }));

        if (combos.length === 0) {
            combos.push(new Combo());
        }

        this.combos.splice(0, this.combos.get_n_items(), combos);
    }

    _store() {
        let filtered = [...this.combos]
            .filter(c => !isEmptyBinding(c))
            .map(c => c.keystr);
        if (filtered.length === 0) {
            filtered = [''];
        }
        this._settings.set_strv(this.action, filtered);
    }
}

export class KeybindingsModel
    extends GObject.Object
    implements Gio.ListModel<Keybinding>
{
    static {
        GObject.registerClass(
            {
                GTypeName: 'KeybindingsModel',
                Implements: [Gio.ListModel],
                Signals: {
                    'collisions-changed': {
                        flags:
                            GObject.SignalFlags.RUN_LAST |
                            GObject.SignalFlags.DETAILED,
                    },
                },
            },
            this
        );
    }

    declare get_item_type: () => GObject.GType;
    declare get_n_items: () => number;
    declare get_item: (_position: number) => Keybinding | null;
    declare items_changed: (
        _position: number,
        _removed: number,
        _added: number
    ) => void;

    declare acceleratorParse: AcceleratorParse;
    declare _model: Gio.ListStore<Keybinding>;
    declare _combos: Gtk.FlattenListModel;
    declare _actionToBinding: Map<string, Keybinding>;
    declare _settings: Gio.Settings;
    declare _collisions: Map<string, Set<string>>;
    declare _systemShortcuts: Map<string, string[]>;

    _init(acceleratorParse: AcceleratorParse, params = {}) {
        super._init(params);
        this.acceleratorParse = acceleratorParse;
        this._model = new Gio.ListStore({ itemType: Keybinding.$gtype });
        this._model.connect(
            'items-changed',
            (_model, position, removed, added) => {
                this.items_changed(position, removed, added);
            }
        );

        this._combos = Gtk.FlattenListModel.new(this._model);
        this._combos.connect('items-changed', () => {
            // Room for optimization here.
            this._updateCollisions();
        });

        this._actionToBinding = new Map();
    }

    init(settings: Gio.Settings) {
        this._settings = settings;
        this.load();

        /* Keep GNOME's shortcuts in sync the same way we track our own: rebuild
         * the lookup and recompute collisions when a system shortcut changes
         * while this page is open. */
        getConflictSettings().forEach(systemSettings =>
            systemSettings.connect('changed', () => {
                this._systemShortcuts = this._buildSystemShortcuts();
                this._updateCollisions();
            })
        );
    }

    vfunc_get_item_type() {
        return this._model.get_item_type();
    }

    vfunc_get_item(position: number) {
        return this._model.get_item(position);
    }

    vfunc_get_n_items() {
        return this._model.get_n_items();
    }

    get collisions() {
        if (this._collisions === undefined) {
            this._collisions = new Map();
            this._updateCollisions();
        }
        return this._collisions;
    }

    /**
     * GNOME Shell shortcuts, keyed by the same normalized keystr that
     * `Combo.keystr` produces, so they can be compared by string equality.
     * Kept in sync with the changes (see `init`).
     */
    get systemShortcuts() {
        if (this._systemShortcuts === undefined) {
            this._systemShortcuts = this._buildSystemShortcuts();
        }
        return this._systemShortcuts;
    }

    _buildSystemShortcuts() {
        const map = new Map<string, string[]>();
        for (const settings of getConflictSettings()) {
            const schema = settings.settings_schema;
            for (const key of settings.list_keys()) {
                const value = settings.get_value<'as'>(key);
                if (value.get_type_string() !== 'as') continue;

                const description = schema.get_key(key).get_summary() || key;
                for (const raw of value.deep_unpack()) {
                    if (!raw) continue;
                    const [ok, keyval, mods] =
                        this.acceleratorParse.accelerator_parse(
                            translateAboveTab(raw)
                        );
                    if (!ok) continue;
                    const keystr = Gtk.accelerator_name(keyval, mods);
                    if (!keystr) continue;

                    const descriptions = map.get(keystr);
                    if (!descriptions) {
                        map.set(keystr, [description]);
                    } else if (!descriptions.includes(description)) {
                        descriptions.push(description);
                    }
                }
            }
        }
        return map;
    }

    getKeybinding(action: string) {
        return this._actionToBinding.get(action);
    }

    /**
     * AlbumWM actions that already bind keystr.
     * Analogue of gnome-control-center's cc_keyboard_manager_get_collision.
     */
    findActionsUsing(keystr: string, exceptAction: string): Keybinding[] {
        if (!keystr) return [];
        const result: Keybinding[] = [];
        for (const binding of this._model) {
            if (binding.action === exceptAction) continue;
            for (const combo of binding.combos) {
                if (!combo.disabled && combo.keystr === keystr) {
                    result.push(binding);
                    break;
                }
            }
        }
        return result;
    }

    /** GNOME Shell shortcuts that already bind keystr. */
    findSystemConflicts(keystr: string): string[] {
        return keystr ? (this.systemShortcuts.get(keystr) ?? []) : [];
    }

    load() {
        const bindings: Keybinding[] = [];
        for (const section in actions) {
            for (const action of actions[section as keyof typeof actions]) {
                const binding = new Keybinding(
                    this._settings,
                    this.acceleratorParse,
                    { section, action }
                );
                bindings.push(binding);
                this._actionToBinding.set(action, binding);
            }
        }
        this._model.splice(0, this._model.get_n_items(), bindings);
    }

    _updateCollisions() {
        const map = new Map<string, Set<string>>();
        for (const binding of this._model) {
            for (const combo of binding.combos) {
                if (combo.disabled) continue;
                map.set(
                    combo.keystr,
                    (map.get(combo.keystr) || new Set<string>()).add(
                        binding.action
                    )
                );
            }
        }
        const changed = new Set<string>();
        for (const [keystr, bindingActions] of map.entries()) {
            const systemCount = this.systemShortcuts.get(keystr)?.length ?? 0;
            if (bindingActions.size + systemCount > 1) {
                if (!this.collisions.has(keystr)) {
                    for (const action of bindingActions) {
                        changed.add(action);
                    }
                } else {
                    const old = this.collisions.get(keystr);
                    for (const action of symmetricDifference(
                        old ?? null,
                        bindingActions
                    )) {
                        changed.add(action);
                    }
                }
                this.collisions.set(keystr, bindingActions);
            } else {
                for (const action of bindingActions) {
                    changed.add(action);
                }
                this.collisions.delete(keystr);
            }
        }
        if (changed.size > 0) {
            for (const action of changed) {
                this.emit(`collisions-changed::${action}`);
            }
        }
    }
}

/**
 * Modal capture dialog, port of gnome-control-center's CcKeyboardShortcutEditor.
 */
class ShortcutEditorDialog extends Adw.Dialog {
    static {
        GObject.registerClass(
            {
                GTypeName: 'ShortcutEditorDialog',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/KeybindingsShortcutEditor.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'headerbar',
                    'cancel_button',
                    'set_button',
                    'stack',
                    'capture_page',
                    'result_page',
                    'capture_info_label',
                    'result_info_label',
                    'picture',
                    'shortcut_accel_label',
                    'conflict_label',
                ],
                Properties: {
                    keybinding: GObject.ParamSpec.object(
                        'keybinding',
                        'Keybinding',
                        'Keybinding being edited',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        Keybinding.$gtype
                    ),
                    keybindings: GObject.ParamSpec.object(
                        'keybindings',
                        'Keybindings',
                        'Keybindings model',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        KeybindingsModel.$gtype
                    ),
                    combo: GObject.ParamSpec.object(
                        'combo',
                        'Combo',
                        'Combo being edited, or null when adding',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        Combo.$gtype
                    ),
                },
            },
            this
        );
    }

    declare _headerbar: Adw.HeaderBar;
    declare _cancel_button: Gtk.Button;
    declare _set_button: Gtk.Button;
    declare _stack: Gtk.Stack;
    declare _capture_page: Adw.PreferencesPage;
    declare _result_page: Adw.PreferencesPage;
    declare _capture_info_label: Gtk.Label;
    declare _result_info_label: Gtk.Label;
    declare _picture: Gtk.Picture;
    declare _shortcut_accel_label: Adw.ShortcutLabel;
    declare _conflict_label: Gtk.Label;

    declare keybinding: Keybinding;
    declare keybindings: KeybindingsModel;
    declare combo: Combo | null;

    declare _captured: Combo | null;
    declare _inhibited: boolean;

    constructor(props: Partial<ShortcutEditorDialog.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);
        this._captured = null;
        this._inhibited = false;

        this.title = _('Set Shortcut');
        const desc = GLib.markup_escape_text(this.keybinding.description, -1);
        const info = `${_('Enter new shortcut for')} <b>${desc}</b>`;
        this._capture_info_label.label = info;
        this._result_info_label.label = info;

        this._picture.set_resource(
            '/dev/0iq/albumwm/icons/enter-keyboard-shortcut.svg'
        );

        this.connect('map', () => this._inhibit());
        this.connect('unmap', () => this._restore());
        this.connect('closed', () => this._restore());
    }

    _inhibit() {
        if (this._inhibited) return;
        (
            this.get_root()?.get_surface() as Gdk.Toplevel | undefined
        )?.inhibit_system_shortcuts(null);
        this._inhibited = true;
    }

    _restore() {
        if (!this._inhibited) return;
        (
            this.get_root()?.get_surface() as Gdk.Toplevel | undefined
        )?.restore_system_shortcuts();
        this._inhibited = false;
    }

    _onKeyPressed(
        controller: Gtk.EventControllerKey,
        keyval: number,
        keycode: number,
        state: Gdk.ModifierType
    ) {
        // Only capture while the capture page is shown, so the result page's
        // Cancel/Set stay keyboard-navigable (Esc there closes via Adw.Dialog).
        if (this._stack.visible_child !== this._capture_page) {
            return Gdk.EVENT_PROPAGATE;
        }

        /**
         * Replace KEY_less ("<") with comma, see
         * https://github.com/paperwm/PaperWM/issues/545
         */
        if (keyval === Gdk.KEY_less) {
            keycode = Gdk.KEY_comma;
            keyval = Gdk.KEY_comma;
        }

        let modmask = state & Gtk.accelerator_get_default_mod_mask();
        let keyvalLower = Gdk.keyval_to_lower(keyval);

        // Normalize <Tab>
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }

        // Put Shift back if it changed the case of the key
        if (keyvalLower !== keyval) {
            modmask |= Gdk.ModifierType.SHIFT_MASK;
        }

        if (
            keyvalLower === Gdk.KEY_Sys_Req &&
            (modmask & Gdk.ModifierType.ALT_MASK) !== 0
        ) {
            // Don't allow SysRq as a keybinding, but allow Alt+Print
            keyvalLower = Gdk.KEY_Print;
        }

        const event = controller.get_current_event() as Gdk.KeyEvent | null;
        const isModifier = event?.is_modifier();

        // Escape cancels
        if (!isModifier && modmask === 0 && keyvalLower === Gdk.KEY_Escape) {
            this.close();
            return Gdk.EVENT_STOP;
        }

        // Remove CapsLock
        modmask &= ~Gdk.ModifierType.LOCK_MASK;

        const newCombo = new Combo({
            keycode,
            keyval: keyvalLower,
            mods: modmask,
        });

        if (!isModifier && isValidBinding(newCombo)) {
            this._captured = newCombo;
            this._showResult();
        }

        return Gdk.EVENT_STOP;
    }

    _showResult() {
        const captured = this._captured!;
        this._shortcut_accel_label.accelerator = captured.keystr;

        const quote = (s: string) => `“${GLib.markup_escape_text(s, -1)}”`;
        const names = [
            ...this.keybindings
                .findActionsUsing(captured.keystr, this.keybinding.action)
                .map(b => `${quote(b.description)} (AlbumWM)`),
            ...this.keybindings
                .findSystemConflicts(captured.keystr)
                .map(d => `${quote(d)} (GNOME)`),
        ];
        if (names.length > 0) {
            this._conflict_label.label = `<b>${_(
                'This key combination is already being used for'
            )} ${names.join(', ')}.</b>`;
            this._conflict_label.visible = true;
        } else {
            this._conflict_label.visible = false;
        }

        this._stack.visible_child = this._result_page;

        // The capture page carries only the close button; the action buttons
        // appear once there is a shortcut to commit.
        this._headerbar.show_end_title_buttons = false;
        this._cancel_button.visible = true;
        this._set_button.visible = true;
    }

    _onSetClicked() {
        const captured = this._captured;
        if (captured === null) return;

        if (this.combo !== null) {
            this.keybinding.replace(this.combo, captured);
        } else {
            this.keybinding.add(captured);
        }

        this.close();
    }

    _onCancelClicked() {
        this.close();
    }
}

declare namespace ShortcutEditorDialog {
    interface ConstructorProps extends Adw.Dialog.ConstructorProps {
        keybinding: Keybinding;
        keybindings: KeybindingsModel;
        combo: Combo | null;
    }
}

class ComboRow extends Adw.PreferencesRow {
    static {
        GObject.registerClass(
            {
                GTypeName: 'ComboRow',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/KeybindingsComboRow.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'shortcut_label',
                    'suffixes',
                    'delete_button',
                    'conflict_button',
                    'conflict_list',
                ],
                Properties: {
                    keybindings: GObject.ParamSpec.object(
                        'keybindings',
                        'Keybindings',
                        'Keybindings model',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        KeybindingsModel.$gtype
                    ),
                    keybinding: GObject.ParamSpec.object(
                        'keybinding',
                        'Keybinding',
                        'Keybinding',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        Keybinding.$gtype
                    ),
                    combo: GObject.ParamSpec.object(
                        'combo',
                        'Combo',
                        'Key combo',
                        GObject.ParamFlags.READWRITE,
                        Combo.$gtype
                    ),
                },
            },
            this
        );
    }

    declare _shortcut_label: Adw.ShortcutLabel;
    declare _suffixes: Gtk.Box;
    declare _delete_button: Gtk.Button;
    declare _conflict_button: Gtk.MenuButton;
    declare _conflict_list: Gtk.Box;

    declare _combo: Combo | null;
    declare _collisions: ConflictEntry[];

    declare keybindings: KeybindingsModel;
    declare keybinding: Keybinding;

    constructor(props: Partial<ComboRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);

        // Enter/Space on the focused row opens the editor.
        const keyController = Gtk.EventControllerKey.new();
        keyController.connect('key-pressed', (_controller, keyval) => {
            switch (keyval) {
                case Gdk.KEY_Return:
                case Gdk.KEY_KP_Enter:
                case Gdk.KEY_ISO_Enter:
                case Gdk.KEY_space:
                    this._openEditor();
                    return Gdk.EVENT_STOP;
                default:
                    return Gdk.EVENT_PROPAGATE;
            }
        });
        this.add_controller(keyController);

        // Click the row to open the editor.
        const clickGesture = Gtk.GestureClick.new();
        clickGesture.set_button(Gdk.BUTTON_PRIMARY);
        clickGesture.connect('released', (_gesture, _nPress, x, y) => {
            const target = this.pick(x, y, Gtk.PickFlags.DEFAULT);
            if (target && this._onButton(target)) return;
            this._openEditor();
        });
        this.add_controller(clickGesture);

        this._collisions = [];

        GLib.idle_add(0, () => {
            this._updateState();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Whether a picked widget belongs to one of the row's action buttons. */
    _onButton(target: Gtk.Widget) {
        return (
            target === this._delete_button ||
            target === this._conflict_button ||
            target.is_ancestor(this._delete_button) ||
            target.is_ancestor(this._conflict_button)
        );
    }

    get combo() {
        if (this._combo === undefined) this._combo = null;
        return this._combo;
    }

    set combo(value) {
        if (value && this._combo && this._combo.keystr === value.keystr) return;
        this._combo = value;
        this.notify('combo');
        this._updateState();
    }

    _openEditor() {
        new ShortcutEditorDialog({
            keybindings: this.keybindings,
            keybinding: this.keybinding,
            combo: this.combo,
        }).present(this);
    }

    get collisions() {
        return this._collisions;
    }

    set collisions(value) {
        this._collisions = value;

        let child = this._conflict_list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._conflict_list.remove(child);
            child = next;
        }
        for (const { description, source } of value) {
            const suffix = source === 'gnome' ? 'GNOME' : 'AlbumWM';
            this._conflict_list.append(
                new Gtk.Label({ label: `${description} (${suffix})` })
            );
        }
    }

    _onDeleteButtonClicked() {
        GLib.idle_add(0, () => {
            this.keybinding.remove(this.combo!);
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateState() {
        if (!this._shortcut_label) {
            return;
        }

        const active = !!this._combo && !this._combo.disabled;
        this._shortcut_label.accelerator = active ? this._combo!.keystr : '';
        this._delete_button.visible = active;
        this._conflict_button.visible = active && this.collisions.length > 0;
        this._suffixes.visible =
            this._delete_button.visible || this._conflict_button.visible;
    }
}

declare namespace ComboRow {
    interface ConstructorProps extends Gtk.ListBoxRow.ConstructorProps {
        keybindings: KeybindingsModel;
        keybinding: Keybinding;
        combo: Combo;
    }
}

class KeybindingsRow extends Adw.ExpanderRow {
    static {
        GObject.registerClass(
            {
                GTypeName: 'KeybindingsRow',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/KeybindingsRow.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'accel_revealer',
                    'accel_label',
                    'reset_revealer',
                    'add_button',
                ],
                Properties: {
                    keybindings: GObject.ParamSpec.object(
                        'keybindings',
                        'Keybindings',
                        'Keybindings model',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        KeybindingsModel.$gtype
                    ),
                    keybinding: GObject.ParamSpec.object(
                        'keybinding',
                        'Keybinding',
                        'Keybinding',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
                        Keybinding.$gtype
                    ),
                },
            },
            this
        );
    }

    declare _accel_revealer: Gtk.Revealer;
    declare _accel_label: Gtk.Label;
    declare _reset_revealer: Gtk.Revealer;
    declare _add_button: Adw.ButtonRow;

    declare keybindings: KeybindingsModel;
    declare keybinding: Keybinding;
    declare _expanded: boolean;
    declare _collisions: Map<string, ConflictEntry[]>;
    declare _comboRows: ComboRow[];

    declare _actionGroup: Gio.SimpleActionGroup;

    constructor(props: Partial<KeybindingsRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);
        this._actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('keybinding', this._actionGroup);

        let action;
        action = new Gio.SimpleAction({ name: 'reset' });
        action.connect('activate', () => this.keybinding.reset());
        this._actionGroup.add_action(action);

        action = new Gio.SimpleAction({ name: 'add' });
        action.connect('activate', () =>
            new ShortcutEditorDialog({
                keybindings: this.keybindings,
                keybinding: this.keybinding,
                combo: null,
            }).present(this)
        );
        this._actionGroup.add_action(action);

        this.set_title(this.keybinding.description);

        this.keybinding.connect('notify::label', () => this._updateState());
        this.connect('notify::expanded', () => this._updateState());

        this._comboRows = [];
        this.keybinding.connect(
            'items-changed',
            (_model, position, removed, added) =>
                this._syncCombos(position, removed, added)
        );
        this._syncCombos(0, 0, this.keybinding.get_n_items());

        this.keybindings.connect(
            `collisions-changed::${this.keybinding.action}`,
            () => {
                this._onCollisionsChanged();
            }
        );

        this._updateState();
    }

    get collisions() {
        if (this._collisions === undefined) {
            this._collisions = new Map();
        }
        return this._collisions;
    }

    _createRow(combo: Combo) {
        const row = new ComboRow({
            keybindings: this.keybindings,
            keybinding: this.keybinding,
            combo,
        });
        return row;
    }

    /**
     * Keep our combo rows in sync with the keybinding model.
     * Mirrors Gtk.ListBox.bind_model behavior (Adw.ExpanderRow's internal
     * Gtk.ListBox is private). There's also no insert at position, so re-append
     * the 'Add Shortcut' button on each insertion.
     */
    _syncCombos(position: number, removed: number, added: number) {
        const combos = this.keybinding.combos;
        const overlap = Math.min(removed, added);

        // Updating combo refreshes the row in place, so reuse the overlap.
        for (let i = 0; i < overlap; i++) {
            this._comboRows[position + i].combo = combos.get_item(
                position + i
            )!;
        }

        if (removed > added) {
            const surplus = this._comboRows.splice(
                position + added,
                removed - added
            );
            for (const row of surplus) this.remove(row);
        } else if (added > removed) {
            // Detach the trailing rows and the button, append the new rows,
            // then restore the tail so the button stays last.
            const tail = this._comboRows.splice(position + removed);
            for (const row of tail) this.remove(row);
            this.remove(this._add_button);

            for (let i = overlap; i < added; i++) {
                const row = this._createRow(combos.get_item(position + i)!);
                this._comboRows.push(row);
                this.add_row(row);
            }
            for (const row of tail) {
                this._comboRows.push(row);
                this.add_row(row);
            }
            this.add_row(this._add_button);
        }

        this._applyCollisions();
    }

    _applyCollisions() {
        for (const row of this._comboRows) {
            row.collisions = this.collisions.get(row.combo!.keystr) || [];
        }
    }

    _onCollisionsChanged() {
        const map = new Map<string, ConflictEntry[]>();
        const collisions = this.keybindings.collisions;
        for (const combo of this.keybinding.combos) {
            if (combo.disabled) continue;
            const entries: ConflictEntry[] = [
                ...[...(collisions.get(combo.keystr) ?? [])]
                    .filter(a => a !== this.keybinding.action)
                    .map(a => ({
                        description:
                            this.keybindings.getKeybinding(a)!.description,
                        source: 'albumwm' as const,
                    })),
                ...this.keybindings
                    .findSystemConflicts(combo.keystr)
                    .map(description => ({
                        description,
                        source: 'gnome' as const,
                    })),
            ];
            if (entries.length > 0) map.set(combo.keystr, entries);
        }
        this._collisions = map;
        this._applyCollisions();
        this._updateState();
    }

    _updateState() {
        GLib.idle_add(0, () => {
            this._accel_label.label = this.keybinding.label;
            if (this.collisions.size > 0) {
                this._accel_label.add_css_class('error');
            } else {
                this._accel_label.remove_css_class('error');
            }
            this._accel_revealer.reveal_child = !this.expanded;
            this._reset_revealer.reveal_child =
                this.keybinding.modified && !this.expanded;
            return GLib.SOURCE_REMOVE;
        });
    }
}

declare namespace KeybindingsRow {
    interface ConstructorProps extends Gtk.ListBoxRow.ConstructorProps {
        keybindings: KeybindingsModel;
        keybinding: Keybinding;
    }
}

export class KeybindingsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(
            {
                GTypeName: 'KeybindingsPage',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/KeybindingsPage.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'keybindings_windows_group',
                    'keybindings_monitors_group',
                    'keybindings_floating_group',
                ],
            },
            this
        );
    }
    declare _keybindings_windows_group: Adw.PreferencesGroup;
    declare _keybindings_monitors_group: Adw.PreferencesGroup;
    declare _keybindings_floating_group: Adw.PreferencesGroup;

    declare acceleratorParse: AcceleratorParse;
    declare _settings: Gio.Settings;
    declare _model: KeybindingsModel;
    declare _windowsView: Gtk.FilterListModel;
    declare _monitorsView: Gtk.FilterListModel;
    declare _floatingView: Gtk.FilterListModel;
    declare _expandedRow: KeybindingsRow | null;

    init(extension: ExtensionPreferences) {
        this._settings = extension.getSettings(KEYBINDINGS_KEY);
        this.acceleratorParse = new AcceleratorParse();
        this._model = new KeybindingsModel(this.acceleratorParse);

        this._windowsView = sectionView(this._model, 'windows');
        this._monitorsView = sectionView(this._model, 'monitors');
        this._floatingView = sectionView(this._model, 'floating');

        this._keybindings_windows_group.bind_model(
            this._windowsView,
            keybinding => this._createRow(keybinding as Keybinding)
        );
        this._keybindings_monitors_group.bind_model(
            this._monitorsView,
            keybinding => this._createRow(keybinding as Keybinding)
        );
        this._keybindings_floating_group.bind_model(
            this._floatingView,
            keybinding => this._createRow(keybinding as Keybinding)
        );

        this._expandedRow = null;

        // send settings to model (which processes and creates rows)
        this._model.init(this._settings);
    }

    _createRow(keybinding: Keybinding) {
        const row = new KeybindingsRow({
            keybindings: this._model,
            keybinding,
        });
        row.connect('notify::expanded', () => this._onRowExpanded(row));
        return row;
    }

    _onRowExpanded(row: KeybindingsRow) {
        if (row.expanded) {
            if (this._expandedRow) this._expandedRow.expanded = false;
            this._expandedRow = row;
        } else if (this._expandedRow === row) {
            this._expandedRow = null;
        }
    }
}

function sectionView(model: KeybindingsModel, section: keyof typeof actions) {
    const filter = Gtk.CustomFilter.new(
        keybinding => (keybinding as Keybinding).section === section
    );
    return Gtk.FilterListModel.new(model, filter);
}

let _aboveTabKeyvals: number[] | null = null;

function aboveTabKeyvals() {
    if (!_aboveTabKeyvals) {
        const keycode = 0x29 + 8; // KEY_GRAVE
        const display = Gdk.Display.get_default();
        const [, , keyvals] = display!.map_keycode(keycode);
        _aboveTabKeyvals = keyvals;
    }
    return _aboveTabKeyvals;
}

function translateAboveTab(keystr: string) {
    if (!keystr.match(/Above_Tab/)) {
        return keystr;
    }
    const keyvals = aboveTabKeyvals();
    if (!keyvals) return keystr.replace('Above_Tab', 'grave');

    const keyname = Gdk.keyval_name(keyvals[0]);
    return keystr.replace('Above_Tab', keyname!);
}

function symmetricDifference<T>(
    setA: Iterable<T> | null,
    setB: Iterable<T>
): Set<T> {
    const difference = new Set(setA);
    for (const elem of setB) {
        if (difference.has(elem)) {
            difference.delete(elem);
        } else {
            difference.add(elem);
        }
    }
    return difference;
}
