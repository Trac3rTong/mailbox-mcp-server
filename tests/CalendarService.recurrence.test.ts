import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  CalDavConnection,
  CalendarEvent,
  CalendarSearchOptions,
} from "../src/types/calendar.types.js";

/**
 * Recurrence expansion, exercised against the REAL ical.js with real iCalendar
 * text. CalendarService.test.ts replaces ical.js with a stub whose Event always
 * answers isRecurring() === false, so it cannot see any of this — which is why
 * a missing expansion survived 555 green tests.
 */

vi.mock("tsdav", () => ({
  createDAVClient: vi.fn(),
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

const connection: CalDavConnection = {
  baseUrl: "https://caldav.example.com",
  username: "test@example.com",
  password: "password",
};

/** Weekly jour fixe that started well before any window we ask about. */
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

const WEEKLY_WITH_EXDATE = WEEKLY.replace(
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE:20260817T090000Z",
);

/** Same series, but one occurrence was moved and renamed. */
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

const TRANSPARENT_ALLDAY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:homeoffice@example.com
DTSTAMP:20260101T090000Z
DTSTART;VALUE=DATE:20260817
DTEND;VALUE=DATE:20260818
TRANSP:TRANSPARENT
SUMMARY:Homeoffice
END:VEVENT
END:VCALENDAR`;

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

// Monday 2026-08-17 .. Sunday 2026-08-23
const WOCHE: CalendarSearchOptions = {
  start: new Date("2026-08-17T00:00:00Z"),
  end: new Date("2026-08-24T00:00:00Z"),
};

describe("CalendarService recurrence expansion", () => {
  let service: CalendarService;

  const parse = (
    ical: string,
    options: CalendarSearchOptions = WOCHE,
    url = "https://caldav.example.com/cal/1.ics",
    etag = '"abc123"',
  ): CalendarEvent[] =>
    (
      service as unknown as {
        parseICalData: (
          data: string,
          calendar: string,
          options: CalendarSearchOptions,
          url?: string,
          etag?: string,
        ) => CalendarEvent[];
      }
    ).parseICalData(ical, "personal", options, url, etag);

  beforeEach(() => {
    service = new CalendarService(connection, createMockCache());
  });

  it("expands a weekly series into the occurrence inside the window", () => {
    const events = parse(WEEKLY);

    expect(events).toHaveLength(1);
    // Not the original DTSTART from January.
    expect(events[0].start.toISOString()).toBe("2026-08-17T09:00:00.000Z");
    expect(events[0].recurring).toBe(true);
  });

  it("does not report the series with its original start date", () => {
    const events = parse(WEEKLY);
    expect(
      events.some(e => e.start.toISOString().startsWith("2026-01-05")),
    ).toBe(false);
  });

  it("gives every occurrence its own id while keeping the shared uid", () => {
    const events = parse(WEEKLY, {
      start: new Date("2026-08-01T00:00:00Z"),
      end: new Date("2026-08-31T00:00:00Z"),
    });

    expect(events.length).toBeGreaterThan(3);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    expect(new Set(events.map(e => e.uid))).toEqual(
      new Set(["jourfixe@example.com"]),
    );
  });

  it("honours EXDATE", () => {
    expect(parse(WEEKLY_WITH_EXDATE)).toHaveLength(0);
    expect(parse(WEEKLY)).toHaveLength(1);
  });

  it("applies a moved occurrence instead of emitting both versions", () => {
    const events = parse(WEEKLY_WITH_OVERRIDE);

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Jour fixe (verlegt)");
    expect(events[0].start.toISOString()).toBe("2026-08-17T14:00:00.000Z");
    expect(events[0].isException).toBe(true);
  });

  it("keeps url and etag so the occurrence can be modified later", () => {
    const [event] = parse(WEEKLY);
    expect(event.url).toBe("https://caldav.example.com/cal/1.ics");
    expect(event.etag).toBe('"abc123"');
  });

  it("passes a non-recurring event through untouched", () => {
    const events = parse(SINGLE);
    expect(events).toHaveLength(1);
    expect(events[0].recurring).toBe(false);
    expect(events[0].id).toBe("einzeln@example.com");
  });

  it("marks TRANSP:TRANSPARENT entries as transparent", () => {
    const [event] = parse(TRANSPARENT_ALLDAY);
    expect(event.transparent).toBe(true);
    expect(event.allDay).toBe(true);
  });

  it("terminates on an endless rule instead of spinning", () => {
    const events = parse(WEEKLY, {
      start: new Date("2026-08-17T00:00:00Z"),
      end: new Date("2036-08-17T00:00:00Z"),
    });
    expect(events.length).toBeLessThanOrEqual(750);
    expect(events.length).toBeGreaterThan(100);
  });
});

describe("CalendarService free/busy", () => {
  let service: CalendarService;

  const freeBusy = (
    events: CalendarEvent[],
    start: Date,
    end: Date,
  ): { busy: Array<{ start: Date; end: Date }> } =>
    (
      service as unknown as {
        calculateFreeBusy: (
          e: CalendarEvent[],
          s: Date,
          en: Date,
        ) => { busy: Array<{ start: Date; end: Date }> };
      }
    ).calculateFreeBusy(events, start, end);

  const parse = (
    ical: string,
    options: CalendarSearchOptions,
  ): CalendarEvent[] =>
    (
      service as unknown as {
        parseICalData: (
          d: string,
          c: string,
          o: CalendarSearchOptions,
        ) => CalendarEvent[];
      }
    ).parseICalData(ical, "personal", options);

  beforeEach(() => {
    service = new CalendarService(connection, createMockCache());
  });

  it("reports an expanded occurrence as busy", () => {
    const events = parse(WEEKLY, WOCHE);
    const result = freeBusy(events, WOCHE.start as Date, WOCHE.end as Date);

    // Before expansion this slot was reported as free: the unexpanded master
    // still carried its January date and never overlapped the window.
    expect(result.busy).toHaveLength(1);
    expect(result.busy[0].start.toISOString()).toBe(
      "2026-08-17T09:00:00.000Z",
    );
  });

  it("does not count a transparent entry as busy", () => {
    const events = parse(TRANSPARENT_ALLDAY, WOCHE);
    const result = freeBusy(events, WOCHE.start as Date, WOCHE.end as Date);
    expect(result.busy).toHaveLength(0);
  });
});
