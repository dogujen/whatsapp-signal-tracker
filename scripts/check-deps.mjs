import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(cliRoot, 'node_modules', 'tsx', 'package.json');

if (!existsSync(marker)) {
    console.error('Dependencies are not installed in node_modules.');
    console.error('Run:');
    console.error('  npm install');
    process.exit(1);
}
