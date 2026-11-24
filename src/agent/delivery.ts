/**
 * Delivery destinations (COD-209): where a message for the owner goes, opaque to core. A door gives meaning to its
 * `kind` (Telegram: `{ kind: "telegram", chatId }`; the web: `{ kind: "web", conversationId }`); core only stores and
 * passes them on. The stored shape is the reminders' destination as 0.1.0-beta.1 wrote it, so existing data reads
 * unchanged. Delivery itself (sending, telling the owner) comes with COD-210.
 */
export type DeliveryDestination = {
  readonly kind: string;
  readonly [field: string]: string | number;
};
