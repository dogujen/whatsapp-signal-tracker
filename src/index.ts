import readline from 'node:readline';
import { App } from './app.js';
import { renderFrame } from './ui.js';
import type { ProbeMethod } from './types.js';

interface CliOptions {
    help: boolean;
    authDir: string;
    signalApi: string;
    probeMethod: ProbeMethod;
}

function parseOptions(argv: string[]): CliOptions {
    const options: CliOptions = {
        help: false,
        authDir: process.env.AUTH_DIR ?? 'auth_info_baileys',
        signalApi: process.env.SIGNAL_API_URL ?? 'http://localhost:8080',
        probeMethod: 'delete'
    };

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--auth-dir=')) {
            options.authDir = arg.slice('--auth-dir='.length);
        } else if (arg.startsWith('--signal-api=')) {
            options.signalApi = arg.slice('--signal-api='.length);
        } else if (arg === '--probe=delete' || arg === '--probe=reaction') {
            options.probeMethod = arg === '--probe=delete' ? 'delete' : 'reaction';
        } else if (arg.length > 0) {
            process.stderr.write(`unknown argument: ${arg}\n`);
            options.help = true;
        }
    }

    return options;
}

function usage(): string {
    return [
        'WhatsApp & Signal Tracker — full CLI',
        '',
        'Usage: npm start -- [options]',
        '',
        'Options:',
        '  --auth-dir=DIR            WhatsApp auth folder (default auth_info_baileys)',
        '  --signal-api=URL          signal-cli-rest-api base URL (default http://localhost:8080)',
        '  --probe=delete|reaction   WhatsApp probe method (default delete)',
        '  -h, --help                Show this help',
        '',
        'Keys: a add · x remove · p probe · w platform · ↑/↓ select · r retry signal · q quit',
        'Signal requires a running signal-cli-rest-api instance.',
        ''
    ].join('\n');
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }

    const app = new App({
        authDir: options.authDir,
        signalApi: options.signalApi,
        probeMethod: options.probeMethod
    });

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('The CLI needs an interactive terminal.\n');
        process.exitCode = 1;
        return;
    }

    const out = process.stdout;
    let drawTimer: NodeJS.Timeout | null = null;
    let clockTimer: NodeJS.Timeout | null = null;
    let exiting = false;

    const draw = () => {
        drawTimer = null;
        const frame = renderFrame(app.snapshot(), {
            cols: out.columns || 110,
            rows: out.rows || 40
        });
        out.write('\x1b[H' + frame.join('\n') + '\x1b[0J');
    };

    const requestDraw = () => {
        if (drawTimer) return;
        drawTimer = setTimeout(draw, 60);
    };

    const shutdown = async () => {
        if (exiting) return;
        exiting = true;
        if (drawTimer) clearTimeout(drawTimer);
        if (clockTimer) clearInterval(clockTimer);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
        await app.stop();
        process.exit(0);
    };

    app.onChange = requestDraw;
    app.onQuit = () => void shutdown();
    process.stdout.on('resize', requestDraw);

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (sequence: string, key: readline.Key) => {
        app.handleKey(sequence ?? '', { name: key?.name, ctrl: key?.ctrl });
    });

    out.write('\x1b[?1049h\x1b[?25l');
    clockTimer = setInterval(requestDraw, 1000);

    await app.start();
    draw();
}

void main();
