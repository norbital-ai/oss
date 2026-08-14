#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const packageRoot = process.cwd();
const sourceRoot = path.join(packageRoot, 'src/quality');
const outputRoot = path.join(packageRoot, 'build/quality');

if (!existsSync(outputRoot)) {
	console.error('[copy-quality-assets] build/quality missing — run svelte-package first');
	process.exit(1);
}

cpSync(path.join(sourceRoot, 'scan.mjs'), path.join(outputRoot, 'scan.mjs'));
mkdirSync(path.join(outputRoot, 'tenant'), { recursive: true });
cpSync(path.join(sourceRoot, 'tenant'), path.join(outputRoot, 'tenant'), { recursive: true });
