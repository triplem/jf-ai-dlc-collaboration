// jf-ai-dlc OIDC/Keycloak replacement for upstream frontend/src/services/auth.ts.
//
// Swapped in at build time by overlay/frontend/vite.config.jf.ts (a resolveId
// plugin redirects `services/auth` to this file) — upstream/ is never edited.
// The exported surface is identical to the upstream module (authService,
// authConfiguration, parseSsoProviders, cognitoOauthScopes, and the User /
// AuthSession / AuthResult / AuthMode / SsoProvider types), so every consumer
// still type-checks against the original declarations while running this code.
//
// Amplify/Cognito → Keycloak, dependency-free:
//   - local mode  : Resource-Owner Password grant against the public `jf-ui`
//                   client (Keycloak directAccessGrants) — keeps the existing
//                   username/password Login form working.
//   - sso mode    : Authorization Code + PKCE redirect to Keycloak; an SSO
//                   provider name is passed as `kc_idp_hint` to jump straight
//                   to an upstream IdP.
// The app sends the id_token as the API Bearer; the api-router verifies it
// against Keycloak's JWKS and projects the claims onto the names handlers read.

import { clearPersistedCache } from '@/lib/persistentCache';
import { normalizeSsoLoginError, SsoLoginTimeoutError } from '@/services/authErrors';

export type AuthMode = 'local' | 'hybrid' | 'sso-only';

export interface SsoProvider {
  name: string;
  displayName: string;
  type: 'oidc' | 'saml';
}

export const parseSsoProviders = (raw: string): SsoProvider[] => {
  try {
    const serialized = raw.startsWith('uri:') ? decodeURIComponent(raw.slice(4)) : raw;
    const parsed = JSON.parse(serialized || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error('Invalid VITE_SSO_PROVIDERS configuration');
    return [];
  }
};

export const authConfiguration = {
  mode: (import.meta.env.VITE_AUTH_MODE || 'local') as AuthMode,
  providers: parseSsoProviders(import.meta.env.VITE_SSO_PROVIDERS || '[]'),
};

// Kept for export-surface parity with upstream; Keycloak requests these scopes.
export const cognitoOauthScopes = ['openid', 'email', 'profile'] as const;

const PLATFORM_ADMIN_GROUP = 'platform-admin';

const issuer = (import.meta.env.VITE_OIDC_ISSUER || '').replace(/\/$/, '');
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID || 'jf-ui';
const appOrigin = import.meta.env.VITE_APP_ORIGIN || window.location.origin;
const callbackUrl = import.meta.env.VITE_AUTH_CALLBACK_URL || `${appOrigin}/auth/callback`;

const endpoints = {
  authorize: `${issuer}/protocol/openid-connect/auth`,
  token: `${issuer}/protocol/openid-connect/token`,
  logout: `${issuer}/protocol/openid-connect/logout`,
};

// --- token store (localStorage) --------------------------------------------
interface StoredTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}
const TOKENS_KEY = 'aidlc-oidc-tokens';
const PKCE_KEY = 'aidlc-oidc-pkce';
const PROFILE_OVERLAY_KEY = 'aidlc-profile-overlay';

const loadTokens = (): StoredTokens | null => {
  const raw = localStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
};
const saveTokens = (t: StoredTokens) => localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
const clearTokens = () => localStorage.removeItem(TOKENS_KEY);

const storeFromResponse = (data: any): StoredTokens => {
  const tokens: StoredTokens = {
    accessToken: data.access_token,
    idToken: data.id_token || '',
    refreshToken: data.refresh_token || '',
    expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000,
  };
  saveTokens(tokens);
  return tokens;
};

// --- JWT + PKCE helpers -----------------------------------------------------
const decodeJwt = (jwt: string): Record<string, any> => {
  try {
    const payload = jwt.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return {};
  }
};

const base64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomString = (len: number): string => {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
};

const pkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
};

// --- token exchange / refresh ----------------------------------------------
const tokenRequest = async (body: Record<string, string>): Promise<any> => {
  const res = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'Authentication failed');
    (err as any).name = data.error === 'invalid_grant' ? 'NotAuthorizedException' : 'AuthError';
    (err as any).oidc = data;
    throw err;
  }
  return data;
};

const refreshIfNeeded = async (): Promise<StoredTokens | null> => {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt - 30_000) return tokens;
  if (!tokens.refreshToken) return tokens;
  try {
    return storeFromResponse(
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
    );
  } catch {
    clearTokens();
    return null;
  }
};

// --- user projection --------------------------------------------------------
export interface User {
  userId: string;
  username: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  groups: string[];
  identitySource: 'cognito' | 'sso';
  identityProvider?: string;
}

export interface AuthSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user?: User;
  nextStep?: 'NEW_PASSWORD_REQUIRED' | 'MFA_REQUIRED';
}

const profileOverlay = (): { displayName?: string; avatarUrl?: string } => {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_OVERLAY_KEY) || '{}');
  } catch {
    return {};
  }
};

const userFromTokens = (tokens: StoredTokens): User => {
  const claims = decodeJwt(tokens.idToken || tokens.accessToken);
  const rawGroups = claims.groups ?? claims['cognito:groups'] ?? claims.realm_access?.roles ?? [];
  const groups = (Array.isArray(rawGroups) ? rawGroups : [rawGroups])
    .map(String)
    .map((g) => g.replace(/^\//, '')); // Keycloak group paths → bare names
  const idp = typeof claims.identity_provider === 'string' ? claims.identity_provider : undefined;
  const overlay = profileOverlay();
  return {
    userId: claims.sub,
    username: claims.preferred_username || claims.sub,
    email: claims.email,
    displayName:
      overlay.displayName ||
      claims.name ||
      claims.preferred_username ||
      claims.email?.split('@')[0] ||
      claims.sub,
    avatarUrl: overlay.avatarUrl || claims.picture,
    groups,
    identitySource: idp ? 'sso' : 'cognito',
    identityProvider: idp,
  };
};

export const isPlatformAdmin = (user: User): boolean => user.groups.includes(PLATFORM_ADMIN_GROUP);

// --- service ----------------------------------------------------------------
let completedReturnTo: string | null = null;

export const authService = {
  async login(username: string, password: string): Promise<AuthResult> {
    try {
      clearTokens();
      const data = await tokenRequest({
        grant_type: 'password',
        username,
        password,
        scope: cognitoOauthScopes.join(' '),
      });
      const tokens = storeFromResponse(data);
      return { user: userFromTokens(tokens) };
    } catch (error: any) {
      console.error('Login error:', error);
      if (error.name === 'NotAuthorizedException') {
        throw new Error('Incorrect username or password', { cause: error });
      }
      throw error;
    }
  },

  async loginWithSso(providerName: string, returnTo: string): Promise<void> {
    if (!authConfiguration.providers.some((provider) => provider.name === providerName)) {
      throw new Error('Unknown enterprise identity provider');
    }
    sessionStorage.setItem('aidlc-auth-return-to', returnTo);
    completedReturnTo = null;
    clearPersistedCache();

    const verifier = randomString(48);
    const state = randomString(16);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: cognitoOauthScopes.join(' '),
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      kc_idp_hint: providerName,
    });
    window.location.assign(`${endpoints.authorize}?${params.toString()}`);
  },

  async completeSsoLogin(): Promise<User> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) || '{}');
    sessionStorage.removeItem(PKCE_KEY);

    if (error) throw normalizeSsoLoginError({ error, error_description: url.searchParams.get('error_description') });
    if (!code || !returnedState || returnedState !== stored.state) {
      throw new SsoLoginTimeoutError(new Error('Invalid SSO callback state'));
    }
    try {
      const data = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        code_verifier: stored.verifier,
      });
      return userFromTokens(storeFromResponse(data));
    } catch (err) {
      throw normalizeSsoLoginError(err);
    }
  },

  consumeReturnTo(): string {
    if (completedReturnTo) return completedReturnTo;
    const path = sessionStorage.getItem('aidlc-auth-return-to') || '/dashboard';
    sessionStorage.removeItem('aidlc-auth-return-to');
    completedReturnTo = path.startsWith('/') && !path.startsWith('//') ? path : '/dashboard';
    return completedReturnTo;
  },

  // Keycloak's ROPC flow has no Cognito-style NEW_PASSWORD challenge, so login()
  // never returns that nextStep and this is not reached in the local stack.
  async completeNewPassword(_newPassword: string): Promise<User> {
    throw new Error('Password-change challenge is not supported against Keycloak; reset the password in Keycloak.');
  },

  async logout(): Promise<void> {
    clearPersistedCache();
    clearTokens();
    localStorage.removeItem(PROFILE_OVERLAY_KEY);
  },

  async getCurrentUser(): Promise<User> {
    const tokens = await refreshIfNeeded();
    if (!tokens) throw new Error('Not authenticated');
    return userFromTokens(tokens);
  },

  // Display name / avatar are held as a local overlay (the local stack does not
  // grant the SPA write access to Keycloak account attributes); getCurrentUser
  // merges it over the token claims so the UI reflects edits immediately.
  async updateProfile(displayName?: string, avatarUrl?: string): Promise<void> {
    const overlay = profileOverlay();
    if (displayName !== undefined) overlay.displayName = displayName;
    if (avatarUrl !== undefined) overlay.avatarUrl = avatarUrl;
    localStorage.setItem(PROFILE_OVERLAY_KEY, JSON.stringify(overlay));
  },

  async getSession(): Promise<AuthSession | null> {
    const tokens = await refreshIfNeeded();
    if (!tokens) return null;
    return {
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
    };
  },

  async isAuthenticated(): Promise<boolean> {
    return (await refreshIfNeeded()) !== null;
  },
};
