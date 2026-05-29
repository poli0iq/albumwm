/* @girs/gnome-shell's WindowPreview omits the JS-side members overviewlayout.ts
 * reads off each preview.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/windowPreview.js */

import type Meta from '@girs/meta-18';

declare module 'resource:///org/gnome/shell/ui/windowPreview.js' {
    interface WindowPreview {
        metaWindow: Meta.Window;
        readonly boundingBox: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    }
}
