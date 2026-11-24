import { Effect, Schema } from 'effect';
import { expect, layer, TestWorkspace } from '../../bolt-cli/src/test/effect.ts';
import { id_of } from '../src/decl/id.ts';
import { manifest } from './catalogue-fixture.ts';
import { PersonalPreferences } from '../src/decl/preferences.ts';
import { schema_slice } from '../src/engine/schema/plan.ts';
import { WORKSPACE_SETTINGS_ID, workspace_settings_objects } from '../src/system/settings.ts';

const Personal = Schema.Struct({ sys_user: Schema.Struct({
	rows: Schema.Array(Schema.Struct({ id: id_of('sys_user'), name: Schema.String, revision: Schema.Number, preferences: PersonalPreferences })),
	next: Schema.NullOr(Schema.String), total: Schema.Number
}) });

layer(TestWorkspace.layer({ manifest }))('native personal settings', (it) => {
	it.effect('uses ordinary read and act with own-row scope, field guards and revision conflicts', () => Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const me = t.member([]), other = t.member([]);
		const caller = yield* t.as(me);
		yield* t.as(other);
		const request = { sys_user: { output: 'personal', fields: ['name', 'preferences', 'revision'], limit: 10 } } as const;
		const before = yield* Schema.decodeUnknownEffect(Personal)(yield* caller.query(request));
		expect(before.sys_user.rows).toHaveLength(1);
		const row = before.sys_user.rows[0];
		if (row === undefined) throw new Error('Missing personal row');
		expect(row.id).toBe(me.id);
		expect(row.preferences).toEqual({});
		yield* caller.act({ 'sys_user.update': [{ target: { id: row.id, revision: row.revision }, set: { preferences: { appearance: 'dark', locale: 'zh', email_notifications: false } } }] });
		const changed = yield* Schema.decodeUnknownEffect(Personal)(yield* caller.query(request));
		expect(changed.sys_user.rows[0]).toMatchObject({ preferences: { appearance: 'dark', locale: 'zh', email_notifications: false }, revision: row.revision + 1 });
		expect(yield* Effect.flip(caller.act({ 'sys_user.update': [{ target: { id: row.id, revision: row.revision }, set: { name: 'Stale write' } }] }))).toMatchObject({ _tag: 'ActConflict' });
		expect(yield* Effect.flip(caller.act({ 'sys_user.update': [{ target: { id: Schema.decodeUnknownSync(id_of('sys_user'))(other.id) }, set: { preferences: { appearance: 'light' } } }] }))).toMatchObject({ _tag: 'ActRefused' });
		expect(yield* Effect.flip(caller.act({ 'sys_user.update': [{ target: { id: row.id }, set: { name: '   ' } }] }))).toMatchObject({ code: 'check' });
		expect(yield* Effect.flip(caller.query({ sys_user: { fields: ['email'], limit: 1 } }))).toMatchObject({ _tag: 'ReadFailed' });
		const protectedWrite: Record<string, import('../src/decl/values.ts').Json> = { 'sys_user.update': [{ target: { id: me.id }, set: { admin: true } }] };
		expect(yield* Effect.flip(caller.act(protectedWrite))).toMatchObject({ _tag: 'ActRefused' });
		const invalid: Record<string, import('../src/decl/values.ts').Json> = { 'sys_user.update': [{ target: { id: me.id }, set: { preferences: { appearance: 'unknown' } } }] };
		expect(yield* Effect.flip(caller.act(invalid))).toMatchObject({ _tag: 'ActRefused' });
		expect(yield* Effect.flip(caller.act({ 'sys_workspace.update': [{ target: { id: Schema.decodeUnknownSync(id_of('sys_workspace'))(WORKSPACE_SETTINGS_ID) }, set: { name: 'Forbidden' } }] }))).toMatchObject({ _tag: 'ActRefused' });
		const admin = yield* t.as(t.admin);
		yield* admin.act({ 'sys_workspace.update': [{ target: { id: Schema.decodeUnknownSync(id_of('sys_workspace'))(WORKSPACE_SETTINGS_ID), revision: 1 }, set: { name: 'Operations' } }] });
		const [stored] = yield* t.db.read([{ text: 'SELECT name FROM sys_workspace', params: [] }]);
		expect(stored?.rows).toEqual([{ name: 'Operations' }]);
	}));
 it.effect('moves the former display override once without exposing private configuration', () => Effect.gen(function* () {
  const t = yield* TestWorkspace;
  yield* t.db.write({ text: "INSERT INTO sys_config (key, value) VALUES ('workspace.identity', '{\"name\":\"Existing desk\"}'), ('test.private', 'private fixture')", params: [] });
  yield* t.db.write({ text: 'DELETE FROM sys_workspace', params: [] });
  const objects = workspace_settings_objects(schema_slice(t.manifest).tables);
  const statements = objects.flatMap(o => o.create.map(text => ({ text, params: [] })));
  yield* t.db.transaction({ statements });
  yield* t.db.transaction({ statements });
  const [workspace, configuration] = yield* t.db.read([
   { text: 'SELECT name FROM sys_workspace', params: [] },
   { text: "SELECT key FROM sys_config WHERE key IN ('workspace.identity','test.private')", params: [] }
  ]);
  expect(workspace?.rows).toEqual([{ name: 'Existing desk' }]);
  expect(configuration?.rows).toEqual([{ key: 'test.private' }]);
 }));

});
