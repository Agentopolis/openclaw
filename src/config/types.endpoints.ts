export type EndpointEntryConfig = {
  id: string;
  instructions?: string;
  /** Whether this endpoint responds synchronously or asynchronously. */
  mode?: "sync" | "async";
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type EndpointsConfig = {
  enabled?: boolean;
  /** Bearer token for endpoint auth. If omitted, endpoints accept unauthenticated requests. */
  token?: string;
  basePath?: string;
  entries?: EndpointEntryConfig[];
};
