import { z } from "npm:zod@4";

const LABELS = {
  "To Reply": "Label_8300810881717443951",
  "To Read": "Label_2",
  INBOX: "INBOX",
} as const;

const ClassificationInputSchema = z.object({
  messageId: z.string(),
  classification: z.enum(["To Reply", "To Read", "Archive Only"]),
});

const GlobalArgsSchema = z.object({
  classifications: z.array(ClassificationInputSchema),
});

const ResultSchema = z.object({
  toReplyCount: z.number().int(),
  toReadCount: z.number().int(),
  archivedCount: z.number().int(),
});

async function runGws(args: string[]): Promise<string> {
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

async function batchModifyMessages(
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  if (ids.length === 0) return;

  const body: Record<string, unknown> = { ids };
  if (addLabelIds.length > 0) body.addLabelIds = addLabelIds;
  if (removeLabelIds.length > 0) body.removeLabelIds = removeLabelIds;

  await runGws([
    "gmail",
    "users",
    "messages",
    "batchModify",
    "--params",
    JSON.stringify({ userId: "me" }),
    "--json",
    JSON.stringify(body),
  ]);
}

export const model = {
  type: "@adam/email/organize",
  version: "2026.03.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Summary of label and archive operations",
      schema: ResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    organize: {
      description:
        "Label emails with To Reply/To Read and archive them from inbox. Batch operations for efficiency.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { classifications } = context.globalArgs;

        if (!classifications || classifications.length === 0) {
          context.logger.info("No classifications to organize");
          return { dataHandles: [] };
        }

        const toReplyIds = classifications
          .filter((c: any) => c.classification === "To Reply")
          .map((c: any) => c.messageId);
        const toReadIds = classifications
          .filter((c: any) => c.classification === "To Read")
          .map((c: any) => c.messageId);
        const allIds = classifications.map((c: any) => c.messageId);

        // Apply "To Reply" label
        if (toReplyIds.length > 0) {
          context.logger.info("Labeling {count} emails as To Reply", {
            count: toReplyIds.length,
          });
          await batchModifyMessages(toReplyIds, [LABELS["To Reply"]], []);
        }

        // Apply "To Read" label
        if (toReadIds.length > 0) {
          context.logger.info("Labeling {count} emails as To Read", {
            count: toReadIds.length,
          });
          await batchModifyMessages(toReadIds, [LABELS["To Read"]], []);
        }

        // Archive all: remove INBOX label
        context.logger.info("Archiving {count} emails", {
          count: allIds.length,
        });
        await batchModifyMessages(allIds, [], [LABELS.INBOX]);

        const resultData = {
          toReplyCount: toReplyIds.length,
          toReadCount: toReadIds.length,
          archivedCount: allIds.length,
        };

        context.logger.info(
          "Organized: {reply} to reply, {read} to read, {archived} archived",
          {
            reply: resultData.toReplyCount,
            read: resultData.toReadCount,
            archived: resultData.archivedCount,
          },
        );

        const handle = await context.writeResource(
          "result",
          "main",
          resultData,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
