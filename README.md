# AlbumWM

AlbumWM is a GNOME Shell extension which implements scrollable tiling support.

AlbumWM is a fork of [PaperWM](https://github.com/paperwm/PaperWM).

## Differences from PaperWM

For now, there are mostly removals and code maintainability improvements.
Features that the fork author considered useless or harmful are dropped.

- **Ported to TypeScript**
- **Dropped the custom workspaces functionality and the hacky multi-monitor support**

    Scrollable tiling is only done on the primary display, though.

    Rationale: PaperWM's custom emulation never worked good.
    Mutter should implement
    [independent workspaces on different monitors](https://gitlab.gnome.org/GNOME/mutter/-/work_items/37),
    not the tiling extension whose job is positioning the windows.

- **Preferences ui redesigned, migrated to Adwaita widgets and
  ported to [Blueprint](https://gnome.pages.gitlab.gnome.org/blueprint-compiler)**
- **Better shortcut conflict detection and handling**

    Instead of unconditionally deleting GNOME shortcuts, show a warning and let
    the user decide.

- **Replaced the global scratch layer with a per-workspace floating layer**
- **Remember each column's last focused window and activate it on column focus**
- **Made workspaces-only-on-primary mode usable**
- Implemented pointer warp on window focus (optional)
- Improved the scroll gesture
- Better default shortcuts (inspired by sway and niri)
- Improved the column management shortcuts (niri-style `consume-or-expel-window-{left,right}`)
- Proper pointer warp on monitor focus
- Dropped drawing a custom top bar on secondary displays
- Dropped the window position indicator and top bar styling
- Dropped all the remnants of X11 support
- Dropped `user.css` and `user.js` support (the latter didn't work anyway)
- Dropped the open-window-position option, new windows always spawn in a new column to the right
- Dropped the maximize-within-tiling option, windows are now always properly maximized
- Dropped the focused-window border highlight

    Ratioale: the windows already indicate focus themselves.

- Dropped the "take window" navigation mode
- Dropped the custom "live alt-tab" switcher, use GNOME's native switcher instead

## Installation

### Manual

Install:

```bash
npm run install:ext
```

Re-login is required, because the shell can't be restarted on Wayland.

Uninstall:

```bash
npm run uninstall:ext
```

### Nix

The flake provides a `gnome-shell-extension-albumwm` package,
which can be installed and enabled like any regular GNOME extension package from nixpkgs,
for example, via `programs.gnome-shell.extensions` in Home Manager configuration.

`flake.nix`:

```nix
albumwm = {
  url = "github:poli0iq/albumwm";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Home Manager:

```nix
programs.gnome-shell.extensions = [
  { package = inputs.albumwm.packages.${pkgs.stdenv.hostPlatform.system}.default; }
];
```

## Related projects

Some projects also implement scrollable tiling, namely:

- [Niri](https://github.com/YaLTeR/niri)
- [papersway](https://spwhitton.name/tech/code/papersway)
