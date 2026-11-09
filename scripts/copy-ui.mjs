import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'ui');
const destination = path.join(root, 'dist', 'ui');

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });