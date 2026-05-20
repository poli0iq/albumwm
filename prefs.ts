import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// For GObject.registerClass side effects
import './preferences/keybindingsPane.js';
import './preferences/winpropsPane.js';

import type Gio from 'gi://Gio?version=2.0';
import type Adw from 'gi://Adw?version=1';
import type { KeybindingsPane } from './preferences/keybindingsPane.js';
import type { WinpropsPane } from './preferences/winpropsPane.js';
import type { WinPropSpec } from './wm/settings.js';

class SettingsWidget {
    extension: ExtensionPreferences;
    _settings: Gio.Settings;
    builder: Gtk.Builder;
    window: Adw.PreferencesWindow;

    constructor(
        extension: ExtensionPreferences,
        prefsWindow: Adw.PreferencesWindow
    ) {
        this.extension = extension;
        this._settings = extension.getSettings();
        this.builder = Gtk.Builder.new_from_file(
            `${extension.path}/ui/Settings.ui`
        );
        this.window = prefsWindow;

        const pages = [
            this.builder.get_object<Adw.PreferencesPage>('general_page'),
            this.builder.get_object<Adw.PreferencesPage>('keybindings_page'),
            this.builder.get_object<Adw.PreferencesPage>('winprops_page'),
            this.builder.get_object<Adw.PreferencesPage>('advanced_page'),
        ];

        pages.forEach(page => prefsWindow.add(page));

        // 'changed' methods
        const booleanStateChanged = (key: string, inverted = false) => {
            const builder = this.builder.get_object<Adw.SwitchRow>(key);
            builder.active = inverted
                ? !this._settings.get_boolean(key)
                : this._settings.get_boolean(key);
            builder.connect('notify::active', obj => {
                this._settings.set_boolean(
                    key,
                    inverted ? !obj.active : obj.active
                );
            });
        };

        const intValueChanged = (builderKey: string, settingKey: string) => {
            const builder = this.builder.get_object<Adw.SpinRow>(builderKey);
            const value = this._settings.get_int(settingKey);
            builder.set_value(value);
            builder.connect('changed', () => {
                this._settings.set_int(settingKey, builder.get_value());
            });
        };

        const doubleValueChanged = (builderKey: string, settingKey: string) => {
            const builder = this.builder.get_object<Adw.SpinRow>(builderKey);
            const value = this._settings.get_double(settingKey);
            builder.set_value(value);
            builder.connect('changed', () => {
                this._settings.set_double(settingKey, builder.get_value());
            });
        };

        const percentValueChanged = (
            builderKey: string,
            settingKey: string
        ) => {
            const builder = this.builder.get_object<Adw.SpinRow>(builderKey);
            const value = this._settings.get_double(settingKey);
            builder.set_value(value * 100.0);
            builder.connect('changed', () => {
                this._settings.set_double(
                    settingKey,
                    builder.get_value() / 100.0
                );
            });
        };

        const toggleGroupSelectionChanged = (
            settingKey: string,
            optionNumberEnum: { [key: string]: number },
            defaultOption: string,
            defaultNumber: number
        ) => {
            const builder =
                this.builder.get_object<Adw.ToggleGroup>(settingKey);
            const setting = this._settings.get_int(settingKey);
            const numberOptionEnum = Object.fromEntries(
                Object.entries(optionNumberEnum).map(a => a.reverse())
            );

            builder.set_active_name(numberOptionEnum[setting] ?? defaultOption);
            builder.connect('notify::active-name', obj => {
                const value =
                    optionNumberEnum[obj.get_active_name()!] ?? defaultNumber;
                this._settings.set_int(settingKey, value);
            });
        };

        const comboRowSelectionChanged = (
            settingKey: string,
            indexNumberEnum: { [key: number]: number },
            defaultIndex: number,
            defaultNumber: number
        ) => {
            const builder = this.builder.get_object<Adw.ComboRow>(settingKey);
            const setting = this._settings.get_int(settingKey);
            const numberIndexEnum = Object.fromEntries(
                Object.entries(indexNumberEnum).map(a => a.reverse())
            );

            builder.set_selected(numberIndexEnum[setting] ?? defaultIndex);
            builder.connect('notify::selected', obj => {
                const value =
                    indexNumberEnum[obj.get_selected()] ?? defaultNumber;
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
        const cycleProcessor = (
            elementName: string,
            settingName: string,
            resetElementName: string
        ) => {
            const element = this.builder.get_object<Adw.EntryRow>(elementName);
            const steps = this._settings
                .get_value<'ad'>(settingName)
                .deep_unpack();

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
                const text = element.get_text();
                const isPercent = text
                    .split(';')
                    .map(v => v.trim())
                    .every(v => /^.*%$/.test(v));
                const isPixels = text
                    .split(';')
                    .map(v => v.trim())
                    .every(v => /^.*px$/.test(v));
                if (isPercent && isPixels) {
                    console.error(
                        'cycle width/height values cannot mix percentage and pixel values'
                    );
                    element.add_css_class('error');
                    return;
                }
                if (!isPercent && !isPixels) {
                    console.error('no cycle width/height value units present');
                    element.add_css_class('error');
                    return;
                }

                // now process element value into internal array
                const varr = text
                    .split(';')
                    .map(v => v.trim())
                    .map(v => v.replaceAll(/[^\d.]/g, '')) // strip everything but digits and period
                    .filter(v => v.length > 0) // needed to remove invalid inputs
                    .map(Number) // only accept valid numbers
                    .map(v => (isPercent ? v / 100.0 : v))
                    .sort((a, b) => a - b); // sort values to ensure monotonicity

                // check to make sure if percent than input cannot be > 100%
                if (isPercent && varr.some(v => v > 1)) {
                    console.error(
                        'cycle width/height percent inputs cannot be greater than 100%'
                    );
                    element.add_css_class('error');
                    return;
                }
                element.remove_css_class('error');

                this._settings.set_value(
                    settingName,
                    new GLib.Variant('ad', varr)
                );
            });
            this.builder.get_object(resetElementName).connect('clicked', () => {
                // text value here should match the gshema value for cycle-width-steps
                element.set_text('38.195%; 50%; 61.804%');
            });
        };
        cycleProcessor(
            'cycle_widths_entry',
            'cycle-width-steps',
            'cycle_widths_reset_button'
        );
        cycleProcessor(
            'cycle_heights_entry',
            'cycle-height-steps',
            'cycle_heights_reset_button'
        );

        toggleGroupSelectionChanged(
            'open-window-position',
            {
                right: 0,
                down: 1,
            },
            'right',
            0
        );
        toggleGroupSelectionChanged(
            'default-focus-mode',
            {
                default: 0,
                center: 1,
                edge: 2,
            },
            'default',
            0
        );

        const scratchOverview = this.builder.get_object<Adw.ComboRow>(
            'scratch-in-overview'
        );
        if (this._settings.get_boolean('only-scratch-in-overview'))
            scratchOverview.set_selected(1); // 'only'
        else if (this._settings.get_boolean('disable-scratch-in-overview'))
            scratchOverview.set_selected(2); // 'never'
        else scratchOverview.set_selected(0); // 'always'

        scratchOverview.connect('notify::selected', obj => {
            if (obj.selected === 1) {
                // 'only'
                this._settings.set_boolean('only-scratch-in-overview', true);
                this._settings.set_boolean(
                    'disable-scratch-in-overview',
                    false
                );
            } else if (obj.selected === 2) {
                // 'never'
                this._settings.set_boolean('only-scratch-in-overview', false);
                this._settings.set_boolean('disable-scratch-in-overview', true);
            } else {
                // 'always'
                this._settings.set_boolean('only-scratch-in-overview', false);
                this._settings.set_boolean(
                    'disable-scratch-in-overview',
                    false
                );
            }
        });

        booleanStateChanged('gesture-enabled');

        comboRowSelectionChanged(
            'gesture-horizontal-fingers',
            {
                0: 0, // 'fingers-disabled'
                1: 3, // 'three-fingers'
                2: 4, // 'four-fingers'
            },
            0, // 'fingers-disabled'
            0
        );

        // Keybindings
        const keybindingsPane =
            this.builder.get_object<KeybindingsPane>('keybindings_pane');
        keybindingsPane.init(extension);

        // Winprops
        const winprops: WinPropSpec[] = this._settings
            .get_value<'as'>('winprops')
            .deep_unpack()
            .map(p => JSON.parse(p));
        // sort a little nicer
        const valueFn = (wp: WinPropSpec) => {
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
        const winpropsPane =
            this.builder.get_object<WinpropsPane>('winpropsPane');
        winpropsPane.addWinprops(winprops);
        winpropsPane.connect('changed', () => {
            // update gsettings with changes
            const rows = winpropsPane.rows
                .filter(r => r.checkHasWmClassOrTitle())
                .map(r => JSON.stringify(r.winprop));

            this._settings.set_value('winprops', new GLib.Variant('as', rows));
        });

        // Advanced

        // Interface
        booleanStateChanged('show-focus-mode-icon');
        booleanStateChanged('show-open-position-icon');
        intValueChanged(
            'overview_min_windows_per_row_spin',
            'overview-min-windows-per-row'
        );
        intValueChanged('minimap_shade_opacity_spin', 'minimap-shade-opacity');

        // Animations
        doubleValueChanged('animation_time_spin', 'animation-time');
        intValueChanged('drift_speed_spin', 'drift-speed');
        intValueChanged('drag_drift_speed_spin', 'drag-drift-speed');
        comboRowSelectionChanged(
            'overview-ensure-viewport-animation',
            {
                0: 0, // 'none'
                1: 1, // 'translate'
                2: 2, // 'fade'
            },
            1, // 'translate'
            1
        );

        // Tiling edge preview
        booleanStateChanged('edge-preview-enable');
        percentValueChanged('edge_scale_spin', 'edge-preview-scale');
        booleanStateChanged('edge-preview-click-enable');
        booleanStateChanged('edge-preview-timeout-enable');
        intValueChanged('edge-preview-timeout', 'edge-preview-timeout');
        booleanStateChanged('edge-preview-timeout-continual');

        // Interface scale
        percentValueChanged('minimap_scale_spin', 'minimap-scale');
        percentValueChanged(
            'window_switcher_preview_scale_spin',
            'window-switcher-preview-scale'
        );
        percentValueChanged(
            'overview_max_window_scale_spin',
            'overview-max-window-scale'
        );

        // Other
        percentValueChanged('maximize-width-percent', 'maximize-width-percent');
        booleanStateChanged('topbar-mouse-scroll-enable');

        // Gesture
        const vSens = this.builder.get_object<Adw.SpinRow>(
            'vertical-sensitivity'
        );
        const hSens = this.builder.get_object<Adw.SpinRow>(
            'horizontal-sensitivity'
        );
        const [sx, sy] = this._settings
            .get_value<'ad'>('swipe-sensitivity')
            .deep_unpack();
        hSens.set_value(sx);
        vSens.set_value(sy);
        const sensChanged = () => {
            this._settings.set_value(
                'swipe-sensitivity',
                new GLib.Variant('ad', [hSens.get_value(), vSens.get_value()])
            );
        };
        vSens.connect('changed', sensChanged);
        hSens.connect('changed', sensChanged);

        const vFric = this.builder.get_object<Adw.SpinRow>('vertical-friction');
        const hFric = this.builder.get_object<Adw.SpinRow>(
            'horizontal-friction'
        );
        const [fx, fy] = this._settings
            .get_value<'ad'>('swipe-friction')
            .deep_unpack();
        hFric.set_value(fx);
        vFric.set_value(fy);
        const fricChanged = () => {
            this._settings.set_value(
                'swipe-friction',
                new GLib.Variant('ad', [hFric.get_value(), vFric.get_value()])
            );
        };
        vFric.connect('changed', fricChanged);
        hFric.connect('changed', fricChanged);
    }
}

export default class AlbumWMPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const provider = new Gtk.CssProvider();
        provider.load_from_path(`${this.path}/resources/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default()!,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        window.set_size_request(700, 750);
        new SettingsWidget(this, window);
    }
}
