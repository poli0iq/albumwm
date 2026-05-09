import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Settings from './wm/settings.js';
// eslint-disable-next-line no-unused-vars
import * as KeybindingsPane from './preferences/keybindingsPane.js';
// eslint-disable-next-line no-unused-vars
import * as WinpropsPane from './preferences/winpropsPane.js';

const _ = s => s;

export default class AlbumWMPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const provider = new Gtk.CssProvider();
        provider.load_from_path(`${this.path}/resources/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        window.set_size_request(700, 750);
        new SettingsWidget(this, window);
    }
}

class SettingsWidget {
    constructor(extension, prefsWindow) {
        this.extension = extension;
        this._settings = extension.getSettings();
        this.builder = Gtk.Builder.new_from_file(`${extension.path}/ui/Settings.ui`);
        this.window = prefsWindow;

        const pages = [
            this.builder.get_object('general_page'),
            this.builder.get_object('keybindings_page'),
            this.builder.get_object('winprops_page'),
            this.builder.get_object('advanced_page'),
        ];

        pages.forEach(page => prefsWindow.add(page));

        // value-changed methods
        const booleanStateChanged = (key, inverted = false) => {
            const builder = this.builder.get_object(key);
            builder.active = inverted
                ? !this._settings.get_boolean(key) : this._settings.get_boolean(key);
            builder.connect('state-set', (obj, state) => {
                this._settings.set_boolean(key, inverted ? !state : state);
            });
        };

        const intValueChanged = (builderKey, settingKey) => {
            const builder = this.builder.get_object(builderKey);
            const value = this._settings.get_int(settingKey);
            builder.set_value(value);
            builder.connect('value-changed', () => {
                this._settings.set_int(settingKey, builder.get_value());
            });
        };

        const doubleValueChanged = (builderKey, settingKey) => {
            const builder = this.builder.get_object(builderKey);
            const value = this._settings.get_double(settingKey);
            builder.set_value(value);
            builder.connect('value-changed', () => {
                this._settings.set_double(settingKey, builder.get_value());
            });
        };

        const percentValueChanged = (builderKey, settingKey) => {
            const builder = this.builder.get_object(builderKey);
            const value = this._settings.get_double(settingKey);
            builder.set_value(value * 100.0);
            builder.connect('value-changed', () => {
                this._settings.set_double(settingKey, builder.get_value() / 100.0);
            });
        };

        const enumOptionsChanged = (settingKey, optionNumberEnum, defaultOption, defaultNumber) => {
            const builder = this.builder.get_object(settingKey);
            const setting = this._settings.get_int(settingKey);
            const numberOptionEnum = Object.fromEntries(
                Object.entries(optionNumberEnum).map(a => a.reverse())
            );

            builder.set_active_id(numberOptionEnum[setting] ?? defaultOption);
            builder.connect('changed', obj => {
                const value = optionNumberEnum[obj.get_active_id()] ?? defaultNumber;
                this._settings.set_int(settingKey, value);
            });
        };

        // const gestureFingersChanged = key => {
        //     const builder = this.builder.get_object(key);
        //     const setting = this._settings.get_int(key);
        //     const valueToFingers = {
        //         0: 'fingers-disabled',
        //         3: 'three-fingers',
        //         4: 'four-fingers',
        //     };
        //     const fingersToValue = Object.fromEntries(
        //         Object.entries(valueToFingers).map(a => a.reverse())
        //     );

        //     builder.set_active_id(valueToFingers[setting] ?? 'fingers-disable');
        //     builder.connect('changed', obj => {
        //         const value = fingersToValue[obj.get_active_id()] ?? 0;
        //         this._settings.set_int(key, value);
        //     });
        // };

        // General
        intValueChanged('window_gap_spin', 'window-gap');
        intValueChanged('hmargin_spinner', 'horizontal-margin');
        intValueChanged('top_margin_spinner', 'vertical-margin');
        intValueChanged('bottom_margin_spinner', 'vertical-margin-bottom');

        // processing function for cycle values
        const cycleProcessor = (elementName, settingName, resetElementName) => {
            const element = this.builder.get_object(elementName);
            const steps = this._settings.get_value(settingName).deep_unpack();

            // need to check if current values are ratio or pixel ==> assume if all <=1 is ratio
            const isRatio = steps.every(v => v <= 1);
            let value;
            if (isRatio) {
                value = steps.map(v => `${(v * 100.0).toString()}%`).toString();
            } else {
                value = steps.map(v => `${v.toString()}px`).toString();
            }
            element.set_text(value.replaceAll(',', '; '));

            element.connect('changed', () => {
                // process values
                // check if values are percent or pixel
                const value = element.get_text();
                const isPercent = value.split(';').map(v => v.trim()).every(v => /^.*%$/.test(v));
                const isPixels = value.split(';').map(v => v.trim()).every(v => /^.*px$/.test(v));
                if (isPercent && isPixels) {
                    console.error("cycle width/height values cannot mix percentage and pixel values");
                    element.add_css_class('error');
                    return;
                }
                if (!isPercent && !isPixels) {
                    console.error("no cycle width/height value units present");
                    element.add_css_class('error');
                    return;
                }

                // now process element value into internal array
                const varr = value
                    .split(';')
                    .map(v => v.trim())
                    .map(v => v.replaceAll(/[^\d.]/g, '')) // strip everything but digits and period
                    .filter(v => v.length > 0) // needed to remove invalid inputs
                    .map(Number) // only accept valid numbers
                    .map(v => isPercent ? v / 100.0 : v)
                    .sort((a, b) => a - b); // sort values to ensure monotonicity

                // check to make sure if percent than input cannot be > 100%
                if (isPercent && varr.some(v => v > 1)) {
                    console.error("cycle width/height percent inputs cannot be greater than 100%");
                    element.add_css_class('error');
                    return;
                }
                element.remove_css_class('error');

                this._settings.set_value(settingName, new GLib.Variant('ad', varr));
            });
            this.builder.get_object(resetElementName).connect('clicked', () => {
                // text value here should match the gshema value for cycle-width-steps
                element.set_text('38.195%; 50%; 61.804%');
            });
        };
        cycleProcessor('cycle_widths_entry', 'cycle-width-steps', 'cycle_widths_reset_button');
        cycleProcessor('cycle_heights_entry', 'cycle-height-steps', 'cycle_heights_reset_button');

        const vSens = this.builder.get_object('vertical-sensitivity');
        const hSens = this.builder.get_object('horizontal-sensitivity');
        const [sx, sy] = this._settings.get_value('swipe-sensitivity').deep_unpack();
        hSens.set_value(sx);
        vSens.set_value(sy);
        const sensChanged = () => {
            this._settings.set_value('swipe-sensitivity', new GLib.Variant('ad', [hSens.get_value(), vSens.get_value()]));
        };
        vSens.connect('value-changed', sensChanged);
        hSens.connect('value-changed', sensChanged);

        const vFric = this.builder.get_object('vertical-friction');
        const hFric = this.builder.get_object('horizontal-friction');
        const [fx, fy] = this._settings.get_value('swipe-friction').deep_unpack();
        hFric.set_value(fx);
        vFric.set_value(fy);
        const fricChanged = () => {
            this._settings.set_value('swipe-friction', new GLib.Variant('ad', [hFric.get_value(), vFric.get_value()]));
        };
        vFric.connect('value-changed', fricChanged);
        hFric.connect('value-changed', fricChanged);

        doubleValueChanged('animation_time_spin', 'animation-time');
        intValueChanged('drift_speed_spin', 'drift-speed');
        intValueChanged('drag_drift_speed_spin', 'drag-drift-speed');
        percentValueChanged('minimap_scale_spin', 'minimap-scale');
        percentValueChanged('window_switcher_preview_scale_spin', 'window-switcher-preview-scale');
        percentValueChanged('overview_max_window_scale_spin', 'overview-max-window-scale');
        intValueChanged('minimap_shade_opacity_spin', 'minimap-shade-opacity');

        // tiling edge preview settings
        booleanStateChanged('edge-preview-enable');
        percentValueChanged('edge_scale_spin', 'edge-preview-scale');
        booleanStateChanged('edge-preview-click-enable');
        booleanStateChanged('edge-preview-timeout-enable');
        intValueChanged('edge_preview_timeout_scale', 'edge-preview-timeout');
        booleanStateChanged('edge-preview-timeout-continual');

        const openWindowPosition = this.builder.get_object('open-window-position');
        const owpos = this._settings.get_int('open-window-position');
        openWindowPosition.set_active_id(
            owpos === Settings.OpenWindowPositions.DOWN ? 'down' : 'right'
        );
        openWindowPosition.connect('changed', obj => {
            const mode = obj.get_active_id() === 'down'
                ? Settings.OpenWindowPositions.DOWN
                : Settings.OpenWindowPositions.RIGHT;
            this._settings.set_int('open-window-position', mode);
        });

        const scratchOverview = this.builder.get_object('scratch-in-overview');
        if (this._settings.get_boolean('only-scratch-in-overview'))
            scratchOverview.set_active_id('only');
        else if (this._settings.get_boolean('disable-scratch-in-overview'))
            scratchOverview.set_active_id('never');
        else
            scratchOverview.set_active_id('always');

        scratchOverview.connect('changed', obj => {
            if (obj.get_active_id() === 'only') {
                this._settings.set_boolean('only-scratch-in-overview', true);
                this._settings.set_boolean('disable-scratch-in-overview', false);
            } else if (obj.get_active_id() === 'never') {
                this._settings.set_boolean('only-scratch-in-overview', false);
                this._settings.set_boolean('disable-scratch-in-overview', true);
            } else {
                this._settings.set_boolean('only-scratch-in-overview', false);
                this._settings.set_boolean('disable-scratch-in-overview', false);
            }
        });

        // Keybindings
        const keybindingsPane = this.builder.get_object('keybindings_pane');
        keybindingsPane.init(extension);

        // Winprops
        const winprops = this._settings.get_value('winprops').deep_unpack()
            .map(p => JSON.parse(p));
        // sort a little nicer
        const valueFn = wp => {
            if (wp.wm_class) {
                return wp.wm_class;
            }
            if (wp.title) {
                return wp.title;
            }
            return '';
        };
        winprops.sort((a, b) => {
            const aa = valueFn(a).replaceAll(/[/]/g, '');
            const bb = valueFn(b).replaceAll(/[/]/g, '');
            return aa.localeCompare(bb);
        });
        const winpropsPane = this.builder.get_object('winpropsPane');
        winpropsPane.addWinprops(winprops);
        winpropsPane.connect('changed', () => {
            // update gsettings with changes
            const rows = winpropsPane.rows
                .filter(r => r.checkHasWmClassOrTitle())
                .map(r => JSON.stringify(r.winprop));

            this._settings.set_value('winprops', new GLib.Variant('as', rows));
        });

        // Advanced
        booleanStateChanged('gesture-enabled');

        const fingerOptions = {
            'fingers-disabled': 0,
            'three-fingers': 3,
            'four-fingers': 4,
        };
        const fingerOptionDefault = 'fingers-disabled';
        const fingerNumberDefault = 0;
        enumOptionsChanged('gesture-horizontal-fingers', fingerOptions, fingerOptionDefault, fingerNumberDefault);
        enumOptionsChanged(
            'default-focus-mode',
            {
                'default': 0,
                'center': 1,
                'edge': 2,
            },
            'default',
            0);

        enumOptionsChanged(
            'overview-ensure-viewport-animation',
            {
                'none': 0,
                'translate': 1,
                'fade': 2,
            },
            'translate',
            1);

        intValueChanged('overview_min_windows_per_row_spin', 'overview-min-windows-per-row');
        booleanStateChanged('show-focus-mode-icon');
        booleanStateChanged('show-open-position-icon');
        percentValueChanged('maximize-width-percent', 'maximize-width-percent');
        booleanStateChanged('topbar-mouse-scroll-enable');
    }
}
