import qrcode from 'qrcode-terminal';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

// jsqr ships a UMD bundle whose runtime export is the decoder function, but its
// declaration file models it as a default export of a CommonJS module. Under
// NodeNext an ESM default import is typed as the module namespace, so the
// callable runtime value needs an explicit type.
type JsQrDecoder = (
    data: Uint8ClampedArray,
    width: number,
    height: number,
) => { data: string } | null;

const decodeMatrix = jsQR as unknown as JsQrDecoder;

export interface QrBlock {
    lines: string[];
    width: number;
}

export function renderQr(text: string): Promise<QrBlock> {
    return new Promise<QrBlock>((resolve, reject) => {
        qrcode.generate(text, { small: true }, (result: string) => {
            if (!result) {
                reject(new Error('QR render failed'));
                return;
            }
            const lines = result.split('\n');
            while (lines.length > 0 && lines[lines.length - 1] === '') {
                lines.pop();
            }
            const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
            resolve({ lines, width });
        });
    });
}

export function decodeQrPng(png: Uint8Array): string {
    const image = PNG.sync.read(Buffer.from(png));
    const decoded = decodeMatrix(new Uint8ClampedArray(image.data), image.width, image.height);
    if (!decoded) {
        throw new Error('QR code not found in image');
    }
    return decoded.data;
}
