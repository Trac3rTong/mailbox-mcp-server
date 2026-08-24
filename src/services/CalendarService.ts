import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import ICAL from "ical.js";
import { createDAVClient, type DAVCalendar, type DAVObject } from "tsdav";
import type { LocalCache } from "../types/cache.types.js";
import type {
  Attendee,
  CalDavConnection,
  CalendarEvent,
  CalendarEventInput,
  CalendarSearchOptions,
  CalendarWriteResult,
  FreeBusyInfo,
} from "../types/calendar.types.js";
import {
  CalendarError,
  classifyTransportError,
  ErrorCode,
  ValidationError,
} from "../types/errors.js";
import { withCacheFallback } from "../utils/cacheFallback.js";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerMetrics,
} from "./CircuitBreaker.js";
import { createLogger } from "./Logger.js";

export class CalendarService {
  private connection: CalDavConnection;
  private cache: LocalCache;
  private client: Awaited<ReturnType<typeof createDAVClient>> | null = null;
  private circuitBreaker: CircuitBreaker;
  private logger = createLogger("CalendarService");

  constructor(
    connection: CalDavConnection,
    cache: LocalCache,
    circuitBreakerConfig?: CircuitBreakerConfig,
  ) {
    this.connection = connection;
    this.cache = cache;

    // Initialize circuit breaker with defaults or provided config
    const cbConfig = circuitBreakerConfig || {
      failureThreshold: 3,
      recoveryTimeout: 5000, // 5 seconds
      monitoringInterval: 2000, // 2 seconds
    };
    this.circuitBreaker = new CircuitBreaker(cbConfig);
  }

  protected async getClient(): Promise<
    Awaited<ReturnType<typeof createDAVClient>>
  > {
    if (!this.client) {
      this.client = await createDAVClient({
        serverUrl: this.connection.baseUrl,
        credentials: {
          username: this.connection.username,
          password: this.connection.password,
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
    }
    return this.client;
  }

  async getCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_events:${JSON.stringify(options)}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents(options);
        return events;
      },
      // No defaultValue: an empty list would claim the calendar is empty when
      // the truth is that it could not be read.
      logger: this.logger,
      operation: "getCalendarEvents",
      service: "CalendarService",
      ttl: 900000, // 15 minutes TTL
      logContext: { options },
    });
  }

  async searchCalendar(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_search:${JSON.stringify(options)}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents(options);
        const filteredEvents = this.filterEventsByQuery(events, options.query);
        return filteredEvents;
      },
      // No defaultValue, see getCalendarEvents.
      logger: this.logger,
      operation: "searchCalendar",
      service: "CalendarService",
      ttl: 900000, // 15 minutes TTL
      logContext: { query: options.query },
    });
  }

  async getFreeBusy(
    start: Date,
    end: Date,
    calendar?: string,
  ): Promise<FreeBusyInfo> {
    const cacheKey = `freebusy:${start.toISOString()}:${end.toISOString()}:${calendar || "all"}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents({
          start,
          end,
          calendar,
        });

        const freeBusy = this.calculateFreeBusy(events, start, end);
        return freeBusy;
      },
      // No defaultValue. The previous one declared the entire window free on any
      // connection failure, which is the one direction that leads to a wrong
      // commitment: an appointment accepted for a slot that is actually taken.
      logger: this.logger,
      operation: "getFreeBusy",
      service: "CalendarService",
      ttl: 300000, // 5 minutes TTL
      logContext: {
        start: start.toISOString(),
        end: end.toISOString(),
        calendar,
      },
    });
  }

  private async fetchCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    try {
      const calendars =
        this.connection.calendars || (await this.discoverCalendars());
      const allEvents: CalendarEvent[] = [];

      for (const calendar of calendars) {
        if (options.calendar && calendar !== options.calendar) {
          continue;
        }

        const calendarEvents = await this.fetchEventsFromCalendar(
          calendar,
          options,
        );
        allEvents.push(...calendarEvents);
      }

      return this.sortAndLimitEvents(allEvents, options);
    } catch (error) {
      this.logger.error(
        "Error fetching calendar events",
        {
          operation: "getEvents",
          service: "CalendarService",
        },
        {
          options,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // Never answer a failed fetch with an empty list: "no events" and "could
      // not reach the calendar" are indistinguishable to the caller, and the
      // empty array used to be cached as a valid result for 15 minutes.
      throw classifyTransportError(error, {
        operation: "getEvents",
        service: "CalendarService",
      });
    }
  }

  protected async discoverCalendars(): Promise<string[]> {
    try {
      const calendars = await this.circuitBreaker.execute(async () => {
        const client = await this.getClient();
        return await client.fetchCalendars();
      });

      return calendars.map(
        (cal: DAVCalendar) => (cal.displayName as string) || cal.url,
      );
    } catch (error) {
      this.logger.error(
        "Calendar discovery failed",
        {
          operation: "getCalendarList",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      // Inventing a calendar named "personal" made every later query run against
      // a name the server never returned, which then legitimately produced no
      // events. Fail here instead.
      throw classifyTransportError(error, {
        operation: "getCalendarList",
        service: "CalendarService",
      });
    }
  }

  private async fetchEventsFromCalendar(
    calendar: string,
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    try {
      const { calendars, calendarObjects } = await this.circuitBreaker.execute(
        async () => {
          const client = await this.getClient();
          const calendars = await client.fetchCalendars();

          const targetCalendar = calendars.find(
            (cal: DAVCalendar) =>
              cal.displayName === calendar || cal.url.includes(calendar),
          );

          if (!targetCalendar) {
            throw new Error(`Calendar ${calendar} not found`);
          }

          const calendarObjects = await client.fetchCalendarObjects({
            calendar: targetCalendar,
            timeRange:
              options.start && options.end
                ? {
                    start: options.start.toISOString(),
                    end: options.end.toISOString(),
                  }
                : undefined,
          });

          return { calendars, calendarObjects };
        },
      );

      return await this.parseCalendarObjects(
        calendarObjects,
        calendar,
        options,
      );
    } catch (error) {
      this.logger.error(
        `Error fetching events from calendar ${calendar}`,
        {
          operation: "fetchCalendarEvents",
          service: "CalendarService",
        },
        {
          calendar,
          options,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // One unreachable calendar out of several used to yield a shorter list
      // that looked complete. A partial answer presented as whole is worse than
      // no answer, so this propagates and fails the whole query.
      throw classifyTransportError(error, {
        operation: "fetchCalendarEvents",
        service: "CalendarService",
      });
    }
  }

  private parseCalendarObjects(
    calendarObjects: DAVObject[],
    calendar: string,
    options: CalendarSearchOptions = {},
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      for (const obj of calendarObjects) {
        if (obj.data) {
          const parsedEvents = this.parseICalData(
            obj.data,
            calendar,
            options,
            obj.url,
            obj.etag,
          );
          events.push(...parsedEvents);
        }
      }
    } catch (error) {
      this.logger.error(
        "Error parsing calendar objects",
        {
          operation: "parseCalendarObjects",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    return events;
  }

  /**
   * Upper bound on occurrences generated from a single series. An RRULE without
   * UNTIL or COUNT is infinite; the window normally stops the iteration, but
   * this guards against a malformed rule spinning forever.
   */
  private static readonly MAX_OCCURRENCES_PER_SERIES = 750;

  /**
   * Window to expand into when the caller did not give one. Unbounded expansion
   * is not an option for an infinite rule.
   */
  private defaultExpansionWindow(options: CalendarSearchOptions): {
    start: Date;
    end: Date;
  } {
    const start =
      options.start ?? new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const end =
      options.end ?? new Date(start.getTime() + 2 * 365 * 24 * 3600 * 1000);
    return { start, end };
  }

  private parseICalData(
    icalData: string,
    calendar: string,
    options: CalendarSearchOptions = {},
    url?: string,
    etag?: string,
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      const jcalData = ICAL.parse(icalData);
      const comp = new ICAL.Component(jcalData);
      const vevents = comp.getAllSubcomponents("vevent");

      // A single calendar object holds the series master plus one VEVENT per
      // modified occurrence, each carrying RECURRENCE-ID. Feeding them all
      // through parseVEvent produced duplicates that shared one id.
      const masters: ICAL.Component[] = [];
      const overrides: ICAL.Component[] = [];
      for (const vevent of vevents as ICAL.Component[]) {
        if (vevent.getFirstPropertyValue("recurrence-id")) {
          overrides.push(vevent);
        } else {
          masters.push(vevent);
        }
      }

      const handledOverrides = new Set<ICAL.Component>();

      for (const master of masters) {
        const event = new ICAL.Event(master);

        for (const override of overrides) {
          if (override.getFirstPropertyValue("uid") === event.uid) {
            try {
              event.relateException(override);
              handledOverrides.add(override);
            } catch {
              // Not relatable to this master; handled as a standalone below.
            }
          }
        }

        if (event.isRecurring()) {
          events.push(
            ...this.expandRecurringEvent(event, calendar, options, url, etag),
          );
        } else {
          const single = this.parseVEvent(master, calendar, url, etag);
          if (single) events.push(single);
        }
      }

      // Overrides whose master is not in this object (server returned only the
      // modified instance). Dropping them would hide a real appointment.
      for (const override of overrides) {
        if (handledOverrides.has(override)) continue;
        const orphan = this.parseVEvent(override, calendar, url, etag);
        if (orphan) {
          events.push({ ...orphan, isException: true });
        }
      }
    } catch (error) {
      this.logger.error(
        "Error parsing iCal data",
        {
          operation: "parseICalData",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    return events;
  }

  /**
   * Turn a recurrence rule into the individual occurrences inside the window.
   *
   * Without this the server's master VEVENT was reported as-is, with its
   * original DTSTART. A weekly meeting set up six months ago showed up dated six
   * months back, sorted to the front of every list, and — because
   * calculateFreeBusy compares against that same stale date — never appeared as
   * busy. get_free_busy therefore reported occupied slots as free.
   */
  private expandRecurringEvent(
    event: ICAL.Event,
    calendar: string,
    options: CalendarSearchOptions,
    url?: string,
    etag?: string,
  ): CalendarEvent[] {
    const { start: windowStart, end: windowEnd } =
      this.defaultExpansionWindow(options);
    const occurrences: CalendarEvent[] = [];

    try {
      const base = this.parseVEvent(event.component, calendar, url, etag);
      if (!base) return [];

      const iterator = event.iterator();
      let next = iterator.next();
      let guard = 0;

      while (next && guard < CalendarService.MAX_OCCURRENCES_PER_SERIES) {
        guard += 1;

        const details = event.getOccurrenceDetails(next);
        const occStart = details.startDate.toJSDate();
        const occEnd = details.endDate.toJSDate();

        if (occStart > windowEnd) break;

        // Half-open overlap: an occurrence ending exactly at the window start
        // does not fall inside it.
        if (occEnd > windowStart) {
          const isException = details.item !== event;
          const overridden = isException
            ? this.parseVEvent(details.item.component, calendar, url, etag)
            : null;

          occurrences.push({
            ...(overridden ?? base),
            id: `${event.uid}#${occStart.toISOString()}`,
            uid: event.uid,
            start: occStart,
            end: occEnd,
            recurring: true,
            // The occurrence's ORIGINAL slot as a UTC instant. This is the
            // identity a caller passes back to change or cancel exactly this
            // occurrence; next.toString() is zone-ambiguous and would not
            // round-trip. For a moved occurrence this stays the original slot,
            // not the shifted start.
            recurrenceId: next.toJSDate().toISOString(),
            isException,
            url,
            etag,
          });
        }

        next = iterator.next();
      }

      if (guard >= CalendarService.MAX_OCCURRENCES_PER_SERIES) {
        this.logger.warning(
          "Recurrence expansion hit its occurrence cap; the series may be truncated",
          { operation: "expandRecurringEvent", service: "CalendarService" },
          {
            uid: event.uid,
            cap: CalendarService.MAX_OCCURRENCES_PER_SERIES,
          },
        );
      }
    } catch (error) {
      this.logger.error(
        "Error expanding recurring event",
        { operation: "expandRecurringEvent", service: "CalendarService" },
        {
          uid: event.uid,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // Fall back to the unexpanded master rather than dropping the series.
      const base = this.parseVEvent(event.component, calendar, url, etag);
      return base ? [base] : [];
    }

    return occurrences;
  }

  private parseVEvent(
    vevent: unknown,
    calendar: string,
    url?: string,
    etag?: string,
  ): CalendarEvent | null {
    try {
      const event = new ICAL.Event(vevent as ICAL.Component);

      const basicInfo = this.extractBasicEventInfo(event);
      if (!this.hasValidDates(event)) {
        return null;
      }

      const timeInfo = this.extractTimeInfo(event);
      const participantInfo = this.extractParticipants(event);
      const metadataInfo = this.extractMetadata(event, calendar);

      return {
        ...basicInfo,
        ...timeInfo,
        ...participantInfo,
        ...metadataInfo,
        url,
        etag,
        transparent:
          String(
            event.component.getFirstPropertyValue("transp") ?? "",
          ).toUpperCase() === "TRANSPARENT",
      };
    } catch (error) {
      this.logger.error(
        "Error parsing VEVENT",
        {
          operation: "parseVEvent",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
  }

  private extractBasicEventInfo(
    event: ICAL.Event,
  ): Pick<
    CalendarEvent,
    "id" | "uid" | "summary" | "description" | "location"
  > {
    const uid = event.uid || `${Date.now()}-${Math.random()}`;
    return {
      id: uid,
      uid,
      summary: event.summary || "",
      description: event.description,
      location: event.location,
    };
  }

  private hasValidDates(event: ICAL.Event): boolean {
    return !!(event.startDate && event.endDate);
  }

  private extractTimeInfo(
    event: ICAL.Event,
  ): Pick<
    CalendarEvent,
    "start" | "end" | "allDay" | "recurring" | "recurrenceRule"
  > {
    return {
      start: event.startDate.toJSDate(),
      end: event.endDate.toJSDate(),
      allDay: event.startDate.isDate,
      recurring: event.isRecurring(),
      recurrenceRule: event.component
        .getFirstPropertyValue("rrule")
        ?.toString(),
    };
  }

  private extractParticipants(
    event: ICAL.Event,
  ): Pick<CalendarEvent, "attendees" | "organizer"> {
    const attendees = this.parseAttendees(event.attendees);
    const organizer = this.parseOrganizer(event.organizer);

    return {
      attendees: attendees.length > 0 ? attendees : undefined,
      organizer,
    };
  }

  private parseAttendees(attendees: unknown[] | null | undefined): Attendee[] {
    // Früher Return mit leerem Array wenn attendees falsy ist
    if (!attendees || !Array.isArray(attendees)) {
      return [];
    }

    return attendees.map((attendee: unknown) => {
      const email = this.extractEmail(attendee);
      return {
        email: email.replace("mailto:", ""),
        name: this.extractName(attendee, email),
        status: this.extractStatus(attendee),
      };
    });
  }

  private parseOrganizer(
    organizer: unknown,
  ): { email: string; name: string } | undefined {
    if (!organizer) {
      return undefined;
    }

    const email = this.extractEmail(organizer).replace("mailto:", "");
    return {
      email,
      name: this.extractName(organizer, email),
    };
  }

  private extractEmail(participant: unknown): string {
    const typedParticipant = participant as { getFirstValue?: () => string };
    return typedParticipant.getFirstValue
      ? typedParticipant.getFirstValue()
      : String(participant);
  }

  private extractName(participant: unknown, email: string): string {
    const typedParticipant = participant as {
      getParameter?: (name: string) => string;
    };
    return typedParticipant.getParameter
      ? typedParticipant.getParameter("cn")
      : email.replace("mailto:", "").split("@")[0];
  }

  private extractStatus(
    attendee: unknown,
  ): "needs-action" | "accepted" | "declined" | "tentative" {
    // Handle null/undefined or non-object attendees
    if (!attendee || typeof attendee !== "object") {
      return "needs-action";
    }

    const typedAttendee = attendee as {
      getParameter?: (name: string) => string;
    };
    const status = typedAttendee.getParameter
      ? typedAttendee.getParameter("partstat") || "needs-action"
      : "needs-action";

    // Map iCal status values to our expected types
    switch (status.toLowerCase()) {
      case "accepted":
        return "accepted";
      case "declined":
        return "declined";
      case "tentative":
        return "tentative";
      default:
        return "needs-action";
    }
  }

  private extractMetadata(
    event: ICAL.Event,
    calendar: string,
  ): Pick<CalendarEvent, "calendar" | "categories" | "created" | "modified"> {
    const categories = this.parseCategories(
      event.component.getFirstPropertyValue("categories"),
    );

    return {
      calendar,
      categories,
      created:
        this.parseICalDate(event.component.getFirstPropertyValue("created")) ||
        new Date(),
      modified:
        this.parseICalDate(
          event.component.getFirstPropertyValue("last-modified"),
        ) || new Date(),
    };
  }

  private parseCategories(categories: unknown): string[] {
    return categories && typeof categories === "string"
      ? categories.split(",").map((cat: string) => cat.trim())
      : [];
  }

  private parseICalDate(value: unknown): Date | null {
    if (!value) return null;
    const typedValue = value as { toJSDate?: () => Date };
    if (typedValue.toJSDate && typeof typedValue.toJSDate === "function") {
      return typedValue.toJSDate();
    }
    if (typeof value === "string") {
      return dayjs(value).toDate();
    }
    return null;
  }

  private filterEventsByQuery(
    events: CalendarEvent[],
    query?: string,
  ): CalendarEvent[] {
    if (!query) return events;

    const searchTerm = query.toLowerCase();

    return events.filter(
      event =>
        event.summary.toLowerCase().includes(searchTerm) ||
        event.description?.toLowerCase().includes(searchTerm) ||
        event.location?.toLowerCase().includes(searchTerm),
    );
  }

  private sortAndLimitEvents(
    events: CalendarEvent[],
    options: CalendarSearchOptions,
  ): CalendarEvent[] {
    const sorted = events.sort((a, b) => a.start.getTime() - b.start.getTime());

    if (options.offset || options.limit) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : undefined;
      return sorted.slice(start, end);
    }

    return sorted;
  }

  private calculateFreeBusy(
    events: CalendarEvent[],
    start: Date,
    end: Date,
  ): FreeBusyInfo {
    const busy: Array<{ start: Date; end: Date; summary?: string }> = [];

    for (const event of events) {
      // TRANSP:TRANSPARENT means the organiser explicitly marked the entry as
      // not blocking time (an all-day "Homeoffice" note, for instance). It used
      // to make the whole day look occupied.
      if (event.transparent) continue;

      if (event.start < end && event.end > start) {
        busy.push({
          start: new Date(Math.max(event.start.getTime(), start.getTime())),
          end: new Date(Math.min(event.end.getTime(), end.getTime())),
          summary: event.summary,
        });
      }
    }

    // Calculate free time slots
    const free: Array<{ start: Date; end: Date }> = [];
    busy.sort((a, b) => a.start.getTime() - b.start.getTime());

    let currentTime = start;
    for (const busySlot of busy) {
      if (currentTime < busySlot.start) {
        free.push({
          start: new Date(currentTime),
          end: new Date(busySlot.start),
        });
      }
      currentTime = new Date(
        Math.max(currentTime.getTime(), busySlot.end.getTime()),
      );
    }

    if (currentTime < end) {
      free.push({
        start: new Date(currentTime),
        end: new Date(end),
      });
    }

    return { start, end, busy, free };
  }

  // ---------------------------------------------------------------------
  // Writing
  //
  // tsdav reports a refusal by resolving with a fetch Response whose ok is
  // false, not by throwing. Every write below therefore inspects the response;
  // ignoring it is precisely how the read path came to report success for
  // operations that never happened.
  // ---------------------------------------------------------------------

  private async resolveCalendar(name?: string): Promise<DAVCalendar> {
    const client = await this.getClient();
    const calendars = await client.fetchCalendars();

    if (calendars.length === 0) {
      throw new CalendarError(
        "The account exposes no writable calendar",
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }

    if (!name) return calendars[0];

    const match = calendars.find(
      cal => (cal.displayName as string) === name || cal.url.includes(name),
    );
    if (!match) {
      const bekannt = calendars
        .map(cal => (cal.displayName as string) || cal.url)
        .join(", ");
      throw new CalendarError(
        `No calendar named '${name}'. Available: ${bekannt}`,
        ErrorCode.CALENDAR_NOT_FOUND,
        undefined,
        undefined,
        {
          details: {
            userMessage: `No calendar named '${name}'. Available: ${bekannt}`,
          },
        },
      );
    }
    return match;
  }

  /** Builds the iCalendar text via ical.js so values are escaped properly. */
  private buildICalendar(input: CalendarEventInput, uid: string): string {
    const calendar = new ICAL.Component(["vcalendar", [], []]);
    calendar.updatePropertyWithValue("version", "2.0");
    calendar.updatePropertyWithValue("prodid", "-//mailbox-mcp-server//EN");

    const vevent = new ICAL.Component("vevent");
    const event = new ICAL.Event(vevent);

    event.uid = uid;
    event.summary = input.summary;
    if (input.description) event.description = input.description;
    if (input.location) event.location = input.location;

    const start = ICAL.Time.fromJSDate(input.start, true);
    const end = ICAL.Time.fromJSDate(input.end, true);
    if (input.allDay) {
      start.isDate = true;
      end.isDate = true;
    }
    event.startDate = start;
    event.endDate = end;

    const now = ICAL.Time.fromJSDate(new Date(), true);
    vevent.updatePropertyWithValue("dtstamp", now);
    vevent.updatePropertyWithValue("created", now);
    vevent.updatePropertyWithValue("last-modified", now);

    if (input.transparent) {
      vevent.updatePropertyWithValue("transp", "TRANSPARENT");
    }
    if (input.categories?.length) {
      vevent.updatePropertyWithValue("categories", input.categories.join(","));
    }

    calendar.addSubcomponent(vevent);
    return calendar.toString();
  }

  private assertWriteAccepted(
    response: { ok?: boolean; status?: number; statusText?: string },
    operation: string,
  ): void {
    if (response?.ok) return;
    const detail = `${operation} was refused by the server (HTTP ${
      response?.status ?? "?"
    } ${response?.statusText ?? ""})`.trim();
    throw new CalendarError(
      detail,
      ErrorCode.OPERATION_FAILED,
      undefined,
      undefined,
      { details: { userMessage: detail } },
    );
  }

  /** Any write invalidates the cached reads; otherwise the change stays hidden. */
  private invalidateCalendarCache(): void {
    this.cache.clear();
  }

  async createEvent(
    input: CalendarEventInput,
    calendarName?: string,
  ): Promise<CalendarWriteResult> {
    if (input.end < input.start) {
      throw new ValidationError(
        "The event ends before it starts",
        "end",
        input.end,
      );
    }

    const client = await this.getClient();
    const calendar = await this.resolveCalendar(calendarName);
    const uid = `${randomUUID()}@mailbox-mcp-server`;
    const filename = `${uid}.ics`;

    const response = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: this.buildICalendar(input, uid),
    });
    this.assertWriteAccepted(response, "Creating the event");

    this.invalidateCalendarCache();

    const url = `${calendar.url.replace(/\/?$/, "/")}${filename}`;
    return {
      success: true,
      message: `Event '${input.summary}' created in '${
        (calendar.displayName as string) || calendar.url
      }'`,
      uid,
      url,
      etag: response.headers?.get?.("etag") ?? undefined,
    };
  }

  /**
   * Replaces the event at `url`.
   *
   * `etag` is optional but strongly recommended: passing the one that came with
   * the event turns the write into a conditional request, so a change made on
   * another device in the meantime causes a refusal instead of being silently
   * overwritten.
   */
  async updateEvent(
    url: string,
    input: CalendarEventInput,
    etag?: string,
  ): Promise<CalendarWriteResult> {
    if (input.end < input.start) {
      throw new ValidationError(
        "The event ends before it starts",
        "end",
        input.end,
      );
    }

    // Safety net against silently flattening a series. buildICalendar produces a
    // single VEVENT with no RRULE/EXDATE/overrides; writing that over a
    // recurring resource would replace the whole series with one event. Refuse
    // and make the caller name a scope. Costs one extra read on the single-event
    // path, which is worth closing a data-loss hole.
    const { data } = await this.fetchRawObject(url);
    const { master } = this.parseSeries(data);
    if (master && new ICAL.Event(master).isRecurring()) {
      const message =
        "This is a recurring series. Updating it as a single event would drop the recurrence. Pass applyToSeries: true to change every occurrence, or recurrenceId to change just one.";
      throw new CalendarError(
        message,
        ErrorCode.INVALID_INPUT,
        undefined,
        undefined,
        { details: { userMessage: message } },
      );
    }

    const client = await this.getClient();
    const uid = this.uidFromUrl(url);

    const response = await client.updateCalendarObject({
      calendarObject: {
        url,
        data: this.buildICalendar(input, uid),
        etag,
      },
    });

    if (response?.status === 412) {
      throw new CalendarError(
        "The event was changed elsewhere since it was read",
        ErrorCode.CALENDAR_EDIT_CONFLICT,
      );
    }
    this.assertWriteAccepted(response, "Updating the event");

    this.invalidateCalendarCache();

    return {
      success: true,
      message: `Event '${input.summary}' updated`,
      uid,
      url,
      etag: response.headers?.get?.("etag") ?? undefined,
    };
  }

  async deleteEvent(url: string, etag?: string): Promise<CalendarWriteResult> {
    const client = await this.getClient();

    const response = await client.deleteCalendarObject({
      calendarObject: { url, etag },
    });

    if (response?.status === 412) {
      throw new CalendarError(
        "The event was changed elsewhere since it was read",
        ErrorCode.CALENDAR_EDIT_CONFLICT,
        undefined,
        undefined,
        {
          details: {
            userMessage:
              "This event was changed elsewhere after you read it. Read it again before deleting.",
          },
        },
      );
    }
    this.assertWriteAccepted(response, "Deleting the event");

    this.invalidateCalendarCache();

    return { success: true, message: "Event deleted", url };
  }

  // ---------------------------------------------------------------------
  // Recurring series: change the whole series, or a single occurrence.
  //
  // These cannot rebuild the resource from a CalendarEventInput the way
  // create/update do — that would drop RRULE, EXDATE and any existing
  // per-occurrence overrides. They fetch the current iCalendar object, edit it
  // with ical.js and write the whole thing back, mirroring how the read path
  // already takes a series apart.
  // ---------------------------------------------------------------------

  /** Picks the calendar whose collection URL is a prefix of the event URL. */
  private async resolveCalendarForUrl(eventUrl: string): Promise<DAVCalendar> {
    const client = await this.getClient();
    const calendars = await client.fetchCalendars();
    const match = calendars.find(
      cal => eventUrl.startsWith(cal.url) || eventUrl.includes(cal.url),
    );
    if (!match) {
      throw new CalendarError(
        `No calendar owns the resource ${eventUrl}`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }
    return match;
  }

  /**
   * Reads the single iCalendar resource at `url`. Fails loudly if it is gone —
   * an empty result here would be indistinguishable from "the event has no
   * data", which is exactly the confusion the read path was cleaned up to avoid.
   */
  private async fetchRawObject(
    url: string,
  ): Promise<{ data: string; etag?: string }> {
    const client = await this.getClient();
    const calendar = await this.resolveCalendarForUrl(url);
    const objects = await client.fetchCalendarObjects({
      calendar,
      objectUrls: [url],
    });
    const obj = objects?.[0];
    if (!obj?.data) {
      throw new CalendarError(
        `The event at ${url} could not be found`,
        ErrorCode.EVENT_NOT_FOUND,
      );
    }
    return { data: obj.data, etag: obj.etag };
  }

  /** Splits a VCALENDAR into the series master and its per-occurrence overrides. */
  private parseSeries(data: string): {
    root: ICAL.Component;
    master: ICAL.Component | null;
    overrides: ICAL.Component[];
  } {
    const root = new ICAL.Component(ICAL.parse(data));
    const vevents = root.getAllSubcomponents("vevent") as ICAL.Component[];
    const overrides = vevents.filter(v =>
      v.getFirstPropertyValue("recurrence-id"),
    );
    const master =
      vevents.find(v => !v.getFirstPropertyValue("recurrence-id")) ?? null;
    return { root, master, overrides };
  }

  /**
   * The ical.js Time for the occurrence whose ORIGINAL slot matches `target`.
   * Compared as absolute instants so a zoned or all-day series still matches;
   * the returned Time carries the master's own type and zone, which is what a
   * RECURRENCE-ID or EXDATE has to serialise with.
   */
  private findOccurrenceTime(
    master: ICAL.Component,
    target: Date,
  ): ICAL.Time | null {
    const event = new ICAL.Event(master);
    if (!event.isRecurring()) return null;

    const iterator = event.iterator();
    const targetMs = target.getTime();
    let next = iterator.next();
    let guard = 0;

    while (next && guard < CalendarService.MAX_OCCURRENCES_PER_SERIES) {
      guard += 1;
      const ms = next.toJSDate().getTime();
      if (ms === targetMs) return next;
      if (ms > targetMs) break;
      next = iterator.next();
    }
    return null;
  }

  /** True when the override's RECURRENCE-ID names the same instant as `target`. */
  private overrideMatches(override: ICAL.Component, target: Date): boolean {
    const rid = override.getFirstPropertyValue("recurrence-id") as
      | ICAL.Time
      | undefined
      | null;
    return !!rid && rid.toJSDate().getTime() === target.getTime();
  }

  /**
   * Writes event fields onto an existing VEVENT. Timing (DTSTART/DTEND) is
   * optional because a whole-series edit must not move the master's anchor — the
   * value a caller has is an occurrence start, not the series start, and writing
   * it onto the master would shift and re-slot the entire series.
   */
  private applyBodyToComponent(
    vevent: ICAL.Component,
    input: CalendarEventInput,
    includeTiming: boolean,
  ): void {
    vevent.updatePropertyWithValue("summary", input.summary);

    vevent.removeAllProperties("description");
    if (input.description) {
      vevent.updatePropertyWithValue("description", input.description);
    }

    vevent.removeAllProperties("location");
    if (input.location) {
      vevent.updatePropertyWithValue("location", input.location);
    }

    vevent.removeAllProperties("transp");
    if (input.transparent) {
      vevent.updatePropertyWithValue("transp", "TRANSPARENT");
    }

    vevent.removeAllProperties("categories");
    if (input.categories?.length) {
      vevent.updatePropertyWithValue("categories", input.categories.join(","));
    }

    if (includeTiming) {
      const event = new ICAL.Event(vevent);
      const start = ICAL.Time.fromJSDate(input.start, true);
      const end = ICAL.Time.fromJSDate(input.end, true);
      if (input.allDay) {
        start.isDate = true;
        end.isDate = true;
      }
      event.startDate = start;
      event.endDate = end;
    }

    const now = ICAL.Time.fromJSDate(new Date(), true);
    vevent.updatePropertyWithValue("last-modified", now);
    vevent.updatePropertyWithValue("dtstamp", now);
  }

  /** Sets the TZID parameter on a time property when the time is zoned. */
  private tagZone(property: ICAL.Property, time: ICAL.Time): void {
    const zone = time.zone;
    if (
      zone &&
      zone !== ICAL.Timezone.utcTimezone &&
      zone !== ICAL.Timezone.localTimezone &&
      zone.tzid
    ) {
      property.setParameter("tzid", zone.tzid);
    }
  }

  /**
   * Writes the modified VCALENDAR back to `url`, conditional on `etag`. A 412
   * means the resource changed since it was read; the change is refused rather
   * than clobbering the newer version.
   */
  private async writeBack(
    url: string,
    data: string,
    etag: string | undefined,
    operation: string,
  ): Promise<void> {
    const client = await this.getClient();
    const response = await client.updateCalendarObject({
      calendarObject: { url, data, etag },
    });

    if (response?.status === 412) {
      throw new CalendarError(
        "The event was changed elsewhere since it was read",
        ErrorCode.CALENDAR_EDIT_CONFLICT,
        undefined,
        undefined,
        {
          details: {
            userMessage:
              "This event was changed elsewhere after you read it. Read it again before changing it.",
          },
        },
      );
    }
    this.assertWriteAccepted(response, operation);
    this.invalidateCalendarCache();
  }

  private seriesUid(master: ICAL.Component, url: string): string {
    return (
      (master.getFirstPropertyValue("uid") as string) || this.uidFromUrl(url)
    );
  }

  private ensureRecurring(
    master: ICAL.Component | null,
    url: string,
  ): ICAL.Component {
    if (!master) {
      throw new CalendarError(
        `The resource ${url} holds no series master`,
        ErrorCode.EVENT_NOT_FOUND,
      );
    }
    if (!new ICAL.Event(master).isRecurring()) {
      const message =
        "This event is not a recurring series. Use update_event / delete_event without a recurrence scope.";
      throw new CalendarError(
        message,
        ErrorCode.INVALID_INPUT,
        undefined,
        undefined,
        { details: { userMessage: message } },
      );
    }
    return master;
  }

  /**
   * Changes fields on every occurrence of a series while leaving its schedule
   * intact. Timing is deliberately NOT changed here (see applyBodyToComponent):
   * moving a series in time is a separate, rarer operation.
   */
  async updateSeries(
    url: string,
    input: CalendarEventInput,
    etag?: string,
  ): Promise<CalendarWriteResult> {
    const { data, etag: currentEtag } = await this.fetchRawObject(url);
    const { root, master } = this.parseSeries(data);
    const series = this.ensureRecurring(master, url);

    this.applyBodyToComponent(series, input, false);

    await this.writeBack(
      url,
      root.toString(),
      etag ?? currentEtag,
      "Updating the series",
    );

    return {
      success: true,
      message: `Series '${input.summary}' updated across all occurrences (schedule unchanged)`,
      uid: this.seriesUid(series, url),
      url,
    };
  }

  /**
   * Changes a single occurrence of a series by writing (or updating) a
   * RECURRENCE-ID override VEVENT. `recurrenceId` is the occurrence's original
   * slot (the value get_calendar_events reports), matched by instant.
   */
  async updateOccurrence(
    url: string,
    recurrenceId: string,
    input: CalendarEventInput,
    etag?: string,
  ): Promise<CalendarWriteResult> {
    if (input.end < input.start) {
      throw new ValidationError(
        "The event ends before it starts",
        "end",
        input.end,
      );
    }
    const target = new Date(recurrenceId);
    if (Number.isNaN(target.getTime())) {
      throw new ValidationError(
        "recurrenceId is not a valid date",
        "recurrenceId",
        recurrenceId,
      );
    }

    const { data, etag: currentEtag } = await this.fetchRawObject(url);
    const { root, master, overrides } = this.parseSeries(data);
    const series = this.ensureRecurring(master, url);

    const occTime = this.findOccurrenceTime(series, target);
    if (!occTime) {
      const message = `No occurrence of this series starts at ${recurrenceId}`;
      throw new CalendarError(
        message,
        ErrorCode.EVENT_NOT_FOUND,
        undefined,
        undefined,
        { details: { userMessage: message } },
      );
    }

    let override = overrides.find(o => this.overrideMatches(o, target));
    if (!override) {
      override = new ICAL.Component("vevent");
      override.updatePropertyWithValue("uid", this.seriesUid(series, url));
      const recProp = override.updatePropertyWithValue(
        "recurrence-id",
        occTime,
      );
      this.tagZone(recProp, occTime);
      override.updatePropertyWithValue(
        "created",
        ICAL.Time.fromJSDate(new Date(), true),
      );
      root.addSubcomponent(override);
    }

    this.applyBodyToComponent(override, input, true);

    await this.writeBack(
      url,
      root.toString(),
      etag ?? currentEtag,
      "Updating the occurrence",
    );

    return {
      success: true,
      message: `Occurrence on ${recurrenceId} updated`,
      uid: this.seriesUid(series, url),
      url,
    };
  }

  /**
   * Cancels a single occurrence of a series: adds an EXDATE for its original
   * slot and drops any override that used to move it.
   */
  async cancelOccurrence(
    url: string,
    recurrenceId: string,
    etag?: string,
  ): Promise<CalendarWriteResult> {
    const target = new Date(recurrenceId);
    if (Number.isNaN(target.getTime())) {
      throw new ValidationError(
        "recurrenceId is not a valid date",
        "recurrenceId",
        recurrenceId,
      );
    }

    const { data, etag: currentEtag } = await this.fetchRawObject(url);
    const { root, master, overrides } = this.parseSeries(data);
    const series = this.ensureRecurring(master, url);

    const occTime = this.findOccurrenceTime(series, target);
    if (!occTime) {
      const message = `No occurrence of this series starts at ${recurrenceId}`;
      throw new CalendarError(
        message,
        ErrorCode.EVENT_NOT_FOUND,
        undefined,
        undefined,
        { details: { userMessage: message } },
      );
    }

    const exProp = series.addPropertyWithValue("exdate", occTime);
    this.tagZone(exProp, occTime);

    for (const override of overrides) {
      if (this.overrideMatches(override, target)) {
        root.removeSubcomponent(override);
      }
    }

    await this.writeBack(
      url,
      root.toString(),
      etag ?? currentEtag,
      "Cancelling the occurrence",
    );

    return {
      success: true,
      message: `Occurrence on ${recurrenceId} cancelled`,
      uid: this.seriesUid(series, url),
      url,
    };
  }

  private uidFromUrl(url: string): string {
    const last = url.split("/").pop() ?? "";
    return decodeURIComponent(last.replace(/\.ics$/i, "")) || randomUUID();
  }

  // Get circuit breaker metrics
  getCircuitBreakerMetrics(): CircuitBreakerMetrics {
    return this.circuitBreaker.getMetrics();
  }

  // Reset circuit breaker (for administrative purposes)
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  // Clean up resources
  async disconnect(): Promise<void> {
    this.client = null;
    this.circuitBreaker.reset();
  }
}
