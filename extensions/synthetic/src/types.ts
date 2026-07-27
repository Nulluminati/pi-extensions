// --- Types ---

export interface SyntheticCatalogModel {
  id: string;
  always_on?: boolean;
  supported_features?: string[];
}

export interface SyntheticModelsResponse {
  data: SyntheticCatalogModel[];
}

export interface SyntheticQuotaResponse {
  subscription?: { limit: number; requests: number; renewsAt: string };
  search?: { hourly?: { limit: number; requests: number; renewsAt: string } };
  freeToolCalls?: { limit: number; requests: number; renewsAt: string };
  weeklyTokenLimit?: { nextRegenAt: string; percentRemaining: number };
  rollingFiveHourLimit?: {
    nextTickAt: string;
    tickPercent: number;
    remaining: number;
    max: number;
    limited: boolean;
  };
}
