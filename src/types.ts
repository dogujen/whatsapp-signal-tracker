export type Platform = 'whatsapp' | 'signal';
export type ProbeMethod = 'delete' | 'reaction';
export type DeviceState = 'Calibrating' | 'Online' | 'Standby' | 'OFFLINE';
export type WaStatus = 'starting' | 'qr' | 'open' | 'closed' | 'logged-out';
export type SignalState = 'starting' | 'unavailable' | 'linking' | 'linked';

export interface QrView {
    title: string;
    lines: string[];
    width: number;
}

export interface ContactView {
    id: string;
    platform: Platform;
    number: string;
    presence: string | null;
    state: DeviceState;
    rtt: number | null;
    avg: number;
    median: number;
    threshold: number;
    samples: number[];
    sampleCount: number;
    probes: number;
    acks: number;
    slow: number;
    minRtt: number;
    maxRtt: number;
    ageMs: number;
}

export interface InputView {
    label: string;
    value: string;
}

export interface ViewState {
    clock: string;
    waStatus: WaStatus;
    signalState: SignalState;
    signalNumber: string | null;
    signalApi: string;
    probeMethod: ProbeMethod;
    addPlatform: Platform;
    contacts: ContactView[];
    selected: number;
    qrs: QrView[];
    input: InputView | null;
    hint: string | null;
    log: string[];
}
