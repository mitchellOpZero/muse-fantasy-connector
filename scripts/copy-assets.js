// Copies src/static/* into dist/static so the compiled server can serve them.
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'static');
const dest = path.join(here, '..', 'dist', 'static');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('copied static assets to dist/static');
