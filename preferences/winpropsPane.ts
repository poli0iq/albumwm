import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import type { WinPropSpec } from '../wm/settings.js';

export class WinpropsRow extends Gtk.ListBoxRow {
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
                    'header',
                    'descLabel',
                    'accelLabel',
                    'revealer',
                    'optionList',
                    'wmClass',
                    'title',
                    'scratchLayer',
                    'preferredWidth',
                    'space',
                    'focus',
                    'deleteButton',
                ],
                Properties: {
                    winprop: GObject.ParamSpec.jsobject(
                        'winprop',
                        'winprop',
                        'Winprop',
                        GObject.ParamFlags.READWRITE |
                            GObject.ParamFlags.CONSTRUCT_ONLY
                    ),
                    expanded: GObject.ParamSpec.boolean(
                        'expanded',
                        'Expanded',
                        'Expanded',
                        GObject.ParamFlags.READWRITE,
                        false
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

    declare _wmClass: Gtk.Entry;
    declare _title: Gtk.Entry;
    declare _scratchLayer: Gtk.Switch;
    declare _preferredWidth: Gtk.Entry;
    declare _space: Gtk.ComboBoxText;
    declare _focus: Gtk.Switch;

    declare _descLabel: Gtk.Label;
    declare _accelLabel: Gtk.Label;
    declare _revealer: Gtk.Revealer;

    _expanded: boolean = false;

    constructor(props: Partial<WinpropsRow.ConstructorProps>) {
        super(props);
    }

    _init(params = {}) {
        super._init(params);

        // description label
        this._setDescLabel();

        // set the values to current state and connect to 'changed' signal
        this._wmClass.set_text(this.winprop.wm_class ?? '');
        this._wmClass.connect('changed', () => {
            // check if null or empty (we still emit changed if wm_class is wiped)
            this.checkHasWmClassOrTitle();
            this.winprop.wm_class = this._wmClass.get_text();
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

        this._scratchLayer.set_active(this.winprop.scratch_layer ?? false);
        this._scratchLayer.connect('state-set', () => {
            const isActive = this._scratchLayer.get_active();
            this.winprop.scratch_layer = isActive;

            // if is active then disable the preferredWidth input
            this._preferredWidth.set_sensitive(!isActive);

            this.emit('changed');
        });

        this._preferredWidth.set_text(this.winprop.preferredWidth ?? '');
        // if scratchLayer is active then users can't edit preferredWidth
        this._preferredWidth.set_sensitive(
            !(this.winprop.scratch_layer ?? false)
        );

        this._preferredWidth.connect('changed', () => {
            // if has value, needs to be valid (have a value or unit)
            if (this._preferredWidth.get_text()) {
                const value = this._preferredWidth.get_text();
                const digits = (value.match(/\d+/) ?? [null])[0];
                const isPercent = /^.*%$/.test(value);
                const isPixel = /^.*px$/.test(value);

                // check had valid number
                if (!digits) {
                    this._setError(this._preferredWidth);
                }
                // if no unit defined
                else if (!isPercent && !isPixel) {
                    this._setError(this._preferredWidth);
                } else {
                    this._setError(this._preferredWidth, false);
                    this.winprop.preferredWidth =
                        this._preferredWidth.get_text();
                    this.emit('changed');
                }
            } else {
                // having no preferredWidth is valid
                this._setError(this._preferredWidth, false);
                delete this.winprop.preferredWidth;
                this.emit('changed');
            }
        });

        this._space.append_text('CURRENT');
        for (let i = 0; i < 16; i++) {
            this._space.append_text(`Workspace ${i + 1}`);
        }
        // index 0 is CURRENT, so add 1
        this._space.set_active((this.winprop.spaceIndex ?? -1) + 1);
        this._space.connect('changed', () => {
            let value: number | undefined = this._space.get_active() - 1;
            if (value < 0) {
                value = undefined;
            }
            this.winprop.spaceIndex = value;
            this.emit('changed');
        });

        this._focus.set_active(this.winprop.focus ?? true);
        this._focus.connect('state-set', () => {
            const isActive = this._focus.get_active();
            this.winprop.focus = isActive;
            this.emit('changed');
        });

        this._updateState();
    }

    /**
     * Checks has an input for either wmClass or title.
     * Sets 'error' cssClass is neither.
     */
    checkHasWmClassOrTitle() {
        if (!this._wmClass.get_text() && !this._title.get_text()) {
            this._setError(this._wmClass);
            this._setError(this._title);
            return false;
        } else {
            this._setError(this._wmClass, false);
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

    get expanded() {
        return this._expanded;
    }

    set expanded(value) {
        if (this._expanded === value) return;

        this._expanded = value;
        this.notify('expanded');
        this._updateState();
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
            this._descLabel.label = this.winprop.wm_class;
        } else if (this.winprop.title) {
            this._descLabel.label = this.winprop.title;
        }
    }

    _updateState() {
        GLib.idle_add(0, () => {
            this._accelLabel.label = this._setAccelLabel();
            if (this.expanded) {
                this._accelLabel.hide();
                this._revealer.reveal_child = true;
                this.add_css_class('expanded');
            } else {
                this._accelLabel.show();
                this._revealer.reveal_child = false;
                this.remove_css_class('expanded');
            }

            return GLib.SOURCE_REMOVE;
        });
    }
}

export declare namespace WinpropsRow {
    interface ConstructorProps extends Gtk.ListBoxRow.ConstructorProps {
        winprop: WinPropSpec;
    }
}

export class WinpropsPane extends Gtk.Box {
    static {
        GObject.registerClass(
            {
                GTypeName: 'WinpropsPane',
                Template: GLib.uri_resolve_relative(
                    import.meta.url,
                    '../ui/WinpropsPane.ui',
                    GLib.UriFlags.NONE
                ),
                InternalChildren: [
                    'search',
                    'listbox',
                    'addButton',
                    'scrolledWindow',
                ],
                Signals: {
                    changed: {},
                },
            },
            this
        );
    }

    declare rows: WinpropsRow[];
    declare _expandedRow: WinpropsRow | null;

    declare _search: Gtk.SearchEntry;
    declare _scrolledWindow: Gtk.ScrolledWindow;
    declare _listbox: Gtk.ListBox;

    _init(params = {}) {
        super._init(params);

        // define search box filter function (searches wm_class, title, and accelLabel)
        this._listbox.set_filter_func((row: Gtk.ListBoxRow): boolean => {
            const r = row as WinpropsRow;
            const search = this._search.get_text().toLowerCase();
            const wmclass = r.winprop.wm_class?.toLowerCase() ?? '';
            const title = r.winprop.title?.toLowerCase() ?? '';
            const accelLabel = r._accelLabel.label?.toLowerCase() ?? '';
            return (
                wmclass.includes(search) ||
                title.includes(search) ||
                accelLabel.includes(search)
            );
        });
        this._search.connect('changed', () => {
            this._listbox.invalidate_filter();
        });

        this._expandedRow = null;
        this.rows = [];
    }

    addWinprops(winprops: WinPropSpec[]) {
        winprops.forEach(winprop => {
            this._listbox.insert(this._createRow(winprop), -1);
        });
    }

    _removeRow(row: WinpropsRow) {
        this._listbox.remove(row);
        const remove = this.rows.findIndex(r => r === row);
        if (remove >= 0) {
            this.rows.splice(remove, 1);
        }
        this.emit('changed');
    }

    _onAddButtonClicked() {
        // first clear search text, otherwise won't be able to see new row
        this._search.set_text('');

        const row = this._createRow();
        row.expanded = true;
        this._listbox.insert(row, 0);
        this._scrolledWindow.get_vadjustment().set_value(0);
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

    _onRowActivated(_list: Gtk.ListBox, row: WinpropsRow) {
        if (!row.is_focus()) {
            return;
        }
        row.expanded = !row.expanded;
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
