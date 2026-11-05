import WebSocket from 'ws';
import { decodeQrPng } from './qr.js';
import type { SignalState } from './types.js';

export interface SignalEvents {
    onState: (state: SignalState) => void;
    onQr: (uri: string | null) => void;
    onReceipt: (sourceNumber: string) => void;
    onLog: (message: string) => void;
}

export interface SignalCheck {
    registered: boolean;
    error?: string;
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✨'];
const LINK_TIMEOUT_MS = 5 * 60 * 1000;
const QR_REFRESH_MS = 25 * 1000;

export function digitsOnly(value: string): string {
    return value.replace(/\D/g, '');
}

export function toSignalNumber(value: string): string {
    const digits = digitsOnly(value);
    return digits.length > 0 ? `+${digits}` : '';
}

/**
 * Signal probe engine backed by signal-cli-rest-api (json-rpc mode).
 *
 * A single websocket receives receipts for the linked account; probes are
 * serialized per contact by the caller and correlated by source number.
 */
export class SignalEngine {
    readonly apiUrl: string;
    private readonly events: SignalEvents;
    private ws: WebSocket | null = null;
    private stopped = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private linkDeadline = 0;

    state: SignalState = 'starting';
    number: string | null = null;

    constructor(apiUrl: string, events: SignalEvents) {
        this.apiUrl = apiUrl.replace(/\/+$/, '');
        this.events = events;
    }

    async start(): Promise<void> {
        this.stopped = false;
        const reachable = await this.isReachable();
        if (!reachable) {
            this.setState('unavailable');
            this.events.onLog(`Signal API not reachable at ${this.apiUrl}`);
            return;
        }

        const accounts = await this.getAccounts();
        if (accounts.length > 0) {
            this.activate(accounts[0]);
            return;
        }
        this.beginLinking();
    }

    async retry(): Promise<void> {
        this.clearTimers();
        this.ws?.close();
        this.ws = null;
        this.setState('starting');
        await this.start();
    }

    async checkNumber(target: string): Promise<SignalCheck> {
        if (!this.number) return { registered: false, error: 'Signal is not linked yet' };
        try {
            const response = await fetch(
                `${this.apiUrl}/v1/search/${encodeURIComponent(this.number)}?numbers=${encodeURIComponent(target)}`,
                { signal: AbortSignal.timeout(30000) }
            );
            if (!response.ok) {
                return { registered: false, error: `Signal API error (HTTP ${response.status})` };
            }
            const data: unknown = await response.json();
            if (Array.isArray(data) && data.some((entry) => (entry as { registered?: boolean })?.registered === true)) {
                return { registered: true };
            }
            return { registered: false, error: 'Number is not registered on Signal or discovery is blocked' };
        } catch (err) {
            return { registered: false, error: `Signal API error: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    async probe(target: string): Promise<void> {
        if (!this.number) throw new Error('Signal is not linked');
        const body = {
            reaction: REACTIONS[Math.floor(Math.random() * REACTIONS.length)],
            recipient: target,
            target_author: target,
            timestamp: Date.now() - 86_400_000
        };
        const response = await fetch(`${this.apiUrl}/v1/reactions/${encodeURIComponent(this.number)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok && response.status !== 204) {
            throw new Error(`Signal probe rejected (HTTP ${response.status})`);
        }
    }

    private async isReachable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.apiUrl}/v1/about`, { signal: AbortSignal.timeout(2000) });
            return response.ok;
        } catch {
            return false;
        }
    }

    private async getAccounts(): Promise<string[]> {
        try {
            const response = await fetch(`${this.apiUrl}/v1/accounts`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [];
            const data: unknown = await response.json();
            if (!Array.isArray(data)) return [];
            const accounts: string[] = [];
            for (const entry of data) {
                const number = typeof entry === 'string'
                    ? entry
                    : (entry as { number?: string } | null)?.number;
                if (number) accounts.push(toSignalNumber(number));
            }
            return accounts;
        } catch {
            return [];
        }
    }

    private activate(number: string) {
        this.number = toSignalNumber(number);
        this.clearLinkTimers();
        this.setState('linked');
        this.events.onQr(null);
        this.connectSocket();
    }

    private beginLinking() {
        this.setState('linking');
        this.linkDeadline = Date.now() + LINK_TIMEOUT_MS;
        void this.refreshQr();
        this.pollTimer = setInterval(() => void this.pollAccounts(), 2000);
    }

    private async pollAccounts() {
        if (this.stopped || this.state !== 'linking') return;
        const accounts = await this.getAccounts();
        if (accounts.length > 0) {
            this.activate(accounts[0]);
            return;
        }
        if (Date.now() > this.linkDeadline) {
            this.clearLinkTimers();
            this.events.onQr(null);
            this.setState('unavailable');
            this.events.onLog('Signal linking timed out — press r to retry');
        }
    }

    private async refreshQr() {
        if (this.stopped || this.state !== 'linking') return;
        try {
            const response = await fetch(
                `${this.apiUrl}/v1/qrcodelink?device_name=${encodeURIComponent('whatsapp-signal-tracker')}`,
                { signal: AbortSignal.timeout(15000) }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const png = new Uint8Array(await response.arrayBuffer());
            this.events.onQr(decodeQrPng(png));
        } catch (err) {
            this.events.onLog(`Signal link QR failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!this.stopped && this.state === 'linking') {
            this.refreshTimer = setTimeout(() => void this.refreshQr(), QR_REFRESH_MS);
        }
    }

    private connectSocket() {
        if (!this.number || this.stopped) return;
        const wsUrl = `${this.apiUrl.replace(/^http/, 'ws')}/v1/receive/${encodeURIComponent(this.number)}`;
        const socket = new WebSocket(wsUrl);
        this.ws = socket;

        socket.on('open', () => this.events.onLog('Signal receipt stream connected'));
        socket.on('message', (data: WebSocket.RawData) => this.handleSocketMessage(data.toString()));
        socket.on('error', (err: Error) => {
            this.events.onLog(`Signal stream error: ${err.message}`);
            this.scheduleSocketReconnect(socket);
        });
        socket.on('close', () => this.scheduleSocketReconnect(socket));
    }

    private handleSocketMessage(raw: string) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }
        const envelope = (parsed as {
            params?: { envelope?: Record<string, unknown> };
            envelope?: Record<string, unknown>;
        })?.params?.envelope ?? (parsed as { envelope?: Record<string, unknown> })?.envelope;
        if (!envelope) return;

        const receipt = envelope.receiptMessage as { isDelivery?: boolean } | undefined;
        if (!receipt?.isDelivery) return;

        const source = envelope.sourceNumber ?? envelope.source;
        if (typeof source === 'string' && source.length > 0) {
            this.events.onReceipt(toSignalNumber(source));
        }
    }

    private scheduleSocketReconnect(socket: WebSocket) {
        if (this.ws !== socket) return;
        this.ws = null;
        if (this.stopped || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectSocket();
        }, 5000);
    }

    private clearLinkTimers() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private clearTimers() {
        this.clearLinkTimers();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private setState(state: SignalState) {
        this.state = state;
        this.events.onState(state);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.clearTimers();
        const socket = this.ws;
        this.ws = null;
        try {
            socket?.close();
        } catch {
            // already closed
        }
    }
}
