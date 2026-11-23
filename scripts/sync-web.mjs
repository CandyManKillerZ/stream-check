// Copies the shared web UI (web/) into desktop/frontend/dist, which Wails
// embeds into the .exe. Run automatically by `wails build` (see wails.json).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'desktop', 'frontend', 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'web'), dist, { recursive: true });
console.log('web/ -> desktop/frontend/dist');
