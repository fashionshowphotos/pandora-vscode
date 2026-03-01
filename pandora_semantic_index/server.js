/**
 * Pandora Semantic Index - WebSocket Server
 * 
 * Provides semantic search over MCP/Bond for all Pandora agents.
 * Run as a standalone service on the PowerEdge.
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { Indexer } from './indexer.js';

const DEFAULT_PORT = 7300;
const DEFAULT_HOST = '0.0.0.0';

/**
 * Semantic Index Server
 */
export class SemanticIndexServer {
  constructor(config = {}) {
    this.port = config.port || DEFAULT_PORT;
    this.host = config.host || DEFAULT_HOST;
    this.indexerConfig = config.indexer || {};
    this.indexer = null;
    this.wss = null;
    this.httpServer = null;
    this.clients = new Set();
  }

  /**
   * Start the server
   */
  async start() {
    // Initialize indexer
    this.indexer = new Indexer(this.indexerConfig);
    await this.indexer.init();

    // Create HTTP server for health checks
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'pandora-semantic-index' }));
      } else if (req.url === '/stats') {
        this.handleStats(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      console.log(`[Server] Client connected from ${req.socket.remoteAddress}`);
      this.clients.add(ws);

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          const response = await this.handleMessage(message);
          ws.send(JSON.stringify({ id: message.id, ...response }));
        } catch (e) {
          ws.send(JSON.stringify({ error: e.message }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });
    });

    return new Promise((resolve) => {
      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[Server] Pandora Semantic Index listening on ws://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming messages
   */
  async handleMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case 'search':
        return await this.handleSearch(payload);
      
      case 'index':
        return await this.handleIndex(payload);
      
      case 'indexFile':
        return await this.handleIndexFile(payload);
      
      case 'stats':
        return await this.indexer.stats();
      
      case 'clear':
        await this.indexer.vectorStore.clear();
        return { cleared: true };
      
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  }

  /**
   * Handle search request
   */
  async handleSearch(payload) {
    const { query, k, keywords, filters } = payload;
    
    if (!query) {
      throw new Error('Search requires "query" field');
    }

    const results = await this.indexer.search(query, { k, keywords, filters });
    
    return {
      query,
      results,
      count: results.length,
    };
  }

  /**
   * Handle directory index request
   */
  async handleIndex(payload) {
    const { directory, force } = payload;
    
    if (!directory) {
      throw new Error('Index requires "directory" field');
    }

    // Run indexing in background, return immediately
    const result = await this.indexer.indexDirectory(directory, {
      force,
      onProgress: (progress) => {
        // Broadcast progress to all clients
        this.broadcast({
          type: 'indexProgress',
          payload: progress,
        });
      },
    });

    return result;
  }

  /**
   * Handle single file index request
   */
  async handleIndexFile(payload) {
    const { filepath } = payload;
    
    if (!filepath) {
      throw new Error('indexFile requires "filepath" field');
    }

    return await this.indexer.indexFile(filepath);
  }

  /**
   * Handle stats request
   */
  async handleStats(res) {
    const stats = await this.indexer.stats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  /**
   * Stop the server
   */
  async stop() {
    if (this.wss) {
      for (const client of this.clients) {
        client.close();
      }
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
    if (this.indexer) {
      await this.indexer.vectorStore.close();
    }
    console.log('[Server] Stopped');
  }
}

// CLI entry point
const entryPoint = process.argv?.[1]?.replace(/\\/g, '/');
if (entryPoint && import.meta.url === `file://${entryPoint}`) {
  const server = new SemanticIndexServer({
    port: parseInt(process.env.PANDORA_SEMANTIC_INDEX_PORT || DEFAULT_PORT),
    host: process.env.PANDORA_SEMANTIC_INDEX_HOST || DEFAULT_HOST,
  });

  server.start().catch(console.error);

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
}

export default SemanticIndexServer;
