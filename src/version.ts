import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Server version, read from package.json so that it is declared in one place.
 * The path resolves both from src/ (ts-node) and from build/ (compiled output).
 */
export const SERVER_VERSION: string = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
