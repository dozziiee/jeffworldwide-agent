// Route paths served by this app, and HTTP header names used in requests and responses.

export const ROUTES = {
  HEALTH: "/health",
  MCP: "/mcp",
  CAR: "/car", // public car pages live at /car/<car_id>
} as const;

/** The Express pattern for a car page. */
export const CAR_PAGE_ROUTE = `${ROUTES.CAR}/:car_id`;

export const HEADERS = {
  AUTHORIZATION: "authorization",
  CONTENT_TYPE: "content-type",
  USER_AGENT: "user-agent",
  HOST: "host",
  WWW_AUTHENTICATE: "WWW-Authenticate",
  ALLOW: "Allow",
  CACHE_CONTROL: "Cache-Control",
} as const;
