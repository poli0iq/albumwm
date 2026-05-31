/* @girs/gnome-shell ships no screenshot.d.ts.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/screenshot.js */

declare module 'resource:///org/gnome/shell/ui/screenshot.js' {
    export class ScreenshotUI {
        open(mode: number): Promise<void>;
        close(instantly?: boolean): void;
    }
}
