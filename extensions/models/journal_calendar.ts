import { z } from "npm:zod@4";

const AttendeeSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  self: z.boolean(),
});

const EventInputSchema = z.object({
  id: z.string(),
  summary: z.string(),
  startTime: z.string(),
  allDay: z.boolean(),
  location: z.string(),
  attendees: z.array(AttendeeSchema),
});

const GlobalArgsSchema = z.object({
  journalDir: z.string().default(
    "/home/adam/.openclaw/workspace/obsidian/Journal",
  ),
  templatePath: z.string().default(
    "/home/adam/.openclaw/workspace/obsidian/Templates/daily.md",
  ),
  events: z.array(EventInputSchema),
});

const ResultSchema = z.object({
  journalPath: z.string(),
  eventsAdded: z.number().int(),
  journalCreated: z.boolean(),
});

function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sanitize(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\](){}#*_<>`~!|\\]/g, "")
    .replace(/<!--.*?-->/g, "")
    .trim();
}

function sanitizeWikiName(s: string): string {
  return sanitize(s).replace(/\|/g, "");
}

function normalizePersonName(from: { name: string | null; email: string }): string {
  const raw = from.name?.trim() ?? "";

  if (!raw || raw.includes("@")) {
    const local = from.email.split("@")[0];
    return local
      .split(/[._-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(" ");
  }

  const cleaned = raw.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();

  if (cleaned.includes(",")) {
    const firstComma = cleaned.indexOf(",");
    const lastName = cleaned.slice(0, firstComma).trim();
    const rest = cleaned.slice(firstComma + 1).trim();
    const firstPart = rest.split(",")[0].trim();
    const nameTokens = firstPart.split(/\s+/).filter((t) =>
      !(t.length > 1 && t === t.toUpperCase() && /^[A-Z]+$/.test(t))
    );
    if (nameTokens.length > 0) {
      return [...nameTokens, lastName].join(" ");
    }
    return lastName;
  }

  return cleaned;
}

function formatEventEntry(event: z.infer<typeof EventInputSchema>): string {
  const timePrefix = event.allDay ? "" : `${event.startTime} `;
  const summary = sanitize(event.summary);

  // Build attendee links (exclude self)
  const nonSelf = event.attendees.filter((a) => !a.self);
  let attendeeStr = "";
  if (nonSelf.length > 0) {
    const names = nonSelf.map((a) =>
      `[[${sanitizeWikiName(normalizePersonName(a))}]]`
    );
    attendeeStr = ` with ${names.join(", ")}`;
  }

  return `- [ ] ${timePrefix}${summary}${attendeeStr} #task #when/next`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export const model = {
  type: "@adam/journal/calendar",
  version: "2026.03.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Summary of calendar journal update",
      schema: ResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    write: {
      description:
        "Write today's calendar events as todo items in the Obsidian daily journal. Idempotent: skips events already present.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { journalDir, templatePath, events } = context.globalArgs;

        if (!events || events.length === 0) {
          context.logger.info("No calendar events to write");
          return { dataHandles: [] };
        }

        const date = todayDateString();
        const journalPath = `${journalDir}/${date}.md`;
        let journalCreated = false;

        // Create journal from template if it doesn't exist
        if (!(await fileExists(journalPath))) {
          if (!(await fileExists(templatePath))) {
            throw new Error(`Template not found: ${templatePath}`);
          }
          const template = await Deno.readTextFile(templatePath);
          const populated = template.replaceAll("{{date}}", date);
          await Deno.writeTextFile(journalPath, populated);
          journalCreated = true;
          context.logger.info("Created journal from template: {path}", {
            path: journalPath,
          });
        }

        let content = await Deno.readTextFile(journalPath);

        // Idempotency: skip events whose summary+time already appears
        const newEvents = events.filter((e: any) => {
          const timePrefix = e.allDay ? "" : `${e.startTime} `;
          const summary = sanitize(e.summary);
          const marker = `${timePrefix}${summary}`;
          return !content.includes(marker);
        });

        if (newEvents.length < events.length) {
          const skipped = events.length - newEvents.length;
          context.logger.info("Skipped {count} already-present events", {
            count: skipped,
          });
        }

        if (newEvents.length === 0) {
          context.logger.info("All events already present in journal");
          const handle = await context.writeResource("result", "main", {
            journalPath,
            eventsAdded: 0,
            journalCreated,
          });
          return { dataHandles: [handle] };
        }

        // Format all new events
        const entries = newEvents
          .map((e: any) => formatEventEntry(e))
          .join("\n");

        // Insert into Journal section after the empty task placeholder
        const emptyTaskMatch = content.match(/(#\s+Journal\n)(- \[ \] \n?)?/);
        if (emptyTaskMatch) {
          const insertPoint =
            content.indexOf(emptyTaskMatch[0]) + emptyTaskMatch[0].length;
          content =
            content.slice(0, insertPoint) +
            entries +
            "\n" +
            content.slice(insertPoint);
        } else {
          // Fallback: insert after `#  Journal` line
          const journalIdx = content.indexOf("#  Journal");
          if (journalIdx !== -1) {
            const lineEnd = content.indexOf("\n", journalIdx);
            content =
              content.slice(0, lineEnd + 1) +
              entries +
              "\n" +
              content.slice(lineEnd + 1);
          }
        }

        await Deno.writeTextFile(journalPath, content);
        context.logger.info("Added {count} calendar events to journal", {
          count: newEvents.length,
        });

        const handle = await context.writeResource("result", "main", {
          journalPath,
          eventsAdded: newEvents.length,
          journalCreated,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
