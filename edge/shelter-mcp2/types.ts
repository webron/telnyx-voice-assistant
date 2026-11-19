export interface HoldInfo {
  shelterId: string;
  bedId: string;
  createdAt: number;
  expiresAt: number;
  expires_in_minutes?: number;
}
