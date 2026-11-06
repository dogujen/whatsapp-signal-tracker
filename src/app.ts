import { RttAnalyzer } from './rtt.js';
import { WhatsAppEngine } from './whatsapp.js';
import { SignalEngine, digitsOnly } from './signal.js';
import { renderQr } from './qr.js';
import type { ContactView, Platform, ProbeMethod, QrView, SignalState, ViewState, WaStatus } from './types.js';

const WHATSAPP_TIMEOUT_MS = 10000;
const SIGNAL_TIMEOUT_MS = 15000;

interface LiveContact {
    id: string;
    platform: Platform;
    number: string;
    jid: string | null;
    analyzer: RttAnalyzer;
    presence: string | null;
    deviceJids: Set<string>;
    running: boolean;
    token: number;
    probes: number;
    acks: number;
    slow: number;
    pendingSignal: { start: number; finish: (rtt: number | null) => void } | null;
}

export interface AppOptions {
    authDir: string;
    signalApi: string;
    probeMethod: ProbeMethod;
}

export interface KeyEvent {
    name?: string;
    ctrl?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class App {
    private readonly options: AppOptions;
    private wa: WhatsAppEngine | null = null;
    private signal: SignalEngine | null = null;

    private waStatus: WaStatus = 'starting';
    private signalState: SignalState = 'starting';
    private signalNumber: string | null = null;

    private contacts: LiveContact[] = [];
    private selected = 0;
    private probeMethod: ProbeMethod;
    private addPlatform: Platform = 'whatsapp';

    private qrWhatsApp: string | null = null;
    private qrSignal: string | null = null;
    private qrBlocks: { whatsapp: QrView | null; signal: QrView | null } = { whatsapp: null, signal: null };

    private input: { label: string; value: string } | null = null;
    private hint: string | null = null;
    private hintTimer: NodeJS.Timeout | null = null;
    private logLines: string[] = [];
    private resolving = false;
    private stopped = false;

    onChange: (() => void) | null = null;
    onQuit: (() => void) | null = null;

    constructor(options: AppOptions) {
        this.options = options;
        this.probeMethod = options.probeMethod;
    }

    async start(): Promise<void> {
        this.wa = new WhatsAppEngine(this.options.authDir, {
            onQr: (qr) => {
                this.qrWhatsApp = qr;
                if (qr) {
                    void this.prepareQr('whatsapp', qr);
                } else {
                    this.qrBlocks.whatsapp = null;
                }
                this.touch();
            },
            onStatus: (status) => {
                this.waStatus = status;
                if (status === 'open') this.log('WhatsApp connected');
                this.touch();
            },
            onPresence: (presences) => this.applyPresence(presences),
            onLog: (message) => this.log(`WhatsApp: ${message}`)
        });

        this.signal = new SignalEngine(this.options.signalApi, {
            onState: (state) => {
                this.signalState = state;
                this.signalNumber = this.signal?.number ?? null;
                if (state === 'linked') this.log(`Signal linked as ${this.signalNumber ?? 'unknown'}`);
                this.touch();
            },
            onQr: (uri) => {
                this.qrSignal = uri;
                if (uri) {
                    void this.prepareQr('signal', uri);
                } else {
                    this.qrBlocks.signal = null;
                }
                this.touch();
            },
            onReceipt: (source) => this.handleSignalReceipt(source),
            onLog: (message) => this.log(`Signal: ${message}`)
        });

        this.log('starting WhatsApp session...');
        this.log(`Signal API: ${this.options.signalApi}`);

        void this.wa.connect().catch((err: unknown) => {
            this.waStatus = 'closed';
            this.log(`WhatsApp failed to start: ${errorText(err)}`);
            this.touch();
        });
        void this.signal.start().catch((err: unknown) => {
            this.signalState = 'unavailable';
            this.log(`Signal failed to start: ${errorText(err)}`);
            this.touch();
        });

        this.touch();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.hintTimer) {
            clearTimeout(this.hintTimer);
            this.hintTimer = null;
        }
        for (const contact of this.contacts) this.stopContact(contact);
        await this.wa?.stop();
        await this.signal?.stop();
    }

    handleKey(sequence: string, key: KeyEvent): void {
        if (key.ctrl && key.name === 'c') {
            this.onQuit?.();
            return;
        }

        if (this.input) {
            if (key.name === 'escape') {
                this.input = null;
                this.touch();
                return;
            }
            if (key.name === 'return' || key.name === 'enter') {
                const value = this.input.value;
                this.input = null;
                this.touch();
                void this.submitContact(value);
                return;
            }
            if (key.name === 'backspace') {
                this.input.value = this.input.value.slice(0, -1);
                this.touch();
                return;
            }
            if (!key.ctrl && sequence.length > 0 && !/[\x00-\x1f\x7f]/.test(sequence)) {
                this.input.value += sequence;
                this.touch();
            }
            return;
        }

        switch (key.name) {
            case 'q':
                this.onQuit?.();
                return;
            case 'up':
            case 'k':
                this.moveSelection(-1);
                return;
            case 'down':
            case 'j':
                this.moveSelection(1);
                return;
            case 'a':
                this.input = {
                    label: this.addPlatform === 'whatsapp' ? 'Add WhatsApp number' : 'Add Signal number',
                    value: ''
                };
                this.touch();
                return;
            case 'x':
                this.removeSelected();
                return;
            case 'p':
                this.toggleProbeMethod();
                return;
            case 'w':
            case 'tab':
                this.togglePlatform();
                return;
            case 'r':
                this.retrySignal();
                return;
            default:
                return;
        }
    }

    snapshot(): ViewState {
        const now = Date.now();
        return {
            clock: new Date().toLocaleTimeString('en-GB', { hour12: false }),
            waStatus: this.waStatus,
            signalState: this.signalState,
            signalNumber: this.signalNumber,
            signalApi: this.options.signalApi,
            probeMethod: this.probeMethod,
            addPlatform: this.addPlatform,
            contacts: this.contacts.map((contact) => this.toView(contact, now)),
            selected: this.selected,
            qrs: this.buildQrs(),
            input: this.input,
            hint: this.hint,
            log: this.logLines.slice(-4)
        };
    }

    private toView(contact: LiveContact, now: number): ContactView {
        const range = contact.analyzer.range;
        return {
            id: contact.id,
            platform: contact.platform,
            number: contact.number,
            presence: contact.presence,
            state: contact.analyzer.state,
            rtt: contact.analyzer.lastRtt,
            avg: contact.analyzer.average,
            median: contact.analyzer.median,
            threshold: contact.analyzer.threshold,
            samples: contact.analyzer.chartSamples(),
            sampleCount: contact.analyzer.sampleCount,
            probes: contact.probes,
            acks: contact.acks,
            slow: contact.slow,
            minRtt: range.min,
            maxRtt: range.max,
            ageMs: contact.analyzer.lastUpdate > 0 ? now - contact.analyzer.lastUpdate : -1
        };
    }

    private buildQrs(): QrView[] {
        const qrs: QrView[] = [];
        if (this.waStatus === 'qr' && this.qrBlocks.whatsapp) qrs.push(this.qrBlocks.whatsapp);
        if (this.signalState === 'linking' && this.qrBlocks.signal) qrs.push(this.qrBlocks.signal);
        return qrs;
    }

    private async prepareQr(platform: Platform, payload: string): Promise<void> {
        try {
            const block = await renderQr(payload);
            const current = platform === 'whatsapp' ? this.qrWhatsApp : this.qrSignal;
            if (current !== payload) return;
            const view: QrView = {
                title: platform === 'whatsapp'
                    ? 'WhatsApp — Linked Devices'
                    : 'Signal — Linked Devices',
                lines: block.lines,
                width: block.width
            };
            if (platform === 'whatsapp') {
                this.qrBlocks.whatsapp = view;
            } else {
                this.qrBlocks.signal = view;
            }
            this.touch();
        } catch (err) {
            this.log(`QR render failed: ${errorText(err)}`);
        }
    }

    private applyPresence(presences: Record<string, string>): void {
        let changed = false;
        for (const contact of this.contacts) {
            if (contact.platform !== 'whatsapp') continue;
            for (const [jid, presence] of Object.entries(presences)) {
                if (this.matchesContactJid(contact, jid)) {
                    contact.presence = presence;
                    changed = true;
                    break;
                }
            }
        }
        if (changed) this.touch();
    }

    private matchesContactJid(contact: LiveContact, jid: string): boolean {
        if (contact.deviceJids.has(jid)) return true;
        const base = jid.split('@')[0].split(':')[0];
        if (base === contact.number.replace(/\D/g, '')) return true;
        if (!contact.jid) return false;
        return contact.jid.split('@')[0].split(':')[0] === base;
    }

    private handleSignalReceipt(source: string): void {
        const key = digitsOnly(source);
        const contact = this.contacts.find((entry) => entry.platform === 'signal' && digitsOnly(entry.number) === key);
        const pending = contact?.pendingSignal;
        if (pending) pending.finish(Math.max(0, Date.now() - pending.start));
    }

    private moveSelection(delta: number): void {
        if (this.contacts.length === 0) return;
        this.selected = Math.min(this.contacts.length - 1, Math.max(0, this.selected + delta));
        this.touch();
    }

    private toggleProbeMethod(): void {
        this.probeMethod = this.probeMethod === 'delete' ? 'reaction' : 'delete';
        this.log(`probe method: ${this.probeMethod}`);
    }

    private togglePlatform(): void {
        this.addPlatform = this.addPlatform === 'whatsapp' ? 'signal' : 'whatsapp';
        this.setHint(`Adding numbers as ${this.addPlatform}`);
    }

    private retrySignal(): void {
        if (!this.signal) {
            this.setHint('Signal engine is not running');
            return;
        }
        this.qrSignal = null;
        this.qrBlocks.signal = null;
        this.log('retrying Signal connection...');
        void this.signal.retry().catch((err: unknown) => this.log(`Signal retry failed: ${errorText(err)}`));
        this.touch();
    }

    private removeSelected(): void {
        if (this.contacts.length === 0) return;
        const [removed] = this.contacts.splice(this.selected, 1);
        this.stopContact(removed);
        this.selected = Math.min(this.selected, Math.max(0, this.contacts.length - 1));
        this.log(`stopped tracking ${removed.number}`);
        this.setHint(`Stopped ${removed.number}`);
    }

    private createContact(id: string, platform: Platform, number: string, jid: string | null): LiveContact {
        return {
            id,
            platform,
            number,
            jid,
            analyzer: new RttAnalyzer(),
            presence: null,
            deviceJids: new Set<string>(),
            running: false,
            token: 0,
            probes: 0,
            acks: 0,
            slow: 0,
            pendingSignal: null
        };
    }

    private startLoop(contact: LiveContact): void {
        contact.running = true;
        const token = ++contact.token;
        if (contact.platform === 'whatsapp') {
            void this.whatsappLoop(contact, token);
        } else {
            void this.signalLoop(contact, token);
        }
    }

    private stopContact(contact: LiveContact): void {
        contact.running = false;
        contact.token++;
        contact.pendingSignal?.finish(null);
        contact.pendingSignal = null;
    }

    private async submitContact(raw: string): Promise<void> {
        const digits = raw.replace(/\D/g, '');
        if (digits.length < 6) {
            this.setHint('Enter a phone number including the country code');
            return;
        }
        if (this.resolving) return;
        this.resolving = true;
        this.setHint('Resolving number...', 15000);

        try {
            const duplicate = this.contacts.some(
                (contact) => contact.platform === this.addPlatform && digitsOnly(contact.number) === digits
            );
            if (duplicate) {
                this.setHint('Already tracking this number');
                return;
            }

            if (this.addPlatform === 'whatsapp') {
                if (!this.wa || this.waStatus !== 'open') {
                    this.setHint('WhatsApp is not connected yet');
                    return;
                }
                const found = await this.wa.isOnWhatsApp(digits);
                if (!found) {
                    this.setHint('Number is not on WhatsApp');
                    return;
                }
                const id = `whatsapp:${found.jid}`;
                if (this.contacts.some((contact) => contact.id === id)) {
                    this.setHint('Already tracking this number');
                    return;
                }
                const contact = this.createContact(id, 'whatsapp', digits, found.jid);
                this.contacts.push(contact);
                this.selected = this.contacts.length - 1;
                void this.wa.subscribePresence(found.jid);
                this.startLoop(contact);
                this.log(`tracking ${digits} on WhatsApp`);
                this.setHint(`Tracking ${found.name ?? digits} on WhatsApp`);
                return;
            }

            if (!this.signal || this.signalState !== 'linked') {
                this.setHint('Signal is not linked yet');
                return;
            }
            const number = `+${digits}`;
            const check = await this.signal.checkNumber(number);
            if (!check.registered) {
                this.setHint(check.error ?? 'Number is not on Signal');
                return;
            }
            const contact = this.createContact(`signal:${digits}`, 'signal', number, null);
            this.contacts.push(contact);
            this.selected = this.contacts.length - 1;
            this.startLoop(contact);
            this.log(`tracking ${number} on Signal`);
            this.setHint(`Tracking ${number} on Signal`);
        } catch (err) {
            this.setHint(`Add failed: ${errorText(err)}`, 6000);
        } finally {
            this.resolving = false;
            this.touch();
        }
    }

    private async whatsappLoop(contact: LiveContact, token: number): Promise<void> {
        while (contact.running && contact.token === token && !this.stopped) {
            const engine = this.wa;
            if (!engine || this.waStatus !== 'open' || !contact.jid) {
                await sleep(1000);
                continue;
            }
            contact.probes++;
            try {
                const result = await engine.probe(contact.jid, this.probeMethod, WHATSAPP_TIMEOUT_MS);
                if (!contact.running || contact.token !== token) break;
                if (result.rtt === null) {
                    contact.analyzer.offline(WHATSAPP_TIMEOUT_MS);
                    this.log(`${contact.number}: no CLIENT ACK, marked offline`);
                } else {
                    contact.acks++;
                    if (!contact.analyzer.add(result.rtt)) contact.slow++;
                    if (result.fromJid) contact.deviceJids.add(result.fromJid);
                }
                this.touch();
            } catch (err) {
                this.log(`${contact.number}: ${errorText(err)}`);
                await sleep(3000);
            }
            await sleep(2000 + Math.floor(Math.random() * 150));
        }
    }

    private async signalLoop(contact: LiveContact, token: number): Promise<void> {
        while (contact.running && contact.token === token && !this.stopped) {
            const engine = this.signal;
            if (!engine || this.signalState !== 'linked') {
                await sleep(1000);
                continue;
            }
            contact.probes++;
            const rtt = await this.runSignalProbe(contact, engine);
            if (!contact.running || contact.token !== token) break;
            if (rtt === null) {
                contact.analyzer.offline(SIGNAL_TIMEOUT_MS);
                this.log(`${contact.number}: no delivery receipt, marked offline`);
            } else {
                contact.acks++;
                if (!contact.analyzer.add(rtt)) contact.slow++;
            }
            this.touch();
            await sleep(1000 + Math.floor(Math.random() * 1000));
        }
    }

    private runSignalProbe(contact: LiveContact, engine: SignalEngine): Promise<number | null> {
        return new Promise<number | null>((resolve) => {
            let settled = false;
            const finish = (rtt: number | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                contact.pendingSignal = null;
                resolve(rtt);
            };
            const timer = setTimeout(() => finish(null), SIGNAL_TIMEOUT_MS);
            contact.pendingSignal = { start: Date.now(), finish };
            engine.probe(contact.number).catch((err: unknown) => {
                this.log(`${contact.number}: ${errorText(err)}`);
                finish(null);
            });
        });
    }

    private log(message: string): void {
        const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
        this.logLines.push(`${stamp} ${message}`);
        if (this.logLines.length > 40) this.logLines.shift();
        this.touch();
    }

    private setHint(message: string, ttl = 4000): void {
        this.hint = message;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => {
            this.hint = null;
            this.touch();
        }, ttl);
        this.touch();
    }

    private touch(): void {
        this.onChange?.();
    }
}
