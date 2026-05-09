import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { Tiling } from './imports.js';

/*
  Application functionality, like global new window actions etc.
 */

let Tracker = Shell.WindowTracker.get_default();

/* Per-app handlers for "duplicate this window". Keyed by desktop file id. */
export let customHandlers;

export function enable() {
    customHandlers = { 'org.gnome.Terminal.desktop': newGnomeTerminal };
}

export function disable() {
    customHandlers = null;
}

export function newGnomeTerminal(metaWindow, app) {
    /* This action activation is _not_ bound to the window: it relies on the
       window being active when called. If the new window doesn't start in the
       same directory it's probably because 'vte.sh' hasn't been sourced. */
    app.action_group.activate_action(
        'win.new-terminal',
        new GLib.Variant('(ss)', ['window', 'current'])
    );
}

export function duplicateWindow(metaWindow) {
    metaWindow = metaWindow || global.display.focus_window;
    let app = Tracker.get_window_app(metaWindow);

    let handler = customHandlers[app.id];
    if (handler) {
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        return handler(metaWindow, app, space);
    }

    app.open_new_window(metaWindow.get_workspace().workspace_index);
    return true;
}
