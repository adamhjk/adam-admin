import { z } from "npm:zod@4";

const ClassificationInputSchema = z.object({
  messageId: z.string(),
  from: z.object({
    name: z.string().nullable(),
    email: z.string(),
  }),
  subject: z.string(),
  classification: z.enum(["To Reply", "To Read", "Archive Only"]),
  certainty: z.number(),
  summary: z.string(),
});

const GlobalArgsSchema = z.object({
  journalDir: z.string().default(
    "/home/adam/.openclaw/workspace/obsidian/Journal",
  ),
  templatePath: z.string().default(
    "/home/adam/.openclaw/workspace/obsidian/Templates/daily.md",
  ),
  classifications: z.array(ClassificationInputSchema),
});

const ResultSchema = z.object({
  journalPath: z.string(),
  tasksAdded: z.number().int(),
  readsAdded: z.number().int(),
  journalCreated: z.boolean(),
});

function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Sanitize untrusted strings before writing to markdown.
// Strips characters that could inject markdown structure, Obsidian
// wiki-link syntax, or HTML.  Collapses to a single line.
function sanitize(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")       // flatten to single line
    .replace(/[[\](){}#*_>`~!|\\]/g, "") // strip markdown/wiki metacharacters
    .replace(/<!--.*?-->/g, "")      // strip HTML comments (could spoof gmail: anchors)
    .trim();
}

// Extra-strict sanitization for the wiki-link name: also remove
// double-brackets and pipe which have meaning inside [[ ]].
function sanitizeWikiName(s: string): string {
  return sanitize(s).replace(/\|/g, "");
}

// Normalize messy sender names into clean "First Last" format.
// Handles: email-as-name, "Last, First Middle DEPT, COUNTRY", etc.
function normalizePersonName(from: { name: string | null; email: string }): string {
  const raw = from.name?.trim() ?? "";

  // If name is empty or is an email address, derive from the email local part
  if (!raw || raw.includes("@")) {
    const local = from.email.split("@")[0];
    return local
      .split(/[._-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(" ");
  }

  // Strip parenthesized groups like (CIB, USA) before further processing
  const cleaned = raw.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();

  // "Last, First Middle DEPT, COUNTRY" → "First Middle Last"
  if (cleaned.includes(",")) {
    const firstComma = cleaned.indexOf(",");
    const lastName = cleaned.slice(0, firstComma).trim();
    const rest = cleaned.slice(firstComma + 1).trim();

    // Take only the segment before any second comma, then strip
    // all-uppercase tokens (corporate suffixes like CIB, USA, LLC)
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

function displayName(from: { name: string | null; email: string }): string {
  return sanitizeWikiName(normalizePersonName(from));
}

function formatToReplyEntry(c: z.infer<typeof ClassificationInputSchema>): string {
  const name = displayName(c.from);
  const subject = sanitize(c.subject);
  const summary = sanitize(c.summary);
  return `- [ ] Reply to [[${name}]] about "${subject}" (${c.certainty}%) #task #when/next\n  - Summary: ${summary}\n  <!-- gmail:${c.messageId} -->`;
}

function formatToReadEntry(c: z.infer<typeof ClassificationInputSchema>): string {
  const name = displayName(c.from);
  const summary = sanitize(c.summary);
  return `- **${name}**: ${summary} <!-- gmail:${c.messageId} -->`;
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
  type: "@adam/journal/triage",
  version: "2026.03.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Summary of journal update operation",
      schema: ResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    write: {
      description:
        "Write email triage results into Obsidian daily journal. Creates journal from template if needed.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { journalDir, templatePath, classifications } =
          context.globalArgs;

        if (!classifications || classifications.length === 0) {
          context.logger.info("No classifications to write");
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

        // Idempotency: skip entries whose gmail ID already appears in the journal
        const newClassifications = classifications.filter(
          (c: any) => !content.includes(`<!-- gmail:${c.messageId} -->`),
        );

        if (newClassifications.length < classifications.length) {
          const skipped = classifications.length - newClassifications.length;
          context.logger.info("Skipped {count} already-present entries", {
            count: skipped,
          });
        }

        if (newClassifications.length === 0) {
          context.logger.info("All entries already present in journal");
          const handle = await context.writeResource("result", "main", {
            journalPath,
            tasksAdded: 0,
            readsAdded: 0,
            journalCreated,
          });
          return { dataHandles: [handle] };
        }

        const toReply = newClassifications.filter(
          (c: any) => c.classification === "To Reply",
        );
        const toRead = newClassifications.filter(
          (c: any) => c.classification === "To Read",
        );

        // Insert "To Reply" tasks into the Journal section
        // Find the empty task placeholder `- [ ] ` at the end of the Journal heading
        // or insert after the `#  Journal` line
        if (toReply.length > 0) {
          const replyEntries = toReply
            .map((c: any) => formatToReplyEntry(c))
            .join("\n");

          // Look for the empty task line in the Journal section
          const emptyTaskMatch = content.match(
            /(#\s+Journal\n)(- \[ \] \n?)?/,
          );
          if (emptyTaskMatch) {
            const insertPoint =
              content.indexOf(emptyTaskMatch[0]) + emptyTaskMatch[0].length;
            content =
              content.slice(0, insertPoint) +
              "\n" +
              replyEntries +
              "\n" +
              content.slice(insertPoint);
          } else {
            // Fallback: insert after `#  Journal` line
            const journalIdx = content.indexOf("#  Journal");
            if (journalIdx !== -1) {
              const lineEnd = content.indexOf("\n", journalIdx);
              content =
                content.slice(0, lineEnd + 1) +
                replyEntries +
                "\n" +
                content.slice(lineEnd + 1);
            }
          }
          context.logger.info("Added {count} reply tasks", {
            count: toReply.length,
          });
        }

        // Insert "To Read" entries
        if (toRead.length > 0) {
          const readEntries = toRead
            .map((c: any) => formatToReadEntry(c))
            .join("\n");

          const toReadIdx = content.indexOf("## To Read");
          if (toReadIdx !== -1) {
            // Find the end of the To Read section (next heading or section break)
            const afterHeading = content.indexOf("\n", toReadIdx) + 1;
            // Find next major heading or section divider
            const restAfterHeading = content.slice(afterHeading);
            const nextSection = restAfterHeading.search(/^#[^#]/m);
            if (nextSection !== -1) {
              const insertPoint = afterHeading + nextSection;
              content =
                content.slice(0, insertPoint) +
                readEntries +
                "\n" +
                content.slice(insertPoint);
            } else {
              // Append at end of To Read section
              content =
                content.slice(0, afterHeading) +
                readEntries +
                "\n" +
                content.slice(afterHeading);
            }
          } else {
            // Create ## To Read section before `# Perception of Effort`
            const effortIdx = content.indexOf("# Perception of Effort");
            if (effortIdx !== -1) {
              content =
                content.slice(0, effortIdx) +
                "## To Read\n" +
                readEntries +
                "\n\n" +
                content.slice(effortIdx);
            } else {
              // Fallback: insert before `# End the Day`
              const endDayIdx = content.indexOf("# End the Day");
              if (endDayIdx !== -1) {
                content =
                  content.slice(0, endDayIdx) +
                  "## To Read\n" +
                  readEntries +
                  "\n\n" +
                  content.slice(endDayIdx);
              }
            }
          }
          context.logger.info("Added {count} read entries", {
            count: toRead.length,
          });
        }

        await Deno.writeTextFile(journalPath, content);
        context.logger.info("Updated journal: {path}", { path: journalPath });

        const handle = await context.writeResource("result", "main", {
          journalPath,
          tasksAdded: toReply.length,
          readsAdded: toRead.length,
          journalCreated,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
