/* https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowMenu.js
 * Upstream @girs/gnome-shell ships no windowMenu.d.ts; shim it locally.
 * Must remain a script file (no top-level imports) so `declare module`
 * registers a new ambient module instead of augmenting an existing one. */

declare module 'resource:///org/gnome/shell/ui/windowMenu.js' {
    import type Clutter from '@girs/clutter-18';
    import type Meta from '@girs/meta-18';
    import { PopupMenu } from 'resource:///org/gnome/shell/ui/popupMenu.js';

    export class WindowMenu extends PopupMenu {
        constructor(window: Meta.Window, sourceActor: Clutter.Actor);
        _buildMenu(window: Meta.Window): void;
    }

    export class WindowMenuManager {
        constructor();
        showWindowMenuForWindow(
            window: Meta.Window,
            type: Meta.WindowMenuType,
            rect: { x: number; y: number; width: number; height: number }
        ): void;
    }
}
