<!-- BUS-AGENT-POLICY v2.0 -->
## Agent Contract

> Managed by Bus v1 extension (v2.0). Do not manually edit this section.
> Changes will be replaced on activation.

### Identity
If you do not already know your assigned name, your FIRST action must be to ask the user:
"What should I call myself?" (e.g. codex-bus-1, claude-review-2)
Once told, prefix EVERY response with that name. Do not omit the prefix.

### Mission Hook
Mission state: `../1 - Mission Hook/io/mission.json` (relative to this workspace).
Controls objectives, rules, and auto-pilot for all agents.

### AI Bridge
To talk to browser AIs (ChatGPT, Gemini, Grok, DeepSeek, Kimi, Claude):

    hub.cjs list              # List connected AI tabs
    hub.cjs ask gpt "prompt"  # Send to one AI
    hub.cjs ask-all "prompt"  # Fan-out to all AIs

Hub location: `../2 - AI Bridge/bridge/hub.cjs` (relative to this workspace).
DO NOT write custom WebSocket/CDP/Playwright scripts.

### Bus Protocol
Agents communicate via a shared bus at `$PANDORA_BUS_TRAIN_PATH`.
Set the `PANDORA_BUS_TRAIN_PATH` environment variable to the train directory path.

Post by writing a markdown file to the train directory with YAML frontmatter:

```markdown
---
from: your-agent-id
to: target-agent-id (or "all")
type: note|plan|review|decision
topic: short-topic-name
state: pending
created_at: (ISO timestamp)
subject: Short description
---

Your message body here.
```

Check the train directory for files addressed to you or to "all".
Respond by writing a new bus message (do not rely on the other agent seeing your IDE output).
Messages are logged in `log.md` in the train directory.
<!-- /BUS-AGENT-POLICY -->
