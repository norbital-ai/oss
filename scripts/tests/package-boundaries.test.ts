// Provider and host facilities must stay usable without importing a workspace engine or another host.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Schema } from 'effect';
const Package = Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) });
const dependencies = (name: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Package))(
		readFileSync(new URL(`../../packages/${name}/package.json`, import.meta.url), 'utf8')
	).dependencies;
it.each(['host-api', 'providers'])(
	'%s has no transitive dependency on Bolt or its standalone host',
	(name) => {
		const seen = new Set<string>();
		const visit = (name: string) => {
			if (seen.has(name)) return;
			seen.add(name);
			for (const dependency of Object.keys(dependencies(name)))
				if (dependency.startsWith('@norbital-ai/')) {
					const child = dependency.slice('@norbital-ai/'.length);
					expect(['bolt', 'bolt-cli', 'bolt-server', 'ui'], `${name} → ${child}`).not.toContain(
						child
					);
					visit(child);
				}
		};
		visit(name);
	}
);
it('the compiler dependency closure does not include delivery providers', () => {
	const seen = new Set<string>();
	const visit = (name: string) => {
		for (const dependency of Object.keys(dependencies(name))) {
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			if (dependency.startsWith('@norbital-ai/')) visit(dependency.slice('@norbital-ai/'.length));
		}
	};
	visit('bolt-cli');
	for (const provider of ['@norbital-ai/providers', 'web-push', 'imapflow', 'nodemailer'])
		expect(seen).not.toContain(provider);
});
