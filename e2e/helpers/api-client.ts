import { BASE_URL } from "../setup.js";

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Lightweight HTTP client for E2E tests.
 * Uses native fetch — no supertest, no in-process routing.
 */
export async function api<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", body, token, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  if (token) {
    requestHeaders["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let responseBody: T;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    responseBody = (await res.json()) as T;
  } else {
    responseBody = (await res.text()) as unknown as T;
  }

  return {
    status: res.status,
    body: responseBody,
    headers: res.headers,
  };
}
