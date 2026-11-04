export interface ChartPalette {
    line: string;
    threshold: string;
    axis: string;
    reset: string;
}

export interface ChartOptions {
    values: number[];
    threshold?: number;
    width: number;
    height: number;
    palette?: ChartPalette;
}

const LOWER_BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
const THRESHOLD_GLYPH = '\u2504';
const LABEL_WIDTH = 6;
const BRAILLE_BASE = 0x2800;

// Braille dot bit for [column 0|1][row 0..3] inside one character cell.
const DOT_BITS = [
    [0x01, 0x02, 0x04, 0x40],
    [0x08, 0x10, 0x20, 0x80]
];

function labelField(value: number): string {
    let text = String(Math.round(value));
    if (text.length > LABEL_WIDTH) {
        text = String(Math.abs(Math.round(value))).slice(0, LABEL_WIDTH);
    }
    return text.padStart(LABEL_WIDTH, ' ') + ' ';
}

function positiveValues(values: number[]): number[] {
    const result: number[] = [];
    for (const value of values) {
        if (Number.isFinite(value) && value > 0) result.push(value);
    }
    return result;
}

function bucketMax(values: number[], buckets: number): number[] {
    const result: number[] = [];
    const count = values.length;
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor((bucket * count) / buckets);
        const end = Math.floor(((bucket + 1) * count) / buckets);
        let max = values[start];
        for (let index = start + 1; index < end; index++) {
            if (values[index] > max) max = values[index];
        }
        result.push(max);
    }
    return result;
}

function drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    mark: (x: number, y: number) => void
): void {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    for (;;) {
        mark(x, y);
        if (x === x1 && y === y1) break;
        const doubled = 2 * err;
        if (doubled >= dy) {
            err += dy;
            x += sx;
        }
        if (doubled <= dx) {
            err += dx;
            y += sy;
        }
    }
}

export function renderChart(opts: ChartOptions): string[] {
    const width = Number.isFinite(opts.width) ? Math.max(10, Math.floor(opts.width)) : 10;
    const height = Number.isFinite(opts.height) ? Math.max(3, Math.floor(opts.height)) : 3;
    const blankRow = ' '.repeat(LABEL_WIDTH + 2 + width);

    const plotted = positiveValues(opts.values);
    if (plotted.length === 0) {
        return new Array<string>(height).fill(blankRow);
    }

    const columns = plotted.length > width ? bucketMax(plotted, width) : plotted;

    const threshold = typeof opts.threshold === 'number' && Number.isFinite(opts.threshold) && opts.threshold > 0
        ? opts.threshold
        : undefined;

    let min = columns[0];
    let max = columns[0];
    for (const value of columns) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (threshold !== undefined) {
        if (threshold < min) min = threshold;
        if (threshold > max) max = threshold;
    }

    const span = max - min;
    let lo: number;
    let hi: number;
    if (span === 0) {
        lo = Math.max(0, min - Math.max(100, min * 0.1));
        hi = min + Math.max(100, min * 0.1);
    } else {
        const padding = span * 0.1;
        lo = Math.max(0, min - padding);
        hi = max + padding;
    }

    const pixelsWidth = width * 2;
    const pixelsHeight = height * 4;
    const masks = new Uint8Array(width * height);

    const yFor = (value: number): number => {
        const ratio = (value - lo) / (hi - lo);
        const pixel = Math.round((1 - ratio) * (pixelsHeight - 1));
        return Math.min(pixelsHeight - 1, Math.max(0, pixel));
    };

    const mark = (pixelX: number, pixelY: number) => {
        const cellX = Math.min(width - 1, Math.max(0, Math.floor(pixelX / 2)));
        const cellY = Math.min(height - 1, Math.max(0, Math.floor(pixelY / 4)));
        masks[cellY * width + cellX] |= DOT_BITS[pixelX % 2][pixelY % 4];
    };

    if (columns.length === 1) {
        drawLine(0, yFor(columns[0]), pixelsWidth - 1, yFor(columns[0]), mark);
    } else {
        for (let index = 1; index < columns.length; index++) {
            const x0 = Math.round(((index - 1) * (pixelsWidth - 1)) / (columns.length - 1));
            const x1 = Math.round((index * (pixelsWidth - 1)) / (columns.length - 1));
            drawLine(x0, yFor(columns[index - 1]), x1, yFor(columns[index]), mark);
        }
    }

    const thresholdRow = threshold === undefined ? -1 : Math.floor(yFor(threshold) / 4);

    const labelRows = new Set<number>([0, Math.floor(height / 2), height - 1]);
    const labels: string[] = new Array<string>(height).fill(' '.repeat(LABEL_WIDTH + 1));
    labels[0] = labelField(hi);
    labels[Math.floor(height / 2)] = labelField((lo + hi) / 2);
    labels[height - 1] = labelField(lo);

    const palette = opts.palette;
    const lines: string[] = [];

    for (let row = 0; row < height; row++) {
        const prefix = labels[row];
        const axis = labelRows.has(row) ? '\u2524' : '\u2502';
        let line = palette ? palette.axis + prefix + axis + palette.reset : prefix + axis;

        let currentStyle = -1;
        let segment = '';

        const flush = () => {
            if (segment.length === 0) return;
            if (!palette || currentStyle === 0) {
                line += segment;
            } else {
                const color = currentStyle === 1 ? palette.line : palette.threshold;
                line += color + segment + palette.reset;
            }
            segment = '';
        };

        for (let column = 0; column < width; column++) {
            const mask = masks[row * width + column];
            let style = 0;
            let glyph = ' ';
            if (mask !== 0) {
                style = 1;
                glyph = String.fromCharCode(BRAILLE_BASE + mask);
            } else if (row === thresholdRow) {
                style = 2;
                glyph = THRESHOLD_GLYPH;
            }
            if (style !== currentStyle) {
                flush();
                currentStyle = style;
            }
            segment += glyph;
        }
        flush();
        lines.push(line);
    }

    return lines;
}

export function renderSparkline(values: number[], width: number): string {
    const available = Number.isFinite(width) ? Math.floor(width) : 0;
    if (available < 1) return '';

    const positive: number[] = [];
    for (const value of values) {
        if (Number.isFinite(value) && value >= 0) positive.push(value);
    }
    if (positive.length === 0) return '';

    const plotted = positive.length > available ? bucketMax(positive, available) : positive;

    let min = plotted[0];
    let max = plotted[0];
    for (const value of plotted) {
        if (value < min) min = value;
        if (value > max) max = value;
    }

    let result = '';
    for (const value of plotted) {
        if (max === min) {
            result += LOWER_BLOCKS[3];
            continue;
        }
        const ratio = (value - min) / (max - min);
        const level = Math.min(7, Math.max(0, Math.round(ratio * 7)));
        result += LOWER_BLOCKS[level];
    }
    return result;
}
