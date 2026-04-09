import { api } from "./api-client.js";

let userCounter = 0;

interface RegisterResponse {
  user: { id: string; email: string };
  token: string;
}

interface LoginResponse {
  user: { id: string; email: string };
  token: string;
}

/**
 * Register a fresh test user and return the JWT token.
 * Each call creates a unique user to avoid conflicts.
 */
export async function createTestUser(
  overrides: { email?: string; password?: string; name?: string } = {},
): Promise<{ userId: string; email: string; token: string }> {
  userCounter++;
  const email = overrides.email || `e2e-user-${userCounter}-${Date.now()}@test.local`;
  const password = overrides.password || "TestPass123!";
  const name = overrides.name || `E2E User ${userCounter}`;

  const res = await api<RegisterResponse>("/auth/register", {
    method: "POST",
    body: { email, password, name },
  });

  if (res.status !== 201) {
    throw new Error(`Failed to register test user: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    userId: res.body.user.id,
    email: res.body.user.email,
    token: res.body.token,
  };
}

/**
 * Login with existing credentials and return the JWT token.
 */
export async function loginTestUser(
  email: string,
  password: string,
): Promise<{ userId: string; email: string; token: string }> {
  const res = await api<LoginResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
  });

  if (res.status !== 200) {
    throw new Error(`Failed to login test user: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    userId: res.body.user.id,
    email: res.body.user.email,
    token: res.body.token,
  };
}
