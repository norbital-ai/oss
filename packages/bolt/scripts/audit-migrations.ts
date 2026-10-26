/** --prepare writes initial source only; --write independently replays and records native proofs. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem } from 'effect';
import { StoreError, checksumOf, readLock } from '@norbital-ai/store';
import { logNativeUpgrade, logNativeValidation } from '../../store/src/log/ddl.ts';
import { logSnapshot } from '../../store/src/log/spec.ts';
import { auditLogSpec } from '../src/node/audit-schema.ts';

const prepareOnly = process.argv.includes('--prepare'),
	write = process.argv.includes('--write');
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	for (const scoped of [false, true]) {
		const directory = fileURLToPath(
			new URL(`../src/node/audit/${scoped ? 'scoped' : 'standalone'}/`, import.meta.url)
		);
		const spec = auditLogSpec(scoped);
		if (prepareOnly) {
			const source = [
				[
					'0002_declaration.sql',
					`-- step declared_log (validating)\n-- hazard: brief metadata locks; new writes are checked immediately; existing rows validate in the next transaction.\n${(yield* logNativeUpgrade(spec)).join(';\n')};\n`
				],
				[
					'0003_validation.sql',
					`-- step validate_log (validating)\n-- hazard: scans existing records with a lock that permits ordinary reads and writes.\n${(yield* logNativeValidation(spec)).join(';\n')};\n`
				],
				['snapshot.json', logSnapshot(spec)]
			] as const;
			for (const [name, text] of source) {
				const file = join(directory, name);
				if (yield* fs.exists(file)) {
					if ((yield* fs.readFileString(file)) !== text)
						return yield* StoreError.of(
							'migrationChanged',
							'admission',
							`${file}: source already exists; add a new migration instead of rewriting it`
						);
				} else yield* fs.writeFileString(file, text);
			}
			continue;
		}
		const files = yield* Effect.forEach(
			(yield* fs.readDirectory(directory))
				.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
				.sort(),
			(name) => Effect.map(fs.readFileString(join(directory, name)), (sql) => ({ name, sql }))
		);
		const lockFile = join(directory, 'migrations.lock.json');
		if (yield* fs.exists(lockFile)) {
			const previous = yield* readLock(yield* fs.readFileString(lockFile));
			for (const [name, checksum] of Object.entries(previous.files))
				if (checksumOf(files.find((file) => file.name === name) ?? { name, sql: '' }) !== checksum)
					return yield* StoreError.of(
						'migrationChanged',
						'admission',
						`${name}: committed log SQL is immutable`
					);
		}
		const { auditMigrationProof } = yield* Effect.promise(
			() => import('../src/node/audit-migrations.ts')
		);
		const proof = yield* auditMigrationProof(
			spec,
			files,
			yield* fs.readFileString(join(directory, 'snapshot.json'))
		);
		if (write) {
			yield* fs.writeFileString(lockFile, proof.lock);
			yield* fs.writeFileString(join(directory, 'physical.json'), proof.physical);
		} else if (
			!(yield* fs.exists(lockFile)) ||
			(yield* fs.readFileString(lockFile)) !== proof.lock ||
			!(yield* fs.exists(join(directory, 'physical.json'))) ||
			(yield* fs.readFileString(join(directory, 'physical.json'))) !== proof.physical
		)
			return yield* StoreError.of(
				'migrationChanged',
				'admission',
				'log native proofs differ; run audit-migrations.ts --write'
			);
	}
	yield* Console.log(
		prepareOnly
			? 'Audit migration source prepared; no verification or database work executed.'
			: 'Both audit log declarations and native migration prefixes verified.'
	);
}).pipe(Effect.provide(NodeServices.layer));
NodeRuntime.runMain(program);
