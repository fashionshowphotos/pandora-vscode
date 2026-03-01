/**
 * Pandora Semantic Index - LanceDB Vector Store
 * Adapted from Continue (Apache-2.0)
 * 
 * Stores code embeddings in LanceDB for fast similarity search.
 * Each row: uuid, path, content, vector, startLine, endLine, nodeTypes
 */

import { connect } from '@lancedb/lancedb';
import { Field, Schema, FixedSizeList, Float32, Utf8, Int32 } from 'apache-arrow';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';

const DEFAULT_DB_PATH = path.join(process.env.PANDORA_STATE_DIR || '.', 'semantic_index');

/**
 * LanceDB Vector Store for code embeddings
 */
export class VectorStore {
  constructor(config = {}) {
    this.dbPath = config.dbPath || DEFAULT_DB_PATH;
    this.tableName = config.tableName || 'code_embeddings';
    this.dimension = config.dimension || 768;
    this.db = null;
    this.table = null;
  }

  /**
   * Initialize the vector store
   */
  async init() {
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true });
    }

    this.db = await connect(this.dbPath);
    
    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    } else {
      // Create empty table with schema
      const schema = this.getSchema();
      // LanceDB creates table on first insert
      this.table = null;
    }

    return this;
  }

  /**
   * Get Arrow schema for the table
   */
  getSchema() {
    return new Schema([
      new Field('uuid', new Utf8(), false),
      new Field('path', new Utf8(), false),
      new Field('content', new Utf8(), false),
      new Field('vector', new FixedSizeList(this.dimension, new Field('item', new Float32(), false)), false),
      new Field('startLine', new Int32(), false),
      new Field('endLine', new Int32(), false),
      new Field('nodeTypes', new Utf8(), false), // JSON array
      new Field('digest', new Utf8(), false),
    ]);
  }

  /**
   * Insert chunks with their embeddings
   * @param {Array<{chunk: object, embedding: number[]}>} items
   */
  async insert(items) {
    if (!items || items.length === 0) return;

    const rows = items.map(({ chunk, embedding }) => ({
      uuid: uuidv4(),
      path: chunk.filepath,
      content: chunk.content.substring(0, 8000), // Truncate large chunks
      vector: embedding,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      nodeTypes: JSON.stringify(chunk.nodeTypes || []),
      digest: chunk.digest,
    }));

    if (!this.table) {
      // Create table on first insert
      this.table = await this.db.createTable(this.tableName, rows);
    } else {
      await this.table.add(rows);
    }

    return rows.length;
  }

  /**
   * Delete chunks by file path
   * @param {string} filepath
   */
  async deleteByPath(filepath) {
    if (!this.table) return;
    
    try {
      await this.table.delete(`path = '${filepath.replace(/'/g, "''")}'`);
    } catch (e) {
      // Table might not exist yet
    }
  }

  /**
   * Search for similar chunks
   */
  async search(queryVector, k = 10, filters = {}) {
    if (!this.table) return [];

    try {
      // LanceDB vector search - query with the vector column name
      const query = this.table.query()
        .nearestTo(queryVector)
        .column('vector')
        .limit(k);

      const results = await query.toArray();

      return results.map((row, i) => ({
        path: row.path,
        content: row.content,
        startLine: row.startLine,
        endLine: row.endLine,
        nodeTypes: JSON.parse(row.nodeTypes || '[]'),
        score: 1 - (row._distance || 0),
        rank: i + 1,
      }));
    } catch (e) {
      console.error('[VectorStore] Search error:', e.message);
      return [];
    }
  }

  /**
   * Hybrid search: combine vector similarity with keyword matching
   * @param {number[]} queryVector - Query embedding
   * @param {string[]} keywords - Keywords to match
   * @param {number} k - Number of results
   */
  async hybridSearch(queryVector, keywords = [], k = 10) {
    if (!this.table) return [];

    // Vector search
    const vectorResults = await this.search(queryVector, k * 2);

    if (keywords.length === 0) {
      return vectorResults.slice(0, k);
    }

    // Keyword boosting
    const keywordPattern = new RegExp(keywords.join('|'), 'gi');
    
    const scored = vectorResults.map(result => {
      const keywordMatches = (result.content.match(keywordPattern) || []).length;
      const boost = 1 + (keywordMatches * 0.1);
      return { ...result, score: result.score * boost };
    });

    // Re-sort by boosted score
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, k);
  }

  /**
   * Get stats about the index
   */
  async stats() {
    if (!this.table) {
      return { count: 0, size: 0 };
    }

    const count = await this.table.countRows();
    
    return {
      count,
      table: this.tableName,
      dimension: this.dimension,
      dbPath: this.dbPath,
    };
  }

  /**
   * Clear all data
   */
  async clear() {
    if (this.table) {
      await this.table.delete('true');
    }
  }

  /**
   * Close the database connection
   */
  async close() {
    // LanceDB doesn't require explicit close
    this.db = null;
    this.table = null;
  }
}

export default VectorStore;
