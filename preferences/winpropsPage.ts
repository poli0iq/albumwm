import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import type { WinPropSpec } from '../wm/settings.js';

const _ = (s: string) => s;

export class WinpropsRow extends Adw.ExpanderRow {
    static {
        GObject.registerClass(
            {
                GTypeName: 'WinpropsRow',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/WinpropsRow.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'accel_revealer',
                    'accel_label',
                    'wm_class',
                    'title',
                    'scratch_layer',
                    'preferred_width',
                    'space',
                    'focus',
                    'delete_button',
                ],
                Properties: {
                    winprop: GObject.ParamSpec.jsobject(
                        'winprop',
                        'winprop',
                        'Winprop',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY
                    ),
                },
                Signals: {
                    changed: {},
                    'row-deleted': {},
                },
            },
            this
        );
    }

    declare winprop: WinPropSpec;

    declare _accel_revealer: Gtk.Revealer;
    declare _accel_label: Gtk.Label;
    declare _wm_class: Adw.EntryRow;
    declare _title: Adw.EntryRow;
    declare _scratch_layer: Adw.SwitchRow;
    declare _preferred_width: Adw.EntryRow;
    declare _space: Adw.ComboRow;
    declare _focus: Adw.SwitchRow;

    constructor(props: Partial<WinpropsRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);

        // description label
        this._setDescLabel();

        // set the values to current state and connect to 'changed' signal
        this._wm_class.set_text(this.winprop.wm_class ?? '');
        this._wm_class.connect('changed', () => {
            // check if null or empty (we still emit changed if wm_class is wiped)
            this.checkHasWmClassOrTitle();
            this.winprop.wm_class = this._wm_class.get_text();
            this._setDescLabel();
            this.emit('changed');
        });

        this._title.set_text(this.winprop.title ?? '');
        this._title.connect('changed', () => {
            this.checkHasWmClassOrTitle();
            this.winprop.title = this._title.get_text();
            this._setDescLabel();
            this.emit('changed');
        });

        this._scratch_layer.set_active(this.winprop.scratch_layer ?? false);
        this._scratch_layer.connect('notify::active', () => {
            const isActive = this._scratch_layer.get_active();
            this.winprop.scratch_layer = isActive;

            // if is active then disable the preferredWidth input
            this._preferred_width.set_sensitive(!isActive);

            this.emit('changed');
        });

        this._preferred_width.set_text(this.winprop.preferredWidth ?? '');
        // if scratchLayer is active then users can't edit preferredWidth
        this._preferred_width.set_sensitive(
            !(this.winprop.scratch_layer ?? false)
        );

        this._preferred_width.connect('changed', () => {
            // if has value, needs to be valid (have a value or unit)
            if (this._preferred_width.get_text()) {
                const value = this._preferred_width.get_text();
                const digits = (value.match(/\d+/) ?? [null])[0];
                const isPercent = /^.*%$/.test(value);
                const isPixel = /^.*px$/.test(value);

                // check had valid number
                if (!digits) {
                    this._setError(this._preferred_width);
                }
                // if no unit defined
                else if (!isPercent && !isPixel) {
                    this._setError(this._preferred_width);
                } else {
                    this._setError(this._preferred_width, false);
                    this.winprop.preferredWidth =
                        this._preferred_width.get_text();
                    this.emit('changed');
                }
            } else {
                // having no preferredWidth is valid
                this._setError(this._preferred_width, false);
                delete this.winprop.preferredWidth;
                this.emit('changed');
            }
        });

        const workspaceList = new Gtk.StringList();
        workspaceList.append('Currently active');
        for (let i = 0; i < 16; i++) {
            workspaceList.append(`Workspace ${i + 1}`);
        }
        this._space.set_model(workspaceList);
        // index 0 is CURRENT, so add 1
        this._space.set_selected((this.winprop.spaceIndex ?? -1) + 1);
        this._space.connect('notify::selected', () => {
            let value: number | undefined = this._space.get_selected() - 1;
            if (value < 0) {
                value = undefined;
            }
            this.winprop.spaceIndex = value;
            this.emit('changed');
        });

        this._focus.set_active(this.winprop.focus ?? true);
        this._focus.connect('notify::active', () => {
            const isActive = this._focus.get_active();
            this.winprop.focus = isActive;
            this.emit('changed');
        });

        this.connect('notify::expanded', this._updateState.bind(this));
        this._updateState();
    }

    /**
     * Checks has an input for either wm_class or title.
     * Sets 'error' cssClass is neither.
     */
    checkHasWmClassOrTitle() {
        if (!this._wm_class.get_text() && !this._title.get_text()) {
            this._setError(this._wm_class);
            this._setError(this._title);
            return false;
        } else {
            this._setError(this._wm_class, false);
            this._setError(this._title, false);
            return true;
        }
    }

    /**
     * Get the wmClass if it exists, otherwise returns the title.
     */
    getWmClassOrTitle() {
        if (this.winprop.wm_class) {
            return this.winprop.wm_class;
        } else if (this.winprop.title) {
            return this.winprop.title;
        } else {
            return '';
        }
    }

    _setError(child: Gtk.Widget, option = true) {
        if (option) {
            child.add_css_class('error');
        } else {
            child.remove_css_class('error');
        }
    }

    _onDeleteButtonClicked() {
        this.emit('row-deleted');
    }

    _setAccelLabel() {
        if (this.winprop.scratch_layer ?? false) {
            return 'scratch layer';
        } else if (this.winprop.preferredWidth ?? false) {
            return 'preferred width';
        } else if (this.winprop.spaceIndex !== undefined) {
            return 'workspace';
        } else {
            return 'no setting';
        }
    }

    /**
     * Sets the description label for this row.
     */
    _setDescLabel() {
        // if wmClass, use that, otherwise use title (fallback)
        if (this.winprop.wm_class) {
            this.set_title(this.winprop.wm_class);
        } else if (this.winprop.title) {
            this.set_title(this.winprop.title);
        } else {
            this.set_title(_('New window property'));
        }
    }

    _updateState() {
        this._accel_label.label = this._setAccelLabel();
        this._accel_revealer.set_reveal_child(!this.expanded);
    }
}

export declare namespace WinpropsRow {
    interface ConstructorProps extends Adw.ExpanderRow.ConstructorProps {
        winprop: WinPropSpec;
    }
}

export class WinpropsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(
            {
                GTypeName: 'WinpropsPage',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/WinpropsPage.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: ['winprops', 'add_button'],
                Signals: {
                    changed: {},
                },
            },
            this
        );
    }

    declare _winprops: Adw.PreferencesGroup;

    declare rows: WinpropsRow[];
    declare _expandedRow: WinpropsRow | null;

    _init(params = {}) {
        super._init(params);

        this._expandedRow = null;
        this.rows = [];
    }

    addWinprops(winprops: WinPropSpec[]) {
        winprops.forEach(winprop => {
            this._winprops.add(this._createRow(winprop));
        });
    }

    _removeRow(row: WinpropsRow) {
        this._winprops.remove(row);
        const remove = this.rows.findIndex(r => r === row);
        if (remove >= 0) {
            this.rows.splice(remove, 1);
        }
        this.emit('changed');
    }

    _onAddButtonClicked() {
        const row = this._createRow();
        row.expanded = true;
        this._winprops.add(row);
    }

    _createRow(winprop?: WinPropSpec) {
        const wp = winprop ?? { wm_class: '' };
        const row = new WinpropsRow({ winprop: wp });
        this.rows.push(row);
        row.connect('notify::expanded', () => this._onRowExpanded(row));
        row.connect('row-deleted', () => this._removeRow(row));
        row.connect('changed', () => this.emit('changed'));
        return row;
    }

    _onRowExpanded(row: WinpropsRow) {
        if (row.expanded) {
            if (this._expandedRow) {
                this._expandedRow.expanded = false;
            }
            this._expandedRow = row;
        } else if (this._expandedRow === row) {
            this._expandedRow = null;
        }
    }
}
