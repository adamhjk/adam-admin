import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  calendars: z.array(z.string()).default([
    "adam@systeminit.com",
    "adam@stalecoffee.org",
  ]),
  timezone: z.string().default("America/Los_Angeles"),
});

const AttendeeSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  self: z.boolean(),
});

const EventSchema = z.object({
  id: z.string(),
  summary: z.string(),
  startTime: z.string(),
  allDay: z.boolean(),
  location: z.string(),
  attendees: z.array(AttendeeSchema),
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

function formatTime12h(isoDateTime: string): string {
  // Parse hours:minutes directly from the ISO string to preserve local timezone
  // Format: "2026-03-31T06:15:00-07:00" → extract "06:15"
  const timeMatch = isoDateTime.match(/T(\d{2}):(\d{2})/);
  if (!timeMatch) return "";
  let hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  const minStr = minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`;
  return `${hours}${minStr}${ampm}`;
}

function todayBounds(timezone: string): { timeMin: string; timeMax: string } {
  const now = new Date();

  // Get today's date in the target timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;

  // Construct midnight in the target timezone and get its UTC offset
  // by creating a date and checking what UTC time corresponds to midnight local
  const midnightLocal = new Date(`${y}-${m}-${d}T00:00:00`);
  const midnightCheck = new Date(
    midnightLocal.toLocaleString("en-US", { timeZone: "UTC" }),
  );
  const localCheck = new Date(
    midnightLocal.toLocaleString("en-US", { timeZone: timezone }),
  );
  const offsetMs = midnightCheck.getTime() - localCheck.getTime();
  const offsetMin = offsetMs / 60000;
  const sign = offsetMin <= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");
  const tz = `${sign}${offH}:${offM}`;

  // Tomorrow's date
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrow);
  const ty = tParts.find((p) => p.type === "year")!.value;
  const tm = tParts.find((p) => p.type === "month")!.value;
  const td = tParts.find((p) => p.type === "day")!.value;

  return {
    timeMin: `${y}-${m}-${d}T00:00:00${tz}`,
    timeMax: `${ty}-${tm}-${td}T00:00:00${tz}`,
  };
}

export const model = {
  type: "@adam/calendar/today",
  version: "2026.03.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    event: {
      description: "Calendar event for today",
      schema: EventSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    scan: {
      description:
        "Scan today's calendar events from configured calendars. Factory pattern: produces one resource per event.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { calendars, timezone } = context.globalArgs;
        const { timeMin, timeMax } = todayBounds(timezone);

        context.logger.info(
          "Scanning {count} calendars for today ({min} to {max})",
          { count: calendars.length, min: timeMin, max: timeMax },
        );

        const allEvents: Array<{
          id: string;
          summary: string;
          startTime: string;
          allDay: boolean;
          location: string;
          attendees: Array<{ name: string | null; email: string; self: boolean }>;
          sortKey: string;
        }> = [];

        for (const calendarId of calendars) {
          try {
            const raw = await runGws([
              "calendar",
              "events",
              "list",
              "--params",
              JSON.stringify({
                calendarId,
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: "startTime",
              }),
              "--output",
              "json",
            ]);
            const data = JSON.parse(raw);
            const items = data.items ?? [];

            for (const item of items) {
              // Skip cancelled events
              if (item.status === "cancelled") continue;

              const allDay = !!item.start?.date;
              const startIso = item.start?.dateTime ?? item.start?.date ?? "";
              const startTime = allDay ? "" : formatTime12h(startIso);
              const sortKey = allDay ? "00:00" : startIso;

              allEvents.push({
                id: item.id,
                summary: item.summary ?? "(no title)",
                startTime,
                allDay,
                location: item.location ?? "",
                attendees: (item.attendees ?? []).map((a: any) => ({
                  name: a.displayName ?? null,
                  email: a.email ?? "",
                  self: a.self ?? false,
                })),
                sortKey,
              });
            }

            context.logger.info("Found {count} events in {cal}", {
              count: items.length,
              cal: calendarId,
            });
          } catch (err) {
            context.logger.error("Failed to scan calendar {cal}: {error}", {
              cal: calendarId,
              error: (err as Error).message,
            });
          }
        }

        // Sort by start time, all-day events first
        allEvents.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

        // Deduplicate by event ID (same event can appear in multiple calendars)
        const seen = new Set<string>();
        const handles = [];
        for (const event of allEvents) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);

          const { sortKey: _, ...eventData } = event;
          const handle = await context.writeResource(
            "event",
            event.id,
            eventData,
          );
          handles.push(handle);
          context.logger.info("{time} {summary}", {
            time: event.startTime || "all-day",
            summary: event.summary,
          });
        }

        context.logger.info("Total: {count} events for today", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
