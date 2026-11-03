// Immutable definitions and field identities shared by revisions. Historical payloads keep their original bytes.
import { canonical, type SchemaObject, type TableSpec } from '@norbital-ai/store';

export const HISTORY_SCHEMA_TABLES = [
	`create table if not exists bolt_history_schema (
		id uuid primary key default gen_random_uuid(), lineage uuid not null,
		model text not null, definition jsonb not null, fields jsonb not null,
		created_at timestamptz not null default clock_timestamp()
	)`,
	'create index if not exists bolt_history_schema__lineage on bolt_history_schema(lineage)',
	`create table if not exists bolt_history_current (
		model text primary key, schema uuid not null references bolt_history_schema(id), active boolean not null default true
	)`,
	'create index if not exists bolt_history__schema_record on bolt_history(record,revision)',
	"create index if not exists bolt_history__unversioned on bolt_history(collection) where coalesce(meta->>'schema','')=''"
];

export const HISTORY_SCHEMA_REGISTER = `create or replace function bolt_history_register(model_name text, definition jsonb)
returns uuid language plpgsql as $bolt_history_schema$
declare held record; version_id uuid; lineage_id uuid; identities jsonb := '{}';
	field_name text; field_spec jsonb; old_name text; identity_id text; prior_fields jsonb;
begin
	select s.* into held from bolt_history_current c join bolt_history_schema s on s.id=c.schema
	where (c.model=model_name and c.active) or (c.model=bolt_history_register.definition->>'was' and c.model<>model_name)
	order by (c.model=model_name) desc limit 1 for update of c;
	if held.id is not null and held.model=model_name and held.definition=bolt_history_register.definition then
		version_id := held.id;
	else
		if to_regclass('bolt_audit_erase') is not null then
			if exists(select 1 from bolt_audit_erase where collection in (model_name,held.model)) then
				raise exception 'History schema change waits for pending erasure of %', model_name;
			end if;
		end if;
		if held.id is not null and to_regclass('bolt_approvals') is not null then
			if exists(select 1 from bolt_approvals a cross join lateral jsonb_array_elements(a.records) r
				where a.state in ('Pending','ChangesRequested') and r->>'collection'=held.model) then
				raise exception 'History schema change waits for open approvals of %', held.model;
			end if;
		end if;
		lineage_id := coalesce(held.lineage,gen_random_uuid());
		prior_fields := coalesce(held.definition->'fields','{}'::jsonb) || coalesce(held.definition->'computed','{}'::jsonb);
		for field_name,field_spec in select key,value from jsonb_each(
			coalesce(bolt_history_register.definition->'fields','{}'::jsonb) || coalesce(bolt_history_register.definition->'computed','{}'::jsonb)) loop
			old_name := case when prior_fields ? field_name then field_name else coalesce(field_spec->>'was',field_name) end;
			identity_id := case when prior_fields ? old_name then held.fields->>old_name end;
			identities := identities || jsonb_build_object(field_name,coalesce(identity_id,gen_random_uuid()::text));
		end loop;
		insert into bolt_history_schema(lineage,model,definition,fields)
		values(lineage_id,model_name,bolt_history_register.definition,identities) returning id into version_id;
		if held.id is not null and held.model<>model_name then
			update bolt_history_current set active=false where model=held.model;
		end if;
		insert into bolt_history_current(model,schema,active) values(model_name,version_id,true)
		on conflict(model) do update set schema=excluded.schema,active=true;
	end if;
	-- Legacy payloads have no historical definition to recover; retain that fact instead of inventing one.
	if to_regclass('bolt_history') is not null then
		update bolt_history set meta=meta || jsonb_build_object('schema',version_id::text,'legacy',true)
		where collection=model_name and coalesce(meta->>'schema','')='';
	end if;
	return version_id;
end $bolt_history_schema$`;

export const HISTORY_SCHEMA_MATCH = `create or replace function bolt_history_matches(history_model text, metadata jsonb, model_name text)
returns boolean language plpgsql stable as $bolt_history_match$ begin
	return case when coalesce(metadata->>'schema','')='' then history_model=model_name else exists(
		select 1 from bolt_history_schema old join bolt_history_current c on c.model=model_name
		join bolt_history_schema current on current.id=c.schema and current.lineage=old.lineage
		where old.id::text=metadata->>'schema') end;
end $bolt_history_match$`;

export const HISTORY_SCHEMA_PURGE = `create or replace function bolt_history_purge_fields(version_id text, model_name text, columns text[])
returns text[] language plpgsql stable as $bolt_history_purge$ begin
	if coalesce(version_id,'')='' then return columns; end if;
	return array(with old as (select * from bolt_history_schema where id::text=version_id),
	current as (select s.* from bolt_history_current c join bolt_history_schema s on s.id=c.schema where c.model=model_name),
	fields as (select o.key as name,coalesce(old.definition->'fields'->o.key,old.definition->'computed'->o.key) as kind from old,current,
		jsonb_each_text(old.fields) o,jsonb_each_text(current.fields) n
		where o.value=n.value and exists(select 1 from unnest(columns) col where col=n.key or starts_with(col,n.key||'__')))
	select name from fields where kind->>'kind'<>'ref' or case when jsonb_typeof(kind->'to')='array' then jsonb_array_length(kind->'to') else 0 end<=1
	union select name||'__'||target from fields,jsonb_array_elements_text(case when jsonb_typeof(kind->'to')='array' then kind->'to' else '[]'::jsonb end) target where kind->>'kind'='ref' and case when jsonb_typeof(kind->'to')='array' then jsonb_array_length(kind->'to') else 0 end>1
	union select col from unnest(columns) col where col in ('id','revision','created_at','created_by','updated_at','updated_by'));
end $bolt_history_purge$`;

/** Runs after columns exist and before backfills can write: revisions commit with their schema version. */
export const historySchemaObjects = (
	tables: Readonly<Record<string, TableSpec>>,
	currency?: string | null
): readonly SchemaObject[] => {
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const objects = Object.entries(tables).flatMap(([name, table]): SchemaObject[] => {
		if (table.audit !== true || table.nativeRules === undefined) return [];
		const definition =
			currency == null
				? table
				: {
						...table,
						fields: Object.fromEntries(
							Object.entries(table.fields).map(([field, kind]) => [
								field,
								kind.kind === 'money' && kind.currency === undefined ? { ...kind, currency } : kind
							])
						)
					};
		return [
			{
				id: `history:schema:${name}`,
				rank: 'column',
				table: '',
				deps: [],
				create: [
					`select bolt_history_register(${literal(name)},${literal(canonical(definition))}::jsonb)`
				],
				drop: null
			}
		];
	});
	const active = Object.entries(tables)
		.filter(([, table]) => table.audit === true && table.nativeRules !== undefined)
		.map(([name]) => name)
		.sort()
		.map(literal);
	return [
		...objects,
		{
			id: 'history:current',
			rank: 'index',
			table: '',
			deps: [],
			drop: null,
			create: [
				`update bolt_history_current set active=false where active and not (model=any(array[${active.join(',')}]::text[]))`
			]
		}
	];
};
