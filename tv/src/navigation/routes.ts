/** Broker-lane playback params (P2): a resolved stremio-server stream + the
 * identity needed to keep the permanent marker in ozzu-postgres. */
export interface BrokerPlayParams {
  url: string;
  infoHash: string;
  fileIdx: number;
  fileName?: string;
  title: string;
  season?: number;
  episode?: number;
  startSeconds?: number;
}

export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  Detail: { itemId: string };
  /** Seerr-lane detail (TMDB catalog) — dir_1790443814736 discovery phase. */
  DiscoverDetail: { tmdbId: number; mediaType: "movie" | "tv" };
  Player: { itemId: string; startSeconds?: number } | { broker: BrokerPlayParams };
  Search: undefined;
  Settings: undefined;
};
