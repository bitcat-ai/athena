export interface LocalMcpServer {
  id: string;
  name: string;
  source: string;
  location: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  status: 'discovered' | 'connecting' | 'connected' | 'error';
  toolCount?: number;
  message?: string;
  needsReview?: boolean;
}

export interface LocalMcpState {
  servers: LocalMcpServer[];
  diagnostics: string[];
  available: boolean;
}
