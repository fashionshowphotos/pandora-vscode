# Pandora Semantic Index

> Semantic code search for Pandora's autonomous agents.
> Adapted from [Continue](https://github.com/continuedev/continue) (Apache-2.0)

## What It Does

Instead of compressing context to fit in a window, this system:

1. **Indexes** the entire codebase into vector embeddings (LanceDB)
2. **Retrieves** only the relevant chunks for each task
3. **Scales** infinitely — 500K lines is no different from 5K lines

A 500,000 line codebase becomes irrelevant as a number. The agent always gets the right 2,000 lines for the current task.

## Quick Start

```bash
# Install dependencies
cd pandora_semantic_index
npm install

# Index the Pandora codebase
node cli.js index ../pandora\ running\ vscode/pandora_core

# Search
node cli.js query "how does the autonomous loop select goals"

# Start server for agent queries
node cli.js serve --port 7300
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Pandora Agents                            │
│  (Claude Code, Codex, Aider, Cline, anything via Bond/MCP)  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Semantic Index Server (ws://host:7300)         │
│                                                              │
│  • search(query) → relevant chunks                           │
│  • index(directory) → build/update index                     │
│  • stats() → index statistics                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    LanceDB Vector Store                      │
│                                                              │
│  • Stores code embeddings                                   │
│  • Fast similarity search                                    │
│  • Hybrid: vector + keyword matching                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Embedding Provider                         │
│                                                              │
│  • Ollama (local, free) — nomic-embed-text                  │
│  • OpenAI (cloud, paid) — text-embedding-3-small            │
│  • Custom API endpoints                                      │
└─────────────────────────────────────────────────────────────┘
```

## Components

| File | Purpose |
|------|---------|
| `chunker.js` | Tree-sitter AST-aware code chunking |
| `embeddings.js` | Ollama/OpenAI/Custom embedding providers |
| `vector_store.js` | LanceDB storage and similarity search |
| `indexer.js` | Directory walking, ignore patterns, batch indexing |
| `server.js` | WebSocket server for agent queries |
| `client.js` | Client library for connecting to server |
| `cli.js` | Command-line interface |
| `pandora_integration.js` | Wire into Pandora autonomous loop |

## Usage in Pandora

```javascript
import { buildSemanticContext, getImplementationContext } from './pandora_semantic_index/pandora_integration.js';

// In analyze phase — get context for target file
const context = await buildSemanticContext(targetFile, analysis, { maxChunks: 20 });

// In improve phase — get implementation details
const implContext = await getImplementationContext(targetFile, bugDescription);

// Use context in prompt
const prompt = `Bug: ${bugDescription}

Relevant code:
${context}

Fix the bug.`;
```

## Embedding Providers

### Ollama (Recommended for local)

```bash
# Pull the embedding model
ollama pull nomic-embed-text

# Start Ollama
ollama serve
```

```javascript
const indexer = new Indexer({
  embedding: { provider: 'ollama', model: 'nomic-embed-text' }
});
```

### OpenAI (Cloud)

```javascript
const indexer = new Indexer({
  embedding: { 
    provider: 'openai', 
    model: 'text-embedding-3-small',
    apiKey: process.env.OPENAI_API_KEY 
  }
});
```

## Why This Beats Compression

| Approach | Context Limit | Scaling |
|----------|---------------|---------|
| 5:1 compression | Still bounded by window | Linear degradation |
| Semantic index | **Unbounded** | Constant time retrieval |

Your 5:1 compression is still fighting the context window. A semantic index sidesteps it entirely.

## MC Spec Integration

- **MC4 Planning** → `getArchitecturalContext(task)` — high-level structure
- **MC2 Building** → `getImplementationContext(file, bug)` — implementation details
- **MC1 Execution** → `buildSemanticContext(file, analysis)` — surgical context

Each layer gets exactly the right granularity automatically.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PANDORA_SEMANTIC_INDEX_ENDPOINT` | `ws://127.0.0.1:7300` | Server endpoint |
| `PANDORA_SEMANTIC_INDEX_PORT` | `7300` | Server port |
| `PANDORA_STATE_DIR` | `./pandora_state` | Index storage location |

## License

Apache-2.0 (adapted from [Continue](https://github.com/continuedev/continue))

---

**Status:** Ready for integration | **Last Updated:** 2026-02-23
