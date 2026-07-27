import Clutter from 'gi://Clutter';

/**
 * Replacement for Gtk.accelerator_parse for the shell process, where GTK
 * libraries must not be imported. Clutter ships the same X11 keysym
 * constants and modifier masks as Gdk.
 */

/**
 * The fake keysym mutter assigns to the key above Tab. Refer to:
 * https://gitlab.gnome.org/GNOME/mutter/-/blob/50.3/src/core/meta-accel-parse.h#L34
 */
const META_KEY_ABOVE_TAB = 0x2f7259c9;

const modMasks: { [mod: string]: number } = {
    '<shift>': Clutter.ModifierType.SHIFT_MASK,
    '<control>': Clutter.ModifierType.CONTROL_MASK,
    '<ctrl>': Clutter.ModifierType.CONTROL_MASK,
    '<primary>': Clutter.ModifierType.CONTROL_MASK,
    '<alt>': Clutter.ModifierType.MOD1_MASK,
    '<super>': Clutter.ModifierType.SUPER_MASK,
    '<hyper>': Clutter.ModifierType.HYPER_MASK,
    '<meta>': Clutter.ModifierType.META_MASK,
};

/**
 * Clutter's KEY_ constants strip the XF86 prefix that keysym names carry
 * (e.g. XF86AudioMute is KEY_AudioMute), so try both.
 */
function keyvalFromName(name: string): number {
    const keysyms = Clutter as unknown as Record<string, unknown>;
    const keyval =
        keysyms[`KEY_${name}`] ?? keysyms[`KEY_${name.replace(/^XF86/, '')}`];
    return typeof keyval === 'number' ? keyval : Clutter.KEY_VoidSymbol;
}

export function parse(keystr: string): [boolean, number, number] {
    const mods = keystr.match(/<.*?>/g) ?? [];

    let mask = 0;
    for (const mod of mods) {
        mask |= modMasks[mod.toLowerCase()] ?? 0;
    }

    // remove mods from keystr, leaving the keysym name
    let key = keystr;
    mods.forEach(m => {
        key = key.replace(m, '');
    });
    key = key.trim();

    const keyval = keyvalFromName(key);
    if (keyval === Clutter.KEY_VoidSymbol) {
        return [false, 0, 0];
    }
    return [true, keyval, mask];
}

/**
 * Two keystrings can represent the same key combination
 */
export function keystrToKeycombo(keystr: string) {
    // Above_Tab is a fake keysymbol provided by mutter
    let aboveTab = false;
    if (keystr.match(/Above_Tab/) || keystr.match(/grave/)) {
        keystr = keystr.replace('Above_Tab', 'a');
        aboveTab = true;
    }

    const [, key, mask] = parse(keystr);
    // Since js doesn't have a mapable tuple type
    return `${aboveTab ? META_KEY_ABOVE_TAB : key}|${mask}`;
}
