import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import type { ProbeMethod, WaStatus } from './types.js';

export interface ProbeResult {
    rtt: number | null;
    fromJid: string | null;
}

export interface WhatsAppEvents {
    onQr: (qr: string | null) => void;
    onStatus: (status: WaStatus) => void;
    onPresence: (presences: Record<string, string>) => void;
    onLog: (message: string) => void;
}

interface PendingProbe {
    start: number;
    resolve: (result: ProbeResult) => void;
    timer: NodeJS.Timeout;
}

const MESSAGE_PREFIXES = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👻', '🔥', '✨'];

function randomMessageId(): string {
    const prefix = MESSAGE_PREFIXES[Math.floor(Math.random() * MESSAGE_PREFIXES.length)];
    return prefix + Math.random().toString(36).slice(2, 10).toUpperCase();
}

/**
 * WhatsApp probe engine.
 *
 * Probes are correlated by the message id returned from sendMessage: any
 * delivery receipt (CLIENT ACK status 3, or an "inactive" raw receipt) for that
 * id resolves the pending probe. This keeps attribution correct even when
 * receipts arrive from a linked-device (LID) JID instead of the phone-number JID.
 */
export class WhatsAppEngine {
    private readonly authDir: string;
    private readonly events: WhatsAppEvents;
    private sock: WASocket | undefined;
    private pending = new Map<string, PendingProbe>();
    private stopped = false;
    private reconnectTimer: NodeJS.Timeout | null = null;

    status: WaStatus = 'starting';

    constructor(authDir: string, events: WhatsAppEvents) {
        this.authDir = authDir;
        this.events = events;
    }

    get connected(): boolean {
        return this.status === 'open';
    }

    async connect(): Promise<void> {
        this.stopped = false;
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            markOnlineOnConnect: true
        });
        this.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.status = 'qr';
                this.events.onQr(qr);
                this.events.onStatus('qr');
            }

            if (connection === 'open') {
                this.status = 'open';
                this.events.onQr(null);
                this.events.onStatus('open');
            }

            if (connection === 'close') {
                this.failPendingProbes();
                if (this.stopped) return;

                const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    this.status = 'logged-out';
                    this.events.onQr(null);
                    this.events.onStatus('logged-out');
                    this.events.onLog('session logged out — delete the auth folder and restart');
                    return;
                }

                this.status = 'closed';
                this.events.onStatus('closed');
                this.scheduleReconnect();
            }
        });

        sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                const id = update.key.id;
                if (!id || !update.key.fromMe) continue;
                if (update.update.status === 3) {
                    this.completeProbe(id, update.key.remoteJid ?? null);
                }
            }
        });

        sock.ws.on('CB:receipt', (node: unknown) => {
            const attrs = (node as { attrs?: Record<string, string> } | undefined)?.attrs;
            if (!attrs?.id || attrs.type !== 'inactive') return;
            this.completeProbe(attrs.id, attrs.from ?? null);
        });

        sock.ev.on('presence.update', (update) => {
            const presences: Record<string, string> = {};
            for (const [jid, data] of Object.entries(update.presences ?? {})) {
                if (data?.lastKnownPresence) presences[jid] = data.lastKnownPresence;
            }
            if (Object.keys(presences).length > 0) this.events.onPresence(presences);
        });
    }

    async isOnWhatsApp(number: string): Promise<{ jid: string; name: string | null } | null> {
        const sock = this.sock;
        if (!sock || this.status !== 'open') return null;
        const digits = number.replace(/\D/g, '');
        const results = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
        const first = results?.[0];
        if (!first?.exists) return null;
        return { jid: first.jid, name: null };
    }

    async subscribePresence(jid: string): Promise<void> {
        try {
            await this.sock?.presenceSubscribe(jid);
        } catch {
            this.events.onLog(`presence subscription failed for ${jid}`);
        }
    }

    /**
     * Send a probe and wait for its delivery receipt. Resolves with
     * rtt === null when no ACK arrives within timeoutMs.
     */
    async probe(jid: string, method: ProbeMethod, timeoutMs: number): Promise<ProbeResult> {
        const sock = this.sock;
        if (!sock || this.status !== 'open') throw new Error('WhatsApp is not connected');

        const fakeId = randomMessageId();
        const content = method === 'delete'
            ? { delete: { remoteJid: jid, fromMe: true, id: fakeId } }
            : {
                react: {
                    text: REACTIONS[Math.floor(Math.random() * REACTIONS.length)],
                    key: { remoteJid: jid, fromMe: false, id: fakeId }
                }
            };

        const start = Date.now();
        const sent = await sock.sendMessage(jid, content);
        const id = sent?.key?.id;
        if (!id) throw new Error('probe was not accepted by WhatsApp');

        return await new Promise<ProbeResult>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ rtt: null, fromJid: null });
            }, timeoutMs);
            this.pending.set(id, { start, resolve, timer });
        });
    }

    private completeProbe(msgId: string, fromJid: string | null) {
        const pending = this.pending.get(msgId);
        if (!pending) return;
        this.pending.delete(msgId);
        clearTimeout(pending.timer);
        pending.resolve({ rtt: Math.max(0, Date.now() - pending.start), fromJid });
    }

    private failPendingProbes() {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.resolve({ rtt: null, fromJid: null });
        }
    }

    private scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped) return;
            this.events.onLog('reconnecting to WhatsApp...');
            void this.connect().catch((err: unknown) => {
                this.events.onLog(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
                this.scheduleReconnect();
            });
        }, 2000);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.failPendingProbes();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const sock = this.sock;
        this.sock = undefined;
        this.status = 'closed';
        try {
            sock?.end(undefined);
        } catch {
            // socket already closed
        }
    }
}
