/**
 * Pandora Semantic Index - Client
 * 
 * Client for connecting to the semantic index server.
 * Used by Pandora agents to retrieve relevant code context.
 */

import WebSocket from 'ws';

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:7300';
const DEFAULT_TIMEOUT = 30000;

/**
 * Semantic Index Client
 */
export class SemanticIndexClient {
  constructor(config = {}) {
    this.endpoint = config.endpoint || process.env.PANDORA_SEMANTIC_INDEX_ENDPOINT || DEFAULT_ENDPOINT;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.ws = null;
    this.connected = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
  }

  /**
   * Connect to the server
   */
  async connect() {
    if (this.ws && this.connected) return this;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint);

      this.ws.on('open', () => {
        this.connected = true;
        resolve(this);
      });

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error));
            } else {
              pending.resolve(response);
            }
          }
        } catch (e) {
          console.error('[SemanticClient] Parse error:', e.message);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        if (!this.connected) {
          reject(new Error(`Failed to connect to semantic index at ${this.endpoint}: ${err.message}`));
        }
      });

      // Timeout
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Send a request to the server
   */
  async request(type, payload) {
    if (!this.connected) {
      await this.connect();
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  /**
   * Search for relevant code
   * @param {string} query - Natural language query
   * @param {object} options - { k: number, keywords: string[], filters: object }
   * @returns {Array<{path, content, startLine, endLine, score}>}
   */
  async search(query, options = {}) {
    const response = await this.request('search', { query, ...options });
    return response.results || [];
  }

  /**
   * Index a directory
   * @param {string} directory - Directory to index
   * @param {boolean} force - Force reindex
   */
  async index(directory, force = false) {
    return this.request('index', { directory, force });
  }

  /**
   * Index a single file
   * @param {string} filepath - File to index
   */
  async indexFile(filepath) {
    return this.request('indexFile', { filepath });
  }

  /**
   * Get index statistics
   */
  async stats() {
    return this.request('stats', {});
  }

  /**
   * Clear the index
   */
  async clear() {
    return this.request('clear', {});
  }

  /**
   * Close the connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected;
  }
}

// Singleton instance for Pandora
let _client = null;

/**
 * Get the global semantic index client
 */
export function getSemanticIndexClient(config = {}) {
  if (!_client) {
    _client = new SemanticIndexClient(config);
  }
  return _client;
}

/**
 * Quick search helper - connects, searches, returns results
 */
export async function semanticSearch(query, options = {}) {
  const client = getSemanticIndexClient();
  try {
    await client.connect();
    return await client.search(query, options);
  } catch (e) {
    console.error('[SemanticSearch] Error:', e.message);
    return [];
  }
}

export default SemanticIndexClient;
