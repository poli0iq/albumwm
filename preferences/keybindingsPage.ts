import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { AcceleratorParse } from '../wm/acceleratorparse.js';

import type { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const _ = (s: string) => s;

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.albumwm.keybindings';

const sections = {
    windows: 'Windows',
    monitors: 'Monitors',
    scratch: 'Scratch layer',
};

const actions = {
    windows: [
        'close-window',
        'switch-next',
        'switch-previous',
        'switch-left',
        'switch-right',
        'switch-up',
        'switch-down',
        'switch-next-loop',
        'switch-previous-loop',
        'switch-left-loop',
        'switch-right-loop',
        'switch-up-loop',
        'switch-down-loop',
        'drift-left',
        'drift-right',
        'switch-global-left',
        'switch-global-right',
        'switch-global-up',
        'switch-global-down',
        'switch-first',
        'switch-second',
        'switch-third',
        'switch-fourth',
        'switch-fifth',
        'switch-sixth',
        'switch-seventh',
        'switch-eighth',
        'switch-ninth',
        'switch-tenth',
        'switch-eleventh',
        'switch-last',
        'live-alt-tab',
        'live-alt-tab-backward',
        'live-alt-tab-scratch',
        'live-alt-tab-scratch-backward',
        'switch-focus-mode',
        'switch-open-window-position',
        'open-window-position-right',
        'open-window-position-down',
        'move-left',
        'move-right',
        'move-up',
        'move-down',
        'slurp-in',
        'barf-out',
        'barf-out-active',
        'center-horizontally',
        'center-vertically',
        'center',
        'album-toggle-fullscreen',
        'toggle-maximize-width',
        'resize-h-inc',
        'resize-h-dec',
        'resize-w-inc',
        'resize-w-dec',
        'cycle-width',
        'cycle-width-backwards',
        'cycle-height',
        'cycle-height-backwards',
        'take-window',
        'activate-window-under-cursor',
    ],
    monitors: [
        'switch-monitor-right',
        'switch-monitor-left',
        'switch-monitor-above',
        'switch-monitor-below',
    ],
    scratch: [
        'toggle-scratch-layer',
        'toggle-scratch',
        'toggle-scratch-window',
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
                    placeholder: GObject.ParamSpec.boolean(
                        'placeholder',
                        'Placeholder',
                        'Placeholder sentinel',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY,
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
    declare placeholder: boolean;

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
        placeholder: boolean;
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

    declare section: keyof typeof sections;
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

    getKeybinding(action: string) {
        return this._actionToBinding.get(action);
    }

    find(binding: Keybinding) {
        return this._model.find(binding);
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
            if (bindingActions.size > 1) {
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

class ComboRow extends Gtk.ListBoxRow {
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
                    'stack',
                    'shortcutPage',
                    'placeholderPage',
                    'editPage',
                    'shortcutLabel',
                    'deleteButton',
                    'conflictButton',
                    'conflictList',
                ],
                Properties: {
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
                    editing: GObject.ParamSpec.boolean(
                        'editing',
                        'Editing',
                        'Editing',
                        GObject.ParamFlags.READWRITE,
                        false
                    ),
                },
                Signals: {
                    'collision-activated': {
                        param_types: [Keybinding.$gtype],
                    },
                },
            },
            this
        );
    }

    declare _stack: Gtk.Stack;
    declare _shortcutPage: Gtk.Box;
    declare _placeholderPage: Gtk.Label;
    declare _editPage: Gtk.Label;
    declare _shortcutLabel: Adw.ShortcutLabel;
    declare _deleteButton: Gtk.Button;
    declare _conflictButton: Gtk.MenuButton;
    declare _conflictList: Gtk.ListBox;

    declare _combo: Combo | null;
    declare _editing: boolean;
    declare _collisions: Gio.ListStore<Keybinding>;

    declare keybinding: Keybinding;
    declare acceleratorParse: AcceleratorParse;

    constructor(props: Partial<ComboRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);

        const keyController = Gtk.EventControllerKey.new();
        keyController.connect(
            'key-pressed',
            (controller, keyval, keycode, state) => {
                this._onKeyPressed(controller, keyval, keycode, state);
            }
        );
        this.add_controller(keyController);

        const focusController = Gtk.EventControllerFocus.new();
        focusController.connect('leave', () => {
            this.editing = false;
        });
        this.add_controller(focusController);

        this._collisions = new Gio.ListStore({ itemType: Keybinding.$gtype });

        this._conflictList.bind_model(this._collisions, (binding: Keybinding) =>
            this._createConflictRow(binding)
        );

        GLib.idle_add(0, () => {
            this._updateState();
            return GLib.SOURCE_REMOVE;
        });
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

    get editing() {
        if (this._editing === undefined) this._editing = false;
        return this._editing;
    }

    set editing(value) {
        if (this.editing === value) return;
        this._editing = value;
        this.notify('editing');
        this._updateState();
    }

    get collisions() {
        return [...this._collisions];
    }

    set collisions(value) {
        this._collisions.splice(0, this._collisions.get_n_items(), value);
    }

    _createConflictRow(binding: Keybinding) {
        return new Gtk.Label({
            label: binding.description,
        });
    }

    _onConflictRowActivated(_list: Gtk.ListBox, row: ComboRow) {
        const binding = this._collisions.get_item(row.get_index());
        this.emit('collision-activated', binding);
    }

    _grabKeyboard() {
        (
            this.get_root()?.get_surface() as Gdk.Toplevel | undefined
        )?.inhibit_system_shortcuts(null);
    }

    _ungrabKeyboard() {
        // using optionals here since may have already been ungrabbed
        (
            this.get_root()?.get_surface() as Gdk.Toplevel | undefined
        )?.restore_system_shortcuts();
    }

    _onDeleteButtonClicked() {
        GLib.idle_add(0, () => {
            this.keybinding.remove(this.combo!);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onKeyPressed(
        controller: Gtk.EventControllerKey,
        keyval: number,
        keycode: number,
        state: Gdk.ModifierType
    ) {
        // Adapted from Control Center, cc-keyboard-shortcut-editor.c
        if (!this.editing) return Gdk.EVENT_PROPAGATE;

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
            this.editing = false;
            if (this.combo!.placeholder) {
                this.keybinding.remove(this.combo!);
            }
            return Gdk.EVENT_STOP;
        }

        // Backspace deletes
        if (!isModifier && modmask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            this._updateKeybinding(new Combo());
            return Gdk.EVENT_STOP;
        }

        // Remove CapsLock
        modmask &= ~Gdk.ModifierType.LOCK_MASK;

        this._updateKeybinding(
            new Combo({
                keycode,
                keyval: keyvalLower,
                mods: modmask,
            })
        );

        return Gdk.EVENT_STOP;
    }

    _updateKeybinding(newCombo: Combo) {
        const isValid = isValidBinding(newCombo);
        const isEmpty = isEmptyBinding(newCombo);

        const oldCombo = this.combo!;
        if (isEmptyBinding(oldCombo) && isValid) {
            this.editing = false;
            this.keybinding.add(newCombo);
            return;
        }

        if (isEmpty) {
            this.editing = false;
            this.keybinding.remove(oldCombo);
            return;
        }

        if (isValid) {
            this.editing = false;
            this.keybinding.replace(oldCombo, newCombo);
        }
    }

    _updateState() {
        if (!this._stack) {
            return;
        }

        if (this.editing) {
            this.add_css_class('editing');
            this._stack.visible_child = this._editPage;
            this.grab_focus();
            this._grabKeyboard();
        } else {
            this.remove_css_class('editing');
            this._stack.visible_child = this._shortcutPage;
            this._ungrabKeyboard();

            if (this._combo && !this._combo.disabled) {
                this._shortcutLabel.accelerator = this._combo.keystr;
                this._deleteButton.visible = true;
                this._conflictButton.visible = this.collisions.length > 0;
            } else {
                this._shortcutLabel.accelerator = '';
                this._deleteButton.visible = false;
            }
        }
    }
}

declare namespace ComboRow {
    interface ConstructorProps extends Gtk.ListBoxRow.ConstructorProps {
        keybinding: Keybinding;
        combo: Combo;
    }
}

class KeybindingsRow extends Gtk.ListBoxRow {
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
                    'header',
                    'descLabel',
                    'accelLabel',
                    'conflictIcon',
                    'revealer',
                    'comboList',
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
                    expanded: GObject.ParamSpec.boolean(
                        'expanded',
                        'Expanded',
                        'Expanded',
                        GObject.ParamFlags.READWRITE,
                        false
                    ),
                    collisions: GObject.ParamSpec.jsobject(
                        'collisions',
                        'Collisions',
                        'Colliding keybindings',
                        GObject.ParamFlags.READABLE
                    ),
                },
                Signals: {
                    'collision-activated': {
                        param_types: [Keybinding.$gtype],
                    },
                },
            },
            this
        );
    }

    declare _header: Gtk.Box;
    declare _descLabel: Gtk.Label;
    declare _accelLabel: Gtk.Label;
    declare _conflictIcon: Gtk.Image;
    declare _revealer: Gtk.Revealer;
    declare _comboList: Gtk.ListBox;

    declare keybindings: KeybindingsModel;
    declare keybinding: Keybinding;
    declare _expanded: boolean;
    declare _collisions: Map<string, Keybinding[]>;

    declare _actionGroup: Gio.SimpleActionGroup;

    constructor(props: Partial<KeybindingsRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);
        this._actionGroup = new Gio.SimpleActionGroup();
        this.insert_action_group('keybinding', this._actionGroup);

        let action;
        action = new Gio.SimpleAction({
            name: 'reset',
            enabled: this.keybinding.modified,
        });
        action.connect('activate', () => this.keybinding.reset());
        this._actionGroup.add_action(action);

        action = new Gio.SimpleAction({ name: 'add' });
        action.connect('activate', () =>
            this.keybinding.add(new Combo({ placeholder: true }))
        );
        this._actionGroup.add_action(action);

        const gesture = Gtk.GestureClick.new();
        gesture.set_button(Gdk.BUTTON_PRIMARY);
        gesture.connect('released', controller => {
            this.expanded = !this.expanded;
            controller.set_state(Gtk.EventSequenceState.CLAIMED);
        });
        this._header.add_controller(gesture);

        this._descLabel.label = this.keybinding.description;
        this._descLabel.tooltip_text = this.keybinding.description;

        this.keybinding.connect('notify::label', () => this._updateState());

        this._comboList.bind_model(this.keybinding, combo =>
            this._createRow(combo)
        );

        this.keybindings.connect(
            `collisions-changed::${this.keybinding.action}`,
            () => {
                this._onCollisionsChanged();
            }
        );

        this._updateState();
    }

    get expanded() {
        if (this._expanded === undefined) this._expanded = false;
        return this._expanded;
    }

    set expanded(value) {
        if (this._expanded === value) return;

        this._expanded = value;
        this.notify('expanded');
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
            keybinding: this.keybinding,
            combo,
        });
        if (combo.placeholder) {
            GLib.idle_add(0, () => {
                row.editing = true;
                return GLib.SOURCE_REMOVE;
            });
        }
        this.connect('notify::collisions', () => {
            row.collisions = this.collisions.get(combo.keystr) || [];
        });
        row.connect('collision-activated', (_row, binding) => {
            this.emit('collision-activated', binding);
        });
        return row;
    }

    _onCollisionsChanged() {
        const map = new Map<string, Keybinding[]>();
        const collisions = this.keybindings.collisions;
        for (const combo of this.keybinding.combos) {
            const bindingActions = collisions.get(combo.keystr);
            if (!bindingActions) continue;
            map.set(
                combo.keystr,
                [...bindingActions]
                    .filter(a => a !== this.keybinding.action)
                    .map(a => this.keybindings.getKeybinding(a)!)
            );
        }
        this._collisions = map;
        this.notify('collisions');
        this._updateState();
    }

    _onRowActivated(_list: Gtk.ListBox, row: ComboRow) {
        if (row.is_focus()) {
            row.editing = !row.editing;
        }
    }

    _updateState() {
        GLib.idle_add(0, () => {
            this._accelLabel.label = this.keybinding.label;
            if (this.expanded) {
                this._accelLabel.hide();
                this._conflictIcon.visible = false;
                this._revealer.reveal_child = true;
                this.add_css_class('expanded');
            } else {
                this._accelLabel.show();
                this._conflictIcon.visible = this.collisions.size > 0;
                this._revealer.reveal_child = false;
                this.remove_css_class('expanded');
            }
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
                InternalChildren: ['listbox'],
            },
            this
        );
    }
    declare _listbox: Gtk.ListBox;

    declare acceleratorParse: AcceleratorParse;
    declare _settings: Gio.Settings;
    declare _model: KeybindingsModel;
    declare _expandedRow: KeybindingsRow | null;

    init(extension: ExtensionPreferences) {
        this._settings = extension.getSettings(KEYBINDINGS_KEY);
        this.acceleratorParse = new AcceleratorParse();
        this._model = new KeybindingsModel(this.acceleratorParse);

        this._listbox.bind_model(this._model, keybinding =>
            this._createRow(keybinding)
        );
        this._listbox.set_header_func((row, before) =>
            this._onSetHeader(
                row as KeybindingsRow,
                before as KeybindingsRow | null
            )
        );

        this._expandedRow = null;

        // send settings to model (which processes and creates rows)
        this._model.init(this._settings);
    }

    _createHeader(row: KeybindingsRow, before: KeybindingsRow | null) {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        if (before)
            box.append(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                })
            );
        box.append(
            new Gtk.Label({
                use_markup: true,
                label: `<b>${_(sections[row.keybinding.section])}</b>`,
                xalign: 0.0,
                halign: Gtk.Align.CENTER,
                margin_start: 12,
                margin_end: 12,
            })
        );
        box.append(
            new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL })
        );
        return box;
    }

    _createRow(keybinding: Keybinding) {
        const row = new KeybindingsRow({
            keybindings: this._model,
            keybinding,
        });
        row.connect('notify::expanded', () => this._onRowExpanded(row));
        row.connect('collision-activated', (_row, binding) =>
            this._onCollisionActivated(binding)
        );
        return row;
    }

    _onCollisionActivated(keybinding: Keybinding) {
        const [found, pos] = this._model.find(keybinding);
        if (found) {
            const row = this._listbox.get_row_at_index(pos)!;
            row.activate();
        }
    }

    _onRowActivated(_list: Gtk.ListBox, row: KeybindingsRow) {
        if (!row.is_focus()) return;
        row.expanded = !row.expanded;
    }

    _onRowExpanded(row: KeybindingsRow) {
        if (row.expanded) {
            if (this._expandedRow) this._expandedRow.expanded = false;
            this._expandedRow = row;
        } else if (this._expandedRow === row) {
            this._expandedRow = null;
        }
    }

    _onSetHeader(row: KeybindingsRow, before: KeybindingsRow | null) {
        const header = row.get_header();
        if (!before || before.keybinding.section !== row.keybinding.section) {
            if (!header || header instanceof Gtk.Separator) {
                row.set_header(this._createHeader(row, before));
            }
        } else if (!header || !(header instanceof Gtk.Separator)) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                })
            );
        }
    }
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
