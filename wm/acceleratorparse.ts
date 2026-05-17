import Gdk from 'gi://Gdk?version=4.0';

/**
 * Provides replacement for Gtk.accelerator_parse.
 */
export class AcceleratorParse {
    accelerator_parse(keystr: string): [boolean, number, number] {
        let mask = this.accelerator_mask(keystr);
        const mods = this.accelerator_mods(keystr);

        // remove mods from keystr
        let key = keystr;
        mods.forEach(m => {
            key = key.replace(m, '');
        });
        key = key.trim();

        // now lookup keyval
        let ok = true;
        let keyval: number;
        const mapped = Gdk.keyval_from_name(key);
        if (mapped !== Gdk.KEY_VoidSymbol) {
            keyval = mapped;
        } else {
            ok = false;
            keyval = 0;
            mask = 0;
        }

        // console.log(keystr, keyval, mask);
        return [ok, keyval, mask];
    }

    /**
     * Returns array of mods for a keystr, e.g. ['<Control>', '<Shift>', '<Alt>'].
     */
    accelerator_mods(keystr: string) {
        return keystr.match(/<.*?>/g) ?? [];
    }

    /**
     * Returns the GDK mask value for a keystr (keybind string representation).
     * Refer to:
     * https://gitlab.gnome.org/GNOME/gtk/-/blob/4.13.0/gdk/gdkenums.h?ref_type=tags#L115
     * https://gitlab.gnome.org/GNOME/gtk/-/blob/4.13.0/gtk/gtkaccelgroup.c#L571
     */
    accelerator_mask(keystr: string) {
        // need to extact all mods from keystr
        const mods = this.accelerator_mods(keystr);
        let result = 0;
        for (const mod of mods) {
            switch (mod.toLowerCase()) {
                case '<shift>':
                    result |= Gdk.ModifierType.SHIFT_MASK;
                    break;
                case '<control>':
                case '<ctrl>':
                case '<primary>':
                    result |= Gdk.ModifierType.CONTROL_MASK;
                    break;
                case '<alt>':
                    result |= Gdk.ModifierType.ALT_MASK;
                    break;
                case '<super>':
                    result |= Gdk.ModifierType.SUPER_MASK;
                    break;
                case '<hyper>':
                    result |= Gdk.ModifierType.HYPER_MASK;
                    break;
                case '<meta>':
                    result |= Gdk.ModifierType.META_MASK;
            }
        }

        return result;
    }
}
