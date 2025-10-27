export type OAuthSpec = {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  usePKCE?: boolean;
  scopes: string[];
};

export type ProviderConfig = {
  id: string;
  oauth: OAuthSpec;
  tools: ToolSpec[];
};

export type ToolSpec = {
  name: string;
  schema: JSONSchema;
  invoke: (args: any, ctx: { token: Token; accountId?: string }) => Promise<any>;
};

export type AgentConfig = {
  providers: ProviderConfig[];
  oauthStore: TokenStore;
  exposure: "strict" | "soft";
};

export type MCPExport = {
  toolName: `use_${string}`;
  input: { prompt: string; accountId?: string; options?: Record<string, unknown> };
  output: { text: string; citations?: any[]; telemetryId?: string };
};

// Added: Referenced in ToolSpec but not defined in spec
export type Token = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  issuedAt: number;
  tokenType?: string;
};

// Added: Referenced in ToolSpec but not defined in spec
export type JSONSchema = {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  [key: string]: any;
};

// Added: Referenced in AgentConfig but not defined in spec
export type TokenStore = {
  getToken(tenantId: string, providerId: string, accountId?: string): Promise<Token | null>;
  setToken(tenantId: string, providerId: string, accountId: string, token: Token): Promise<void>;
  revokeToken(tenantId: string, providerId: string, accountId: string): Promise<void>;
  getAccounts(tenantId: string, providerId: string): Promise<string[]>;
};
