import type { DeviceState } from './types.js';

const HISTORY_LIMIT = 2000;
const RECENT_LIMIT = 3;
const CHART_LIMIT = 240;
const IGNORE_ABOVE = 5000;

/**
 * Per-contact RTT statistics for the CLI.
 *
 * Same decision rule as the web tracker: median over the measurement history,
 * threshold = 90% of that median, moving average over the last three samples.
 * Values above 5s are treated as timeouts, not measurements.
 */
export class RttAnalyzer {
    private history: number[] = [];
    private recent: number[] = [];

    state: DeviceState = 'Calibrating';
    lastRtt: number | null = null;
    lastUpdate = 0;

    add(rtt: number): boolean {
        if (!Number.isFinite(rtt) || rtt <= 0 || rtt > IGNORE_ABOVE) return false;

        this.history.push(rtt);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();

        this.recent.push(rtt);
        if (this.recent.length > RECENT_LIMIT) this.recent.shift();

        this.lastRtt = Math.round(rtt);
        this.lastUpdate = Date.now();
        this.classify();
        return true;
    }

    offline(elapsed: number) {
        this.state = 'OFFLINE';
        this.lastRtt = Math.round(elapsed);
        this.lastUpdate = Date.now();
        this.recent = [];
    }

    get average(): number {
        if (this.recent.length === 0) return 0;
        return this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    }

    get median(): number {
        if (this.history.length < 3) return 0;
        const sorted = [...this.history].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }

    get threshold(): number {
        return this.median * 0.9;
    }

    get sampleCount(): number {
        return this.history.length;
    }

    get range(): { min: number; max: number } {
        if (this.history.length === 0) return { min: 0, max: 0 };
        let min = this.history[0];
        let max = this.history[0];
        for (const value of this.history) {
            if (value < min) min = value;
            if (value > max) max = value;
        }
        return { min, max };
    }

    chartSamples(): number[] {
        return this.history.slice(-CHART_LIMIT);
    }

    private classify() {
        if (this.history.length < 3) {
            this.state = 'Calibrating';
            return;
        }
        this.state = this.average < this.threshold ? 'Online' : 'Standby';
    }
}
