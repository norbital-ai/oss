import { it, expect } from '@effect/vitest';
import { Effect } from 'effect';
import { StoreError } from '@norbital-ai/store';
import { auditMigrationProof, readAuditMigrations } from '../src/node/audit-migrations.ts';

it.live('proves the native audit history against its declaration', () =>
	Effect.gen(function* () {
		const migrations = yield* readAuditMigrations(true);
		const proof = yield* auditMigrationProof(
			migrations.spec,
			migrations.files,
			migrations.snapshot
		);
		expect(proof.lock).toBe(migrations.lock);
		expect(proof.physical).toBe(migrations.physical);
	})
);

it.live('rejects an audit migration that grants public access', () =>
	Effect.gen(function* () {
		const migrations = yield* readAuditMigrations(true);
		const edited = migrations.files.map((file, index) =>
			index !== migrations.files.length - 1
				? file
				: { ...file, sql: `${file.sql}\nGRANT USAGE ON SCHEMA bolt_audit TO PUBLIC;\n` }
		);
		const refused = yield* Effect.flip(
			auditMigrationProof(migrations.spec, edited, migrations.snapshot)
		);
		expect(refused).toBeInstanceOf(StoreError);
		if (refused instanceof StoreError) expect(refused.code).toBe('migrationChanged');
	})
);
