import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import { Settings, Tiling } from './imports.js';

import type { WindowPreview } from 'resource:///org/gnome/shell/ui/windowPreview.js';

type Row = {
    x: number;
    y: number;
    width: number;
    height: number;
    fullWidth: number;
    fullHeight: number;
    windows: WindowPreview[];
    /** Assigned per row in computeWindowSlots. */
    additionalScale: number;
};

/**
 * The strategy-specific layout object and its rows. Upstream documents
 * computeLayout's return as opaque and never inspects it, so these shapes are
 * entirely ours to define.
 */
type Layout = {
    numRows: number;
    rows: Row[];
    maxColumns: number;
    gridWidth: number;
    gridHeight: number;
    /** Overall layout scale, finalized by computeScaleAndSpace. */
    scale: number;
};

/**
 * Gnome 45's UnalignedLayoutStrategy is not exported.  Hence, we recreate this class
 * with modifications to ensure window ordering reflects tiling window order in overview.
 *
 * See https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-45/js/ui/workspace.js
 */
export class UnalignedLayoutStrategy extends Workspace.LayoutStrategy {
    _newRow(): Row {
        // Row properties:
        //
        // * x, y are the position of row, relative to area
        //
        // * width, height are the scaled versions of fullWidth, fullHeight
        //
        // * width also has the spacing in between windows. It's not in
        //   fullWidth, as the spacing is constant, whereas fullWidth is
        //   meant to be scaled
        //
        // * neither height/fullHeight have any sort of spacing or padding
        return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            fullWidth: 0,
            fullHeight: 0,
            windows: [],
            additionalScale: 1,
        };
    }

    // Computes and returns an individual scaling factor for @window,
    // to be applied in addition to the overall layout scale.
    _computeWindowScale(window: WindowPreview): number {
        // Since we align windows next to each other, the height of the
        // thumbnails is much more important to preserve than the width of
        // them, so two windows with equal height, but maybe differering
        // widths line up.
        const ratio = window.boundingBox.height / this._monitor.height;

        // The purpose of this manipulation here is to prevent windows
        // from getting too small. For something like a calculator window,
        // we need to bump up the size just a bit to make sure it looks
        // good. We'll use a multiplier of 1.5 for this.

        // Map from [0, 1] to [1.5, 1]
        return Util.lerp(1.5, 1, ratio);
    }

    _computeRowSizes(layout: Layout) {
        const { rows, scale } = layout;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            row.width =
                row.fullWidth * scale +
                (row.windows.length - 1) * this._columnSpacing;
            row.height = row.fullHeight * scale;
        }
    }

    _keepSameRow(row: Row, width: number, idealRowWidth: number): boolean {
        // enforce a minimum number of windows per overview row
        if (row.windows.length < Settings.prefs!.overview_min_windows_per_row) {
            return true;
        }

        if (row.fullWidth + width <= idealRowWidth) return true;

        const oldRatio = row.fullWidth / idealRowWidth;
        const newRatio = (row.fullWidth + width) / idealRowWidth;

        if (Math.abs(1 - newRatio) < Math.abs(1 - oldRatio)) return true;

        return false;
    }

    computeLayout(
        windows: WindowPreview[],
        { numRows }: { numRows: number }
    ): Layout {
        if (!numRows)
            throw new Error(
                `${this.constructor.name}: No numRows given in layout params`
            );

        const rows: Row[] = [];
        let totalWidth = 0;
        for (let i = 0; i < windows.length; i++) {
            const window = windows[i];
            const s = this._computeWindowScale(window);
            totalWidth += window.boundingBox.width * s;
        }

        const idealRowWidth = totalWidth / numRows;

        const sortedWindows = windows.slice();
        // sorting needs to be done here to address moved windows
        sortedWindows.sort(sortWindows);

        let windowIdx = 0;
        for (let i = 0; i < numRows; i++) {
            const row = this._newRow();
            rows.push(row);

            for (; windowIdx < sortedWindows.length; windowIdx++) {
                const window = sortedWindows[windowIdx];
                const s = this._computeWindowScale(window);
                const width = window.boundingBox.width * s;
                const height = window.boundingBox.height * s;
                row.fullHeight = Math.max(row.fullHeight, height);

                // either new width is < idealWidth or new width is nearer from idealWidth then oldWidth
                if (
                    this._keepSameRow(row, width, idealRowWidth) ||
                    i === numRows - 1
                ) {
                    row.windows.push(window);
                    row.fullWidth += width;
                } else {
                    break;
                }
            }
        }

        let gridHeight = 0;
        let maxRow = rows[0];
        for (let i = 0; i < numRows; i++) {
            const row = rows[i];

            if (row.fullWidth > maxRow.fullWidth) maxRow = row;
            gridHeight += row.fullHeight;
        }

        return {
            numRows,
            rows,
            maxColumns: maxRow.windows.length,
            gridWidth: maxRow.fullWidth,
            gridHeight,
            scale: 0,
        };
    }

    computeScaleAndSpace(
        layout: Layout,
        area: Workspace.Rect
    ): [number, number] {
        const hspacing = (layout.maxColumns - 1) * this._columnSpacing;
        const vspacing = (layout.numRows - 1) * this._rowSpacing;

        const spacedWidth = area.width - hspacing;
        const spacedHeight = area.height - vspacing;

        const horizontalScale = spacedWidth / layout.gridWidth;
        const verticalScale = spacedHeight / layout.gridHeight;

        // Thumbnails should be less than 70% of the original size
        const scale = Math.min(
            horizontalScale,
            verticalScale,
            Settings.prefs!.overview_max_window_scale
        );

        const scaledLayoutWidth = layout.gridWidth * scale + hspacing;
        const scaledLayoutHeight = layout.gridHeight * scale + vspacing;
        const space =
            (scaledLayoutWidth * scaledLayoutHeight) /
            (area.width * area.height);

        layout.scale = scale;

        return [scale, space];
    }

    computeWindowSlots(
        layout: Layout,
        area: Workspace.Rect
    ): Workspace.WindowSlot[] {
        this._computeRowSizes(layout);

        const { rows, scale } = layout;

        const slots: Workspace.WindowSlot[] = [];

        // Do this in three parts.
        let heightWithoutSpacing = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            heightWithoutSpacing += row.height;
        }

        const verticalSpacing = (rows.length - 1) * this._rowSpacing;
        const additionalVerticalScale = Math.min(
            1,
            (area.height - verticalSpacing) / heightWithoutSpacing
        );

        // keep track how much smaller the grid becomes due to scaling
        // so it can be centered again
        let compensation = 0;
        let y = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];

            // If this window layout row doesn't fit in the actual
            // geometry, then apply an additional scale to it.
            const horizontalSpacing =
                (row.windows.length - 1) * this._columnSpacing;
            const widthWithoutSpacing = row.width - horizontalSpacing;
            const additionalHorizontalScale = Math.min(
                1,
                (area.width - horizontalSpacing) / widthWithoutSpacing
            );

            if (additionalHorizontalScale < additionalVerticalScale) {
                row.additionalScale = additionalHorizontalScale;
                // Only consider the scaling in addition to the vertical scaling for centering.
                compensation +=
                    (additionalVerticalScale - additionalHorizontalScale) *
                    row.height;
            } else {
                row.additionalScale = additionalVerticalScale;
                // No compensation when scaling vertically since centering based on a too large
                // height would undo what vertical scaling is trying to achieve.
            }

            row.x =
                area.x +
                Math.max(
                    area.width -
                        (widthWithoutSpacing * row.additionalScale +
                            horizontalSpacing),
                    0
                ) /
                    2;
            row.y =
                area.y +
                Math.max(
                    area.height - (heightWithoutSpacing + verticalSpacing),
                    0
                ) /
                    2 +
                y;
            y += row.height * row.additionalScale + this._rowSpacing;
        }

        compensation /= 2;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowY = row.y + compensation;
            const rowHeight = row.height * row.additionalScale;

            let x = row.x;
            for (let j = 0; j < row.windows.length; j++) {
                const window = row.windows[j];

                let s =
                    scale *
                    this._computeWindowScale(window) *
                    row.additionalScale;
                const cellWidth = window.boundingBox.width * s;
                const cellHeight = window.boundingBox.height * s;

                s = Math.min(s, Settings.prefs!.overview_max_window_scale);
                const cloneWidth = window.boundingBox.width * s;
                const cloneHeight = window.boundingBox.height * s;

                let cloneX = x + (cellWidth - cloneWidth) / 2;
                let cloneY;

                // If there's only one row, align windows vertically centered inside the row
                if (rows.length === 1)
                    cloneY = rowY + (rowHeight - cloneHeight) / 2;
                // If there are multiple rows, align windows to the bottom edge of the row
                else cloneY = rowY + rowHeight - cellHeight;

                // Align with the pixel grid to prevent blurry windows at scale = 1
                cloneX = Math.floor(cloneX);
                cloneY = Math.floor(cloneY);

                slots.push([cloneX, cloneY, cloneWidth, cloneHeight, window]);
                x += cellWidth + this._columnSpacing;
            }
        }
        return slots;
    }
}

/**
 * Ensures windows are sorted correctly in overview (correctly being the tiled order in the space).
 */
export function sortWindows(a: WindowPreview, b: WindowPreview): number {
    const aw = a.metaWindow as Tiling.Window;
    const bw = b.metaWindow as Tiling.Window;
    if (!aw && !bw) {
        return 0;
    }
    if (!aw) {
        return -1;
    }
    if (!bw) {
        return 1;
    }

    const spaceA = Tiling.spaces.spaceOfWindow(aw)!;
    const spaceB = Tiling.spaces.spaceOfWindow(bw)!;
    const ia = spaceA.columnOf(aw);
    const ib = spaceB.columnOf(bw);
    if (ia === -1 && ib === -1) {
        return aw.get_stable_sequence() - bw.get_stable_sequence();
    }
    if (ia === -1) {
        return -1;
    }
    if (ib === -1) {
        return 1;
    }
    return ia - ib;
}
