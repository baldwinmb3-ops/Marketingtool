export type Role = "admin" | "marketer";

export type ActiveFilter = "all" | "active" | "inactive";

export interface User {
  id: string;
  name: string;
  emailOrLogin: string;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  name: string;
  active: boolean;
  frequentAlert: boolean;
  showAlertActive: boolean;
  showAlertMessage: string;
  showAlertSentAt: string;
  showAlertUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketLine {
  id: string;
  brandId: string;
  ticketLabel: string;
  qualifierText: string;
  retailPrice: number;
  cmaPrice: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CartLine {
  id: string;
  brandId: string;
  brandName: string;
  ticketLineId: string;
  ticketDisplayText: string;
  retailEach: number;
  cmaEach: number;
  qty: number;
}

export interface TicketLineDraft {
  ticketLabel: string;
  qualifierText: string;
  retailPrice: string;
  cmaPrice: string;
  active: boolean;
}
