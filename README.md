# AlbumWM

AlbumWM is a GNOME Shell extension which implements scrollable tiling support.

AlbumWM is a fork of [PaperWM](https://github.com/paperwm/PaperWM).

## Differences from PaperWM

For now, there are mostly removals and code maintainability improvements.
Features that the fork author considered useless or harmful are dropped.

- **Dropped the custom workspaces functionality and the hacky multi-monitor support**

  Now both the "Workspaces on all displays" and "Workspaces on primary display only" modes work.
  Scrollable tiling is only done on the primary display, though.

  Rationale: PaperWM's custom emulation never worked good.
  Mutter should implement
  [independent workspaces on different monitors](https://gitlab.gnome.org/GNOME/mutter/-/work_items/37),
  not the tiling extension whose job is positioning the windows.
- Dropped drawing a custom top bar on secondary displays
- Dropped the window position indicator and top bar styling
- Dropped all the remnants of X11 support
- Dropped `user.css` and `user.js` support (the latter didn't work anyway)
- Dropped all the open-window-position modes except RIGHT and DOWN
- Dropped the maximize-within-tiling option, windows are now always properly maximized
- Dropped the focused-window border highlight

  Ratioale: the windows already indicate focus themselves.

## Installation

### Manual

Install:
```bash
npm run install:ext
``````
Re-login is required, because the shell can't be restarted on Wayland.

Uninstall:
```bash
npm run uninstall:ext
```

### Nix

The flake provides a `gnome-shell-extension-albumwm` package,
which can be installed and enabled like any regular GNOME extension package from nixpkgs,
for example, via `programs.gnome-shell.extensions` in Home Manager configuration.

## Related projects ##

Some projects also implement scrollable tiling, namely:
- [Niri](https://github.com/YaLTeR/niri)
- [papersway](https://spwhitton.name/tech/code/papersway)
