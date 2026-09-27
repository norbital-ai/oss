/// <reference types="node" />
// The package entries of §3.3.10 (L-BOLT-940, L-BOLT-1034): `/protocol` (the 13 C8/C9 types), `/type-service`
// (`typeService`) and `/isolate-globals` (`IsolateGlobals`) are exported, each built from its source.
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type * as Protocol from '../src/protocol/index.ts';
import type { IsolateGlobals } from '../src/engine/guest/globals.ts';
import * as TypeService from '../src/tooling/type-service.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, { types: string; default: string }> };

it('exports the protocol, type-service and isolate-globals entries over existing sources', () => {
	expect(Object.keys(pkg.exports)).toEqual(['.', './client', './engine', './artifact', './protocol', './type-service', './docs', './isolate-globals', './test', './test/browser']);
	for (const [entry, t] of Object.entries(pkg.exports)) {
		expect(t.types, entry).toBe(t.default.replace(/\.js$/, '.d.ts'));
		expect(existsSync(new URL(t.default.replace('./build/', '../src/').replace(/\.js$/, '.ts'), import.meta.url)), entry).toBe(true);
	}
	expect(Object.keys(TypeService)).toEqual(['typeService']);
});

it('the protocol entry is exactly the 13 wire and artifact types', () => {
	const names = [...readFileSync(new URL('../src/protocol/index.ts', import.meta.url), 'utf8').matchAll(/^export type (\w+)/gm)].map((m) => m[1]);
	expect(names).toEqual(['QueryRequest', 'QueryResponse', 'ActRequest', 'ActResponse', 'LiveRegister', 'LiveFrame', 'FileUploadHeaders',
		'SessionRequest', 'SessionResponse', 'HostOperation', 'HostOperationResult', 'ArtifactDescriptor', 'ContractDigest']);
	// the types are usable as a host outside Bolt would use them
	const q: Protocol.QueryRequest = { reads: [{ m: 'read', a: ['orders', {}] }] };
	const h: Protocol.FileUploadHeaders = { 'Idempotency-Key': 'u1' };
	const g: keyof IsolateGlobals = 'structuredClone';
	expect([q.reads.length, h['Idempotency-Key'], g]).toEqual([1, 'u1', 'structuredClone']);
});
