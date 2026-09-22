export const MAX_CONTEXT_ITEM_LENGTH = 10_000;

export type ContextItem = {
  id: string;
  text: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export function combineContextItems(items: Array<Pick<ContextItem, "text">>) {
  return items
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
