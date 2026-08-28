import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import dayjs from "dayjs";
import type { CalendarService } from "../services/CalendarService.js";
import {
  CalendarError,
  ErrorCode,
  type ErrorContext,
  toMCPError,
  ValidationError,
} from "../types/errors.js";
import {
  createEventSchema,
  deleteEventSchema,
  getCalendarEventsSchema,
  getFreeBusySchema,
  getIcsSchema,
  listCalendarsSchema,
  putIcsSchema,
  searchCalendarSchema,
  updateEventSchema,
  validateInput,
} from "../validation/schemas.js";

/** Field descriptions shared by create_event and update_event. */
const EVENT_BODY_PROPERTIES = {
  summary: {
    type: "string",
    description: "Title of the event",
  },
  start: {
    type: "string",
    format: "date-time",
    description: "Start of the event (ISO 8601)",
  },
  end: {
    type: "string",
    format: "date-time",
    description: "End of the event (ISO 8601)",
  },
  allDay: {
    type: "boolean",
    description: "All-day event (dates instead of times)",
    default: false,
  },
  description: { type: "string", description: "Longer description" },
  location: { type: "string", description: "Location" },
  transparent: {
    type: "boolean",
    description:
      "Mark as not blocking time, so it does not count as busy in free/busy",
    default: false,
  },
  categories: {
    type: "array",
    items: { type: "string" },
    description: "Category labels",
  },
} as const;

/** Calendar tool names - exported for tool routing */
export const CALENDAR_TOOLS = [
  "get_calendar_events",
  "search_calendar",
  "get_free_busy",
  "create_event",
  "update_event",
  "delete_event",
  "list_calendars",
  "get_ics",
  "put_ics",
] as const;

export type CalendarToolName = (typeof CALENDAR_TOOLS)[number];

export function isCalendarTool(name: string): name is CalendarToolName {
  return CALENDAR_TOOLS.includes(name as CalendarToolName);
}

export function createCalendarTools(calendarService: CalendarService): Tool[] {
  return [
    {
      name: "get_calendar_events",
      description:
        "Get calendar events from mailbox.org calendar within a date range",
      inputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            format: "date-time",
            description:
              "Start date for event search (ISO 8601 format, default: today)",
          },
          end: {
            type: "string",
            format: "date-time",
            description:
              "End date for event search (ISO 8601 format, default: 30 days from start)",
          },
          calendar: {
            type: "string",
            description:
              "Specific calendar name to search (optional, searches all if not specified)",
          },
          limit: {
            type: "number",
            description: "Maximum number of events to return (default: 100)",
            default: 100,
            minimum: 1,
            maximum: 500,
          },
          offset: {
            type: "number",
            description: "Number of events to skip for pagination (default: 0)",
            default: 0,
            minimum: 0,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search_calendar",
      description:
        "Search calendar events by text query in title, description, or location",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query to match against event title, description, and location",
          },
          start: {
            type: "string",
            format: "date-time",
            description:
              "Start date for search range (ISO 8601 format, default: today)",
          },
          end: {
            type: "string",
            format: "date-time",
            description:
              "End date for search range (ISO 8601 format, default: 1 year from start)",
          },
          calendar: {
            type: "string",
            description: "Specific calendar name to search (optional)",
          },
          limit: {
            type: "number",
            description: "Maximum number of events to return (default: 50)",
            default: 50,
            minimum: 1,
            maximum: 200,
          },
          offset: {
            type: "number",
            description: "Number of events to skip for pagination (default: 0)",
            default: 0,
            minimum: 0,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_free_busy",
      description: "Get free/busy information for scheduling appointments",
      inputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            format: "date-time",
            description: "Start date for free/busy query (ISO 8601 format)",
          },
          end: {
            type: "string",
            format: "date-time",
            description: "End date for free/busy query (ISO 8601 format)",
          },
          calendar: {
            type: "string",
            description:
              "Specific calendar name to check (optional, checks all if not specified)",
          },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "create_event",
      description:
        "Create a new event in a mailbox.org calendar. Returns the uid, url and etag of the new event; url and etag are needed to change or delete it later, the uid is the stable anchor for matching it against a copy in another system.",
      inputSchema: {
        type: "object",
        properties: {
          ...EVENT_BODY_PROPERTIES,
          calendar: {
            type: "string",
            description:
              "Calendar to create the event in (optional, uses the first calendar if omitted)",
          },
          uid: {
            type: "string",
            description:
              "Optional UID to give the event. Pass the origin system's UID when mirroring an event so both copies share one stable anchor. Omitted: the server assigns its own. Cannot express a recurrence rule — use put_ics for a recurring series.",
          },
        },
        required: ["summary", "start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "update_event",
      description:
        "Change an existing event. Takes the url from get_calendar_events. Pass the etag so the write is refused if the event was changed elsewhere in the meantime; without it such a change is overwritten silently. All fields are replaced, so send the complete event, not only what changed. For a RECURRING event you must name a scope: recurrenceId changes one occurrence (moving or renaming just it), applyToSeries changes every occurrence (title/location/etc.; the schedule of a series is kept, not moved). Updating a recurring event without either is refused so the series is not flattened.",
      inputSchema: {
        type: "object",
        properties: {
          ...EVENT_BODY_PROPERTIES,
          url: {
            type: "string",
            description: "URL of the CalDAV resource, from get_calendar_events",
          },
          etag: {
            type: "string",
            description:
              "ETag from get_calendar_events. Strongly recommended: it turns the write into a conditional request.",
          },
          recurrenceId: {
            type: "string",
            format: "date-time",
            description:
              "Recurring events only: the target occurrence's original slot (the recurrenceId value from get_calendar_events). Changes just this one occurrence. Its start/end move to the values you pass.",
          },
          applyToSeries: {
            type: "boolean",
            description:
              "Recurring events only: change every occurrence. Title/location/description/etc. are applied to the series; the recurrence schedule (start times, frequency) is left unchanged. Cannot be combined with recurrenceId.",
            default: false,
          },
        },
        required: ["url", "summary", "start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_event",
      description:
        "Delete an event by its CalDAV url. Pass the etag so the deletion is refused if the event changed since it was read. For a RECURRING event, pass recurrenceId to cancel just one occurrence; without it the whole series is deleted.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the CalDAV resource, from get_calendar_events",
          },
          etag: {
            type: "string",
            description: "ETag from get_calendar_events (recommended)",
          },
          recurrenceId: {
            type: "string",
            format: "date-time",
            description:
              "Recurring events only: cancel just this occurrence (its recurrenceId from get_calendar_events) instead of deleting the whole series.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "list_calendars",
      description:
        "List the account's calendars with their collection URL and metadata. Use it to learn which calendars exist before writing, and to tell an empty-but-real calendar apart from a name that does not exist (an empty calendar returns no events, so get_calendar_events cannot reveal it).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_ics",
      description:
        "Fetch the raw iCalendar (VCALENDAR) text of one event resource by its url. Lossless: keeps RRULE, EXDATE, per-occurrence overrides, attendees and alarms. Pair with put_ics to mirror an event into another calendar without losing fields.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the CalDAV resource, from get_calendar_events",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "put_ics",
      description:
        "Write a raw iCalendar (VCALENDAR) object into a calendar verbatim. This is the only way to create a RECURRING series (create_event cannot express an RRULE). The body must contain a VEVENT with a UID. Without an etag it creates the resource; with an etag it conditionally replaces an existing one (refused if it changed elsewhere). Returns the uid and url.",
      inputSchema: {
        type: "object",
        properties: {
          calendar: {
            type: "string",
            description:
              "Calendar to write into (optional, uses the first calendar if omitted)",
          },
          ics: {
            type: "string",
            description:
              "Raw VCALENDAR text, including a VEVENT with a UID. Typically obtained from get_ics on the source system.",
          },
          filename: {
            type: "string",
            description:
              "Optional resource filename. Defaults to '<uid>.ics' derived from the body. No path separators.",
          },
          etag: {
            type: "string",
            description:
              "ETag of an existing resource to replace conditionally. Omit to create a new resource.",
          },
        },
        required: ["ics"],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleCalendarTool(
  name: string,
  args: Record<string, unknown>,
  calendarService: CalendarService,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "get_calendar_events": {
        const validatedArgs = validateInput(getCalendarEventsSchema, args);
        const start = validatedArgs.start
          ? new Date(validatedArgs.start)
          : dayjs().startOf("day").toDate();
        const end = validatedArgs.end
          ? new Date(validatedArgs.end)
          : dayjs(start).add(30, "days").toDate();

        const options = {
          start,
          end,
          calendar: validatedArgs.calendar,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
        };

        const events = await calendarService.getCalendarEvents(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${events.length} calendar events:\n\n${events
                .map(
                  event =>
                    `**${event.summary}**
Start: ${dayjs(event.start).format("YYYY-MM-DD HH:mm")} ${event.allDay ? "(All Day)" : ""}
End: ${dayjs(event.end).format("YYYY-MM-DD HH:mm")}
${event.location ? `Location: ${event.location}\n` : ""}${
  event.description
    ? `Description: ${event.description.substring(0, 100)}${event.description.length > 100 ? "..." : ""}\n`
    : ""
}Calendar: ${event.calendar}
uid: ${event.uid}
${event.attendees?.length ? `Attendees: ${event.attendees.length}\n` : ""}${
  event.recurring
    ? `Recurring: Yes${event.isException ? " (this occurrence was moved or edited)" : ""}\n${
        event.recurrenceId ? `recurrenceId: ${event.recurrenceId}\n` : ""
      }`
    : ""
}${event.transparent ? "Blocks time: no (marked transparent)\n" : ""}${
  event.url
    ? `url: ${event.url}\netag: ${event.etag ?? "(none)"}${
        event.recurring
          ? "\nNote: recurring event. To change ONE occurrence pass recurrenceId; to change the WHOLE series pass applyToSeries: true. Plain update_event/delete_event on a series is refused."
          : ""
      }\n`
    : ""
}`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "search_calendar": {
        const validatedArgs = validateInput(searchCalendarSchema, args);
        const start = validatedArgs.start
          ? new Date(validatedArgs.start)
          : dayjs().startOf("day").toDate();
        const end = validatedArgs.end
          ? new Date(validatedArgs.end)
          : dayjs(start).add(1, "year").toDate();

        const options = {
          query: validatedArgs.query,
          start,
          end,
          calendar: validatedArgs.calendar,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
        };

        const events = await calendarService.searchCalendar(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${events.length} events matching "${validatedArgs.query}":\n\n${events
                .map(
                  event =>
                    `**${event.summary}**
Start: ${dayjs(event.start).format("YYYY-MM-DD HH:mm")} ${event.allDay ? "(All Day)" : ""}
End: ${dayjs(event.end).format("YYYY-MM-DD HH:mm")}
${event.location ? `Location: ${event.location}\n` : ""}${
  event.description
    ? `Description: ${event.description.substring(0, 150)}${event.description.length > 150 ? "..." : ""}\n`
    : ""
}Calendar: ${event.calendar}
`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "get_free_busy": {
        const validatedArgs = validateInput(getFreeBusySchema, args);
        const start = new Date(validatedArgs.start);
        const end = new Date(validatedArgs.end);

        const freeBusy = await calendarService.getFreeBusy(
          start,
          end,
          validatedArgs.calendar,
        );

        const busySlots = freeBusy.busy.map(
          slot =>
            `${dayjs(slot.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(slot.end).format("HH:mm")}${slot.summary ? ` (${slot.summary})` : ""}`,
        );

        const freeSlots = freeBusy.free.map(
          slot =>
            `${dayjs(slot.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(slot.end).format("HH:mm")}`,
        );

        return {
          content: [
            {
              type: "text",
              text: `**Free/Busy Information**
Period: ${dayjs(start).format("YYYY-MM-DD HH:mm")} - ${dayjs(end).format("YYYY-MM-DD HH:mm")}

**Busy Times (${freeBusy.busy.length}):**
${busySlots.length > 0 ? busySlots.join("\n") : "No busy times"}

**Free Times (${freeBusy.free.length}):**
${freeSlots.length > 0 ? freeSlots.join("\n") : "No free times"}`,
            },
          ],
        };
      }

      case "create_event": {
        const a = validateInput(createEventSchema, args);
        const result = await calendarService.createEvent(
          {
            summary: a.summary,
            start: new Date(a.start),
            end: new Date(a.end),
            allDay: a.allDay,
            description: a.description,
            location: a.location,
            transparent: a.transparent,
            categories: a.categories,
          },
          a.calendar,
          a.uid,
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ ${result.message}

**${a.summary}**
${dayjs(a.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(a.end).format("YYYY-MM-DD HH:mm")}${a.location ? `\nLocation: ${a.location}` : ""}

Keep these to change or delete the event later:
- uid: ${result.uid}
- url: ${result.url}
- etag: ${result.etag ?? "(not returned by the server; re-read the event before changing it)"}`,
            },
          ],
        };
      }

      case "update_event": {
        const a = validateInput(updateEventSchema, args);
        const body = {
          summary: a.summary,
          start: new Date(a.start),
          end: new Date(a.end),
          allDay: a.allDay,
          description: a.description,
          location: a.location,
          transparent: a.transparent,
          categories: a.categories,
        };

        // Route by scope: one occurrence, the whole series, or a plain single
        // event. update_event refuses a recurring resource with no scope.
        const result = a.recurrenceId
          ? await calendarService.updateOccurrence(
              a.url,
              a.recurrenceId,
              body,
              a.etag,
            )
          : a.applyToSeries
            ? await calendarService.updateSeries(a.url, body, a.etag)
            : await calendarService.updateEvent(a.url, body, a.etag);

        // A series-wide edit does not move the schedule, so the start/end just
        // sent were not applied to the timing — don't print them as if they were.
        const timing = a.applyToSeries
          ? ""
          : `\n${dayjs(a.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(a.end).format("YYYY-MM-DD HH:mm")}`;

        return {
          content: [
            {
              type: "text",
              text: `✅ ${result.message}

**${a.summary}**${timing}${a.location ? `\nLocation: ${a.location}` : ""}${
                a.etag
                  ? ""
                  : "\n⚠️ Sent without an etag: a change made elsewhere since you read this event was not checked for."
              }
- url: ${result.url}${result.etag ? `\n- etag: ${result.etag}` : "\n- etag: (re-read the event before the next change)"}`,
            },
          ],
        };
      }

      case "delete_event": {
        const a = validateInput(deleteEventSchema, args);
        // recurrenceId cancels one occurrence (EXDATE); otherwise delete the
        // whole resource.
        const result = a.recurrenceId
          ? await calendarService.cancelOccurrence(
              a.url,
              a.recurrenceId,
              a.etag,
            )
          : await calendarService.deleteEvent(a.url, a.etag);

        return {
          content: [
            {
              type: "text",
              text: `✅ ${result.message}
- url: ${a.url}${a.etag ? "" : "\n⚠️ Done without an etag: no check was made for changes since you read this event."}`,
            },
          ],
        };
      }

      case "list_calendars": {
        validateInput(listCalendarsSchema, args);
        const calendars = await calendarService.listCalendars();

        return {
          content: [
            {
              type: "text",
              text: `Found ${calendars.length} calendars:\n\n${calendars
                .map(
                  cal =>
                    `**${cal.name}**
url: ${cal.url}${cal.color ? `\ncolor: ${cal.color}` : ""}${
                      cal.components?.length
                        ? `\ncomponents: ${cal.components.join(", ")}`
                        : ""
                    }`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "get_ics": {
        const a = validateInput(getIcsSchema, args);
        const raw = await calendarService.getIcs(a.url);

        return {
          content: [
            {
              type: "text",
              text: `Raw iCalendar for ${raw.url}
etag: ${raw.etag ?? "(none returned)"}

${raw.ics}`,
            },
          ],
        };
      }

      case "put_ics": {
        const a = validateInput(putIcsSchema, args);
        const result = await calendarService.putIcs(
          a.calendar,
          a.ics,
          a.filename,
          a.etag,
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ ${result.message}
- uid: ${result.uid}
- url: ${result.url}${
                result.etag
                  ? `\n- etag: ${result.etag}`
                  : "\n- etag: (not returned by the server; re-read before the next change)"
              }`,
            },
          ],
        };
      }

      default:
        throw new ValidationError(
          `Unknown calendar tool: ${name}`,
          "tool_name",
          name,
        );
    }
  } catch (error) {
    const context: ErrorContext = {
      operation: name,
      service: "calendarTools",
      details: { args },
    };

    // Handle validation errors specifically
    if (
      error instanceof Error &&
      error.message.startsWith("Validation failed:")
    ) {
      const validationError = new ValidationError(
        error.message.replace("Validation failed: ", ""),
        "input_validation",
        args,
        context,
      );

      return {
        content: [
          {
            type: "text",
            text: `❌ Invalid input for ${name}: ${validationError.getUserMessage()}`,
          },
        ],
        isError: true,
      };
    }

    // Convert to structured error if not already
    const mcpError =
      error instanceof Error
        ? toMCPError(error, context)
        : new CalendarError(
            String(error),
            ErrorCode.OPERATION_FAILED,
            undefined,
            undefined,
            context,
          );

    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${mcpError.getUserMessage()}${mcpError.isRetryable ? " (This operation can be retried)" : ""}`,
        },
      ],
      isError: true,
    };
  }
}
