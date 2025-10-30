import type { OAuthSpec, ProviderConfig, Token, TokenStore } from "./types.js";
import type { AuthEventPublisher } from "./scheduler.js";


export class OAuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * Generate cryptographically secure random state string for OAuth
 *
 * Used to prevent CSRF attacks by creating unique state per OAuth flow.
 * Called by getAuthorizationUrl to create state parameter.
 *
 * @returns 64-character hexadecimal string
 */
function generateRandomState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate PKCE code verifier
 *
 * Creates a cryptographically random string for PKCE flow.
 * Must be 43-128 characters from [A-Z][a-z][0-9]-._~
 *
 * @returns Base64url encoded random string (43 characters)
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate PKCE code challenge from verifier
 *
 * Creates SHA256 hash of the verifier and base64url encodes it.
 *
 * @param verifier - The code verifier to hash
 * @returns Base64url encoded SHA256 hash
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64url encode a Uint8Array
 *
 * @param array - The array to encode
 * @returns Base64url encoded string
 */
function base64UrlEncode(array: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...array));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * OAuthManager handles OAuth token lifecycle for downstream MCP servers
 * 
 * Key responsibilities:
 * 1. Handle OAuth callbacks from providers
 * 2. Exchange authorization codes for access tokens
 * 3. Store tokens in TokenStore (Durable Objects)
 * 4. Auto-refresh expired tokens
 * 5. Revoke tokens when requested
 * 
 * @class OAuthManager
 */
export class OAuthManager {
  private codeVerifiers: Map<string, string> = new Map(); // Maps state -> code_verifier
  private registeredClients: Map<string, string> = new Map(); // Maps provider ID -> dynamically registered client_id

  /**
   * @param tokenStore - Storage backend for persisting OAuth tokens
   * @param providers - Map of provider IDs to ProviderConfig
   * @param baseUrl - Base URL for OAuth redirect URIs
   * @param publisher - Event publisher for scheduling refreshes
   */
  constructor(
    private tokenStore: TokenStore,
    private providers: Map<string, ProviderConfig>,
    private baseUrl: string,
    private publisher: AuthEventPublisher
  ) {}

  /**
   * Handle OAuth callback from provider
   * Extracts provider ID and user ID from state parameter
   *
   * State format: "providerId:userId:randomness"
   */
  async handleCallback(
    code: string,
    state: string
  ): Promise<{ token: Token; userId: string; providerId: string }> {
    // Extract provider ID and user ID from state
    const [providerId, userId] = state.split(":");

    if (!providerId || !userId) {
      throw new OAuthError("Invalid state parameter", "INVALID_STATE");
    }

    const provider = this.providers.get(providerId);
    const oauthSpec = provider?.oauth;
    if (!oauthSpec) {
      throw new OAuthError(`Provider ${providerId} not configured`, "UNKNOWN_PROVIDER");
    }

    // Use dynamically registered client ID if available
    const clientId = this.registeredClients.get(providerId) || oauthSpec.clientId;
    if (!clientId) {
      throw new OAuthError("No client ID available for token exchange", "NO_CLIENT_ID");
    }

    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: `${this.baseUrl}/oauth/callback`,
    };

    // Add client secret if not using PKCE
    if (oauthSpec.clientSecret && !oauthSpec.usePKCE) {
      tokenParams.client_secret = oauthSpec.clientSecret;
    }

    // Add PKCE code verifier if this flow used PKCE
    if (oauthSpec.usePKCE) {
      const codeVerifier = this.codeVerifiers.get(state);
      if (!codeVerifier) {
        throw new OAuthError("PKCE code verifier not found for this state", "MISSING_CODE_VERIFIER");
      }
      tokenParams.code_verifier = codeVerifier;

      // Clean up stored verifier
      this.codeVerifiers.delete(state);
    }

    const response = await fetch(oauthSpec.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenParams),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { error?: string } | null;
      const errorMessage = errorData?.error || response.statusText;
      throw new OAuthError(
        `Token exchange failed: ${errorMessage}`,
        "TOKEN_EXCHANGE_FAILED",
        response.status
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const token: Token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type || "Bearer",
      issuedAt: Date.now(),
    };

    await this.tokenStore.setToken(userId, providerId, "default", token);
    // schedule next refresh if we have an expiry
    if (token.expiresAt) {
      const lead = provider?.refresh?.leadMs ?? 600_000;
      const runAt = Math.max(0, token.expiresAt - lead);
      await this.publisher.scheduleRefresh({ userId, providerId, accountId: "default", runAt });
    }
    return { token, userId, providerId };
  }

  /**
   * Dynamically register an OAuth client with the provider
   * Uses RFC 7591 Dynamic Client Registration
   *
   * @param providerId - Provider identifier
   * @param oauthSpec - Provider's OAuth specification
   * @returns Registered client ID
   */
  private async registerClient(providerId: string, oauthSpec: OAuthSpec): Promise<string> {
    if (!oauthSpec.registrationUrl) {
      throw new OAuthError("Provider does not support dynamic client registration", "NO_REGISTRATION_ENDPOINT");
    }

    const response = await fetch(oauthSpec.registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Pleiades",
        redirect_uris: [`${this.baseUrl}/oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none"
      })
    });

    if (!response.ok) {
      throw new OAuthError("Client registration failed", "REGISTRATION_FAILED", response.status);
    }

    const data = await response.json() as { client_id: string };
    const clientId = data.client_id;

    // Cache the registered client ID
    this.registeredClients.set(providerId, clientId);

    return clientId;
  }

  /**
   * Generate authorization URL for OAuth flow
   * Supports PKCE if configured for the provider
   * Handles dynamic client registration if needed
   */
  async getAuthorizationUrl(providerId: string, userId: string): Promise<string> {
    const provider = this.providers.get(providerId);
    const oauthSpec = provider?.oauth;
    if (!oauthSpec) {
      throw new OAuthError(`Provider ${providerId} not configured`, "UNKNOWN_PROVIDER");
    }

    // Handle dynamic client registration if needed
    let clientId = oauthSpec.clientId;
    if (!clientId && oauthSpec.registrationUrl) {
      // Check if we've already registered
      const registered = this.registeredClients.get(providerId);
      if (registered) {
        clientId = registered;
      } else {
        clientId = await this.registerClient(providerId, oauthSpec);
      }
    }

    if (!clientId) {
      throw new OAuthError("No client ID available and no registration endpoint configured", "NO_CLIENT_ID");
    }

    const randomState = generateRandomState();
    const state = `${providerId}:${userId}:${randomState}`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: `${this.baseUrl}/oauth/callback`,
      state
    });

    // Add scope if provided (some PKCE flows omit it)
    if (oauthSpec.scopes && oauthSpec.scopes.length > 0) {
      params.set("scope", oauthSpec.scopes.join(" "));
    }

    // Add PKCE parameters if enabled
    if (oauthSpec.usePKCE) {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      // Store verifier for token exchange
      this.codeVerifiers.set(state, codeVerifier);

      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }

    return `${oauthSpec.authUrl}?${params.toString()}`;
  }

  /**
   * Get token for a provider and user
   * Returns null if no token exists
   * Auto-refreshes if token is expired
   */
  async getToken(userId: string, providerId: string): Promise<Token | null> {
    const token = await this.tokenStore.getToken(userId, providerId);
    
    if (!token) {
      return null;
    }

    // Auto-refresh if expired
    if (token.expiresAt && token.expiresAt < Date.now()) {
      return await this.refreshToken(userId, providerId);
    }

    return token;
  }

  /**
   * Refresh an expired access token using a refresh token
   */
  async refreshToken(userId: string, providerId: string): Promise<Token> {
    const token = await this.tokenStore.getToken(userId, providerId);
    if (!token?.refreshToken) {
      throw new OAuthError("No refresh token available", "NO_REFRESH_TOKEN");
    }

    const provider = this.providers.get(providerId);
    const oauthSpec = provider?.oauth;
    if (!oauthSpec) {
      throw new OAuthError(`Provider ${providerId} not configured`, "UNKNOWN_PROVIDER");
    }

    const response = await fetch(oauthSpec.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: oauthSpec.clientId,
        client_secret: oauthSpec.clientSecret || "",
      }),
    });

    if (!response.ok) {
      throw new OAuthError("Token refresh failed", "TOKEN_REFRESH_FAILED", response.status);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const newToken: Token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || token.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type || "Bearer",
      issuedAt: Date.now(),
    };

    await this.tokenStore.setToken(userId, providerId, "default", newToken);
    if (newToken.expiresAt) {
      const lead = provider?.refresh?.leadMs ?? 600_000;
      const runAt = Math.max(0, newToken.expiresAt - lead);
      await this.publisher.scheduleRefresh({ userId, providerId, accountId: "default", runAt });
    }
    return newToken;
  }

  /**
   * Revoke a stored token
   */
  async revokeToken(userId: string, providerId: string): Promise<void> {
    await this.tokenStore.revokeToken(userId, providerId, "default");
  }
}

// Re-export types for convenience
export type { OAuthSpec, Token } from "./types.js";
