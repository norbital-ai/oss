import { expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Schema } from 'effect';
import { input_schema } from '@norbital-ai/store/kind';
import {
	decodePublicHydration,
	public_read_key,
	PublicBoot,
	toPublicBoot
} from '../src/protocol/public-page.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import { stored_file_url } from '../src/page/file-ref.ts';
import { create_bolt } from '../src/page/bolt.ts';
import { renderPublicPage } from '../src/shell/public/server.ts';

const boot: PublicBoot = {
	workspace: { name: 'Public fixture', locale: 'en-SG', tz: 'Asia/Singapore' },
	actor: null,
	location: { pathname: '/app/portal/book', search: '?slot=morning' },
	base: '/fixture',
	visitor: { app: 'portal' },
	kiosk: null,
	contract: 'fixture-contract',
	describe: false,
	messages: {},
	catalog: {},
	automations: {},
	read_catalog: {},
	operation_outputs: { automations: {} }
};
const body = {
	route: 'app/portal/book',
	release: 'release-a',
	locale: 'en-SG',
	boot,
	reads: {}
};

it.effect('refuses interactive refresh during server rendering without pretending to reread data', () =>
	Effect.gen(function* () {
		let reads = 0;
		const result = yield* Effect.exit(renderPublicPage(
			boot,
			'2026-11-12T00:00:00Z',
			() => Effect.sync(() => { reads++; return {}; }),
			(ctx) => {
				ctx.refresh();
				return { body: 'Unreachable refresh', head: '' };
			}
		));
		expect(Exit.isFailure(result)).toBe(true);
		if (Exit.isFailure(result))
			expect(Cause.squash(result.cause)).toEqual(new Error('Start interactive page effects on mount.'));
		expect(reads).toBe(0);
	})
);

it('keeps native image previews and original downloads within one encoded public surface', () => {
	expect(stored_file_url('/fixture', 'file/a?b')).toBe('/fixture/__bolt/files/file%2Fa%3Fb');
	for (const preview of [64, 512, 1024] as const) {
		const url = new URL(
			stored_file_url('/fixture', 'file', { preview }, { app: 'public/jobs' }),
			'https://workspace.test'
		);
		expect([...url.searchParams]).toEqual([
			['preview', String(preview)],
			['app', 'public/jobs']
		]);
	}
	const kiosk = new URL(
		stored_file_url('/fixture', 'file', {}, { kiosk: 'lobby' }),
		'https://workspace.test'
	);
	expect([...kiosk.searchParams]).toEqual([['kiosk', 'lobby']]);
	expect(kiosk.searchParams.has('preview')).toBe(false);
	expect(kiosk.searchParams.has('app')).toBe(false);
});

it.effect(
	'decodes admitted reads and refuses a different route, release, locale or envelope shape',
	() =>
		Effect.gen(function* () {
			expect(
				yield* decodePublicHydration(JSON.stringify(body), {
					route: body.route,
					release: body.release
				})
			).toEqual({ boot, reads: body.reads });
			for (const changed of [
				{ ...body, route: 'app/portal/visits' },
				{ ...body, release: 'release-b' },
				{ ...body, locale: 'fr' },
				{ ...body, reads: 123 }
			]) {
				const result = yield* Effect.result(
					decodePublicHydration(JSON.stringify(changed), {
						route: body.route,
						release: body.release
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
);

it.effect(
	'projects public boot without internal workspace, navigation, agent or Studio metadata',
	() =>
		Effect.gen(function* () {
			const source: ShellBoot = {
				workspace: {
					...boot.workspace,
					environment: 'private-environment',
					apex: 'https://operator.invalid',
					organization: true
				},
				actor: null,
				name: null,
				admin: false,
				preview: null,
				nav: [],
				surfaces: { agent: true, studio: true, inbox: true, runs: true, settings: true },
				inbox: 0,
				kiosks: [],
				envoys: { private: 'private-envoy-name' },
				push: null,
				visitor: { app: 'portal' },
				catalog: {},
				automations: {},
				read_catalog: {},
				operation_outputs: { automations: {} },
				contract: boot.contract
			};
			const projected = yield* toPublicBoot(source, {
				base: boot.base,
				location: boot.location,
				kiosk: null
			});
			expect(projected).toEqual(boot);
			const text = JSON.stringify(projected);
			for (const privateText of [
				'private-environment',
				'operator.invalid',
				'organization',
				'surfaces',
				'envoys',
				'private-envoy-name'
			])
				expect(text).not.toContain(privateText);
		})
);

it.effect('seeds the hydrated query with its native decimal before the stream answers', () =>
	Effect.gen(function* () {
		const request = { jobs: { fields: ['total'] } };
		const key = public_read_key({ m: 'query', a: [request] });
		const rows = [{ id: 'job', total: '12.5' }];
		const props = yield* decodePublicHydration(
			JSON.stringify({ ...body, reads: { [key]: { jobs: { rows, next: null, total: 1 } } } }),
			{ route: body.route, release: body.release }
		);
		const client = yield* create_bolt({
			operation_outputs: boot.operation_outputs,
			actor: boot.actor,
			locale: boot.workspace.locale,
			initial_read: (read) => props.reads[public_read_key(read)]
		});
		const query = client.native_query(
			{ m: 'query', a: [request] },
			Schema.Struct({
				jobs: Schema.Struct({
					rows: Schema.Array(
						Schema.Struct({ id: Schema.String, total: input_schema({ kind: 'decimal', scale: 1 }) })
					),
					next: Schema.NullOr(Schema.String),
					total: Schema.Number
				})
			})
		);
		const total = query.current?.jobs.rows[0]?.total;
		expect(total).toBeTypeOf('string');
		expect(String(total)).toBe('12.5');
		expect(query.loading).toBe(false);
	})
);

it.effect('retains search-index metadata in public hydration', () =>
	Effect.gen(function* () {
		const catalog = {
			orders: {
				record_label: 'record.title',
				label: ['title'],
				fields: { title: { kind: 'text' as const } },
				indexes: { hue: { description: 'Hue', input: { r: { kind: 'number' as const } } } }
			}
		};
		const decoded = yield* decodePublicHydration(
			JSON.stringify({ ...body, boot: { ...boot, catalog } }),
			{ route: body.route, release: body.release }
		);
		expect(decoded.boot.catalog).toEqual(catalog);
	})
);
