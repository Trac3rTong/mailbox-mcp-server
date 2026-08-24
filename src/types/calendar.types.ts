// Shared types for calendar functionality
export interface Attendee {
  email: string;
  name?: string;
  status: "needs-action" | "accepted" | "declined" | "tentative";
}

export interface CalendarEvent {
  /**
   * Identifies THIS occurrence. For a recurring series every occurrence shares
   * the uid, so the id carries the occurrence start as well. Using the bare uid
   * gave every occurrence of a weekly meeting the same id.
   */
  id: string;
  /** Identifies the SERIES. Not unique across occurrences. */
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  recurrenceRule?: string;
  /**
   * Set on an occurrence produced by expanding a recurrence rule: the
   * occurrence's ORIGINAL slot as a UTC ISO instant. Pass it back to
   * update_event/delete_event to target exactly this occurrence. For a moved
   * occurrence it stays the original slot, not the shifted start.
   */
  recurrenceId?: string;
  /** True when this occurrence overrides the series (its own VEVENT). */
  isException?: boolean;
  /** TRANSP:TRANSPARENT — the organiser marked this as not blocking time. */
  transparent?: boolean;
  attendees?: Attendee[];
  organizer?: {
    email: string;
    name?: string;
  };
  calendar: string;
  /**
   * URL of the CalDAV resource holding this event. Required to modify or delete
   * it later; the read path used to drop it.
   */
  url?: string;
  /**
   * ETag of that resource. Sending it back with a change is what stops an edit
   * from silently overwriting a change made elsewhere in the meantime.
   */
  etag?: string;
  categories?: string[];
  created: Date;
  modified: Date;
}

/** Fields accepted when creating or changing an event. */
export interface CalendarEventInput {
  summary: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  description?: string;
  location?: string;
  /** Marks the entry as not blocking time (TRANSP:TRANSPARENT). */
  transparent?: boolean;
  categories?: string[];
}

/** What a write returned, including the identity needed for the next change. */
export interface CalendarWriteResult {
  success: boolean;
  message: string;
  uid?: string;
  url?: string;
  etag?: string;
}

export interface CalendarSearchOptions {
  query?: string;
  start?: Date;
  end?: Date;
  calendar?: string;
  limit?: number;
  offset?: number;
}

export interface FreeBusyInfo {
  start: Date;
  end: Date;
  busy: Array<{
    start: Date;
    end: Date;
    summary?: string;
  }>;
  free: Array<{
    start: Date;
    end: Date;
  }>;
}

export interface CalDavConnection {
  baseUrl: string;
  username: string;
  password: string;
  calendars?: string[];
}
