import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as panelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { Settings, Utils, Tiling, Scratch } from './imports.js';

import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const display = global.display;

/*
  Functionality related to the top bar, often called the statusbar.
 */

export const panelBox = Main.layoutManager.panelBox;

export let focusButton: FocusButton | null;
let signals: Utils.Signals | null, gsettings: Gio.Settings | null;

export function enable(extension: Extension) {
    gsettings = extension.getSettings();

    signals = new Utils.Signals();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    focusButton = new FocusButton();

    Main.panel.addToStatusArea('FocusButton', focusButton, 2, 'left');

    fixFocusModeIcon();

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

    signals.connect(panelBox, 'show', () => {
        fixTopBar();
    });

    signals.connect(Main.panel, 'scroll-event', (_actor, event) => {
        topBarScrollAction(event);
    });
}

export function disable() {
    signals!.destroy();
    signals = null;
    focusButton!.destroy();
    focusButton = null;

    gsettings = null;
}

type TooltipProps = {
    parent: St.Widget;
    x_point: number;
};

class BaseIcon extends St.Icon {
    static {
        GObject.registerClass({ GTypeName: 'BaseIcon' }, this);
    }

    declare tooltip_parent: St.Widget;
    declare tooltip_x_point: number;
    declare mode: number;
    declare setMode: (mode?: number) => void;
    declare updateTooltipText: () => void;
    declare clickFunction?: () => void;
    declare tooltip: St.Label;

    _init(
        props?: Partial<St.Icon.ConstructorProps>,
        tooltipProps?: TooltipProps,
        init: () => void = () => {},
        setMode: (mode?: number) => void = (_mode?: number) => {},
        updateTooltipText: () => void = () => {}
    ) {
        super._init(props);

        // allow custom x position for tooltip
        this.tooltip_parent = tooltipProps?.parent ?? this;
        this.tooltip_x_point = tooltipProps?.x_point ?? 0;

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
        const point = this.apply_transform_to_point(
            new Graphene.Point3D({ x: xpoint, y: 0 })
        );
        this.tooltip.set_position(Math.max(0, point.x - 62), point.y + 34);
    }

    /**
     * Sets a function to be executed on click.
     */
    setClickFunction(clickFunction: () => void) {
        this.clickFunction = clickFunction;
        return this;
    }

    /**
     * Sets visibility of icon.
     */
    setVisible(visible = true) {
        this.visible = visible;
        return this;
    }

    /**
     * Returns a nicely formatted keybind string from AlbumWM
     */
    getKeybindString(key: string) {
        // get first keybind
        try {
            const kb = gsettings!
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

class FocusIcon extends BaseIcon {
    static {
        GObject.registerClass({ GTypeName: 'FocusIcon' }, this);
    }

    declare gIconDefault: Gio.Icon;
    declare gIconCenter: Gio.Icon;
    declare gIconEdge: Gio.Icon;

    _init(
        props?: Partial<St.Icon.ConstructorProps>,
        tooltipProps?: TooltipProps
    ) {
        super._init(
            props,
            tooltipProps,
            () => {
                this.gIconDefault = Gio.icon_new_for_string(
                    'resource:///dev/0iq/albumwm/icons/focus-mode-default-symbolic.svg'
                );
                this.gIconCenter = Gio.icon_new_for_string(
                    'resource:///dev/0iq/albumwm/icons/focus-mode-center-symbolic.svg'
                );
                this.gIconEdge = Gio.icon_new_for_string(
                    'resource:///dev/0iq/albumwm/icons/focus-mode-edge-symbolic.svg'
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
                const markup = (color: string, mode: string) => {
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

export class FocusButton extends panelMenu.Button {
    static {
        GObject.registerClass({ GTypeName: 'FocusButton' }, this);
    }

    declare _icon: FocusIcon;
    declare focusMode: number;

    constructor() {
        super(0.0, 'FocusMode');
    }

    _init() {
        // dontCreateMenu disables the base click gesture (an empty-menu toggle).
        super._init(0.0, 'FocusMode', true);

        this._icon = new FocusIcon(
            {
                style_class: 'system-status-icon focus-mode-button',
            },
            { parent: this, x_point: -10 }
        );

        this.setFocusMode();
        this.add_child(this._icon);

        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => this._onClicked());
        this.add_action(click);
    }

    /**
     * Sets the focus mode with this button.
     */
    setFocusMode(mode?: number) {
        mode = mode ?? Tiling.FocusModes.DEFAULT;
        this.focusMode = mode;
        this._icon.setMode(mode);
        return this;
    }

    _onClicked() {
        if (Main.overview.visible) {
            return;
        }

        Tiling.switchToNextFocusMode();
        this._icon.updateTooltipText();
    }
}

/**
 * Action when mouse scrolling on topbar.
 */
export function topBarScrollAction(event: Clutter.Event) {
    if (!Settings.prefs!.topbar_mouse_scroll_enable) {
        return Clutter.EVENT_PROPAGATE;
    }

    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/panel.js#L420
    const pill = (
        Main.panel.statusArea as typeof Main.panel.statusArea & {
            activities?: panelMenu.Button;
        }
    ).activities;
    // If GNOME pill has the pointer, exit
    if (pill && pill.has_pointer) {
        return Clutter.EVENT_PROPAGATE;
    }

    const direction = event.get_scroll_direction();
    switch (direction) {
        case Clutter.ScrollDirection.DOWN:
            Tiling.spaces!.activeSpace?.switchRight();
            break;
        case Clutter.ScrollDirection.UP:
            Tiling.spaces!.activeSpace?.switchLeft();
            break;
    }
    const selected = Tiling.spaces!.activeSpace?.selectedWindow;
    if (selected) {
        let hasFocus = selected.has_focus();
        selected.foreach_transient(mw => {
            hasFocus = mw.has_focus() || hasFocus;
            return true;
        });
        if (hasFocus) {
            Tiling.focusHandler(selected);
        } else {
            Main.activateWindow(selected);
        }
    }

    return Clutter.EVENT_PROPAGATE;
}

export function fixTopBar() {
    const space = Tiling?.spaces?.activeSpace;
    if (!space) return;

    const normal = !Main.overview.visible;
    // selected is current (tiled) selected window (can be different to focused window)
    const selected = space.selectedWindow;
    const focused = display.focus_window as Tiling.Window;
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
    if (Settings.prefs!.show_focus_mode_icon) focusButton!.show();
    else focusButton!.hide();
}
