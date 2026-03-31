# adam-admin

Personal automation workflows built with [Swamp](https://github.com/systeminit/swamp) — a local-first, git-native automation system for AI agents.

These workflows handle daily admin tasks: triaging email, populating a daily journal from calendar events, enriching contact records, and syncing an Obsidian vault.

## Workflows

### email-triage

Scans Gmail inbox, classifies each message with AI, updates an Obsidian daily journal, labels/archives messages, and enriches People entries for unknown senders.

**Pipeline:**

1. **Scan** — reads unread emails from Gmail inbox
2. **Classify** — AI classifies each email as To Reply, To Read, or Archive
3. **Enrich** — creates People entries for unknown To Reply senders
4. **Journal** — writes classification results to the Obsidian daily note
5. **Organize** — applies Gmail labels (To Reply / To Read) and archives processed messages
6. **Sync** — pushes Obsidian vault changes

**Input:** `maxMessages` (integer, default 200)

### calendar-triage

Scans today's calendar events and writes them into the Obsidian daily journal as task items, with links to People entries for attendees.

**Pipeline:**

1. **Scan** — reads today's events from configured calendars
2. **Enrich** — creates People entries for unknown calendar attendees
3. **Journal** — adds calendar events as todo items in the daily note
4. **Sync** — pushes Obsidian vault changes

## Models

| Model | Type | Purpose |
|---|---|---|
| `email-inbox` | `@adam/email/inbox` | Scan Gmail inbox for unread messages |
| `email-classify` | `@adam/email/classify` | Classify emails using Claude AI |
| `email-organize` | `@adam/email/organize` | Apply Gmail labels and archive |
| `email-journal` | `@adam/journal/triage` | Write email triage results to Obsidian journal |
| `calendar-today` | `@adam/calendar/today` | Scan today's calendar events |
| `calendar-journal` | `@adam/journal/calendar` | Write calendar events to Obsidian journal |
| `people-enrich` | `@adam/people/enrich` | Create/update People entries from email context |
| `people-enrich-cal` | `@adam/people/enrich` | Create/update People entries from calendar attendees |
| `obs-sync` | `command/shell` | Sync the Obsidian vault |

## Setup

### Prerequisites

- [Swamp CLI](https://github.com/systeminit/swamp) installed
- Gmail API access configured (via [gws](https://github.com/systeminit/gws) or equivalent)
- Google Calendar API access configured
- An Obsidian vault with a daily journal template
- An `ob sync` command available for vault syncing

### Running workflows

```bash
# Run email triage
swamp workflow run email-triage --log --repo-dir /path/to/adam-admin

# Run calendar triage
swamp workflow run calendar-triage --log --repo-dir /path/to/adam-admin

# Run email triage with custom max messages
swamp workflow run email-triage --log --input maxMessages=50 --repo-dir /path/to/adam-admin
```

### Scheduling

These workflows are designed to run on a schedule:

- **email-triage** — every hour
- **calendar-triage** — once daily in the morning

You can schedule them with cron, systemd timers, or (if running under [OpenClaw](https://github.com/openclaw/openclaw)) as cron jobs managed by your agent.

## Structure

```
adam-admin/
├── models/
│   ├── @adam/
│   │   ├── calendar/today/       # Calendar scanning
│   │   ├── email/
│   │   │   ├── classify/         # AI email classification
│   │   │   ├── inbox/            # Gmail inbox scanning
│   │   │   └── organize/         # Gmail labeling & archiving
│   │   ├── journal/
│   │   │   ├── calendar/         # Calendar → journal writing
│   │   │   └── triage/           # Email triage → journal writing
│   │   └── people/enrich/        # Contact enrichment
│   └── command/shell/            # Shell commands (obs-sync)
├── workflows/                    # Workflow definitions
├── vaults/                       # Encrypted credential storage
└── .swamp/                       # Runtime data (gitignored)
```

## License

[MIT](LICENSE)
