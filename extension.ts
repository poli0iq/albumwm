import {
    Utils,
    Settings,
    Gestures,
    Keybindings,
    LiveAltTab,
    Navigator,
    Stackoverlay,
    Scratch,
    Tiling,
    Topbar,
    Patches,
    Grab,
} from './wm/imports.js';

import Gio from 'gi://Gio?version=2.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/**
   The currently used modules
     - tiling is the main module, responsible for tiling and workspaces

     - navigator is used to initiate a discrete navigation.
       Focus is only switched when the navigation is done.

     - keybindings is a utility wrapper around mutters keybinding facilities.

     - scratch is used to manage floating windows, or scratch windows.

     - liveAltTab is a simple altTab implementiation with live previews.

     - stackoverlay is somewhat kludgy. It makes clicking on the left or right
       edge of the screen always activate the partially (or sometimes wholly)
       concealed window at the edges.

     - Patches is used for monkey patching gnome shell behavior which simply
       doesn't fit albumwm.

     - topbar adds the workspace name to the topbar and styles it.

     - gestures is responsible for 3-finger swiping.

     Notes of ordering:
        - several modules import settings, so settings should be before them;
          - settings.js should not depend on other albumwm modules;
        - Settings should be before Patches (for reverse order disable);
 */

export default class AlbumWM extends Extension {
    modules = [
        Utils,
        Settings,
        Patches,
        Gestures,
        Keybindings,
        LiveAltTab,
        Navigator,
        Stackoverlay,
        Scratch,
        Tiling,
        Topbar,
        Grab,
    ];

    _resource: Gio.Resource | null = null;

    enable() {
        console.log(`#AlbumWM enabled`);
        this._resource = Gio.Resource.load(`${this.path}/albumwm.gresource`);
        Gio.resources_register(this._resource);
        this.modules.forEach(m => {
            if (m['enable']) {
                m.enable(this);
            }
        });
    }

    disable() {
        console.log('#AlbumWM disabled');
        this.prepareForDisable();
        [...this.modules].reverse().forEach(m => {
            if (m['disable']) {
                m.disable();
            }
        });
        Gio.resources_unregister(this._resource!);
        this._resource = null;
    }

    prepareForDisable() {
        // Finishing navigation here avoids leaving AlbumWM in a broken state
        // if disable hits mid-navigation (e.g. workspace switch view).
        Navigator.finishNavigation();
    }
}
