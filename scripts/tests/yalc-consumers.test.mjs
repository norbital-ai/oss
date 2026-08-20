import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensurePureInstallation, managedPackages, stalePackages } from '../lib/yalc-consumers.mjs';

const fixture = () => mkdtempSync(path.join(tmpdir(), 'norbital-yalc-consumer-'));
const writeJson = (file, value) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('managedPackages finds clean exact-version consumers as well as existing overlays', () => {
	const root = fixture();
	try {
		writeJson(path.join(root, 'package.json'), {
			dependencies: {
				'@norbital-ai/bolt': '0.0.12',
				'@norbital-ai/ui': 'file:.yalc/@norbital-ai/ui',
				effect: '4.0.0-rc.109'
			},
			devDependencies: { typescript: '6.0.3' }
		});
		assert.deepEqual(managedPackages(root), ['@norbital-ai/bolt', '@norbital-ai/ui']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('ensurePureInstallation establishes a clean link before converting it to pure', () => {
	const root = fixture();
	try {
		const manifestPath = path.join(root, 'package.json');
		const lockPath = path.join(root, 'yalc.lock');
		writeJson(manifestPath, {
			dependencies: {
				'@norbital-ai/bolt': '0.0.12',
				'@norbital-ai/ui': 'file:.yalc/@norbital-ai/ui'
			}
		});
		writeJson(lockPath, {
			packages: { '@norbital-ai/ui': { replaced: '0.0.12', file: true } }
		});
		for (const name of ['bolt', 'ui']) {
			mkdirSync(path.join(root, 'node_modules/@norbital-ai', name), { recursive: true });
			mkdirSync(path.join(root, 'node_modules/@norbital-ai', `.ignored_${name}`), {
				recursive: true
			});
		}

		const calls = [];
		const run = (_command, args) => {
			calls.push(args);
			const names = args.filter((argument) => argument.startsWith('@norbital-ai/'));
			const manifest = readJson(manifestPath);
			const lock = readJson(lockPath);
			for (const name of names) {
				const short = name.slice('@norbital-ai/'.length);
				mkdirSync(path.join(root, '.yalc/@norbital-ai', short), { recursive: true });
				if (!args.includes('--pure')) {
					const replaced = manifest.dependencies[name];
					manifest.dependencies[name] = `file:.yalc/${name}`;
					lock.packages[name] = { replaced, file: true };
				} else {
					lock.packages[name] = { ...lock.packages[name], pure: true };
					delete lock.packages[name].file;
				}
			}
			writeJson(manifestPath, manifest);
			writeJson(lockPath, lock);
		};

		assert.deepEqual(
			ensurePureInstallation({
				consumerDirectory: root,
				names: ['@norbital-ai/bolt', '@norbital-ai/ui'],
				yalcBin: '/fake/yalc',
				run
			}),
			['@norbital-ai/bolt', '@norbital-ai/ui']
		);
		assert.deepEqual(calls, [
			['add', '@norbital-ai/bolt'],
			['add', '--pure', '@norbital-ai/bolt', '@norbital-ai/ui']
		]);
		assert.equal(
			readJson(manifestPath).dependencies['@norbital-ai/bolt'],
			'file:.yalc/@norbital-ai/bolt'
		);
		assert.equal(readJson(lockPath).packages['@norbital-ai/bolt'].replaced, '0.0.12');
		assert.equal(readJson(lockPath).packages['@norbital-ai/bolt'].pure, true);
		assert.equal(existsSync(path.join(root, 'node_modules/@norbital-ai/bolt')), false);
		assert.equal(existsSync(path.join(root, 'node_modules/@norbital-ai/.ignored_ui')), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('ensurePureInstallation refuses a partial --only store on a clean consumer', () => {
	const root = fixture();
	try {
		writeJson(path.join(root, 'package.json'), {
			dependencies: { '@norbital-ai/bolt': '0.0.12' }
		});
		assert.throws(
			() =>
				ensurePureInstallation({
					consumerDirectory: root,
					names: ['@norbital-ai/bolt'],
					yalcBin: '/fake/yalc',
					run: () => undefined
				}),
			/without --only/
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('stalePackages compares the pushed and materialised signatures', () => {
	const root = fixture();
	try {
		writeJson(path.join(root, '.yalc/@norbital-ai/bolt/package.json'), {
			yalcSignature: 'new'
		});
		writeJson(path.join(root, 'node_modules/@norbital-ai/bolt/package.json'), {
			yalcSignature: 'old'
		});
		writeJson(path.join(root, '.yalc/@norbital-ai/ui/package.json'), {
			yalcSignature: 'same'
		});
		writeJson(path.join(root, 'node_modules/@norbital-ai/ui/package.json'), {
			yalcSignature: 'same'
		});
		assert.deepEqual(stalePackages(root, ['@norbital-ai/bolt', '@norbital-ai/ui']), [
			'@norbital-ai/bolt'
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
