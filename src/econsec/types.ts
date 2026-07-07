export type EconsecTier = '0' | '1' | '2' | '3' | 'raw';

export type EconsecStatus = 'ok' | 'redirect' | 'blocked' | 'dead' | 'skip';

export interface EconsecSource {
  id: string;
  name: string;
  url: string | null;
  tier: EconsecTier;
  region: string;
  category: string;
  lang: string;
  cost: 'free' | 'paid' | 'freemium';
  mr: string[];
  notes: string;
  verify?: string;
  // Fields appended by the liveness checker
  status?: EconsecStatus;
  last_checked?: string;
  final_url?: string;
}

export interface EconsecData {
  meta: {
    name: string;
    version: string;
    generated: string;
    scope: string;
    tiers: Record<string, string>;
    [key: string]: unknown;
  };
  sources: EconsecSource[];
}

export interface EconsecFilterState {
  tier: EconsecTier | 'all';
  region: string;
  category: string;
  cost: string;
  query: string;
}
