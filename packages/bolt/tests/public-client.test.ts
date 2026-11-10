import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import {
	decodePublicHydration,
	publicReadKey,
	PublicBoot,
	toPublicBoot
} from '../src/protocol/public-page.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import { storedFileUrl } from '../src/page/file-ref.ts';
import { createBolt } from '../src/page/bolt.ts';

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
	automations: {}
};
const body = {
	route: 'app/portal/book',
	release: 'release-a',
	locale: 'en-SG',
	boot,
	reads: {}
};

it('keeps native image previews and original downloads within one encoded public surface', () => {
	expect(storedFileUrl('/fixture', 'file/a?b')).toBe('/fixture/__bolt/files/file%2Fa%3Fb');
	for (const preview of [64, 512, 1024] as const) {
		const url = new URL(
			storedFileUrl('/fixture', 'file', { preview }, { app: 'public/jobs' }),
			'https://workspace.test'
		);
		expect([...url.searchParams]).toEqual([
			['preview', String(preview)],
			['app', 'public/jobs']
		]);
	}
	const kiosk = new URL(
		storedFileUrl('/fixture', 'file', {}, { kiosk: 'lobby' }),
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
		const key = publicReadKey({ m: 'query', a: [request] });
		const rows = [{ id: 'job', total: { $dec: '12.5' } }];
		const props = yield* decodePublicHydration(
			JSON.stringify({ ...body, reads: { [key]: { jobs: { rows, next: null } } } }),
			{ route: body.route, release: body.release }
		);
		const client = yield* createBolt({
			actor: boot.actor,
			locale: boot.workspace.locale,
			initialRead: (read) => props.reads[publicReadKey(read)]
		});
		const query = client.query<{ jobs: { rows: readonly { total: Decimal }[] } }>(request);
		expect(query.current?.jobs.rows[0]?.total).toBeInstanceOf(Decimal);
		expect(query.current?.jobs.rows[0]?.total.toString()).toBe('12.5');
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
