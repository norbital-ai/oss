/** --prepare writes initial source only; --write independently replays and records native proofs. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem } from 'effect';
import { StoreError, checksum_of, log_ddl, log_snapshot, read_lock } from '@norbital-ai/store';
import { audit_log_spec } from '../src/audit/schema.ts';

const prepareOnly = process.argv.includes('--prepare'),
	write = process.argv.includes('--write');
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	for (const scoped of [false, true]) {
		const directory = fileURLToPath(
			new URL(`../src/audit/${scoped ? 'scoped' : 'standalone'}/`, import.meta.url)
		);
		const spec = audit_log_spec(scoped);
		if (prepareOnly) {
			const source = [
				[
					'0001_initial.sql',
					// The extension prerequisite (first two statements) runs before every replay.
					`-- step initial_log (additive)\n${(yield* log_ddl(spec)).slice(2).join(';\n')};\n`
				],
				['snapshot.json', log_snapshot(spec)]
			] as const;
			for (const [name, text] of source) {
				const file = join(directory, name);
				if (yield* fs.exists(file)) {
					if ((yield* fs.readFileString(file)) !== text)
						return yield* StoreError.of(
							'migration_changed',
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
			const previous = yield* read_lock(yield* fs.readFileString(lockFile));
			for (const [name, checksum] of Object.entries(previous.files))
				if (checksum_of(files.find((file) => file.name === name) ?? { name, sql: '' }) !== checksum)
					return yield* StoreError.of(
						'migration_changed',
						'admission',
						`${name}: committed log SQL is immutable`
					);
		}
		const { audit_migration_proof } = yield* Effect.promise(
			() => import('../src/audit/migrations.ts')
		);
		const proof = yield* audit_migration_proof(
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
				'migration_changed',
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
