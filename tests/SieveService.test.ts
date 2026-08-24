import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SieveService,
  extractScriptContent,
  findResponseEnd,
  parseListScripts,
} from "../src/services/SieveService.js";
import type {
  SieveConnection,
  SieveTransport,
} from "../src/types/sieve.types.js";

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  })),
}));

const config: SieveConnection = {
  host: "127.0.0.1",
  port: 4190,
  secure: false,
  user: "test@mailbox.org",
  password: "pw",
};

const b = (s: string) => Buffer.from(s, "utf8");

/**
 * Scripted ManageSieve session. Returns queued response buffers in order and
 * records exactly what the service wrote — so tests drive full command cycles
 * without a socket.
 */
class FakeTransport implements SieveTransport {
  writes: Buffer[] = [];
  private queue: Buffer[];
  private secureFlag: boolean;

  constructor(responses: Buffer[], startSecure = false) {
    this.queue = [...responses];
    this.secureFlag = startSecure;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }
  isSecure(): boolean {
    return this.secureFlag;
  }
  startTls(): Promise<void> {
    this.secureFlag = true;
    return Promise.resolve();
  }
  write(data: Buffer): void {
    this.writes.push(data);
  }
  readResponse(): Promise<Buffer> {
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error("no scripted response left"));
    return Promise.resolve(next);
  }
  close(): void {}

  writtenText(): string {
    return Buffer.concat(this.writes).toString("utf8");
  }
}

const GREETING_WITH_TLS = b(
  '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\n"SIEVE" "fileinto envelope"\r\n"STARTTLS"\r\nOK "ready"\r\n',
);
const STARTTLS_OK = b('OK "Begin TLS negotiation"\r\n');
const POST_TLS_CAPS = b(
  '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\n"SIEVE" "fileinto"\r\nOK\r\n',
);
const AUTH_OK = b('OK "Logged in."\r\n');

/** The four responses consumed by connect()+authenticate() over STARTTLS. */
const handshake = () => [GREETING_WITH_TLS, STARTTLS_OK, POST_TLS_CAPS, AUTH_OK];

describe("findResponseEnd (byte-accurate)", () => {
  it("returns -1 until a terminator arrives", () => {
    expect(findResponseEnd(b(""))).toBe(-1);
    expect(findResponseEnd(b("OK no crlf yet"))).toBe(-1);
    expect(findResponseEnd(b("{50}\r\nonly a few bytes"))).toBe(-1);
  });

  it("terminates on OK/NO/BYE past the whole line", () => {
    expect(findResponseEnd(b("OK\r\n"))).toBe(4);
    expect(findResponseEnd(b("NO err\r\n"))).toBe(8);
  });

  it("does not treat a literal body as a terminator", () => {
    const body = "NO everywhere\r\n";
    const buf = b(`{${Buffer.byteLength(body)}}\r\n${body}OK\r\n`);
    expect(findResponseEnd(buf)).toBe(buf.length);
  });

  it("counts literal length in OCTETS, not UTF-16 units", () => {
    // "grüße" is 5 code units but 7 UTF-8 octets. A char-based skip would land
    // mid-response and mis-detect the terminator.
    const body = "grüße\r\n";
    const octets = Buffer.byteLength(body, "utf8");
    const buf = b(`{${octets}}\r\n${body}OK\r\n`);
    expect(findResponseEnd(buf)).toBe(buf.length);
  });

  it("leaves the next response untouched", () => {
    const first = "OK one\r\n";
    expect(findResponseEnd(b(`${first}leftover`))).toBe(first.length);
  });
});

describe("extractScriptContent (byte-accurate)", () => {
  it("extracts exactly n octets, umlauts intact", () => {
    const body = 'require ["fileinto"];\r\n# Spätzle & Grüße\r\nfileinto "Müll";\r\n';
    const octets = Buffer.byteLength(body, "utf8");
    const res = b(`{${octets}}\r\n${body}\r\nOK\r\n`);
    expect(extractScriptContent(res)).toBe(body);
  });

  it("handles a body that itself contains an OK line", () => {
    const body = "# OK this looks like a terminator\r\nkeep;\r\n";
    const octets = Buffer.byteLength(body, "utf8");
    const res = b(`{${octets}}\r\n${body}\r\nOK\r\n`);
    expect(extractScriptContent(res)).toBe(body);
  });

  it("returns undefined without a literal", () => {
    expect(extractScriptContent(b('OK "empty"\r\n'))).toBeUndefined();
  });
});

describe("parseListScripts", () => {
  it("parses names and the ACTIVE flag", () => {
    const res = '"Open-Xchange" ACTIVE\r\n"claude-filter"\r\nOK\r\n';
    expect(parseListScripts(res)).toEqual([
      { name: "Open-Xchange", content: "", active: true },
      { name: "claude-filter", content: "", active: false },
    ]);
  });

  it("returns an empty list when there are none", () => {
    expect(parseListScripts('OK "no scripts"\r\n')).toEqual([]);
  });
});

describe("SieveService handshake + TLS gate", () => {
  it("upgrades via STARTTLS before authenticating", async () => {
    const t = new FakeTransport([
      ...handshake(),
      b('"Open-Xchange" ACTIVE\r\nOK\r\n'),
    ]);
    const service = new SieveService(config, () => t);

    const scripts = await service.listScripts();

    expect(scripts).toEqual([
      { name: "Open-Xchange", content: "", active: true },
    ]);
    const text = t.writtenText();
    expect(text).toContain("STARTTLS\r\n");
    expect(text.indexOf("STARTTLS")).toBeLessThan(text.indexOf("AUTHENTICATE"));
    expect(text).toContain('AUTHENTICATE "PLAIN"');
  });

  it("refuses to authenticate when the channel cannot be encrypted", async () => {
    // Greeting without STARTTLS, transport stays insecure.
    const t = new FakeTransport([
      b('"IMPLEMENTATION" "Dovecot"\r\n"SIEVE" "fileinto"\r\nOK\r\n'),
    ]);
    const service = new SieveService(config, () => t);

    await expect(service.listScripts()).rejects.toThrow(/not encrypted/i);
    expect(t.writtenText()).not.toContain("AUTHENTICATE");
  });

  it("skips STARTTLS when the channel is already secure", async () => {
    const t = new FakeTransport(
      [b('"IMPLEMENTATION" "Dovecot"\r\n"SIEVE" "fileinto"\r\nOK\r\n'), AUTH_OK, b("OK\r\n")],
      true, // implicit TLS
    );
    const service = new SieveService({ ...config, secure: true }, () => t);

    await service.listScripts();
    expect(t.writtenText()).not.toContain("STARTTLS");
    expect(t.writtenText()).toContain("AUTHENTICATE");
  });
});

describe("SieveService script operations", () => {
  it("getScript returns the literal body byte-for-byte", async () => {
    const body = 'require ["fileinto"];\r\nfileinto "Grüße";\r\n';
    const octets = Buffer.byteLength(body, "utf8");
    const t = new FakeTransport([
      ...handshake(),
      b(`{${octets}}\r\n${body}\r\nOK\r\n`),
    ]);
    const service = new SieveService(config, () => t);

    expect(await service.getScript("Open-Xchange")).toBe(body);
  });

  it("getScript throws on a NO response", async () => {
    const t = new FakeTransport([
      ...handshake(),
      b('NO "script does not exist"\r\n'),
    ]);
    const service = new SieveService(config, () => t);

    await expect(service.getScript("missing")).rejects.toThrow(/get script/i);
  });

  it("putScript sends a non-synchronising literal with the OCTET length", async () => {
    const content = 'require ["fileinto"];\r\nfileinto "Müll";\r\n'; // has umlaut
    const octets = Buffer.byteLength(content, "utf8");
    const t = new FakeTransport([...handshake(), b('OK "putscript"\r\n')]);
    const service = new SieveService(config, () => t);

    await service.putScript("test", content);

    const text = t.writtenText();
    expect(text).toContain(`PUTSCRIPT "test" {${octets}+}\r\n`);
    expect(text).toContain(content);
    // The octet count must exceed the JS string length for umlaut content.
    expect(octets).toBeGreaterThan(content.length);
  });

  it("checkScript sends CHECKSCRIPT with an octet literal", async () => {
    const content = "keep;\r\n";
    const octets = Buffer.byteLength(content, "utf8");
    const t = new FakeTransport([...handshake(), b("OK\r\n")]);
    const service = new SieveService(config, () => t);

    await service.checkScript(content);
    expect(t.writtenText()).toContain(`CHECKSCRIPT {${octets}+}\r\n`);
  });

  it("setActiveScript reports a NO as an error", async () => {
    const t = new FakeTransport([...handshake(), b('NO "no such script"\r\n')]);
    const service = new SieveService(config, () => t);

    await expect(service.setActiveScript("nope")).rejects.toThrow(/activate/i);
  });

  it("parses capabilities from the greeting", async () => {
    const t = new FakeTransport(handshake());
    const service = new SieveService(config, () => t);
    await service.connect();
    await service.authenticate();

    const caps = service.getServerCapabilities();
    expect(caps?.implementation).toBe("Dovecot Pigeonhole");
    expect(caps?.sieveExtensions).toContain("fileinto");
  });
});
