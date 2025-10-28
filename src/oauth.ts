import type { OAuthSpec, Token, TokenStore } from "./types.js";


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

// TODO:  Add JSDoc and describe what is consuming this, what it does
function generateRandomState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
 */
export class OAuthManager {
  constructor(
    private tokenStore: TokenStore,
    private providers: Map<string, OAuthSpec>,
    private baseUrl: string
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

    const oauthSpec = this.providers.get(providerId);
    if (!oauthSpec) {
      throw new OAuthError(`Provider ${providerId} not configured`, "UNKNOWN_PROVIDER");
    }

    const response = await fetch(oauthSpec.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: oauthSpec.clientId,
        client_secret: oauthSpec.clientSecret || "",
        redirect_uri: `${this.baseUrl}/oauth/callback`,
      }),
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
    return { token, userId, providerId };
  }

  /**
   * Generate authorization URL for OAuth flow
   */
  getAuthorizationUrl(providerId: string, userId: string): string {
    const oauthSpec = this.providers.get(providerId);
    if (!oauthSpec) {
      throw new OAuthError(`Provider ${providerId} not configured`, "UNKNOWN_PROVIDER");
    }

    const state = generateRandomState();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: oauthSpec.clientId,
      redirect_uri: `${this.baseUrl}/oauth/callback`,
      scope: oauthSpec.scopes.join(" "),
      state: `${providerId}:${userId}`
    });

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

    const oauthSpec = this.providers.get(providerId);
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
