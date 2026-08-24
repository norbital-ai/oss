import { sql } from 'drizzle-orm';
import { customType, integer, timestamp as pgInstant, uuid } from 'drizzle-orm/pg-core';
import { SYSTEM_COLLECTION_FIELD_NAMES } from '@norbital-ai/std/collection';
import { defineModel } from './models-schema.js';

const timestampRange = customType<{ data: string; driverData: string }>({
	dataType: () => 'tstzrange'
});

/** The platform fields every model receives through the common model compiler. */
export const defineSystemRowModel = () =>
	defineModel({
		id: uuid().primaryKey().defaultRandom(),
		created_at: pgInstant({ withTimezone: true, mode: 'string' }).defaultNow(),
		updated_at: pgInstant({ withTimezone: true, mode: 'string' }).defaultNow(),
		sys_period: timestampRange()
			.notNull()
			.default(sql`tstzrange(CURRENT_TIMESTAMP, NULL, '[)')`),
		row_version: integer().default(1),
		approval_id: uuid()
	});

export type SystemRowColumns = ReturnType<typeof defineSystemRowModel>['columns'];
export const SYSTEM_COLUMN_NAMES = SYSTEM_COLLECTION_FIELD_NAMES;
