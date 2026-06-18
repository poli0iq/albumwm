import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

/** Known GNOME Settings panels. */
export type Panel = 'keyboard';

/**
 * Opens GNOME Settings on the given panel via its D-Bus activation interface,
 * reusing a running instance when there is one.
 */
export function openPanel(panel: Panel) {
    Gio.DBus.session.call(
        'org.gnome.Settings',
        '/org/gnome/Settings',
        'org.freedesktop.Application',
        'ActivateAction',
        new GLib.Variant('(sava{sv})', [
            'launch-panel',
            [new GLib.Variant('(sav)', [panel, []])],
            {},
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        null
    );
}
