import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  CalDavConnection,
  CalendarEventInput,
} from "../src/types/calendar.types.js";

/**
 * Writing events.
 *
 * The point under test is not "does it call tsdav" but "does it notice when the
 * server says no". tsdav resolves with a fetch Response whose ok is false
 * instead of throwing — the same shape of trap that let the IMAP path report
 * deletions that never happened.
 */

const mockCreateCalendarObject = vi.fn();
const mockUpdateCalendarObject = vi.fn();
const mockDeleteCalendarObject = vi.fn();
const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();

vi.mock("tsdav", () => ({
  createDAVClient: vi.fn(async () => ({
    fetchCalendars: mockFetchCalendars,
    fetchCalendarObjects: mockFetchCalendarObjects,
    createCalendarObject: mockCreateCalendarObject,
    updateCalendarObject: mockUpdateCalendarObject,
    deleteCalendarObject: mockDeleteCalendarObject,
  })),
  DAVClient: class {},
}));

/** A plain, non-recurring resource — what updateEvent now reads before writing. */
const SINGLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:abc@example.com
DTSTAMP:20260101T090000Z
DTSTART:20260901T090000Z
DTEND:20260901T100000Z
SUMMARY:Einzeltermin
END:VEVENT
END:VCALENDAR`;

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const connection: CalDavConnection = {
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

const TERMIN: CalendarEventInput = {
  summary: "Zahnarzt",
  start: new Date("2026-09-01T09:00:00Z"),
  end: new Date("2026-09-01T10:00:00Z"),
};

describe("CalendarService writing", () => {
  let service: CalendarService;
  let cache: LocalCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = createMockCache();
    service = new CalendarService(connection, cache);
    mockFetchCalendars.mockResolvedValue([
      { displayName: "Privat", url: "https://caldav.example.com/cal/privat/" },
      { displayName: "Arbeit", url: "https://caldav.example.com/cal/arbeit/" },
    ]);
  });

  describe("createEvent", () => {
    it("creates the event and returns url and etag for later changes", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok('"v1"'));

      const result = await service.createEvent(TERMIN, "Privat");

      expect(result.success).toBe(true);
      expect(result.url).toMatch(
        /^https:\/\/caldav\.example\.com\/cal\/privat\/.+\.ics$/,
      );
      expect(result.etag).toBe('"v1"');
    });

    it("fails when the server refuses, instead of reporting success", async () => {
      mockCreateCalendarObject.mockResolvedValue(refused(403, "Forbidden"));

      await expect(service.createEvent(TERMIN, "Privat")).rejects.toThrow(
        /refused/i,
      );
    });

    it("writes iCalendar that survives a comma and a newline in the summary", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok());

      await service.createEvent(
        { ...TERMIN, summary: "Termin, mit Komma\nund Zeilenumbruch" },
        "Privat",
      );

      const ical: string = mockCreateCalendarObject.mock.calls[0][0].iCalString;
      // ical.js escapes the separators; a string template would have produced a
      // broken VEVENT here.
      expect(ical).toContain("BEGIN:VEVENT");
      expect(ical).toContain("END:VCALENDAR");
      expect(ical).toMatch(/SUMMARY:Termin\\,\s?mit Komma\\n/);
    });

    it("names the available calendars when the requested one does not exist", async () => {
      await expect(service.createEvent(TERMIN, "Gibtsnicht")).rejects.toThrow(
        /Privat.*Arbeit|Arbeit.*Privat/,
      );
      expect(mockCreateCalendarObject).not.toHaveBeenCalled();
    });

    it("rejects an event that ends before it starts", async () => {
      await expect(
        service.createEvent({
          ...TERMIN,
          start: new Date("2026-09-01T10:00:00Z"),
          end: new Date("2026-09-01T09:00:00Z"),
        }),
      ).rejects.toThrow(/ends before it starts/);
      expect(mockCreateCalendarObject).not.toHaveBeenCalled();
    });

    it("marks an all-day event as a date, not a timestamp", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok());

      await service.createEvent({ ...TERMIN, allDay: true }, "Privat");

      const ical: string = mockCreateCalendarObject.mock.calls[0][0].iCalString;
      expect(ical).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
    });

    it("clears the read cache so the new event is not hidden by it", async () => {
      mockCreateCalendarObject.mockResolvedValue(ok());
      await service.createEvent(TERMIN, "Privat");
      expect(cache.clear).toHaveBeenCalled();
    });
  });

  describe("updateEvent", () => {
    const URL = "https://caldav.example.com/cal/privat/abc.ics";

    beforeEach(() => {
      // updateEvent now reads the resource first to refuse flattening a series.
      // A non-recurring resource lets the plain-update path proceed.
      mockFetchCalendarObjects.mockResolvedValue([
        { url: URL, etag: '"current"', data: SINGLE_ICS },
      ]);
    });

    it("passes the etag through so the write is conditional", async () => {
      mockUpdateCalendarObject.mockResolvedValue(ok('"v2"'));

      await service.updateEvent(URL, TERMIN, '"v1"');

      expect(mockUpdateCalendarObject).toHaveBeenCalledWith({
        calendarObject: expect.objectContaining({ url: URL, etag: '"v1"' }),
      });
    });

    it("reports a conflict rather than overwriting a concurrent change", async () => {
      mockUpdateCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );

      await expect(service.updateEvent(URL, TERMIN, '"alt"')).rejects.toThrow(
        /changed elsewhere/i,
      );
    });

    it("fails on any other refusal", async () => {
      mockUpdateCalendarObject.mockResolvedValue(refused(404, "Not Found"));
      await expect(service.updateEvent(URL, TERMIN)).rejects.toThrow(
        /refused/i,
      );
    });
  });

  describe("deleteEvent", () => {
    const URL = "https://caldav.example.com/cal/privat/abc.ics";

    it("deletes and clears the cache", async () => {
      mockDeleteCalendarObject.mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: { get: () => null },
      });

      const result = await service.deleteEvent(URL, '"v1"');

      expect(result.success).toBe(true);
      expect(cache.clear).toHaveBeenCalled();
    });

    it("reports a conflict instead of deleting a changed event", async () => {
      mockDeleteCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );
      await expect(service.deleteEvent(URL, '"alt"')).rejects.toThrow(
        /changed elsewhere/i,
      );
    });

    it("fails when the server refuses", async () => {
      mockDeleteCalendarObject.mockResolvedValue(refused(403, "Forbidden"));
      await expect(service.deleteEvent(URL)).rejects.toThrow(/refused/i);
    });
  });
});
