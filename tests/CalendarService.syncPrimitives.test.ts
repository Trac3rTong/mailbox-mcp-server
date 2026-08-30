import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type { CalendarEventInput } from "../src/types/calendar.types.js";

/**
 * The sync primitives: a foreign UID on create, list_calendars, and the raw
 * get_ics / put_ics pair. What matters is that put_ics writes the body verbatim
 * (so a recurrence rule survives), that a malformed or UID-less body fails
 * before anything is written, and that an empty-but-real calendar is still
 * reported by list_calendars.
 */

const mockCreateCalendarObject = vi.fn();
const mockUpdateCalendarObject = vi.fn();
const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();

vi.mock("tsdav", () => ({
  createDAVClient: vi.fn(async () => ({
    fetchCalendars: mockFetchCalendars,
    fetchCalendarObjects: mockFetchCalendarObjects,
    createCalendarObject: mockCreateCalendarObject,
    updateCalendarObject: mockUpdateCalendarObject,
  })),
  DAVClient: class {},
}));

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const connection = {
  baseUrl: "https://caldav.example.com",
  username: "test@example.com",
  password: "password",
};

const createMockCache = (): LocalCache =>
  ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    has: vi.fn(),
    size: vi.fn(),
    cleanup: vi.fn(),
    getStale: vi.fn(),
  }) as unknown as LocalCache;

const ok = (etag = '"neu"') => ({
  ok: true,
  status: 201,
  statusText: "Created",
  headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag : null) },
});

const refused = (status: number, statusText: string) => ({
  ok: false,
  status,
  statusText,
  headers: { get: () => null },
});

const FAMILIE_URL = "https://caldav.example.com/cal/familie/";

const SERIES_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:series-1@google.com
DTSTAMP:20260101T090000Z
DTSTART:20260901T160000Z
DTEND:20260901T163000Z
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:Klavier
END:VEVENT
END:VCALENDAR`;

const TERMIN: CalendarEventInput = {
  summary: "Zahnarzt",
  start: new Date("2026-09-01T09:00:00Z"),
  end: new Date("2026-09-01T10:00:00Z"),
};

describe("CalendarService sync primitives", () => {
  let service: CalendarService;
  let cache: LocalCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = createMockCache();
    service = new CalendarService(connection, cache);
    mockFetchCalendars.mockResolvedValue([
      { displayName: "Familie", url: FAMILIE_URL },
      { displayName: "Kalender", url: "https://caldav.example.com/cal/priv/" },
    ]);
  });

  describe("createEvent with a foreign UID", () => {
    it("uses the given UID as the anchor and the filename", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok('"v1"'));

      const result = await service.createEvent(
        TERMIN,
        "Familie",
        "abc-123@google.com",
      );

      expect(result.uid).toBe("abc-123@google.com");
      const call = mockCreateCalendarObject.mock.calls[0][0];
      expect(call.filename).toBe("abc-123@google.com.ics");
      expect(call.iCalString).toContain("UID:abc-123@google.com");
    });

    it("mints its own UID when none is given", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok());

      const result = await service.createEvent(TERMIN, "Familie");

      expect(result.uid).toMatch(/@mailbox-mcp-server$/);
    });

    it("names a UID collision (If-None-Match 412) instead of a generic refusal", async () => {
      mockCreateCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );

      await expect(
        service.createEvent(TERMIN, "Familie", "dup@google.com"),
      ).rejects.toThrow(/already exists/i);
    });
  });

  describe("listCalendars", () => {
    it("keeps the collection url and metadata, including an empty calendar", async () => {
      mockFetchCalendars.mockResolvedValue([
        {
          displayName: "Familie",
          url: FAMILIE_URL,
          calendarColor: "#5d82b6",
          components: ["VEVENT"],
          ctag: "ctag-1",
        },
        // No events at all — still has to be reported, which is the whole point.
        { displayName: "Leer", url: "https://caldav.example.com/cal/leer/" },
      ]);

      const calendars = await service.listCalendars();

      expect(calendars).toHaveLength(2);
      expect(calendars[0]).toMatchObject({
        name: "Familie",
        url: FAMILIE_URL,
        color: "#5d82b6",
        components: ["VEVENT"],
        ctag: "ctag-1",
      });
      expect(calendars[1]).toMatchObject({ name: "Leer" });
    });
  });

  describe("getIcs", () => {
    it("returns the raw body and etag of the resource", async () => {
      const url = `${FAMILIE_URL}series-1@google.com.ics`;
      mockFetchCalendarObjects.mockResolvedValue([
        { url, etag: '"e1"', data: SERIES_ICS },
      ]);

      const raw = await service.getIcs(url);

      expect(raw.ics).toBe(SERIES_ICS);
      expect(raw.etag).toBe('"e1"');
      expect(raw.url).toBe(url);
    });

    it("fails loudly when the resource is gone", async () => {
      mockFetchCalendarObjects.mockResolvedValue([]);
      await expect(service.getIcs(`${FAMILIE_URL}missing.ics`)).rejects.toThrow(
        /could not be found/i,
      );
    });
  });

  describe("putIcs", () => {
    it("writes the body verbatim, keeping the recurrence rule", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok('"v1"'));

      const result = await service.putIcs("Familie", SERIES_ICS);

      expect(result.uid).toBe("series-1@google.com");
      const call = mockCreateCalendarObject.mock.calls[0][0];
      expect(call.filename).toBe("series-1@google.com.ics");
      // The exact bytes reach the server — this is what create_event cannot do.
      expect(call.iCalString).toBe(SERIES_ICS);
      expect(call.iCalString).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
    });

    it("replaces conditionally when an etag is given", async () => {
      mockUpdateCalendarObject.mockResolvedValue(ok('"v2"'));

      await service.putIcs("Familie", SERIES_ICS, undefined, '"old"');

      expect(mockCreateCalendarObject).not.toHaveBeenCalled();
      const arg = mockUpdateCalendarObject.mock.calls[0][0].calendarObject;
      expect(arg.etag).toBe('"old"');
      expect(arg.data).toBe(SERIES_ICS);
    });

    it("reports a conflict instead of overwriting a concurrent change", async () => {
      mockUpdateCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );
      await expect(
        service.putIcs("Familie", SERIES_ICS, undefined, '"old"'),
      ).rejects.toThrow(/changed elsewhere/i);
    });

    it("names a create collision (412 without etag) as 'already exists', not a concurrent change", async () => {
      mockCreateCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );
      await expect(service.putIcs("Familie", SERIES_ICS)).rejects.toThrow(
        /already exists/i,
      );
    });

    it("fails when the server refuses the create", async () => {
      mockCreateCalendarObject.mockResolvedValue(refused(403, "Forbidden"));
      await expect(service.putIcs("Familie", SERIES_ICS)).rejects.toThrow(
        /refused/i,
      );
    });

    it("rejects a body that does not parse, without writing", async () => {
      await expect(
        service.putIcs("Familie", "this is not iCalendar"),
      ).rejects.toThrow(/could not be parsed|no VEVENT/i);
      expect(mockCreateCalendarObject).not.toHaveBeenCalled();
    });

    it("rejects a VEVENT without a UID, without writing", async () => {
      const noUid = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260901T160000Z
DTEND:20260901T163000Z
SUMMARY:Ohne UID
END:VEVENT
END:VCALENDAR`;
      await expect(service.putIcs("Familie", noUid)).rejects.toThrow(
        /no VEVENT with a UID/i,
      );
      expect(mockCreateCalendarObject).not.toHaveBeenCalled();
    });
  });
});
