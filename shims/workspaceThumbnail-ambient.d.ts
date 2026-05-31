/* @girs/gnome-shell ships no workspaceThumbnail.d.ts.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/workspaceThumbnail.js */

declare module 'resource:///org/gnome/shell/ui/workspaceThumbnail.js' {
    export class ThumbnailsBox {
        _shouldShow: boolean;
        _updateShouldShow(): void;
        notify(prop: string): void;
    }
}
