#!/usr/bin/env node
/**
 * Pandora Semantic Index - CLI Tool
 * 
 * Commands:
 *   index <directory>  - Index a codebase
 *   query <query>      - Search the index
 *   stats              - Show index statistics
 *   serve              - Start WebSocket server
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Indexer } from './indexer.js';
import { SemanticIndexServer } from './server.js';
import chalk from 'chalk';

const DEFAULT_STATE_DIR = process.env.PANDORA_STATE_DIR || './pandora_state';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName('pandora-semantic-index')
    .command(
      'index <directory>',
      'Index a codebase directory',
      (yargs) => {
        return yargs
          .positional('directory', { describe: 'Directory to index', type: 'string' })
          .option('force', { alias: 'f', describe: 'Force reindex', type: 'boolean', default: false })
          .option('provider', { describe: 'Embedding provider (ollama/openai)', type: 'string', default: 'ollama' })
          .option('model', { describe: 'Embedding model', type: 'string' })
          .option('state-dir', { describe: 'State directory', type: 'string', default: DEFAULT_STATE_DIR });
      },
      async (argv) => {
        const indexer = new Indexer({
          embedding: {
            provider: argv.provider,
            model: argv.model,
          },
          vectorStore: {
            dbPath: `${argv.stateDir}/semantic_index`,
          },
        });

        await indexer.init();

        console.log(chalk.blue(`[Indexing] ${argv.directory}`));
        console.log(chalk.gray(`Provider: ${argv.provider}`));

        const result = await indexer.indexDirectory(argv.directory, {
          force: argv.force,
          onProgress: (p) => {
            process.stdout.write(`\r${chalk.gray(`[${p.processed}/${p.total}]`)} ${chalk.white(p.file?.split('/').pop() || '')}`);
          },
        });

        console.log('\n');
        console.log(chalk.green('✓ Indexing complete'));
        console.log(`  Indexed: ${result.indexed} files`);
        console.log(`  Skipped: ${result.skipped} files`);
        console.log(`  Errors:  ${result.errors}`);
        console.log(`  Chunks:  ${result.totalChunks}`);
      }
    )
    .command(
      'query <query>',
      'Search the semantic index',
      (yargs) => {
        return yargs
          .positional('query', { describe: 'Search query', type: 'string' })
          .option('k', { describe: 'Number of results', type: 'number', default: 10 })
          .option('keywords', { describe: 'Keywords for hybrid search (comma-separated)', type: 'string' })
          .option('provider', { describe: 'Embedding provider', type: 'string', default: 'ollama' })
          .option('state-dir', { describe: 'State directory', type: 'string', default: DEFAULT_STATE_DIR });
      },
      async (argv) => {
        const indexer = new Indexer({
          embedding: { provider: argv.provider },
          vectorStore: { dbPath: `${argv.stateDir}/semantic_index` },
        });

        await indexer.init();

        const keywords = argv.keywords?.split(',').map(k => k.trim()).filter(Boolean) || [];
        
        console.log(chalk.blue(`[Query] "${argv.query}"`));
        if (keywords.length > 0) {
          console.log(chalk.gray(`Keywords: ${keywords.join(', ')}`));
        }

        const results = await indexer.search(argv.query, { k: argv.k, keywords });

        console.log(chalk.green(`\n✓ Found ${results.length} results\n`));

        for (const r of results) {
          console.log(chalk.yellow(`${r.rank}. ${r.path}:${r.startLine}-${r.endLine}`));
          console.log(chalk.gray(`   Score: ${r.score.toFixed(3)} | Types: ${r.nodeTypes.join(', ')}`));
          console.log(chalk.white(`   ${r.content.split('\n')[0].substring(0, 80)}...`));
          console.log();
        }
      }
    )
    .command(
      'stats',
      'Show index statistics',
      (yargs) => {
        return yargs
          .option('state-dir', { describe: 'State directory', type: 'string', default: DEFAULT_STATE_DIR });
      },
      async (argv) => {
        const indexer = new Indexer({
          vectorStore: { dbPath: `${argv.stateDir}/semantic_index` },
        });

        await indexer.init();
        const stats = await indexer.stats();

        console.log(chalk.blue('[Stats]'));
        console.log(`  Total chunks: ${stats.count}`);
        console.log(`  Dimension:    ${stats.dimension}`);
        console.log(`  Table:        ${stats.table}`);
        console.log(`  Path:         ${stats.dbPath}`);
      }
    )
    .command(
      'serve',
      'Start WebSocket server for agent queries',
      (yargs) => {
        return yargs
          .option('port', { describe: 'Server port', type: 'number', default: 7300 })
          .option('host', { describe: 'Server host', type: 'string', default: '0.0.0.0' })
          .option('provider', { describe: 'Embedding provider', type: 'string', default: 'ollama' })
          .option('state-dir', { describe: 'State directory', type: 'string', default: DEFAULT_STATE_DIR });
      },
      async (argv) => {
        const server = new SemanticIndexServer({
          port: argv.port,
          host: argv.host,
          indexer: {
            config: {
              embedding: { provider: argv.provider },
              vectorStore: { dbPath: `${argv.stateDir}/semantic_index` },
            },
          },
        });

        await server.start();

        process.on('SIGINT', async () => {
          console.log(chalk.yellow('\n[Server] Shutting down...'));
          await server.stop();
          process.exit(0);
        });
      }
    )
    .demandCommand()
    .help()
    .argv;
}

main().catch((e) => {
  console.error(chalk.red(`Error: ${e.message}`));
  process.exit(1);
});
