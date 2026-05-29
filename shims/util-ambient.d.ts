/* @girs/gnome-shell's util.js declaration is missing lerp.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/misc/util.js#L292 */

export {};

declare module 'resource:///org/gnome/shell/misc/util.js' {
    export function lerp(start: number, end: number, progress: number): number;
}
