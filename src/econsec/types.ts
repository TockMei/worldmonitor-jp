export type EconsecTier = '0' | '1' | '2' | '3' | 'raw';

// 'dead_candidate' is the checker's intermediate state: first failure, not
// yet confirmed (dead is only set after two consecutive failing runs).
export type EconsecStatus = 'ok' | 'redirect' | 'blocked' | 'dead' | 'dead_candidate' | 'skip';

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

export interface EconsecFeedItem {
  title: string;
  link: string;
  date: string | null;
}

export interface EconsecFeedsResponse {
  generated: string;
  feeds: Record<string, EconsecFeedItem[]>;
}

export type EconsecAlertType = 'add' | 'remove';

export interface EconsecAlert {
  date: string;
  source: string;
  type: EconsecAlertType;
  entity: string;
  detail: string;
}

export interface EconsecAlertsResponse {
  meta: { generated: string | null };
  alerts: EconsecAlert[];
}
