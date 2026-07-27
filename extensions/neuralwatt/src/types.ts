// --- Types ---

export interface NeuralwattCatalogModel {
  id: string;
  metadata?: {
    deprecated?: boolean;
    pricing?: { pricing_tbd?: boolean };
    capabilities?: { tools?: boolean };
  };
}

export interface NeuralwattModelsResponse {
  data: NeuralwattCatalogModel[];
}

export interface NeuralwattQuotaResponse {
  snapshot_at?: string;
  balance?: {
    credits_remaining_usd?: number;
    total_credits_usd?: number;
    credits_used_usd?: number;
    accounting_method?: string;
  };
  usage?: {
    current_month?: {
      cost_usd?: number;
      requests?: number;
      tokens?: number;
      energy_kwh?: number;
    };
  };
  limits?: {
    overage_limit_usd?: number | null;
    rate_limit_tier?: string;
  };
  subscription?: {
    plan?: string;
    status?: string;
    billing_interval?: string;
    current_period_end?: string;
    kwh_included?: number;
    kwh_used?: number;
    kwh_remaining?: number;
    in_overage?: boolean;
  } | null;
  key?: {
    name?: string;
    allowance?: {
      limit_usd?: number;
      period?: string;
      spent_usd?: number;
      remaining_usd?: number;
      blocked?: boolean;
    } | null;
  };
}
