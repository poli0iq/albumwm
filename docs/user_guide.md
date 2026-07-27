# AlbumWM User Guide

## Installation

See [README](../README.md#installation).

## Initial setup

Once installed and enabled,
the first thing that will meet you will be the shortcut conflict notifications.

They mean that GNOME already has some key combinations bound that AlbumWM also wants for itself.

You can apply the recommended settings that will both resolve these conflicts
and tweak related GNOME Shell behavior to better work with AlbumWM:

<details>
<summary>Manual</summary>

Run in shell:

```bash
### General tweaks

# Classic static workspaces, as in i3/sway.
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 10

# Focus follows mouse, but isn't lost when the mouse moves to empty space.
gsettings set org.gnome.desktop.wm.preferences focus-mode \'sloppy\'

# Not compatible with AlbumWM.
gsettings set org.gnome.desktop.wm.preferences edge-tiling false

# One workspace, but always visible.
gsettings set org.gnome.desktop.wm.preferences workspaces-only-on-primary false

# Not compatible with AlbumWM.
gsettings set org.gnome.mutter.keybindings toggle-tiled-left "[]"
gsettings set org.gnome.mutter.keybindings toggle-tiled-right "[]"

### Shortcut tweaks

# Super+{number} by default, which we need for workspaces.
gsettings set org.gnome.shell.keybindings switch-to-application-1 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-2 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-3 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-4 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-5 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-6 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-7 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-8 "['']"
gsettings set org.gnome.shell.keybindings switch-to-application-9 "['']"

# Workspaces shortcuts.
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-1 "['<Super>Home', '<Super>1']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-2 "['<Super>2']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-3 "['<Super>3']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-4 "['<Super>4']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-5 "['<Super>5']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-6 "['<Super>6']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-7 "['<Super>7']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-8 "['<Super>8']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-9 "['<Super>9']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-10 "['<Super>0']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-last "['<Super>End']"

gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-left "['<Super>i', '<Super>Page_Up', '<Super>KP_Prior', '<Super><Alt>Left', '<Control><Alt>Left']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-right "['<Super>u', '<Super>Page_Down', '<Super>KP_Next', '<Super><Alt>Right', '<Control><Alt>Right']"

gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-1 "['<Super><Shift>Home', '<Super><Shift>1']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-2 "['<Super><Shift>2']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-3 "['<Super><Shift>3']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-4 "['<Super><Shift>4']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-5 "['<Super><Shift>5']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-6 "['<Super><Shift>6']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-7 "['<Super><Shift>7']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-8 "['<Super><Shift>8']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-9 "['<Super><Shift>9']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-10 "['<Super><Shift>0']"
gsettings set org.gnome.desktop.wm.keybindings move-to-workspace-last "['<Super><Shift>End']"

gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-left "['<Super><Shift>i', '<Super><Shift>Page_Up', '<Super><Shift>KP_Prior', '<Super><Shift><Alt>Left', '<Control><Shift><Alt>Left']"
gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-right "['<Super><Shift>u', '<Super><Shift>Page_Down', '<Super><Shift>KP_Next', '<Super><Shift><Alt>Right', '<Control><Shift><Alt>Right']"

# Replaced by AlbumWM's move-window-to-monitor-{left,below,above,right}.
gsettings set org.gnome.desktop.wm.keybindings move-to-monitor-left "[]"
gsettings set org.gnome.desktop.wm.keybindings move-to-monitor-down "[]"
gsettings set org.gnome.desktop.wm.keybindings move-to-monitor-up "[]"
gsettings set org.gnome.desktop.wm.keybindings move-to-monitor-right "[]"

# Remaining conflicts.
gsettings set org.gnome.desktop.wm.keybindings minimize "['<Control><Alt><Super>h']"
gsettings set org.gnome.settings-daemon.plugins.media-keys screensaver "['<Control><Alt><Super>l']"
gsettings set org.gnome.settings-daemon.plugins.media-keys rotate-video-lock-static "[]"
```

</details>

<details>
<summary>Nix (Home Manager)</summary>

```nix
{ ... }:
{
  dconf.settings = {
    "org/gnome/mutter" = {
      # Classic static workspaces, as in i3/sway.
      dynamic-workspaces = false;
    };

    # Custom shortcut example.
    "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0" = {
      binding = "<Super>t";
      name = "Terminal";
      command = "ptyxis --new-window";
    };

    "org/gnome/settings-daemon/plugins/media-keys" = {
      # We have to list all the custom shortcuts here.
      custom-keybindings = [
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/"
      ];

      # Resolve conflicts.
      screensaver = [ "<Control><Alt><Super>l" ];
      rotate-video-lock-static = [ ];
    };

    "org/gnome/desktop/wm/preferences" = {
      num-workspaces = 10;

      # Focus follows mouse, but isn't lost when the mouse moves to empty space.
      focus-mode = "sloppy";

      # Not compatible with AlbumWM.
      edge-tiling = false;

      # One workspace, but always visible.
      workspaces-only-on-primary = false;
    };

    "org/gnome/mutter/keybindings" = {
      # Not compatible with AlbumWM.
      toggle-tiled-left = [ ];
      toggle-tiled-right = [ ];
    };

    "org/gnome/shell/keybindings" = {
      # Super+{number} by default, which we need for workspaces.
      switch-to-application-1 = [ "" ];
      switch-to-application-2 = [ "" ];
      switch-to-application-3 = [ "" ];
      switch-to-application-4 = [ "" ];
      switch-to-application-5 = [ "" ];
      switch-to-application-6 = [ "" ];
      switch-to-application-7 = [ "" ];
      switch-to-application-8 = [ "" ];
      switch-to-application-9 = [ "" ];
    };

    "org/gnome/desktop/wm/keybindings" = {
      switch-to-workspace-1 = [
        "<Super>Home"
        "<Super>1"
      ];
      switch-to-workspace-2 = [ "<Super>2" ];
      switch-to-workspace-3 = [ "<Super>3" ];
      switch-to-workspace-4 = [ "<Super>4" ];
      switch-to-workspace-5 = [ "<Super>5" ];
      switch-to-workspace-6 = [ "<Super>6" ];
      switch-to-workspace-7 = [ "<Super>7" ];
      switch-to-workspace-8 = [ "<Super>8" ];
      switch-to-workspace-9 = [ "<Super>9" ];
      switch-to-workspace-10 = [ "<Super>0" ];
      switch-to-workspace-last = [ "<Super>End" ];

      switch-to-workspace-left = [
        "<Super>i"

        "<Super>Page_Up"
        "<Super>KP_Prior"
        "<Super><Alt>Left"
        "<Control><Alt>Left"
      ];
      switch-to-workspace-right = [
        "<Super>u"

        "<Super>Page_Down"
        "<Super>KP_Next"
        "<Super><Alt>Right"
        "<Control><Alt>Right"
      ];

      move-to-workspace-1 = [
        "<Super><Shift>Home"
        "<Super><Shift>1"
      ];
      move-to-workspace-2 = [ "<Super><Shift>2" ];
      move-to-workspace-3 = [ "<Super><Shift>3" ];
      move-to-workspace-4 = [ "<Super><Shift>4" ];
      move-to-workspace-5 = [ "<Super><Shift>5" ];
      move-to-workspace-6 = [ "<Super><Shift>6" ];
      move-to-workspace-7 = [ "<Super><Shift>7" ];
      move-to-workspace-8 = [ "<Super><Shift>8" ];
      move-to-workspace-9 = [ "<Super><Shift>9" ];
      move-to-workspace-10 = [ "<Super><Shift>0" ];
      move-to-workspace-last = [ "<Super><Shift>End" ];

      move-to-workspace-left = [
        "<Shift><Super>i"

        "<Super><Shift>Page_Up"
        "<Super><Shift>KP_Prior"
        "<Super><Shift><Alt>Left"
        "<Control><Shift><Alt>Left"
      ];
      move-to-workspace-right = [
        "<Shift><Super>u"

        "<Super><Shift>Page_Down"
        "<Super><Shift>KP_Next"
        "<Super><Shift><Alt>Right"
        "<Control><Shift><Alt>Right"
      ];

      # Resolve conflict.
      minimize = [ "<Control><Alt><Super>h" ];

      # Replaced by AlbumWM's move-window-to-monitor-{left,below,above,right}.
      move-to-monitor-left = [ ];
      move-to-monitor-down = [ ];
      move-to-monitor-up = [ ];
      move-to-monitor-right = [ ];
    };

    "org/gnome/shell/extensions/albumwm" = {
      # You may put something here.
    };

    "org/gnome/shell/extensions/albumwm/keybindings" = {
      # You may put something here.
    };
  };
}
```

</details>
