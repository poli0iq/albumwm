/* @girs/gnome-shell is missing some declarations (or names them incorrectly,
 * e.g. _itemEnteredHandler misses the underscore) */

export {};

declare module 'resource:///org/gnome/shell/ui/switcherPopup.js' {
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/switcherPopup.js?ref_type=tags#L47
    interface SwitcherPopup {
        _switcherList: {
            windows: Meta.Window[];
            highlight(n: number): void;
        };
        _selectedIndex: number;

        _itemEnteredHandler(n: number): void;
        _itemRemovedHandler(n: number): void;
    }
}
