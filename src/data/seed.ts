import { Brand, TicketLine, User } from "../types";

const now = new Date().toISOString();

export const seedUsers: User[] = [
  {
    id: "user-admin-1",
    name: "Primary Admin",
    emailOrLogin: "admin@premiumapp.local",
    role: "admin",
    active: true,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "user-marketer-1",
    name: "Marketer Demo",
    emailOrLogin: "marketer@premiumapp.local",
    role: "marketer",
    active: true,
    createdAt: now,
    updatedAt: now
  }
];

export const seedBrands: Brand[] = [
  {
    id: "brand-medieval-times",
    name: "Medieval Times",
    active: true,
    frequentAlert: true,
    showAlertActive: false,
    showAlertMessage: "",
    showAlertSentAt: "",
    showAlertUpdatedAt: "",
    createdAt: now,
    updatedAt: now
  },
  {
    id: "brand-carolina-opry",
    name: "Carolina Opry",
    active: true,
    frequentAlert: true,
    showAlertActive: false,
    showAlertMessage: "",
    showAlertSentAt: "",
    showAlertUpdatedAt: "",
    createdAt: now,
    updatedAt: now
  },
  {
    id: "brand-aquarium",
    name: "Aquarium",
    active: false,
    frequentAlert: false,
    showAlertActive: false,
    showAlertMessage: "",
    showAlertSentAt: "",
    showAlertUpdatedAt: "",
    createdAt: now,
    updatedAt: now
  },
  {
    id: "brand-pirates-voyage",
    name: "Pirates Voyage",
    active: true,
    frequentAlert: true,
    showAlertActive: false,
    showAlertMessage: "",
    showAlertSentAt: "",
    showAlertUpdatedAt: "",
    createdAt: now,
    updatedAt: now
  }
];

export const seedTicketLines: TicketLine[] = [
  {
    id: "line-medieval-adult-12",
    brandId: "brand-medieval-times",
    ticketLabel: "Adult",
    qualifierText: "12+",
    retailPrice: 89.99,
    cmaPrice: 74.5,
    active: true,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "line-medieval-child",
    brandId: "brand-medieval-times",
    ticketLabel: "Child",
    qualifierText: "",
    retailPrice: 49.99,
    cmaPrice: 38.58,
    active: true,
    sortOrder: 2,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "line-opry-premium",
    brandId: "brand-carolina-opry",
    ticketLabel: "Premium",
    qualifierText: "",
    retailPrice: 69,
    cmaPrice: 55,
    active: true,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "line-opry-vip",
    brandId: "brand-carolina-opry",
    ticketLabel: "VIP",
    qualifierText: "",
    retailPrice: 89,
    cmaPrice: 72,
    active: false,
    sortOrder: 2,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "line-pirates-gold",
    brandId: "brand-pirates-voyage",
    ticketLabel: "Gold",
    qualifierText: "",
    retailPrice: 84,
    cmaPrice: 67,
    active: true,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now
  }
];
