/* @girs/gnome-shell types workspace.js but omits the abstract LayoutStrategy
 * base that overviewlayout.ts subclasses.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.1/js/ui/workspace.js#L102 */

import type { LayoutManager } from 'resource:///org/gnome/shell/ui/layout.js';
import type { WindowPreview } from 'resource:///org/gnome/shell/ui/windowPreview.js';

/* girs declares Monitor as a non-exported `declare class`, so it can't be
 * imported by name; recover it from the exported LayoutManager.monitors. */
type Monitor = LayoutManager['monitors'][number];

declare module 'resource:///org/gnome/shell/ui/workspace.js' {
    /** The {x, y, width, height} area LayoutStrategy methods lay windows out in. */
    export interface Rect {
        x: number;
        y: number;
        width: number;
        height: number;
    }

    /**
     * Final [x, y, width, height, window] placement computeWindowSlots returns
     * for each window; WorkspaceLayout destructures it to allocate the clone.
     */
    export type WindowSlot = [number, number, number, number, WindowPreview];

    export class LayoutStrategy {
        _monitor: Monitor;
        _rowSpacing: number;
        _columnSpacing: number;

        constructor(params: {
            monitor: Monitor;
            rowSpacing?: number;
            columnSpacing?: number;
        });

        /* Subclasses pin the layout/scale shapes; from here they stay opaque
         * pass-through values, the way upstream treats them. */
        computeLayout(
            windows: WindowPreview[],
            params: { numRows: number }
        ): unknown;
        computeScaleAndSpace(layout: unknown, area: Rect): [number, number];
    }

    export class WorkspaceLayout extends Clutter.LayoutManager {
        _spacing: number;
        _monitorIndex: number;
        _sortedWindows: WindowPreview[];
        _layoutStrategy: LayoutStrategy;
        _adjustSpacingAndPadding(
            rowSpacing: number,
            columnSpacing: number,
            containerBox: Clutter.ActorBox | null
        ): [number, number];
        _isBetterScaleAndSpace(
            oldScale: number,
            oldSpace: number,
            newScale: number,
            newSpace: number
        ): boolean;
        _createBestLayout(area: Rect): unknown;
    }

    interface Workspace {
        _isOverviewWindow(window: Meta.Window): boolean;
    }
}
