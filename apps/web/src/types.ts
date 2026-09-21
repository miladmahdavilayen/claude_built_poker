export interface ChatMessageRecord {
  id: string;
  tableId: string;
  userId: string | null;
  displayName: string | null;
  message: string;
  createdAt: string;
}
