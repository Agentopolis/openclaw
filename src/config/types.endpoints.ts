export type EndpointTokenConfig = {
  value: string;
  name?: string;
};

export type EndpointEntryConfig = {
  id: string;
  instructions?: string;
  /** Whether this endpoint responds synchronously or asynchronously. */
  mode?: "sync" | "async";
  /** Auth tokens for this endpoint. If empty/omitted, the endpoint accepts unauthenticated requests. */
  tokens?: EndpointTokenConfig[];
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type EndpointRateLimitConfig = {
  /** Max requests per window (default: 60). */
  maxRequests?: number;
  /** Window size in seconds (default: 60). */
  windowSeconds?: number;
};

export type EndpointsConfig = {
  enabled?: boolean;
  basePath?: string;
  rateLimit?: EndpointRateLimitConfig;
  entries?: EndpointEntryConfig[];
};
