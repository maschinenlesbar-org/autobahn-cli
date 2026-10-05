// Public entry point for the API client library.

export { AutobahnClient } from "./client.js";
// The type of `client.roadworks`, `client.warnings`, …, for helpers that take any of them.
export type { ServiceResource } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  DEFAULT_USER_AGENT,
  MAX_RETRIES,
  headerValueProblem,
  isBidiControl,
  isTransientNetworkError,
  quoteValue,
  sanitizeServerText,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export { VERSION } from "./version.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryPrimitive, QueryValue } from "./query.js";
export {
  AutobahnError,
  AutobahnApiError,
  AutobahnNetworkError,
  AutobahnNotFoundError,
  AutobahnParseError,
  AutobahnValidationError,
  MAX_MESSAGE_VALUE_LENGTH,
  cutForMessage,
  isRetryableStatus,
  redactUrl,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
export { assertValid, baseUrlProblem, idProblem, roadIdProblem } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
