/* @girs/gnome-shell types altTab.js but omits WindowIcon.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/altTab.js#L1002 */

import type Clutter from '@girs/clutter-18';
import type Meta from '@girs/meta-18';
import type Shell from '@girs/shell-18';
import type St from '@girs/st-18';

declare module 'resource:///org/gnome/shell/ui/altTab.js' {
    export class WindowIcon {
        _init(window: Meta.Window, mode: number): void;
        window: Meta.Window;
        app: Shell.App;
        _icon: St.Widget;
        _createAppIcon(app: Shell.App, size: number): Clutter.Actor;
    }
}
