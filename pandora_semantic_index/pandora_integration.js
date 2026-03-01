/**
 * Pandora Semantic Index - Pandora Integration
 * 
 * Wires semantic retrieval into Pandora's autonomous loop.
 * Replaces compression-based context with semantic search.
 */

import { SemanticIndexClient, getSemanticIndexClient } from './client.js';

const SEMANTIC_INDEX_ENDPOINT = process.env.PANDORA_SEMANTIC_INDEX_ENDPOINT || 'ws://127.0.0.1:7300';

/**
 * Build context for a target file using semantic search
 * @param {string} targetFile - File being analyzed
 * @param {string} analysis - Bug analysis text
 * @param {object} options - { maxChunks: number, includeRelated: boolean }
 * @returns {string} - Context string for the improver
 */
export async function buildSemanticContext(targetFile, analysis, options = {}) {
  const { maxChunks = 20, includeRelated = true } = options;
  
  const client = getSemanticIndexClient({ endpoint: SEMANTIC_INDEX_ENDPOINT });
  
  try {
    await client.connect();
  } catch (e) {
    console.warn(`[SemanticContext] Index not available: ${e.message}`);
    return null; // Fall back to traditional context
  }

  // Extract keywords from analysis
  const keywords = extractKeywords(analysis);
  
  // Search for relevant code
  const results = await client.search(analysis, {
    k: maxChunks,
    keywords,
    filters: includeRelated ? {} : { path: targetFile },
  });

  if (results.length === 0) {
    return null;
  }

  // Build context string
  const contextParts = [];
  
  // Group by file
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, []);
    byFile.get(r.path).push(r);
  }

  // Format context
  for (const [path, chunks] of byFile) {
    const isTarget = path === targetFile || path.endsWith(targetFile);
    contextParts.push(`\n### ${isTarget ? 'TARGET' : 'RELATED'}: ${path}`);
    
    for (const chunk of chunks.slice(0, 3)) { // Max 3 chunks per file
      contextParts.push(`\n[L${chunk.startLine}-${chunk.endLine}] (relevance: ${chunk.score.toFixed(2)})`);
      contextParts.push('```javascript');
      contextParts.push(chunk.content);
      contextParts.push('```');
    }
  }

  return contextParts.join('\n');
}

/**
 * Extract keywords from analysis text
 */
function extractKeywords(text) {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'this', 'that', 'these', 'those', 'it', 'its']);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Count frequency
  const freq = new Map();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Return top keywords
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

/**
 * Find similar code patterns across the codebase
 * @param {string} code - Code snippet to find similar patterns for
 * @param {number} k - Number of results
 */
export async function findSimilarPatterns(code, k = 10) {
  const client = getSemanticIndexClient({ endpoint: SEMANTIC_INDEX_ENDPOINT });
  
  try {
    await client.connect();
  } catch (e) {
    return [];
  }

  return client.search(code, { k });
}

/**
 * Get architectural context for planning (MC4 level)
 * @param {string} task - Task description
 */
export async function getArchitecturalContext(task) {
  const client = getSemanticIndexClient({ endpoint: SEMANTIC_INDEX_ENDPOINT });
  
  try {
    await client.connect();
  } catch (e) {
    return null;
  }

  // Search for high-level architectural patterns
  const results = await client.search(task, {
    k: 15,
    keywords: extractKeywords(task),
  });

  // Filter for architectural files
  const archFiles = results.filter(r => 
    r.path.includes('kernel') ||
    r.path.includes('orchestrator') ||
    r.path.includes('index.js') ||
    r.path.includes('main.js') ||
    r.nodeTypes.includes('class_declaration') ||
    r.nodeTypes.includes('interface_declaration')
  );

  return archFiles.length > 0 ? archFiles : results.slice(0, 5);
}

/**
 * Get implementation context for building (MC2 level)
 * @param {string} targetFile - File being modified
 * @param {string} bugDescription - Bug or feature description
 */
export async function getImplementationContext(targetFile, bugDescription) {
  const client = getSemanticIndexClient({ endpoint: SEMANTIC_INDEX_ENDPOINT });
  
  try {
    await client.connect();
  } catch (e) {
    return null;
  }

  // Search for implementation details
  const results = await client.search(bugDescription, {
    k: 20,
    keywords: [...extractKeywords(bugDescription), targetFile.split('/').pop().replace('.js', '')],
  });

  // Prioritize target file and direct dependencies
  const targetResults = results.filter(r => r.path === targetFile || r.path.endsWith('/' + targetFile));
  const relatedResults = results.filter(r => !targetResults.includes(r));

  return {
    target: targetResults,
    related: relatedResults.slice(0, 10),
  };
}

/**
 * Check if semantic index is available
 */
export async function isSemanticIndexAvailable() {
  const client = getSemanticIndexClient({ endpoint: SEMANTIC_INDEX_ENDPOINT });
  
  try {
    await client.connect();
    const stats = await client.stats();
    return stats.count > 0;
  } catch {
    return false;
  }
}

export default {
  buildSemanticContext,
  findSimilarPatterns,
  getArchitecturalContext,
  getImplementationContext,
  isSemanticIndexAvailable,
};
