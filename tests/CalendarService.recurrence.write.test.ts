import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  CalDavConnection,
  CalendarEventInput,
} from "../src/types/calendar.types.js";

/**
 * Writing to recurring series, against the REAL ical.js with real iCalendar
 * text. The point under test is that the recurrence survives: editing a series
 * or one occurrence must not flatten RRULE/EXDATE/overrides, and the RECURRENCE-ID
 * an override carries must match the occurrence's original slot.
 */

const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();
const mockUpdateCalendarObject = vi.fn();
const mockDeleteCalendarObject = vi.fn();
const mockCreateCalendarObject = vi.fn();

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

const CAL_URL = "https://caldav.example.com/cal/privat/";
const EVENT_URL = `${CAL_URL}jourfixe.ics`;

/** Weekly Monday jour fixe, times in UTC. */
const WEEKLY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:jourfixe@example.com
DTSTAMP:20260101T090000Z
DTSTART:20260105T090000Z
DTEND:20260105T100000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Jour fixe
END:VEVENT
END:VCALENDAR`;

/** Same series, one occurrence (2026-08-17) already moved to 14:00 and renamed. */
const WEEKLY_WITH_OVERRIDE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:jourfixe@example.com
DTSTAMP:20260101T090000Z
DTSTART:20260105T090000Z
DTEND:20260105T100000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Jour fixe
END:VEVENT
BEGIN:VEVENT
UID:jourfixe@example.com
RECURRENCE-ID:20260817T090000Z
DTSTAMP:20260101T090000Z
DTSTART:20260817T140000Z
DTEND:20260817T150000Z
SUMMARY:Jour fixe (verlegt)
END:VEVENT
END:VCALENDAR`;

/** Same series with one occurrence already excluded. */
const WEEKLY_WITH_EXDATE = WEEKLY.replace(
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE:20260810T090000Z",
);

const SINGLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:einzeln@example.com
DTSTAMP:20260101T090000Z
DTSTART:20260819T110000Z
DTEND:20260819T120000Z
SUMMARY:Einzeltermin
END:VEVENT
END:VCALENDAR`;

// The Monday 2026-08-17 occurrence, as get_calendar_events reports it.
const OCC_ID = "2026-08-17T09:00:00.000Z";

const BODY: CalendarEventInput = {
  summary: "Geändert",
  start: new Date("2026-08-17T14:00:00Z"),
  end: new Date("2026-08-17T15:00:00Z"),
};

const ok = (etag = '"neu"') => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag : null) },
});

const refused = (status: number, statusText: string) => ({
  ok: false,
  status,
  statusText,
  headers: { get: () => null },
});

/** Reads back the iCalendar text the service tried to write. */
const writtenData = (): string =>
  mockUpdateCalendarObject.mock.calls[0][0].calendarObject.data;

const writtenEtag = (): string | undefined =>
  mockUpdateCalendarObject.mock.calls[0][0].calendarObject.etag;

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("CalendarService recurring writes", () => {
  let service: CalendarService;

  const loadResource = (data: string, etag = '"current"') => {
    mockFetchCalendarObjects.mockResolvedValue([
      { url: EVENT_URL, etag, data },
    ]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CalendarService(connection, createMockCache());
    mockFetchCalendars.mockResolvedValue([
      { displayName: "Privat", url: CAL_URL },
      { displayName: "Arbeit", url: "https://caldav.example.com/cal/arbeit/" },
    ]);
    mockUpdateCalendarObject.mockResolvedValue(ok());
  });

  describe("updateSeries", () => {
    it("keeps RRULE, existing override and EXDATE, and changes the master fields", async () => {
      const withBoth = WEEKLY_WITH_OVERRIDE.replace(
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE:20260810T090000Z",
      );
      loadResource(withBoth);

      await service.updateSeries(EVENT_URL, {
        ...BODY,
        summary: "Neuer Titel",
      });

      const data = writtenData();
      expect(data).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
      expect(data).toContain("EXDATE:20260810T090000Z");
      expect(data).toContain("RECURRENCE-ID:20260817T090000Z"); // override survived
      expect(data).toContain("SUMMARY:Neuer Titel");
    });

    it("does not move the master's DTSTART even though a start was supplied", async () => {
      loadResource(WEEKLY);

      await service.updateSeries(EVENT_URL, BODY);

      const data = writtenData();
      // The occurrence start in BODY (14:00 on 2026-08-17) must NOT become the
      // series anchor; the weekly 09:00 master stands.
      expect(data).toContain("DTSTART:20260105T090000Z");
      expect(data).not.toContain("DTSTART:20260817T140000Z");
    });

    it("passes the caller etag so the write is conditional", async () => {
      loadResource(WEEKLY, '"current"');
      await service.updateSeries(EVENT_URL, BODY, '"caller"');
      expect(writtenEtag()).toBe('"caller"');
    });

    it("falls back to the fetched etag when the caller gives none", async () => {
      loadResource(WEEKLY, '"current"');
      await service.updateSeries(EVENT_URL, BODY);
      expect(writtenEtag()).toBe('"current"');
    });

    it("reports a conflict instead of overwriting a concurrent change", async () => {
      loadResource(WEEKLY);
      mockUpdateCalendarObject.mockResolvedValue(
        refused(412, "Precondition Failed"),
      );
      await expect(
        service.updateSeries(EVENT_URL, BODY, '"alt"'),
      ).rejects.toThrow(/changed elsewhere/i);
    });

    it("refuses a resource that is not a series", async () => {
      loadResource(SINGLE);
      await expect(service.updateSeries(EVENT_URL, BODY)).rejects.toThrow(
        /not a recurring series/i,
      );
      expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
    });
  });

  describe("updateOccurrence", () => {
    it("adds an override VEVENT with the occurrence's original RECURRENCE-ID", async () => {
      loadResource(WEEKLY);

      await service.updateOccurrence(EVENT_URL, OCC_ID, BODY);

      const data = writtenData();
      expect(data).toContain("RECURRENCE-ID:20260817T090000Z");
      // moved to the new time from BODY
      expect(data).toContain("DTSTART:20260817T140000Z");
      expect(data).toContain("SUMMARY:Geändert");
      // master left intact
      expect(data).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
      expect(data).toContain("DTSTART:20260105T090000Z");
    });

    it("updates an existing override in place rather than duplicating it", async () => {
      loadResource(WEEKLY_WITH_OVERRIDE);

      await service.updateOccurrence(EVENT_URL, OCC_ID, {
        summary: "Nochmal verlegt",
        start: new Date("2026-08-17T16:00:00Z"),
        end: new Date("2026-08-17T17:00:00Z"),
      });

      const data = writtenData();
      expect(occurrences(data, "RECURRENCE-ID:20260817T090000Z")).toBe(1);
      expect(data).toContain("DTSTART:20260817T160000Z");
      expect(data).toContain("SUMMARY:Nochmal verlegt");
      expect(data).not.toContain("DTSTART:20260817T140000Z");
    });

    it("fails loudly when no occurrence starts at the given recurrenceId", async () => {
      loadResource(WEEKLY);
      await expect(
        // 2026-08-18 is a Tuesday — not in a Monday series.
        service.updateOccurrence(EVENT_URL, "2026-08-18T09:00:00.000Z", BODY),
      ).rejects.toThrow(/no occurrence/i);
      expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
    });

    it("rejects a recurrenceId that is not a date", async () => {
      loadResource(WEEKLY);
      await expect(
        service.updateOccurrence(EVENT_URL, "not-a-date", BODY),
      ).rejects.toThrow(/valid date/i);
    });
  });

  describe("cancelOccurrence", () => {
    it("adds an EXDATE for the occurrence", async () => {
      loadResource(WEEKLY);
      await service.cancelOccurrence(EVENT_URL, OCC_ID);
      expect(writtenData()).toContain("EXDATE:20260817T090000Z");
    });

    it("also removes an override that used to move that occurrence", async () => {
      loadResource(WEEKLY_WITH_OVERRIDE);
      await service.cancelOccurrence(EVENT_URL, OCC_ID);
      const data = writtenData();
      expect(data).toContain("EXDATE:20260817T090000Z");
      expect(data).not.toContain("RECURRENCE-ID:20260817T090000Z");
    });

    it("fails loudly for an unknown occurrence", async () => {
      loadResource(WEEKLY);
      await expect(
        service.cancelOccurrence(EVENT_URL, "2026-08-18T09:00:00.000Z"),
      ).rejects.toThrow(/no occurrence/i);
      expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
    });
  });

  describe("updateEvent guard against flattening a series", () => {
    it("refuses to update a recurring resource without a scope", async () => {
      loadResource(WEEKLY);
      await expect(service.updateEvent(EVENT_URL, BODY)).rejects.toThrow(
        /recurring series/i,
      );
      expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
    });

    it("still updates a plain single event", async () => {
      loadResource(SINGLE);
      const result = await service.updateEvent(EVENT_URL, BODY, '"v1"');
      expect(result.success).toBe(true);
      expect(mockUpdateCalendarObject).toHaveBeenCalledTimes(1);
    });
  });
});
