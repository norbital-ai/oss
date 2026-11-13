// Native audit function SQL; the cell build packs these exact bytes.
import { UUID_PATTERN } from '@norbital-ai/store/kind';
export const AUDIT_FUNCTIONS: readonly string[] = [
	// An engine write statement sets `bolt.write` to its own statement_timestamp(): its rows' history and erasure
	// columns come from the statement itself, so the row trigger stays for raw SQL alone.
	'drop function if exists bolt_audit_mark() cascade',
	'drop function if exists bolt_write_context()',
	// Store discovers this host provider by its exact signature; only an erase statement's own anonymised fields relax edit locks.
	`create or replace function store_anonymise_fields(table_name text, record_id text) returns jsonb language plpgsql volatile as $bolt_audit$
declare fields jsonb;
begin
	if current_setting('bolt.write', true) is distinct from statement_timestamp()::text then return '[]'::jsonb; end if;
	fields := nullif(current_setting('bolt.anonymise', true), '')::jsonb -> (table_name || '/' || record_id);
	if jsonb_typeof(fields) is distinct from 'array' then return '[]'::jsonb; end if;
	return fields;
end;
$bolt_audit$`,
	// Raw SQL only: an engine statement's rows skip it (`audit_triggers`' WHEN) and keep their history in the statement.
	`create or replace function bolt_audit() returns trigger language plpgsql volatile as $bolt_audit$
declare old_row jsonb; new_row jsonb; row_id text; revision_number int; operation text; reason text;
	schema_version text; schema_snapshot boolean := false; ref_edge jsonb; parent_live boolean; held_request uuid; changes jsonb;
begin
	old_row := case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
	new_row := case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
	row_id := coalesce(new_row->>'id',old_row->>'id');
	operation := case TG_OP when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'update' end;
	revision_number := case when TG_OP='DELETE' then (old_row->>'revision')::int + 1 else (new_row->>'revision')::int end;
	with images(j) as (values (old_row),(new_row)), touched(c,id) as (
		select TG_TABLE_NAME::text,j->>'id' from images
		union
		select edge->>1,j->>(edge->>0) from images cross join jsonb_array_elements(TG_ARGV[0]::jsonb) edge
	)
	select a.id into held_request from bolt_approvals a
	where a.state in ('Pending','ChangesRequested') and exists (
		select 1 from jsonb_array_elements(a.records) AS entry(value) join touched t
		on t.c=entry.value->>'collection' and t.id=entry.value->>'id'
	) order by a.id limit 1 for update;
	if found then
		raise exception using errcode='BA001', message='under_approval ' || held_request::text || ' Under approval: raw writes cannot change this record or its owned children.';
	end if;
	-- An AFTER trigger is not nested inside the referential action that fired it (pg_trigger_depth is 1 for a
	-- cascaded row), so a row whose own referential parent is already gone was removed or unlinked by that action.
	reason := 'direct';
	if TG_OP <> 'INSERT' then
		for ref_edge in select value from jsonb_array_elements(coalesce(TG_ARGV[1],'[]')::jsonb) loop
			if old_row->>(ref_edge->>0) is not null then
				execute format('select exists(select 1 from %I where id::text = $1)', ref_edge->>1)
					using old_row->>(ref_edge->>0) into parent_live;
				if not parent_live then reason := 'cascade'; exit; end if;
			end if;
		end loop;
	end if;
	changes := case when operation='create' then new_row - array['bolt_search','bolt_embedding','bolt_record_label']
		when operation='delete' then '{}'::jsonb else (
			select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) from jsonb_each(new_row) entry(k,v)
			where k not in ('revision','updated_at','updated_by','bolt_search','bolt_embedding','bolt_record_label') and old_row->k is distinct from v
		) end;
	if row_id ~* '${UUID_PATTERN.source}' then
		select c.schema::text into schema_version from bolt_history_current c join bolt_history_schema s on s.id=c.schema
		where c.model=TG_TABLE_NAME and c.active and s.model=TG_TABLE_NAME;
		if schema_version is null then
			raise exception using errcode='BA001', message='schema History requires a registered schema version';
		end if;
		if operation='update' and not exists(
			select 1 from bolt_history where collection=TG_TABLE_NAME and record=row_id::uuid and meta->>'schema'=schema_version) then
			changes := new_row - array['bolt_search','bolt_embedding','bolt_record_label'];
			schema_snapshot := true;
		end if;
		insert into bolt_history(collection,record,revision,at,actor,op,cause,changes,restored_from,request,operation,meta)
		values(TG_TABLE_NAME,row_id::uuid,revision_number,clock_timestamp(),'sql',operation,reason,changes,null,null,nullif(current_setting('bolt.audit',true),''),
		jsonb_build_object('id',row_id,'revision',coalesce(new_row,old_row)->'revision','updated_at',coalesce(new_row,old_row)->'updated_at','updated_by',coalesce(new_row,old_row)->'updated_by','created_at',coalesce(new_row,old_row)->'created_at','created_by',coalesce(new_row,old_row)->'created_by','schema',schema_version,'full',schema_snapshot));
	end if;
	return null;
end;
$bolt_audit$`
];
