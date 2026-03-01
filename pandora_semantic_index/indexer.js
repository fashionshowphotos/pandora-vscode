/**
 * Pandora Semantic Index - Indexer Pipeline
 * 
 * Main indexing orchestrator:
 * - Walks directory tree
 * - Respects ignore patterns
 * - Chunks files
 * - Generates embeddings
 * - Stores in LanceDB
 */

import { glob } from 'glob';
import ignore from 'ignore';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { chunkDocument, shouldChunk } from './chunker.js';
import { createEmbeddingProvider } from './embeddings.js';
import { VectorStore } from './vector_store.js';

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '.env',
  '.env.*',
  '**/*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const BATCH_SIZE = 50; // Files per batch for embedding

/**
 * Codebase Indexer
 */
export class Indexer {
  constructor(config = {}) {
    this.embeddingProvider = createEmbeddingProvider(config.embedding || {});
    this.vectorStore = new VectorStore({
      dimension: this.embeddingProvider.getDimension(),
      ...config.vectorStore,
    });
    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    this.maxChunkSize = config.maxChunkSize || 500;
    this.batchSize = config.batchSize || BATCH_SIZE;
    this.indexedCount = 0;
    this.skippedCount = 0;
    this.errorCount = 0;
  }

  /**
   * Initialize the indexer
   */
  async init() {
    await this.vectorStore.init();
    return this;
  }

  /**
   * Index a directory
   * @param {string} directory - Root directory to index
   * @param {object} options - { force: boolean, onProgress: function }
   */
  async indexDirectory(directory, options = {}) {
    const { force = false, onProgress } = options;
    
    console.log(`[Indexer] Indexing ${directory}...`);
    
    // Find all files
    const files = await this.discoverFiles(directory);
    console.log(`[Indexer] Found ${files.length} files to index`);

    // Process in batches
    let processed = 0;
    const batch = [];

    for (const file of files) {
      batch.push(file);

      if (batch.length >= this.batchSize) {
        await this.processBatch(batch, directory, force, onProgress, processed, files.length);
        processed += batch.length;
        batch.length = 0;
      }
    }

    // Process remaining
    if (batch.length > 0) {
      await this.processBatch(batch, directory, force, onProgress, processed, files.length);
    }

    const stats = await this.vectorStore.stats();
    console.log(`[Indexer] Complete. Indexed: ${this.indexedCount}, Skipped: ${this.skippedCount}, Errors: ${this.errorCount}`);
    console.log(`[Indexer] Vector store: ${stats.count} chunks`);

    return {
      indexed: this.indexedCount,
      skipped: this.skippedCount,
      errors: this.errorCount,
      totalChunks: stats.count,
    };
  }

  /**
   * Discover files to index
   */
  async discoverFiles(directory) {
    const gitignorePath = `${directory}/.gitignore`;
    const pandoraIgnorePath = `${directory}/.pandoraignore`;
    
    const ig = ignore().add(this.ignorePatterns);

    // Add gitignore patterns
    if (existsSync(gitignorePath)) {
      const gitignore = readFileSync(gitignorePath, 'utf-8');
      ig.add(gitignore.split('\n').filter(l => l && !l.startsWith('#')));
    }

    // Add pandora-specific ignores
    if (existsSync(pandoraIgnorePath)) {
      const pandoraignore = readFileSync(pandoraIgnorePath, 'utf-8');
      ig.add(pandoraignore.split('\n').filter(l => l && !l.startsWith('#')));
    }

    // Glob all files (relative paths)
    const allFiles = await glob('**/*', {
      cwd: directory,
      absolute: false,
      nodir: true,
      dot: false,
    });

    // Filter by ignore patterns (already relative)
    const filtered = ig.filter(allFiles);

    // Convert to absolute paths
    return filtered.map(f => path.resolve(directory, f));
  }

  /**
   * Process a batch of files
   */
  async processBatch(files, rootDir, force, onProgress, processed, total) {
    const allChunks = [];
    const chunkMap = new Map(); // filepath -> chunks

    // Read and chunk files
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        
        if (!shouldChunk(file, content)) {
          this.skippedCount++;
          continue;
        }

        const chunks = [];
        for await (const chunk of chunkDocument(file, content, this.maxChunkSize)) {
          chunks.push(chunk);
        }

        if (chunks.length > 0) {
          chunkMap.set(file, chunks);
          allChunks.push(...chunks);
        }
      } catch (e) {
        console.error(`[Indexer] Error reading ${file}: ${e.message}`);
        this.errorCount++;
      }
    }

    if (allChunks.length === 0) return;

    // Delete old chunks for these files
    for (const file of files) {
      await this.vectorStore.deleteByPath(file);
    }

    // Generate embeddings - truncate chunks to stay under embedding model context limit
    // nomic-embed-text: 8192 tokens, ~4 chars/token, so ~32000 chars max, use 6000 to be safe
    const MAX_CHUNK_CHARS = 6000;
    const texts = allChunks.map(c => c.content.length > MAX_CHUNK_CHARS 
      ? c.content.substring(0, MAX_CHUNK_CHARS) 
      : c.content);
    
    try {
      const embeddings = await this.embeddingProvider.embed(texts);

      // Insert into vector store
      const items = allChunks.map((chunk, i) => ({
        chunk,
        embedding: embeddings[i],
      }));

      await this.vectorStore.insert(items);
      this.indexedCount += files.length;

      if (onProgress) {
        onProgress({
          processed: processed + files.length,
          total,
          chunks: allChunks.length,
          file: files[files.length - 1],
        });
      }
    } catch (e) {
      console.error(`[Indexer] Embedding error: ${e.message}`);
      this.errorCount += files.length;
    }
  }

  /**
   * Index a single file (for incremental updates)
   */
  async indexFile(filepath, options = {}) {
    const { force = false } = options;

    try {
      const content = readFileSync(filepath, 'utf-8');
      
      if (!shouldChunk(filepath, content)) {
        return { indexed: false, reason: 'File not suitable for chunking' };
      }

      // Delete old chunks
      await this.vectorStore.deleteByPath(filepath);

      // Chunk
      const chunks = [];
      for await (const chunk of chunkDocument(filepath, content, this.maxChunkSize)) {
        chunks.push(chunk);
      }

      if (chunks.length === 0) {
        return { indexed: false, reason: 'No chunks generated' };
      }

      // Embed
      const embeddings = await this.embeddingProvider.embed(chunks.map(c => c.content));

      // Store
      const items = chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] }));
      await this.vectorStore.insert(items);

      return { indexed: true, chunks: chunks.length };
    } catch (e) {
      return { indexed: false, error: e.message };
    }
  }

  /**
   * Search the index
   */
  async search(query, options = {}) {
    const { k = 10, keywords = [], filters = {} } = options;

    // Embed the query
    const [queryVector] = await this.embeddingProvider.embed([query]);

    // Search
    if (keywords.length > 0) {
      return this.vectorStore.hybridSearch(queryVector, keywords, k);
    }

    return this.vectorStore.search(queryVector, k, filters);
  }

  /**
   * Get stats
   */
  async stats() {
    return this.vectorStore.stats();
  }
}

export default Indexer;
