import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as panelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { Settings, Utils, Tiling, Scratch } from './imports.js';

const display = global.display;

/*
  Functionality related to the top bar, often called the statusbar.
 */

export let panelBox = Main.layoutManager.panelBox;

export let focusButton, openPositionButton;
let signals, gsettings;

export function enable(extension) {
    gsettings = extension.getSettings();

    signals = new Utils.Signals();

    // eslint-disable-next-line no-use-before-define
    focusButton = new FocusButton();
    // eslint-disable-next-line no-use-before-define
    openPositionButton = new OpenPositionButton();

    Main.panel.addToStatusArea('FocusButton', focusButton, 2, 'left');
    Main.panel.addToStatusArea(
        'OpenPositionButton',
        openPositionButton,
        3,
        'left'
    );

    fixFocusModeIcon();
    fixOpenPositionIcon();

    signals.connect(Main.overview, 'showing', fixTopBar);
    signals.connect(Main.overview, 'hidden', () => {
        fixTopBar();
    });

    signals.connect(
        gsettings,
        'changed::show-focus-mode-icon',
        (_settings, _key) => {
            fixFocusModeIcon();
        }
    );

    signals.connect(
        gsettings,
        'changed::show-open-position-icon',
        (_settings, _key) => {
            fixOpenPositionIcon();
        }
    );

    signals.connect(panelBox, 'show', () => {
        fixTopBar();
    });

    signals.connect(Main.panel, 'scroll-event', (_actor, event) => {
        topBarScrollAction(event);
    });
}

export function disable() {
    signals.destroy();
    signals = null;
    focusButton.destroy();
    focusButton = null;
    openPositionButton.destroy();
    openPositionButton = null;

    gsettings = null;
}

const BaseIcon = GObject.registerClass(
    // eslint-disable-next-line no-shadow
    class BaseIcon extends St.Icon {
        _init(
            props = {},
            tooltipProps = {},
            init = () => {},
            setMode = _mode => {},
            updateTooltipText = () => {}
        ) {
            super._init(props);

            // allow custom x position for tooltip
            this.tooltip_parent = tooltipProps?.parent ?? this;
            this.tooltip_x_point = tooltipProps?.x_point ?? 0;
            this.mode;

            // assign functions
            this.setMode = setMode;
            this.updateTooltipText = updateTooltipText;

            init();
            this.initToolTip();
            this.setMode();

            this.reactive = true;
            this.connect('button-press-event', () => {
                if (this.clickFunction) {
                    this.clickFunction();
                    this.updateTooltipText();
                }
            });
        }

        initToolTip() {
            const tt = new St.Label({ style_class: 'focus-button-tooltip' });
            tt.hide();
            // global.stage.add_child(tt);
            Utils.actorAddChild(global.stage, tt);
            this.tooltip_parent.connect('enter-event', _icon => {
                this._updateTooltipPosition(this.tooltip_x_point);
                this.updateTooltipText();
                tt.show();

                // alignment needs to be set after actor is shown
                tt.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
            });
            this.tooltip_parent.connect('leave-event', (_icon, _event) => {
                if (!this.has_pointer) {
                    tt.hide();
                }
            });
            this.tooltip = tt;
        }

        /**
         * Updates tooltip position relative to this button.
         */
        _updateTooltipPosition(xpoint = 0) {
            let point = this.apply_transform_to_point(
                new Graphene.Point3D({ x: xpoint, y: 0 })
            );
            this.tooltip.set_position(Math.max(0, point.x - 62), point.y + 34);
        }

        /**
         * Sets a function to be executed on click.
         * @param {Function} clickFunction
         * @returns
         */
        setClickFunction(clickFunction) {
            this.clickFunction = clickFunction;
            return this;
        }

        /**
         * Sets visibility of icon.
         * @param {boolean} visible
         */
        setVisible(visible = true) {
            this.visible = visible;
            return this;
        }

        /**
         * Returns a nicely formatted keybind string from AlbumWM
         * @param {String} key
         */
        getKeybindString(key) {
            // get first keybind
            try {
                let kb = gsettings
                    .get_child('keybindings')
                    .get_strv(key)[0]
                    .replace(/[<>]/g, ' ')
                    .trim()
                    .replace(/\s+/g, '+');

                // empty
                if (kb.length === 0) {
                    return '';
                }
                return `\n<i>(${kb})</i>`;
            } catch {
                return '';
            }
        }
    }
);

export const FocusIcon = GObject.registerClass(
    // eslint-disable-next-line no-shadow
    class FocusIcon extends BaseIcon {
        _init(props = {}, tooltipProps = {}) {
            super._init(
                props,
                tooltipProps,
                () => {
                    const pather = relativePath =>
                        GLib.uri_resolve_relative(
                            import.meta.url,
                            relativePath,
                            GLib.UriFlags.NONE
                        );
                    this.gIconDefault = Gio.icon_new_for_string(
                        pather('../resources/focus-mode-default-symbolic.svg')
                    );
                    this.gIconCenter = Gio.icon_new_for_string(
                        pather('../resources/focus-mode-center-symbolic.svg')
                    );
                    this.gIconEdge = Gio.icon_new_for_string(
                        pather('../resources/focus-mode-edge-symbolic.svg')
                    );
                },
                mode => {
                    mode = mode ?? Tiling.FocusModes.DEFAULT;
                    this.mode = mode;

                    switch (mode) {
                        case Tiling.FocusModes.CENTER:
                            this.gicon = this.gIconCenter;
                            break;
                        case Tiling.FocusModes.EDGE:
                            this.gicon = this.gIconEdge;
                            break;
                        default:
                            this.gicon = this.gIconDefault;
                            break;
                    }

                    return this;
                },
                () => {
                    const markup = (color, mode) => {
                        const ct = this.tooltip.clutter_text;
                        ct.set_markup(`<i>Window focus mode</i>
Current mode: <span foreground="${color}"><b>${mode}</b></span>\
${this.getKeybindString('switch-focus-mode')}`);
                    };
                    switch (this.mode) {
                        case Tiling.FocusModes.DEFAULT:
                            markup('#6be67b', 'DEFAULT');
                            return;
                        case Tiling.FocusModes.CENTER:
                            markup('#6be6cb', 'CENTER');
                            break;
                        case Tiling.FocusModes.EDGE:
                            markup('#abe67b', 'EDGE');
                            break;
                        default:
                            markup('#6be67b', 'DEFAULT');
                            this.tooltip.set_text('');
                            break;
                    }
                }
            );
        }
    }
);

export const FocusButton = GObject.registerClass(
    // eslint-disable-next-line no-shadow
    class FocusButton extends panelMenu.Button {
        _init() {
            super._init(0.0, 'FocusMode');

            this._icon = new FocusIcon(
                {
                    style_class: 'system-status-icon focus-mode-button',
                },
                { parent: this, x_point: -10 }
            );

            this.setFocusMode();
            this.add_child(this._icon);
            this.connect('event', this._onClicked.bind(this));
        }

        /**
         * Sets the focus mode with this button.
         * @param {*} mode
         */
        setFocusMode(mode) {
            mode = mode ?? Tiling.FocusModes.DEFAULT;
            this.focusMode = mode;
            this._icon.setMode(mode);
            return this;
        }

        _onClicked(_actor, event) {
            if (Main.overview.visible) {
                return Clutter.EVENT_PROPAGATE;
            }

            if (
                event.type() !== Clutter.EventType.TOUCH_BEGIN &&
                event.type() !== Clutter.EventType.BUTTON_PRESS
            ) {
                return Clutter.EVENT_PROPAGATE;
            }

            Tiling.switchToNextFocusMode();
            this._icon.updateTooltipText();
            return Clutter.EVENT_PROPAGATE;
        }
    }
);

export const OpenPositionIcon = GObject.registerClass(
    // eslint-disable-next-line no-shadow
    class OpenPositionIcon extends BaseIcon {
        _init(props = {}, tooltipProps = {}) {
            super._init(
                props,
                tooltipProps,
                () => {
                    const pather = relativePath =>
                        GLib.uri_resolve_relative(
                            import.meta.url,
                            relativePath,
                            GLib.UriFlags.NONE
                        );
                    this.gIconRight = Gio.icon_new_for_string(
                        pather('../resources/open-position-right-symbolic.svg')
                    );
                    this.gIconDown = Gio.icon_new_for_string(
                        pather('../resources/open-position-down-symbolic.svg')
                    );

                    signals.connect(
                        gsettings,
                        'changed::open-window-position',
                        (_settings, _key) => {
                            const mode = Settings.prefs.open_window_position;
                            this.setMode(mode);
                        }
                    );
                },
                mode => {
                    mode = mode ?? Settings.OpenWindowPositions.RIGHT;
                    this.mode = mode;
                    this.gicon =
                        mode === Settings.OpenWindowPositions.DOWN
                            ? this.gIconDown
                            : this.gIconRight;
                    this.updateTooltipText();
                    return this;
                },
                () => {
                    const label =
                        this.mode === Settings.OpenWindowPositions.DOWN
                            ? 'DOWN'
                            : 'RIGHT';
                    const ct = this.tooltip.clutter_text;
                    ct.set_markup(`<i>Open Window Position</i>
Current position: <b>${label}</b>\
${this.getKeybindString('switch-open-window-position')}`);
                }
            );
        }
    }
);

export const OpenPositionButton = GObject.registerClass(
    // eslint-disable-next-line no-shadow
    class OpenPositionButton extends panelMenu.Button {
        _init() {
            super._init(0.0, 'OpenPosition');

            this._icon = new OpenPositionIcon(
                {
                    style_class: 'system-status-icon open-position-icon',
                },
                { parent: this, x_point: -10 }
            );

            this.setPositionMode(Settings.prefs.open_window_position);
            this.add_child(this._icon);
            this.connect('button-press-event', this._onClicked.bind(this));
        }

        /**
         * Sets the position mode with this button.
         * @param {*} mode
         */
        setPositionMode(mode) {
            mode = mode ?? Settings.OpenWindowPositions.RIGHT;
            this.positionMode = mode;
            this._icon.setMode(mode);
            return this;
        }

        _onClicked(_actor, _event) {
            switchToNextOpenPositionMode();
            return Clutter.EVENT_PROPAGATE;
        }
    }
);

/**
 * Action when mouse scrolling on topbar.
 * @param {Clutter.event} event
 * @returns
 */
export function topBarScrollAction(event) {
    if (!Settings.prefs.topbar_mouse_scroll_enable) {
        return Clutter.EVENT_PROPAGATE;
    }

    // if gnome pill has pointer, exit
    const pill = Main.panel?.statusArea?.activities;
    if (pill && pill.has_pointer) {
        return Clutter.EVENT_PROPAGATE;
    }

    let direction = event.get_scroll_direction();
    switch (direction) {
        case Clutter.ScrollDirection.DOWN:
            Tiling.spaces?.activeSpace.switchRight(false);
            break;
        case Clutter.ScrollDirection.UP:
            Tiling.spaces?.activeSpace.switchLeft(false);
            break;
    }
    const selected = Tiling.spaces?.activeSpace?.selectedWindow;
    if (selected) {
        let hasFocus = selected.has_focus();
        selected.foreach_transient(mw => {
            hasFocus = mw.has_focus() || hasFocus;
        });
        if (hasFocus) {
            Tiling.focusHandler(selected);
        } else {
            Main.activateWindow(selected);
        }
    }

    return Clutter.EVENT_PROPAGATE;
}

export function createButton(iconName, accessibleName) {
    return new St.Button({
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        style_class: 'button workspace-icon-button',
        child: new St.Icon({ icon_name: iconName }),
    });
}

/**
 * Toggles between RIGHT and DOWN open-window positions.
 */
export function switchToNextOpenPositionMode() {
    const next =
        Settings.prefs.open_window_position ===
        Settings.OpenWindowPositions.DOWN
            ? Settings.OpenWindowPositions.RIGHT
            : Settings.OpenWindowPositions.DOWN;
    gsettings.set_int('open-window-position', next);
}

/**
 * Switches to the next position for opening new windows.
 */
export function setOpenPositionMode(mode) {
    gsettings.set_int('open-window-position', mode);
}

export function fixTopBar() {
    const space = Tiling?.spaces?.activeSpace;
    if (!space) return;

    const normal = !Main.overview.visible;
    // selected is current (tiled) selected window (can be different to focused window)
    const selected = space.selectedWindow;
    const focused = display.focus_window;
    const focusIsFloatOrScratch =
        focused &&
        (space.isFloating(focused) || Scratch.isScratchWindow(focused));
    // check if is currently fullscreened (check focused-floating, focused-scratch, and selected/tiled window)
    const fullscreen = focusIsFloatOrScratch
        ? focused.fullscreen
        : selected && selected.fullscreen;

    if (normal && !space.showTopBar) {
        hideTopBar();
    } else if (normal && fullscreen) {
        hideTopBar();
    } else {
        showTopBar();
    }
}

export function showTopBar() {
    panelBox.show();
}

export function hideTopBar() {
    panelBox.hide();
}

export function fixFocusModeIcon() {
    Settings.prefs.show_focus_mode_icon
        ? focusButton.show()
        : focusButton.hide();
}

export function fixOpenPositionIcon() {
    Settings.prefs.show_open_position_icon
        ? openPositionButton.show()
        : openPositionButton.hide();
}
