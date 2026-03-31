import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  maxMessages: z.number().int().default(200),
  query: z.string().default("in:inbox"),
});

const EmailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.object({
    name: z.string().nullable(),
    email: z.string(),
  }),
  to: z.array(
    z.object({
      name: z.string().nullable(),
      email: z.string(),
    }),
  ),
  subject: z.string(),
  date: z.string(),
  bodyText: z.string(),
  snippet: z.string(),
});

async function runGws(
  args: string[],
): Promise<string> {
  const cmd = new Deno.Command("gws", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`gws ${args.join(" ")} failed: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout);
}

export const model = {
  type: "@adam/email/inbox",
  version: "2026.03.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    email: {
      description: "Individual email message from inbox",
      schema: EmailSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    scan: {
      description:
        "Scan Gmail inbox and read each message. Factory pattern: produces one resource per email.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { maxMessages, query } = context.globalArgs;
        context.logger.info("Scanning inbox: query={query}, max={max}", {
          query,
          max: maxMessages,
        });

        // Step 1: List messages
        const triageRaw = await runGws([
          "gmail",
          "+triage",
          "--max",
          String(maxMessages),
          "--query",
          query,
          "--format",
          "json",
        ]);
        const triage = JSON.parse(triageRaw);
        const messages = triage.messages ?? [];

        if (messages.length === 0) {
          context.logger.info("No messages found");
          return { dataHandles: [] };
        }

        context.logger.info("Found {count} messages, reading each...", {
          count: messages.length,
        });

        // Step 2: Read each message (factory pattern)
        const handles = [];
        for (const msg of messages) {
          try {
            const readRaw = await runGws([
              "gmail",
              "+read",
              "--id",
              msg.id,
              "--format",
              "json",
              "--headers",
            ]);
            const read = JSON.parse(readRaw);

            const bodyText = (read.body_text ?? "").slice(0, 4000);
            const snippet = bodyText.slice(0, 200);

            const emailData = {
              id: msg.id,
              threadId: read.thread_id ?? msg.id,
              from: {
                name: read.from?.name ?? null,
                email: read.from?.email ?? msg.from ?? "",
              },
              to: (read.to ?? []).map((t: any) => ({
                name: t.name ?? null,
                email: t.email ?? "",
              })),
              subject: read.subject ?? msg.subject ?? "(no subject)",
              date: read.date ?? msg.date ?? "",
              bodyText,
              snippet,
            };

            const handle = await context.writeResource(
              "email",
              msg.id,
              emailData,
            );
            handles.push(handle);
            context.logger.info("Read email {id}: {subject}", {
              id: msg.id,
              subject: emailData.subject,
            });
          } catch (err) {
            context.logger.error("Failed to read message {id}: {error}", {
              id: msg.id,
              error: (err as Error).message,
            });
          }
        }

        if (handles.length === 0) {
          throw new Error("Failed to read any messages");
        }

        context.logger.info("Scanned {count} emails", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
