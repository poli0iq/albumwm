import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// For GObject.registerClass side effects
import './preferences/keybindingsPage.js';
import './preferences/winpropsPage.js';

import type Adw from 'gi://Adw?version=1';
import type { KeybindingsPage } from './preferences/keybindingsPage.js';
import type { WinpropsPage } from './preferences/winpropsPage.js';
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
        intValueChanged('window_gap_spin', 'column-gap');
        intValueChanged('hmargin_spinner', 'horizontal-margin');
        intValueChanged('vmargin_spinner', 'vertical-margin');

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

            element.set_text(steps.map(v => `${v * 100.0}%`).join('; '));

            element.connect('changed', () => {
                // values are percentages of the monitor dimension
                const text = element.get_text();
                const isPercent = text
                    .split(';')
                    .map(v => v.trim())
                    .every(v => /^.*%$/.test(v));
                if (!isPercent) {
                    console.error(
                        'cycle width/height values must be percentages'
                    );
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
                    .map(v => v / 100.0)
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
                // text value here should match the gshema value for preset-column-widths
                element.set_text('38.195%; 50%; 61.804%');
            });
        };
        cycleProcessor(
            'cycle_widths_entry',
            'preset-column-widths',
            'cycle_widths_reset_button'
        );
        cycleProcessor(
            'cycle_heights_entry',
            'preset-window-heights',
            'cycle_heights_reset_button'
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

        booleanStateChanged('warp-pointer-on-focus');

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
        const keybindingsPage =
            this.builder.get_object<KeybindingsPage>('keybindings_page');
        keybindingsPage.init(extension);

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
        const winpropsPage =
            this.builder.get_object<WinpropsPage>('winprops_page');
        winpropsPage.addWinprops(winprops);
        winpropsPage.connect('changed', () => {
            // update gsettings with changes
            const rows = winpropsPage.rows
                .filter(r => r.checkHasWmClassOrTitle())
                .map(r => JSON.stringify(r.winprop));

            this._settings.set_value('winprops', new GLib.Variant('as', rows));
        });

        // Advanced

        // Interface
        booleanStateChanged('show-focus-mode-icon');
        intValueChanged(
            'overview_min_windows_per_row_spin',
            'overview-min-windows-per-row'
        );
        intValueChanged('minimap_shade_opacity_spin', 'minimap-shade-opacity');

        // Animations
        doubleValueChanged('animation_time_spin', 'animation-time');
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
        percentValueChanged('maximize-width-percent', 'maximize-column-width');
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
        Gio.resources_register(
            Gio.Resource.load(`${this.path}/albumwm.gresource`)
        );

        Gtk.IconTheme.get_for_display(
            Gdk.Display.get_default()!
        ).add_resource_path('/dev/0iq/albumwm/icons');

        const provider = new Gtk.CssProvider();
        provider.load_from_resource('/dev/0iq/albumwm/prefs.css');
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default()!,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        new SettingsWidget(this, window);
        window.set_search_enabled(true);
    }
}
