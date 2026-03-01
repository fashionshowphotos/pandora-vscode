/**
 * Pandora Semantic Index - Embedding Providers
 * 
 * Supports multiple embedding backends:
 * - Ollama (local, free)
 * - OpenAI (cloud, paid)
 * - Custom API endpoints
 */

import OpenAI from 'openai';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'; // Good local model via Ollama
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Create an embedding provider based on config
 */
export function createEmbeddingProvider(config = {}) {
  const provider = config.provider || 'ollama';
  
  if (provider === 'openai') {
    return new OpenAIEmbeddingProvider(config);
  }
  
  if (provider === 'ollama') {
    return new OllamaEmbeddingProvider(config);
  }
  
  if (provider === 'custom') {
    return new CustomEmbeddingProvider(config);
  }
  
  throw new Error(`Unknown embedding provider: ${provider}`);
}

/**
 * Ollama embedding provider (local, free)
 */
class OllamaEmbeddingProvider {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || DEFAULT_EMBEDDING_MODEL;
    this.embeddingId = `ollama:${this.model}`;
  }

  async embed(texts) {
    // Ollama requires prompt to be a string, not array
    const inputTexts = Array.isArray(texts) ? texts : [texts];
    const embeddings = [];

    for (let i = 0; i < inputTexts.length; i++) {
      const text = inputTexts[i];
      
      // Throttle: wait 100ms between requests to prevent CPU overload
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embedding failed: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      embeddings.push(data.embedding);
    }
    
    return embeddings;
  }

  getDimension() {
    // nomic-embed-text dimension
    if (this.model.includes('nomic')) return 768;
    if (this.model.includes('all-minilm')) return 384;
    if (this.model.includes('mxbai')) return 1024;
    return 768; // default
  }
}

/**
 * OpenAI embedding provider (cloud, paid)
 */
class OpenAIEmbeddingProvider {
  constructor(config = {}) {
    this.client = new OpenAI({ apiKey: config.apiKey || process.env.OPENAI_API_KEY });
    this.model = config.model || OPENAI_EMBEDDING_MODEL;
    this.embeddingId = `openai:${this.model}`;
  }

  async embed(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    
    const response = await this.client.embeddings.create({
      model: this.model,
      input,
    });

    return response.data.map(d => d.embedding);
  }

  getDimension() {
    if (this.model.includes('small')) return 1536;
    if (this.model.includes('large')) return 3072;
    if (this.model.includes('ada')) return 1536;
    return 1536;
  }
}

/**
 * Custom API embedding provider
 */
class CustomEmbeddingProvider {
  constructor(config = {}) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model || 'custom';
    this.embeddingId = `custom:${this.model}`;
    
    if (!this.endpoint) {
      throw new Error('Custom embedding provider requires endpoint URL');
    }
  }

  async embed(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ input, model: this.model }),
    });

    if (!response.ok) {
      throw new Error(`Custom embedding failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Assume OpenAI-compatible response format
    return data.data?.map(d => d.embedding) || data.embeddings || [data.embedding];
  }

  getDimension() {
    return 768; // default, should be configured
  }
}

export default { createEmbeddingProvider };
