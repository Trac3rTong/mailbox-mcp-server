import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarService } from "../src/services/CalendarService.js";
import {
  createCalendarTools,
  handleCalendarTool,
} from "../src/tools/calendarTools.js";
import type { CalendarEvent } from "../src/types/calendar.types.js";

vi.mock("../src/services/CalendarService.js");

describe("Calendar Tools", () => {
  let mockCalendarService: Partial<CalendarService>;

  const mockEvent: CalendarEvent = {
    id: "event-1",
    uid: "event-1@example.com",
    summary: "Team Meeting",
    description: "Weekly team sync",
    location: "Conference Room A",
    start: new Date("2025-06-20T10:00:00Z"),
    end: new Date("2025-06-20T11:00:00Z"),
    allDay: false,
    recurring: false,
    calendar: "work",
    created: new Date("2025-06-01T00:00:00Z"),
    modified: new Date("2025-06-01T00:00:00Z"),
    attendees: [
      { email: "alice@example.com", name: "Alice", status: "accepted" },
      { email: "bob@example.com", name: "Bob", status: "tentative" },
    ],
    organizer: { email: "organizer@example.com", name: "Organizer" },
  };

  beforeEach(() => {
    mockCalendarService = {
      getCalendarEvents: vi.fn(),
      searchCalendar: vi.fn(),
      getFreeBusy: vi.fn(),
    };
  });

  describe("createCalendarTools", () => {
    it("should create all calendar tools", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);

      expect(tools.map(t => t.name)).toEqual([
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
        "create_event",
        "update_event",
        "delete_event",
        "list_calendars",
        "get_ics",
        "put_ics",
      ]);
    });

    it("should have proper schema for get_calendar_events tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const getTool = tools.find(t => t.name === "get_calendar_events");

      expect(getTool?.inputSchema.properties).toHaveProperty("start");
      expect(getTool?.inputSchema.properties).toHaveProperty("end");
      expect(getTool?.inputSchema.properties).toHaveProperty("calendar");
      expect(getTool?.inputSchema.properties).toHaveProperty("limit");
      expect(getTool?.inputSchema.properties).toHaveProperty("offset");
    });

    it("should have proper schema for search_calendar tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const searchTool = tools.find(t => t.name === "search_calendar");

      expect(searchTool?.inputSchema.required).toContain("query");
      expect(searchTool?.inputSchema.properties).toHaveProperty("query");
      expect(searchTool?.inputSchema.properties).toHaveProperty("start");
      expect(searchTool?.inputSchema.properties).toHaveProperty("end");
    });

    it("should have proper schema for get_free_busy tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const freeBusyTool = tools.find(t => t.name === "get_free_busy");

      expect(freeBusyTool?.inputSchema.required).toContain("start");
      expect(freeBusyTool?.inputSchema.required).toContain("end");
      expect(freeBusyTool?.inputSchema.properties).toHaveProperty("calendar");
    });
  });

  describe("handleCalendarTool - get_calendar_events", () => {
    it("should retrieve calendar events with date range", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        calendar: undefined,
        limit: 100,
        offset: 0,
      });

      expect(result.content[0].text).toContain("Team Meeting");
      expect(result.content[0].text).toContain("Conference Room A");
      expect(result.content[0].text).toContain("2025-06-20");
    });

    it("should use default dates when not provided", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {},
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalled();
      expect(result.content[0].text).toContain("Found 1 calendar events");
    });

    it("should filter by specific calendar", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
          calendar: "work",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        calendar: "work",
        limit: 100,
        offset: 0,
      });
    });

    it("should apply limit and offset for pagination", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
          limit: 10,
          offset: 5,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 5,
        }),
      );
    });

    it("should handle empty results", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("Found 0 calendar events");
    });

    it("should display all-day events correctly", async () => {
      const allDayEvent = { ...mockEvent, allDay: true };
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        allDayEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("(All Day)");
    });

    it("should display recurring events correctly", async () => {
      const recurringEvent = { ...mockEvent, recurring: true };
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        recurringEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("Recurring: Yes");
    });

    it("should display attendee count", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("Attendees: 2");
    });

    it("should truncate long descriptions", async () => {
      const longDescriptionEvent = {
        ...mockEvent,
        description: "A".repeat(200),
      };
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        longDescriptionEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("...");
    });
  });

  describe("handleCalendarTool - search_calendar", () => {
    it("should search calendar events by query", async () => {
      vi.mocked(mockCalendarService.searchCalendar!).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
          start: "2025-06-01T00:00:00Z",
          end: "2025-06-30T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalledWith({
        query: "meeting",
        start: new Date("2025-06-01T00:00:00Z"),
        end: new Date("2025-06-30T00:00:00Z"),
        calendar: undefined,
        limit: 50,
        offset: 0,
      });

      expect(result.content[0].text).toContain('matching "meeting"');
      expect(result.content[0].text).toContain("Team Meeting");
    });

    it("should use default date range (1 year) when not provided", async () => {
      vi.mocked(mockCalendarService.searchCalendar!).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalled();
      const callArgs = vi.mocked(mockCalendarService.searchCalendar!).mock
        .calls[0][0];
      const daysDiff =
        (callArgs.end!.getTime() - callArgs.start!.getTime()) /
        (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeCloseTo(365, 0);
    });

    it("should apply limit and offset", async () => {
      vi.mocked(mockCalendarService.searchCalendar!).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
          limit: 20,
          offset: 10,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 20,
          offset: 10,
        }),
      );
    });

    it("should handle empty search results", async () => {
      vi.mocked(mockCalendarService.searchCalendar!).mockResolvedValue([]);

      const result = await handleCalendarTool(
        "search_calendar",
        {
          query: "nonexistent",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("Found 0 events");
    });
  });

  describe("handleCalendarTool - get_free_busy", () => {
    it("should retrieve free/busy information", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [
          {
            start: new Date("2025-06-20T10:00:00Z"),
            end: new Date("2025-06-20T11:00:00Z"),
            summary: "Team Meeting",
          },
          {
            start: new Date("2025-06-20T14:00:00Z"),
            end: new Date("2025-06-20T15:00:00Z"),
            summary: "Client Call",
          },
        ],
        free: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T10:00:00Z"),
          },
          {
            start: new Date("2025-06-20T11:00:00Z"),
            end: new Date("2025-06-20T14:00:00Z"),
          },
        ],
      };

      vi.mocked(mockCalendarService.getFreeBusy!).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getFreeBusy).toHaveBeenCalledWith(
        new Date("2025-06-20T00:00:00Z"),
        new Date("2025-06-20T23:59:59Z"),
        undefined,
      );

      expect(result.content[0].text).toContain("Free/Busy Information");
      expect(result.content[0].text).toContain("Busy Times (2)");
      expect(result.content[0].text).toContain("Free Times (2)");
      expect(result.content[0].text).toContain("Team Meeting");
      expect(result.content[0].text).toContain("Client Call");
    });

    it("should filter by specific calendar", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [],
        free: [],
      };

      vi.mocked(mockCalendarService.getFreeBusy!).mockResolvedValue(
        freeBusyInfo,
      );

      await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
          calendar: "work",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getFreeBusy).toHaveBeenCalledWith(
        new Date("2025-06-20T00:00:00Z"),
        new Date("2025-06-20T23:59:59Z"),
        "work",
      );
    });

    it("should handle no busy times", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [],
        free: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T23:59:59Z"),
          },
        ],
      };

      vi.mocked(mockCalendarService.getFreeBusy!).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("No busy times");
    });

    it("should handle no free times", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T23:59:59Z"),
            summary: "All Day Event",
          },
        ],
        free: [],
      };

      vi.mocked(mockCalendarService.getFreeBusy!).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("No free times");
    });
  });

  describe("handleCalendarTool - recurrence in get_calendar_events", () => {
    it("surfaces recurrenceId and the scope hint for a recurring occurrence", async () => {
      const occurrence: CalendarEvent = {
        ...mockEvent,
        recurring: true,
        recurrenceId: "2026-08-17T09:00:00.000Z",
        url: "https://caldav.example.com/cal/privat/jourfixe.ics",
        etag: '"v1"',
      };
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        occurrence,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        { start: "2026-08-17T00:00:00Z", end: "2026-08-18T00:00:00Z" },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain(
        "recurrenceId: 2026-08-17T09:00:00.000Z",
      );
      expect(result.content[0].text).toContain("applyToSeries: true");
    });
  });

  describe("handleCalendarTool - update/delete routing", () => {
    const URL = "https://caldav.example.com/cal/privat/jourfixe.ics";
    const written = { success: true, message: "done", url: URL, uid: "u@x" };

    beforeEach(() => {
      mockCalendarService.updateEvent = vi.fn().mockResolvedValue(written);
      mockCalendarService.updateSeries = vi.fn().mockResolvedValue(written);
      mockCalendarService.updateOccurrence = vi.fn().mockResolvedValue(written);
      mockCalendarService.deleteEvent = vi.fn().mockResolvedValue(written);
      mockCalendarService.cancelOccurrence = vi.fn().mockResolvedValue(written);
    });

    const body = {
      url: URL,
      summary: "Titel",
      start: "2026-08-17T14:00:00Z",
      end: "2026-08-17T15:00:00Z",
    };

    it("routes update_event with recurrenceId to updateOccurrence", async () => {
      await handleCalendarTool(
        "update_event",
        { ...body, recurrenceId: "2026-08-17T09:00:00.000Z" },
        mockCalendarService as CalendarService,
      );
      expect(mockCalendarService.updateOccurrence).toHaveBeenCalledWith(
        URL,
        "2026-08-17T09:00:00.000Z",
        expect.objectContaining({ summary: "Titel" }),
        undefined,
      );
      expect(mockCalendarService.updateSeries).not.toHaveBeenCalled();
      expect(mockCalendarService.updateEvent).not.toHaveBeenCalled();
    });

    it("routes update_event with applyToSeries to updateSeries", async () => {
      await handleCalendarTool(
        "update_event",
        { ...body, applyToSeries: true },
        mockCalendarService as CalendarService,
      );
      expect(mockCalendarService.updateSeries).toHaveBeenCalledTimes(1);
      expect(mockCalendarService.updateOccurrence).not.toHaveBeenCalled();
      expect(mockCalendarService.updateEvent).not.toHaveBeenCalled();
    });

    it("routes a plain update_event to updateEvent", async () => {
      await handleCalendarTool(
        "update_event",
        body,
        mockCalendarService as CalendarService,
      );
      expect(mockCalendarService.updateEvent).toHaveBeenCalledTimes(1);
      expect(mockCalendarService.updateSeries).not.toHaveBeenCalled();
      expect(mockCalendarService.updateOccurrence).not.toHaveBeenCalled();
    });

    it("rejects update_event that sets both recurrenceId and applyToSeries", async () => {
      const result = await handleCalendarTool(
        "update_event",
        {
          ...body,
          recurrenceId: "2026-08-17T09:00:00.000Z",
          applyToSeries: true,
        },
        mockCalendarService as CalendarService,
      );
      expect(result.isError).toBe(true);
      expect(mockCalendarService.updateOccurrence).not.toHaveBeenCalled();
      expect(mockCalendarService.updateSeries).not.toHaveBeenCalled();
    });

    it("routes delete_event with recurrenceId to cancelOccurrence", async () => {
      await handleCalendarTool(
        "delete_event",
        { url: URL, recurrenceId: "2026-08-17T09:00:00.000Z" },
        mockCalendarService as CalendarService,
      );
      expect(mockCalendarService.cancelOccurrence).toHaveBeenCalledWith(
        URL,
        "2026-08-17T09:00:00.000Z",
        undefined,
      );
      expect(mockCalendarService.deleteEvent).not.toHaveBeenCalled();
    });

    it("routes a plain delete_event to deleteEvent", async () => {
      await handleCalendarTool(
        "delete_event",
        { url: URL },
        mockCalendarService as CalendarService,
      );
      expect(mockCalendarService.deleteEvent).toHaveBeenCalledTimes(1);
      expect(mockCalendarService.cancelOccurrence).not.toHaveBeenCalled();
    });
  });

  describe("handleCalendarTool - sync primitives", () => {
    it("prints the uid in get_calendar_events so a copy can be matched", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        { start: "2025-06-20T00:00:00Z", end: "2025-06-21T00:00:00Z" },
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("uid: event-1@example.com");
    });

    it("passes a foreign uid from create_event through to the service", async () => {
      mockCalendarService.createEvent = vi.fn().mockResolvedValue({
        success: true,
        message: "created",
        uid: "abc@google.com",
        url: "https://caldav.example.com/cal/familie/abc%40google.com.ics",
      });

      const result = await handleCalendarTool(
        "create_event",
        {
          summary: "Test",
          start: "2026-09-01T09:00:00Z",
          end: "2026-09-01T10:00:00Z",
          calendar: "Familie",
          uid: "abc@google.com",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ summary: "Test" }),
        "Familie",
        "abc@google.com",
      );
      expect(result.content[0].text).toContain("uid: abc@google.com");
    });

    it("rejects a create_event uid with control characters instead of silently stripping it", async () => {
      mockCalendarService.createEvent = vi.fn();

      const result = await handleCalendarTool(
        "create_event",
        {
          summary: "Test",
          start: "2026-09-01T09:00:00Z",
          end: "2026-09-01T10:00:00Z",
          calendar: "Familie",
          // A control character (SOH) the old silent-strip would have removed.
          uid: `bad${String.fromCharCode(1)}uid@google.com`,
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(mockCalendarService.createEvent).not.toHaveBeenCalled();
    });

    it("lists calendars with their collection url", async () => {
      mockCalendarService.listCalendars = vi.fn().mockResolvedValue([
        {
          name: "Familie",
          url: "https://caldav.example.com/cal/familie/",
          components: ["VEVENT"],
          ctag: "ctag-1",
        },
        { name: "Leer", url: "https://caldav.example.com/cal/leer/" },
      ]);

      const result = await handleCalendarTool(
        "list_calendars",
        {},
        mockCalendarService as CalendarService,
      );

      expect(result.content[0].text).toContain("Found 2 calendars");
      expect(result.content[0].text).toContain("**Familie**");
      expect(result.content[0].text).toContain(
        "url: https://caldav.example.com/cal/familie/",
      );
      // ctag is surfaced so a sync can use it for cheap change-detection.
      expect(result.content[0].text).toContain("ctag: ctag-1");
      expect(result.content[0].text).toContain("**Leer**");
    });

    it("returns the raw body from get_ics", async () => {
      mockCalendarService.getIcs = vi.fn().mockResolvedValue({
        url: "https://caldav.example.com/cal/familie/x.ics",
        etag: '"e1"',
        ics: "BEGIN:VCALENDAR\nRRULE:FREQ=WEEKLY\nEND:VCALENDAR",
      });

      const result = await handleCalendarTool(
        "get_ics",
        { url: "https://caldav.example.com/cal/familie/x.ics" },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getIcs).toHaveBeenCalledWith(
        "https://caldav.example.com/cal/familie/x.ics",
      );
      expect(result.content[0].text).toContain("RRULE:FREQ=WEEKLY");
      expect(result.content[0].text).toContain('etag: "e1"');
    });

    it("writes a raw body via put_ics and reports uid and url", async () => {
      mockCalendarService.putIcs = vi.fn().mockResolvedValue({
        success: true,
        message: "written",
        uid: "series-1@google.com",
        url: "https://caldav.example.com/cal/familie/series-1%40google.com.ics",
        etag: '"v1"',
      });

      const result = await handleCalendarTool(
        "put_ics",
        {
          calendar: "Familie",
          ics: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:series-1@google.com\nEND:VEVENT\nEND:VCALENDAR",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.putIcs).toHaveBeenCalledWith(
        "Familie",
        expect.stringContaining("UID:series-1@google.com"),
        undefined,
        undefined,
      );
      expect(result.content[0].text).toContain("uid: series-1@google.com");
    });

    it("rejects put_ics with an empty body at the validation layer", async () => {
      mockCalendarService.putIcs = vi.fn();

      const result = await handleCalendarTool(
        "put_ics",
        { calendar: "Familie", ics: "" },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(mockCalendarService.putIcs).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle validation errors", async () => {
      const result = await handleCalendarTool(
        "get_free_busy",
        {
          // Missing required fields
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid input");
    });

    it("should handle unknown tool name", async () => {
      const result = await handleCalendarTool(
        "unknown_tool",
        {},
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown calendar tool");
    });

    it("should handle service errors", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents!).mockRejectedValue(
        new Error("Connection failed"),
      );

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error executing");
    });

    it("should handle invalid date formats", async () => {
      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "invalid-date",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
    });
  });
});
