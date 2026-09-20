import { Effect, Layer, Option, Redacted } from 'effect';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { HostConfig } from '../src/runtime/access/system-principal.js';
import { answerAppRequest } from '../src/runtime/pwa.js';
import * as Workspace from '../src/runtime/workspace.js';

const request = (url: string) =>
	Invocation.cases.Request.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make('pwa-1'),
		scope: {
			tenantId: TenantId.make('acme'),
			environment: EnvironmentName.make('production'),
			releaseId: ReleaseId.make('r1')
		},
		method: 'GET',
		url,
		headers: {}
	});

const workspace = Layer.succeed(
	Workspace.Service,
	Workspace.Service.of({ definition: { name: 'Acme Ops' } } as Workspace.Interface)
);
const hostRoot = (root: string) =>
	Layer.succeed(HostConfig, {
		read: () => Effect.succeed(Option.some(Redacted.make(root)))
	});

// The handler needs the workspace; `HostConfig` is read as an option, so a merged layer satisfies
// the same requirement with the mount configured.
type PwaLayer = Layer.Layer<Workspace.Interface>;
const answer = (url: string, layer: PwaLayer) =>
	Effect.runPromise(answerAppRequest(request(url)).pipe(Effect.provide(layer)));

const text = (body: Uint8Array | undefined): string => new TextDecoder().decode(body);

describe('installable workspace', () => {
	it('answers neither path for an ordinary request', async () => {
		expect(await answer('/people', workspace)).toBeUndefined();
	});

	it('scopes the manifest to the configured mount, with the tenant as the install id', async () => {
		const response = await answer(
			'/manifest.webmanifest',
			Layer.merge(workspace, hostRoot('https://core.example/__bolt/')) as unknown as PwaLayer
		);
		const manifest = JSON.parse(text(response?.body));
		expect(manifest).toMatchObject({
			id: 'acme',
			name: 'Acme Ops',
			start_url: '/__bolt',
			scope: '/__bolt/',
			display: 'standalone'
		});
		expect(response?.headers['content-type']).toEqual(['application/manifest+json; charset=utf-8']);
	});

	it('names the app as the document asked, as text', async () => {
		const response = await answer(
			'/__bolt/request/manifest.webmanifest?name=HR%20%26%20Payroll%20%3Cb%3E',
			workspace
		);
		expect(JSON.parse(text(response?.body)).name).toBe('HR & Payroll <b>');
		const worker = await answer('/__bolt/request/sw.js?name=HR%20%3Cb%3E', workspace);
		// The offline page carries the name as text; the push title carries it as a JS string.
		expect(text(worker?.body)).toContain('<h1>HR &#60;b&#62;</h1>');
		expect(text(worker?.body)).not.toContain('<h1>HR <b>');
	});

	it('reads the mount off an unstripped request path when no root is configured', async () => {
		const response = await answer('/__bolt/request/sw.js', workspace);
		expect(response?.headers['service-worker-allowed']).toEqual(['/__bolt/']);
		const worker = text(response?.body);
		expect(worker).toContain(`const STATIC = "/__bolt/static/"`);
		expect(worker).toContain('Acme Ops');
		expect(worker).toContain("request.mode === 'navigate'");
	});
});
