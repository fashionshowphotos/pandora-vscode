# Pandora — Eyes & Hands for VS Code

Two VS Code extensions that give AI agents full observability and execution control inside your editor.

## Pandora Eyes

Observes developer friction and feeds it back to Pandora. Watches for undo storms, cursor thrashing, error spikes, and rapid saves — scores each 30s window and logs high-friction events to the Bus.

Install: `ext install coherentlight.pandora-eyes`

## Pandora Hands

WebSocket RPC adapter (port 7345) — gives Pandora controlled execution inside VS Code. Read/write files, run terminals, open editors. Auth-token gated and audit-logged.

Install: `ext install coherentlight.pandora-hands`

## How they work together

```
VS Code session
   ├── Pandora Eyes  ──► friction signals ──► Bus _train/ ──► Pandora Core
   └── Pandora Hands ◄── RPC commands ◄────────────────────────────────────
                     ──► file edits, terminal runs, editor navigation
```

Eyes tells Pandora where the pain is. Hands lets Pandora fix it.

## License

Free for personal and non-commercial use. Commercial use requires a license — coherent-light.com
