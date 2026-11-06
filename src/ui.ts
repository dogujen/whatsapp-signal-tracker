import { renderChart, renderSparkline } from './chart.js';
import type { ContactView, QrView, ViewState } from './types.js';

export interface FrameSize {
    cols: number;
    rows: number;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';

const STATE_COLOR: Record<string, string> = {
    Online: GREEN,
    Standby: YELLOW,
    OFFLINE: RED,
    Calibrating: GRAY
};

const DISCLAIMER = 'Proof-of-concept for educational and security research purposes only. Demonstrates privacy vulnerabilities in WhatsApp and Signal.';

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleLength(text: string): number {
    return Array.from(text.replace(ANSI_PATTERN, '')).length;
}

function fit(text: string, width: number): string {
    const visible = visibleLength(text);
    if (visible > width) {
        const plain = Array.from(text.replace(ANSI_PATTERN, ''));
        return plain.slice(0, Math.max(0, width)).join('');
    }
    return text + ' '.repeat(Math.max(0, width - visible));
}

function center(text: string, width: number): string {
    const chars = Array.from(text);
    const trimmed = chars.length > width ? chars.slice(0, Math.max(0, width)) : chars;
    const left = Math.max(0, Math.floor((width - trimmed.length) / 2));
    return ' '.repeat(left) + trimmed.join('');
}

function formatMs(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    return `${Math.round(value)}ms`;
}

function formatAge(ageMs: number): string {
    if (ageMs < 0) return 'waiting';
    if (ageMs < 1500) return 'now';
    return `${Math.round(ageMs / 1000)}s ago`;
}

export function renderFrame(state: ViewState, size: FrameSize): string[] {
    const width = Math.max(60, (size.cols || 100) - 1);
    const height = Math.max(20, size.rows || 40);
    const header = headerLines(state, width);
    const bodyRows = Math.max(3, height - header.length - 4);

    const out: string[] = [...header];
    out.push(DIM + '─'.repeat(width) + RESET);
    const body = bodyLines(state, width, bodyRows);
    for (let index = 0; index < bodyRows; index++) {
        out.push(fit(body[index] ?? '', width));
    }
    out.push(DIM + '─'.repeat(width) + RESET);
    out.push(state.input
        ? CYAN + fit(`  > ${state.input.label}: ${state.input.value}▏`, width) + RESET
        : DIM + fit('  a add   x remove   p probe   w platform   ↑/↓ select   r retry signal   q quit', width) + RESET);
    out.push(statusLine(state, width));
    return out;
}

function headerLines(state: ViewState, width: number): string[] {
    const wa = `WA ${state.waStatus}`;
    const signal = state.signalState === 'linked'
        ? `Signal ${state.signalNumber ?? 'linked'}`
        : `Signal ${state.signalState}`;
    const right = `${state.clock} · ${wa} · ${signal}`;
    const single = `  ${DISCLAIMER}`;

    if (single.length + right.length + 2 <= width) {
        return [BOLD + fit(single + ' '.repeat(width - single.length - right.length) + right, width) + RESET];
    }

    const wrapped = wrapText(DISCLAIMER, Math.max(20, width - 2));
    const lines = wrapped.map((line) => BOLD + fit(`  ${line}`, width) + RESET);
    lines.push(DIM + fit(' '.repeat(Math.max(0, width - right.length)) + right, width) + RESET);
    return lines;
}

function wrapText(text: string, width: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const candidate = current.length === 0 ? word : `${current} ${word}`;
        if (candidate.length <= width) {
            current = candidate;
            continue;
        }
        if (current.length > 0) lines.push(current);
        current = word;
    }
    if (current.length > 0) lines.push(current);
    return lines.length > 0 ? lines : [''];
}

function statusLine(state: ViewState, width: number): string {
    const base = `  probe ${state.probeMethod} · add ${state.addPlatform} · signal ${state.signalApi}`;
    const notice = state.hint ?? state.log[state.log.length - 1] ?? '';
    const room = width - base.length - 3;
    if (!notice || room < 4) return DIM + fit(base, width) + RESET;
    const color = state.hint ? YELLOW : DIM;
    return DIM + base + RESET + '   ' + color + fit(notice, room) + RESET;
}

function bodyLines(state: ViewState, width: number, rows: number): string[] {
    if (state.qrs.length > 0) {
        const qr = qrLines(state, width, rows);
        const tooWide = state.qrs.some((entry) => entry.width > width);
        if (tooWide || qr.length > rows) {
            return [center(`QR needs ${Math.max(...state.qrs.map((entry) => entry.width))}×${qr.length} — enlarge the terminal`, width)];
        }
        const remaining = rows - qr.length;
        if (remaining > 1 && state.contacts.length > 0) {
            return [...qr, '', ...compactContacts(state, width, remaining - 1)];
        }
        return qr;
    }

    if (state.contacts.length === 0) {
        return [
            '',
            center('No contacts tracked', width),
            center("press 'a' to add a phone number", width),
            center("'w' switches the add platform · 'q' quits", width)
        ];
    }

    return contactBlocks(state, width, rows);
}

function qrLines(state: ViewState, width: number, rows: number): string[] {
    const first = state.qrs[0];
    if (!first) return [];
    const second = state.qrs[1];
    const gap = 6;

    if (second && width >= first.width + gap + second.width) {
        const total = first.width + gap + second.width;
        const pad = Math.max(0, Math.floor((width - total) / 2));
        const out = [
            ' '.repeat(pad) + center(first.title, first.width) + ' '.repeat(gap) + center(second.title, second.width)
        ];
        const count = Math.max(first.lines.length, second.lines.length);
        for (let index = 0; index < count; index++) {
            out.push(
                ' '.repeat(pad)
                + (first.lines[index] ?? ' '.repeat(first.width))
                + ' '.repeat(gap)
                + (second.lines[index] ?? ' '.repeat(second.width))
            );
        }
        return out;
    }

    const stackedRows = 1 + first.lines.length + (second ? 2 + second.lines.length : 0);
    if (second && stackedRows <= rows) {
        return [center(first.title, width), ...centeredQr(first, width), '', center(second.title, width), ...centeredQr(second, width)];
    }

    const out = [center(first.title, width), ...centeredQr(first, width)];
    if (second) out.push('', center('second QR hidden — enlarge the terminal', width));
    return out;
}

function centeredQr(block: QrView, width: number): string[] {
    const pad = Math.max(0, Math.floor((width - block.width) / 2));
    return block.lines.map((line) => ' '.repeat(pad) + line);
}

function contactBlocks(state: ViewState, width: number, rows: number): string[] {
    const count = state.contacts.length;
    const perContact = Math.floor(rows / count);
    const chartHeight = Math.max(3, Math.min(14, perContact - 4));
    const blockHeight = chartHeight + 4;
    const maxVisible = Math.max(1, Math.min(count, Math.floor(rows / blockHeight)));
    const start = Math.max(0, Math.min(state.selected - maxVisible + 1, count - maxVisible));
    const out: string[] = [];
    for (let index = start; index < Math.min(count, start + maxVisible); index++) {
        out.push(...contactBlock(state.contacts[index], index === state.selected, width, chartHeight));
    }
    return out;
}

function contactBlock(contact: ContactView, selected: boolean, width: number, chartHeight: number): string[] {
    const marker = selected ? '▸' : ' ';
    const platform = contact.platform === 'whatsapp' ? 'WhatsApp' : 'Signal';
    const stateText = contact.state.toUpperCase();
    const stateColor = STATE_COLOR[contact.state] ?? GRAY;

    const headWidth = Math.max(0, width - stateText.length);
    const presenceText = contact.presence ? `presence ${contact.presence}` : 'presence —';
    const head = fit(`${marker} ● ${platform}  ${contact.number}   ${presenceText}`, headWidth);
    const header = (selected ? BOLD + CYAN : '') + head + RESET + stateColor + BOLD + stateText + RESET;

    const hasSamples = contact.samples.length > 0;
    const avg = hasSamples ? formatMs(contact.avg) : '—';
    const median = contact.median > 0 ? formatMs(contact.median) : '—';
    const threshold = contact.threshold > 0 ? formatMs(contact.threshold) : '—';
    const slow = contact.slow > 0 ? ` (${contact.slow} slow)` : '';
    const observedRange = hasSamples
        ? `range ${Math.round(contact.minRtt)}–${Math.round(contact.maxRtt)}ms`
        : 'range —';
    const metrics = `  RTT ${formatMs(contact.rtt)}  ·  avg ${avg}  ·  med ${median}  ·  thr ${threshold}  ·  n ${contact.sampleCount}  ·  ack ${contact.acks}/${contact.probes}${slow}  ·  ${observedRange}  ·  ${formatAge(contact.ageMs)}`;

    const out = [header, metrics];

    if (!hasSamples) {
        out.push('  waiting for the first delivery receipt...');
        for (let index = 1; index < chartHeight; index++) out.push('');
    } else {
        const lineColor = STATE_COLOR[contact.state] ?? GRAY;
        const chartWidth = Math.max(10, width - 10);
        const chart = renderChart({
            values: contact.samples,
            threshold: contact.threshold > 0 ? contact.threshold : undefined,
            width: chartWidth,
            height: chartHeight,
            palette: { line: lineColor, threshold: RED, axis: GRAY, reset: RESET }
        });
        for (const line of chart) out.push('  ' + line);
    }

    const sparkWidth = Math.max(10, width - 4);
    const spark = renderSparkline(contact.samples.slice(-sparkWidth), sparkWidth);
    const sparkColor = STATE_COLOR[contact.state] ?? GRAY;
    out.push(sparkColor + fit('  ' + spark, width) + RESET);
    out.push(DIM + '─'.repeat(width) + RESET);
    return out;
}

function compactContacts(state: ViewState, width: number, rows: number): string[] {
    if (rows <= 0) return [];
    const count = state.contacts.length;
    const maxVisible = Math.max(1, Math.min(count, rows));
    const start = Math.max(0, Math.min(state.selected - maxVisible + 1, count - maxVisible));
    const out: string[] = [];
    for (let index = start; index < Math.min(count, start + maxVisible); index++) {
        const contact = state.contacts[index];
        const marker = index === state.selected ? '▸' : ' ';
        const platform = contact.platform === 'whatsapp' ? 'WA' : 'SG';
        const stateText = contact.state.toUpperCase();
        const threshold = contact.threshold > 0 ? formatMs(contact.threshold) : '—';
        const line = fit(
            `  ${marker} ${platform} ${contact.number}  ${stateText}  rtt ${formatMs(contact.rtt)}  avg ${formatMs(contact.samples.length > 0 ? contact.avg : null)}  thr ${threshold}  ${contact.presence ?? ''}`,
            width
        );
        const colored = line.replace(stateText, `${STATE_COLOR[contact.state] ?? GRAY}${stateText}${RESET}`);
        out.push((index === state.selected ? BOLD : '') + colored);
    }
    return out;
}
