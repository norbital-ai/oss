// Native audit function SQL; the cell build packs these exact bytes.
export const AUDIT_FUNCTIONS: readonly string[] = [
	`create or replace function bolt_write_context() returns jsonb language plpgsql volatile as $bolt_audit$
declare value jsonb;
begin
	value := nullif(current_setting('bolt.write', true), '')::jsonb;
	if value is null then return null; end if;
	if jsonb_typeof(value) is distinct from 'object'
		or jsonb_typeof(value->'token') is distinct from 'string' then
		raise exception using errcode='22023', message='invalid native write context';
	end if;
	if to_regclass('pg_temp.bolt_write_context') is null
		or to_regclass('pg_temp.bolt_write_targets') is null then return null; end if;
	select saved.context into value from pg_temp.bolt_write_context saved where saved.token=value->>'token';
	if not found then return null; end if;
	if jsonb_typeof(value) is distinct from 'object'
		or jsonb_typeof(value->'token') is distinct from 'string'
		or jsonb_typeof(value->'now') is distinct from 'string'
		or jsonb_typeof(value->'actor') is distinct from 'string'
		or coalesce(value->>'mode', '') not in ('write', 'seed', 'restore') then
		raise exception using errcode='22023', message='invalid native write context';
	end if;
	return value;
end;
$bolt_audit$`,
	// Store discovers this host provider by its exact signature; only admitted per-row erasure columns relax edit locks.
	`create or replace function store_anonymise_fields(table_name text, record_id text) returns jsonb language plpgsql volatile as $bolt_audit$
declare context jsonb; key text; fields jsonb;
begin
	context := bolt_write_context();
	key := table_name || '/' || record_id;
	if context is null or context->>'mode' <> 'write'
		or to_regclass('pg_temp.bolt_erased') is null then return '[]'::jsonb; end if;
	select target.anonymise into fields from pg_temp.bolt_write_targets target
	where target.token=context->>'token' and target.record_key=key and target.direct and target.erased
		and exists (select 1 from pg_temp.bolt_erased erased
			where erased.token=target.token and erased.c=table_name and erased.id=record_id);
	if jsonb_typeof(fields) is distinct from 'array' then return '[]'::jsonb; end if;
	return fields;
end;
$bolt_audit$`,
	`create or replace function bolt_audit_mark() returns trigger language plpgsql volatile as $bolt_audit$
declare context jsonb; old_row jsonb; new_row jsonb; key text; marked boolean; direct_row boolean;
begin
	context := bolt_write_context();
	if context is not null then
		old_row := case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
		new_row := case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
		key := TG_TABLE_NAME || '/' || coalesce(new_row->>'id', old_row->>'id');
		select target.erased,target.direct into marked,direct_row from pg_temp.bolt_write_targets target
		where target.token=context->>'token' and target.record_key=key;
		marked := coalesce(marked,false);
		if not marked and not coalesce(direct_row,false) then
			select exists (
				select 1 from (values (old_row), (new_row)) image(j)
				cross join jsonb_array_elements(TG_ARGV[1]::jsonb) edge
				join pg_temp.bolt_erased parent on parent.token=context->>'token'
					and parent.c=edge->>1 and parent.id=image.j->>(edge->>0)
			) into marked;
		end if;
		if marked then
			insert into pg_temp.bolt_erased(token,c,id)
			values(context->>'token',TG_TABLE_NAME,coalesce(new_row->>'id',old_row->>'id'))
			on conflict do nothing;
		end if;
	end if;
	if TG_OP='DELETE' then return OLD; else return NEW; end if;
end;
$bolt_audit$`,
	`create or replace function bolt_audit() returns trigger language plpgsql volatile as $bolt_audit$
declare context jsonb; old_row jsonb; new_row jsonb; row_id text; key text; revision_number int;
	operation text; reason text; history_reason text; source_revision int; erased_row boolean := false;
	explicit_reason text; explicit_erased boolean; ref_edge jsonb; parent_live boolean;
	held_request uuid; changes jsonb; native_at timestamptz; native_actor text; native_request uuid;
begin
	old_row := case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
	new_row := case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
	row_id := coalesce(new_row->>'id',old_row->>'id');
	key := TG_TABLE_NAME || '/' || row_id;
	operation := case TG_OP when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'update' end;
	revision_number := case when TG_OP='DELETE' then (old_row->>'revision')::int + 1 else (new_row->>'revision')::int end;
	context := bolt_write_context();
	if context is null then
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
			raise exception using errcode='BA001', message='underApproval ' || held_request::text || ' Under approval: raw writes cannot change this record or its owned children.';
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
		native_at := clock_timestamp();
		native_actor := 'sql';
	else
		select exists(select 1 from pg_temp.bolt_erased where token=context->>'token' and c=TG_TABLE_NAME and id=row_id) into erased_row;
		reason := case when context->>'mode'='seed' then 'seed' else 'cascade' end;
		select origin.cause,origin.erased into explicit_reason,explicit_erased from pg_temp.bolt_origins origin
		where origin.token=context->>'token' and origin.c=TG_TABLE_NAME and origin.id=row_id
			and origin.revision=revision_number and origin.op=operation;
		if found then reason := explicit_reason; erased_row := explicit_erased; end if;
		native_at := (context->>'now')::timestamptz;
		native_actor := context->>'actor';
		native_request := (context->>'request')::uuid;
		if reason='direct' then
			select target.restored into source_revision from pg_temp.bolt_write_targets target
			where target.token=context->>'token' and target.record_key=key and target.direct;
		end if;
	end if;
	history_reason := case when source_revision is null then reason else 'restored' end;
	changes := case when operation='create' or (erased_row and operation='update') then new_row - array['bolt_search','bolt_embedding']
		when operation='delete' then '{}'::jsonb else (
			select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) from jsonb_each(new_row) entry(k,v)
			where k not in ('revision','updated_at','updated_by','bolt_search','bolt_embedding') and old_row->k is distinct from v
		) end;
	if row_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		insert into bolt_history(collection,record,revision,at,actor,op,cause,changes,restored_from,request,operation,meta)
		values(TG_TABLE_NAME,row_id::uuid,revision_number,native_at,native_actor,operation,history_reason,changes,source_revision,native_request,nullif(current_setting('bolt.audit',true),''),
		jsonb_build_object('id',row_id,'revision',coalesce(new_row,old_row)->'revision','updated_at',coalesce(new_row,old_row)->'updated_at','updated_by',coalesce(new_row,old_row)->'updated_by','created_at',coalesce(new_row,old_row)->'created_at','created_by',coalesce(new_row,old_row)->'created_by'));
	end if;
	if context is not null and to_regclass('pg_temp.bolt_changes') is not null then
		insert into pg_temp.bolt_changes(token,c,id,revision,op,cause,erased,o,n)
		values(context->>'token',TG_TABLE_NAME,row_id,revision_number,operation,reason,erased_row,old_row,new_row);
	end if;
	return null;
end;
$bolt_audit$`
];
