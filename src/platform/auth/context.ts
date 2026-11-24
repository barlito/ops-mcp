// vendored from second-brain-mcp@d4ba1c5
// Identity of the authenticated caller. Any authenticated client reads everything: no scopes.
export interface AuthContext {
  credentialId: string;
  name: string;
  kind: "token" | "connector_key";
  clientIp?: string;
}
