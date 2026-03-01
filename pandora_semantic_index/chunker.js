/**
 * Pandora Semantic Index - Code Chunker
 * Adapted from Continue (Apache-2.0)
 * 
 * Splits code files into semantic chunks using tree-sitter for AST-aware chunking.
 * Falls back to line-based chunking for unsupported languages.
 */

import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';

const LANGUAGE_PARSERS = {
  js: JavaScript,
  javascript: JavaScript,
  ts: TypeScript.typescript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  py: Python,
  python: Python,
};

const FUNCTION_NODE_TYPES = [
  'function_declaration',
  'function_definition',
  'method_definition',
  'arrow_function',
  'function_expression',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'type_alias_declaration',
  'export_statement',
  'import_statement',
];

/**
 * Chunk a file into semantic units
 * @param {string} filepath - File path
 * @param {string} content - File content
 * @param {number} maxChunkSize - Max tokens per chunk (default 500)
 * @returns {AsyncGenerator<Chunk>}
 */
export async function* chunkDocument(filepath, content, maxChunkSize = 500) {
  if (!content || content.trim() === '') return;

  const ext = filepath.split('.').pop()?.toLowerCase();
  const parser = LANGUAGE_PARSERS[ext];

  if (parser) {
    try {
      for await (const chunk of codeChunker(filepath, content, maxChunkSize, parser)) {
        yield chunk;
      }
      return;
    } catch (e) {
      // Fall back to basic chunker
    }
  }

  // Basic line-based chunker
  yield* basicChunker(filepath, content, maxChunkSize);
}

/**
 * AST-aware code chunker using tree-sitter
 */
async function* codeChunker(filepath, content, maxChunkSize, language) {
  const p = new Parser();
  p.setLanguage(language);
  
  // Hard char limit: ~4000 chars = ~1000 tokens (safe for nomic-embed-text)
  const MAX_CHUNK_CHARS = 4000;
  
  const tree = p.parse(content);
  const root = tree.rootNode;

  const chunks = [];
  let currentChunk = { lines: [], startLine: 1, nodeTypes: new Set(), charCount: 0 };

  function* flushChunk() {
    if (currentChunk.lines.length > 0) {
      const chunkContent = currentChunk.lines.join('\n');
      if (chunkContent.trim()) {
        // Truncate if still over limit
        const finalContent = chunkContent.length > MAX_CHUNK_CHARS 
          ? chunkContent.substring(0, MAX_CHUNK_CHARS) 
          : chunkContent;
        yield {
          filepath,
          content: finalContent,
          startLine: currentChunk.startLine,
          endLine: currentChunk.startLine + currentChunk.lines.length - 1,
          nodeTypes: [...currentChunk.nodeTypes],
          digest: hashContent(finalContent),
        };
      }
      currentChunk = { lines: [], startLine: 1, nodeTypes: new Set(), charCount: 0 };
    }
  }

  function walkNode(node, lines, startLineNum) {
    const nodeStartLine = node.startPosition.row + 1;
    const nodeEndLine = node.endPosition.row + 1;
    const nodeContent = lines.slice(nodeStartLine - 1, nodeEndLine).join('\n');
    const nodeChars = nodeContent.length;

    // If this is a semantic unit (function, class, etc.)
    if (FUNCTION_NODE_TYPES.includes(node.type)) {
      // If adding this would exceed max, flush current first
      if (currentChunk.charCount + nodeChars > MAX_CHUNK_CHARS && currentChunk.lines.length > 0) {
        const chunkContent = currentChunk.lines.join('\n');
        const finalContent = chunkContent.length > MAX_CHUNK_CHARS 
          ? chunkContent.substring(0, MAX_CHUNK_CHARS) 
          : chunkContent;
        const chunk = {
          filepath,
          content: finalContent,
          startLine: currentChunk.startLine,
          endLine: currentChunk.startLine + currentChunk.lines.length - 1,
          nodeTypes: [...currentChunk.nodeTypes],
          digest: hashContent(finalContent),
        };
        currentChunk = { lines: [], startLine: nodeStartLine, nodeTypes: new Set([node.type]), charCount: 0 };
        // Add node content if it fits, otherwise truncate
        if (nodeChars <= MAX_CHUNK_CHARS) {
          currentChunk.lines = lines.slice(nodeStartLine - 1, nodeEndLine);
          currentChunk.charCount = nodeChars;
        } else {
          // Node too big - truncate
          currentChunk.lines = [nodeContent.substring(0, MAX_CHUNK_CHARS)];
          currentChunk.charCount = MAX_CHUNK_CHARS;
        }
        return chunk;
      }

      // Start new chunk for this semantic unit if current is empty
      if (currentChunk.lines.length === 0) {
        currentChunk.startLine = nodeStartLine;
      }

      currentChunk.nodeTypes.add(node.type);
      const nodeLines = lines.slice(nodeStartLine - 1, nodeEndLine);
      currentChunk.lines.push(...nodeLines);
      currentChunk.charCount += nodeChars;
    } else {
      // Non-semantic node - just accumulate if under limit
      if (currentChunk.lines.length === 0) {
        currentChunk.startLine = nodeStartLine;
      }
      const nodeLines = lines.slice(nodeStartLine - 1, nodeEndLine);
      if (currentChunk.charCount + nodeContent.length <= MAX_CHUNK_CHARS) {
        currentChunk.lines.push(...nodeLines);
        currentChunk.charCount += nodeContent.length;
      }
    }

    // Recurse into children
    for (const child of node.children) {
      walkNode(child, lines, startLineNum);
    }

    return null;
  }

  const lines = content.split('\n');
  
  for (const child of root.children) {
    const chunk = walkNode(child, lines, 1);
    if (chunk) yield chunk;
  }

  // Flush remaining
  if (currentChunk.lines.length > 0) {
    yield {
      filepath,
      content: currentChunk.lines.join('\n'),
      startLine: currentChunk.startLine,
      endLine: currentChunk.startLine + currentChunk.lines.length - 1,
      nodeTypes: [...currentChunk.nodeTypes],
      digest: hashContent(currentChunk.lines.join('\n')),
    };
  }
}

/**
 * Basic line-based chunker for unsupported languages
 */
function* basicChunker(filepath, content, maxChunkSize) {
  const lines = content.split('\n');
  // Hard char limit: ~4000 chars = ~1000 tokens (safe for nomic-embed-text)
  const MAX_CHUNK_CHARS = 4000;
  
  let currentChunk = [];
  let currentSize = 0;
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length + 1; // +1 for newline
    
    if (currentSize + lineSize > MAX_CHUNK_CHARS && currentChunk.length > 0) {
      // Flush current chunk
      const chunk = currentChunk.join('\n');
      if (chunk.trim()) {
        yield {
          filepath,
          content: chunk,
          startLine,
          endLine: i,
          nodeTypes: ['text'],
          digest: hashContent(chunk),
        };
      }
      currentChunk = [];
      currentSize = 0;
      startLine = i + 1;
    }
    
    currentChunk.push(line);
    currentSize += lineSize;
  }
  
  // Flush remaining
  if (currentChunk.length > 0) {
    const chunk = currentChunk.join('\n');
    if (chunk.trim()) {
      yield {
        filepath,
        content: chunk,
        startLine,
        endLine: lines.length,
        nodeTypes: ['text'],
        digest: hashContent(chunk),
      };
    }
  }
}

/**
 * Simple content hash for deduplication
 */
function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check if a file should be chunked
 */
export function shouldChunk(filepath, content) {
  if (content.length > 1000000) return false; // Skip huge files
  if (content.length === 0) return false;
  
  const basename = filepath.split('/').pop() || '';
  if (!basename.includes('.')) return false; // Skip files without extension
  
  // Skip binary files
  const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib'];
  const ext = basename.split('.').pop()?.toLowerCase();
  if (binaryExts.includes(ext)) return false;
  
  return true;
}

export default { chunkDocument, shouldChunk };
