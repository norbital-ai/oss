import { defineModel, enums, geolocation, numeric, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		name: text().notNull(),
		location: geolocation(),
		client_name: text(),
		house_type: enums(['hdb_flat', 'condo', 'landed', 'commercial', 'industrial', 'other']),
		floor_area_sqm: numeric()
	},
	{
		description: 'Physical site with tenant and dwelling context. Past jobs hang off the site.',
		recordLabel: 'name',
		icon: 'lucide:map-pin'
	}
);
