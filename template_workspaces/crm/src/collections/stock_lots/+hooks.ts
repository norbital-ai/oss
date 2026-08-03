import type { Hooks } from './$types.js';

type AfterApi = Parameters<NonNullable<NonNullable<Hooks['create']>['after']>>[0]['api'];

const LOT_LIMIT = 5000;

function normalizeLotNo(lotNo: unknown): string {
	const normalized = String(lotNo ?? '').trim();
	if (!normalized) throw new Error('Lot number is required.');
	return normalized;
}

function validateQuantity(value: unknown): void {
	const quantity = Number(value);
	if (Number.isNaN(quantity) || quantity < 0) {
		throw new Error('Quantity cannot be negative.');
	}
}

async function syncProductStockLevel(api: AfterApi, productId: string): Promise<void> {
	const lots = await api.db.query.stock_lots.findMany({
		where: { product_id: { eq: productId }, sellable: { eq: true } },
		columns: { quantity: true },
		limit: LOT_LIMIT
	});
	const totalQty = lots.reduce((sum, lot) => sum + Number(lot.quantity), 0);
	const now = new Date();

	const existing = await api.db.query.stock_levels.findFirst({
		where: { product_id: { eq: productId } }
	});

	if (existing) {
		await api.db.mutate('stock_levels', [
			{ norbital_id: existing.norbital_id, qty_on_hand: totalQty, qty_as_of: now }
		]);
		return;
	}

	await api.db.mutate('stock_levels', [
		{ product_id: productId, qty_on_hand: totalQty, qty_as_of: now }
	]);
}

const afterSync = async ({
	record,
	api
}: {
	readonly record: { readonly product_id: string };
	readonly api: AfterApi;
}) => {
	await syncProductStockLevel(api, record.product_id);
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.product_id) throw new Error('A stock lot must reference a product.');
			if (!input.warehouse_id) throw new Error('A stock lot must reference a warehouse.');

			const product = await api.db.query.products.findFirst({
				where: { norbital_id: { eq: input.product_id } }
			});
			if (!product) throw new Error('Referenced product does not exist.');

			const warehouse = await api.db.query.warehouses.findFirst({
				where: { norbital_id: { eq: input.warehouse_id } }
			});
			if (!warehouse) throw new Error('Referenced warehouse does not exist.');

			validateQuantity(input.quantity);

			return {
				...input,
				lot_no: normalizeLotNo(input.lot_no),
				sellable: input.sellable ?? true
			};
		},
		after: afterSync
	},
	update: {
		before: async ({ input, existing }) => {
			if (input.product_id != null && input.product_id !== existing.product_id) {
				throw new Error('Product cannot be changed on a stock lot.');
			}
			if (input.warehouse_id != null && input.warehouse_id !== existing.warehouse_id) {
				throw new Error('Warehouse cannot be changed on a stock lot.');
			}
			if (input.lot_no != null && input.lot_no !== existing.lot_no) {
				throw new Error('Lot number cannot be changed once set.');
			}
			if (input.quantity != null) validateQuantity(input.quantity);
			return input;
		},
		after: afterSync
	},
	delete: {
		after: afterSync
	}
} satisfies Hooks;
