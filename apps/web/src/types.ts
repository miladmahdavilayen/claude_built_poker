export interface ChatMessageRecord {
  id: string;
  tableId: string;
  userId: string | null;
  displayName: string | null;
  message: string;
  createdAt: string;
  /** The players it mentions (`@Name`), by user id — on a message as it arrives, not on the history. */
  mentions?: string[];
}
