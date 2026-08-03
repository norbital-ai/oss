import { custom, date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		direction: enums(['incoming', 'outgoing']),
		quote_id: uuid(),
		purchase_order_id: uuid(),
		amount: custom('money', { allowedCurrencies: ['CNY', 'USD', 'EUR', 'GBP', 'SGD'] }),
		payment_date: date().notNull(),
		method: enums([
			'bank_transfer',
			'cash',
			'cheque',
			'online',
			'wechat_pay',
			'alipay',
			'letter_of_credit',
			'other'
		]),
		reference: text(),
		notes: text()
	},
	{
		description:
			'Money moved against a trade document. An incoming payment settles a sales document; an outgoing one settles a purchase order. Exactly one of the two document references is set, which is what lets receivable and payable status be derived from a single ledger.',
		recordLabel: ['payment_date', 'amount'],
		icon: 'lucide:banknote',
		indexes: [
			{ columns: ['quote_id'] },
			{ columns: ['purchase_order_id'] },
			{ columns: ['payment_date'] },
			{ columns: ['direction'] }
		]
	}
);
