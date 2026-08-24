import { type Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type SieveCapabilities,
  type SieveConnection,
  SieveError,
  type SieveScript,
  type SieveTransport,
} from "../types/sieve.types.js";
import { createLogger } from "./Logger.js";

/**
 * ManageSieve (RFC 5804) client.
 *
 * The response reader (findResponseEnd / extractScriptContent / parseListScripts)
 * and the STARTTLS-upgrade transport are ported from Rheopyrin/ox-mcp
 * (src/mail/sieve-transport.ts, MIT licence) and adapted here:
 *   - literal accounting is byte-accurate on a Buffer, not a UTF-16 string, so a
 *     script that contains umlauts round-trips exactly (the string version slices
 *     the wrong number of code units);
 *   - the service keeps this project's interface, error type and CHECKSCRIPT /
 *     DELETESCRIPT / CAPABILITY handling.
 *
 * The transport is injectable so tests drive full command/response cycles
 * against a fake session instead of the production host.
 */

const CRLF = Buffer.from("\r\n");

/**
 * Index just past the terminating OK/NO/BYE line, honouring `{n}` / `{n+}`
 * literals so a literal body is never mistaken for the terminator. Returns -1
 * while the response is still incomplete. Byte-accurate: the literal skip counts
 * octets, and structural tokens are read as latin1 (1 byte = 1 char) so multibyte
 * payload bytes cannot false-match a protocol token.
 */
export function findResponseEnd(buffer: Buffer): number {
  let pos = 0;
  while (pos < buffer.length) {
    const nl = buffer.indexOf(CRLF, pos);
    if (nl === -1) return -1;
    const line = buffer.toString("latin1", pos, nl);
    const literal = line.match(/\{(\d+)\+?\}$/);
    if (literal) {
      pos = nl + 2 + Number(literal[1]); // skip CRLF + n OCTETS
      continue;
    }
    if (/^(OK|NO|BYE)\b/.test(line)) return nl + 2;
    pos = nl + 2;
  }
  return -1;
}

/**
 * The script body from a GETSCRIPT response's `{n}` literal, decoded as exactly
 * n octets of UTF-8. Returns undefined when the response carries no literal.
 */
export function extractScriptContent(res: Buffer): string | undefined {
  // The literal header {n}\r\n is ASCII, so its latin1 string offset equals its
  // byte offset; the payload after it is decoded byte-accurately as UTF-8.
  const header = res.toString("latin1").match(/\{(\d+)\+?\}\r\n/);
  if (!header) return undefined;
  const start = (header.index ?? 0) + header[0].length;
  const length = Number(header[1]);
  return res.toString("utf8", start, start + length);
}

/** Parse a LISTSCRIPTS response into script names and their active flag. */
export function parseListScripts(res: string): SieveScript[] {
  const scripts: SieveScript[] = [];
  for (const line of res.split(/\r?\n/)) {
    const m = line.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?\s*$/i);
    if (m) {
      scripts.push({
        name: m[1].replace(/\\(.)/g, "$1"),
        content: "",
        active: Boolean(m[2]),
      });
    }
  }
  return scripts;
}

/** Quote and escape a script name for a ManageSieve command. */
function quoteName(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Real TCP transport: plaintext connect (or implicit TLS), in-band STARTTLS
 * upgrade, literal-aware framing. Network I/O only — no protocol logic.
 */
export class TcpSieveTransport implements SieveTransport {
  private socket?: Socket | TLSSocket;
  private buffer = Buffer.alloc(0);
  private pending?: {
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  };
  private secure: boolean;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly initialSecure: boolean,
    private readonly timeoutMs = 15000,
  ) {
    this.secure = initialSecure;
  }

  connect(): Promise<void> {
    if (this.initialSecure) {
      const socket = tlsConnect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: true,
      });
      this.attach(socket);
      return this.waitReady(socket, "secureConnect");
    }
    const socket = netConnect({ host: this.host, port: this.port });
    this.attach(socket);
    return this.waitReady(socket, "connect");
  }

  isSecure(): boolean {
    return this.secure;
  }

  startTls(): Promise<void> {
    const plain = this.socket as Socket;
    const socket = tlsConnect({
      socket: plain,
      servername: this.host,
      rejectUnauthorized: true,
    });
    this.attach(socket);
    this.secure = true;
    return this.waitReady(socket, "secureConnect");
  }

  write(data: Buffer): void {
    if (!this.socket) throw new SieveError("ManageSieve: not connected");
    this.socket.write(data);
  }

  readResponse(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.tryResolve();
    });
  }

  close(): void {
    try {
      this.socket?.write(Buffer.from("LOGOUT\r\n"));
    } catch {
      // Server may already have closed the connection.
    }
    this.socket?.destroy();
    this.socket = undefined;
    if (this.pending) {
      this.pending.reject(new SieveError("Connection closed"));
      this.pending = undefined;
    }
  }

  // Every handler is bound to its own socket and no-ops once we have moved on
  // (STARTTLS wraps the plain socket in the TLS socket, so its listeners must NOT
  // be stripped). The buffer is reset so no pre-TLS bytes leak into the secure
  // stream — this is what the old code's double `data` handler got wrong.
  private attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setTimeout(this.timeoutMs, () => {
      if (socket === this.socket) this.fail(new SieveError("ManageSieve timeout"));
    });
    socket.on("data", (chunk: Buffer) => {
      if (socket !== this.socket) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.tryResolve();
    });
    socket.on("error", (err: Error) => {
      if (socket === this.socket) this.fail(new SieveError(err.message));
    });
  }

  private waitReady(
    socket: Socket | TLSSocket,
    event: "connect" | "secureConnect",
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once(event, () => resolve());
      socket.once("error", reject);
    });
  }

  private tryResolve(): void {
    if (!this.pending) return;
    const end = findResponseEnd(this.buffer);
    if (end === -1) return;
    const response = Buffer.from(this.buffer.subarray(0, end));
    this.buffer = this.buffer.subarray(end);
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(response);
  }

  private fail(err: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(err);
    this.socket?.destroy();
    this.socket = undefined;
  }
}

type TransportFactory = (config: SieveConnection) => SieveTransport;

const defaultTransportFactory: TransportFactory = config =>
  new TcpSieveTransport(config.host, config.port, config.secure);

export class SieveService {
  private transport: SieveTransport | null = null;
  private connected = false;
  private authenticated = false;
  private capabilities: SieveCapabilities | null = null;
  private logger = createLogger("SieveService");

  constructor(
    private config: SieveConnection,
    private transportFactory: TransportFactory = defaultTransportFactory,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    this.transport = this.transportFactory(this.config);
    await this.transport.connect();
    // The server sends its capabilities followed by OK as the greeting.
    const greeting = await this.transport.readResponse();
    this.capabilities = this.parseCapabilities(greeting.toString("utf8"));
    this.connected = true;

    this.logger.info("Connected to ManageSieve server", {
      operation: "connect",
      service: "SieveService",
    });
  }

  async authenticate(): Promise<void> {
    if (!this.connected || !this.transport) {
      throw new SieveError("Not connected to server");
    }
    if (this.authenticated) return;

    // Upgrade to TLS before sending credentials, unless the channel is already
    // encrypted. The server re-sends its capabilities after the upgrade.
    if (
      !this.transport.isSecure() &&
      this.capabilities?.sieveExtensions.includes("STARTTLS")
    ) {
      const tlsResponse = await this.send("STARTTLS");
      this.assertOk(tlsResponse, "STARTTLS");
      await this.transport.startTls();
      const postTls = await this.transport.readResponse();
      this.capabilities = this.parseCapabilities(postTls.toString("utf8"));
    }

    if (!this.transport.isSecure()) {
      // Never put a password on a plaintext socket.
      throw new SieveError(
        "Refusing to authenticate: the connection is not encrypted (no STARTTLS)",
      );
    }

    const token = Buffer.from(
      `\0${this.config.user}\0${this.config.password}`,
    ).toString("base64");
    const response = await this.send(`AUTHENTICATE "PLAIN" "${token}"`);
    this.assertOk(response, "Authentication");

    this.authenticated = true;
    this.logger.info("Authenticated with ManageSieve server", {
      operation: "authenticate",
      service: "SieveService",
    });
  }

  async disconnect(): Promise<void> {
    try {
      this.transport?.close();
    } finally {
      this.transport = null;
      this.connected = false;
      this.authenticated = false;
      this.capabilities = null;
    }
  }

  async listScripts(): Promise<SieveScript[]> {
    await this.ensureAuthenticated();
    const response = await this.send("LISTSCRIPTS");
    this.assertOk(response, "Failed to list scripts");
    return parseListScripts(response.toString("utf8"));
  }

  async getScript(name: string): Promise<string> {
    await this.ensureAuthenticated();
    const response = await this.send(`GETSCRIPT ${quoteName(name)}`);
    this.assertOk(response, `Failed to get script '${name}'`);
    const content = extractScriptContent(response);
    if (content === undefined) {
      throw new SieveError(
        `GETSCRIPT for '${name}' returned no script literal`,
      );
    }
    return content;
  }

  async putScript(name: string, content: string): Promise<void> {
    await this.ensureAuthenticated();
    const response = await this.sendLiteral(
      `PUTSCRIPT ${quoteName(name)} `,
      content,
    );
    this.assertOk(response, `Failed to put script '${name}'`);
  }

  async deleteScript(name: string): Promise<void> {
    await this.ensureAuthenticated();
    const response = await this.send(`DELETESCRIPT ${quoteName(name)}`);
    this.assertOk(response, `Failed to delete script '${name}'`);
  }

  async setActiveScript(name: string): Promise<void> {
    await this.ensureAuthenticated();
    const response = await this.send(`SETACTIVE ${quoteName(name)}`);
    this.assertOk(response, `Failed to activate script '${name}'`);
  }

  async checkScript(content: string): Promise<void> {
    await this.ensureAuthenticated();
    const response = await this.sendLiteral("CHECKSCRIPT ", content);
    this.assertOk(response, "Script validation failed");
  }

  getServerCapabilities(): SieveCapabilities | null {
    return this.capabilities;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  // --- internals -------------------------------------------------------

  private async ensureAuthenticated(): Promise<void> {
    if (!this.connected) await this.connect();
    if (!this.authenticated) await this.authenticate();
  }

  /** Send a plain command line and read its full response. */
  private async send(command: string): Promise<Buffer> {
    if (!this.transport) throw new SieveError("Not connected to server");
    this.transport.write(Buffer.from(`${command}\r\n`, "utf8"));
    return this.transport.readResponse();
  }

  /**
   * Send a command whose argument is a non-synchronising literal `{n+}`, with a
   * byte-accurate octet count and the body as raw UTF-8 bytes.
   */
  private async sendLiteral(prefix: string, content: string): Promise<Buffer> {
    if (!this.transport) throw new SieveError("Not connected to server");
    const body = Buffer.from(content, "utf8");
    const head = Buffer.from(`${prefix}{${body.length}+}\r\n`, "utf8");
    this.transport.write(Buffer.concat([head, body, CRLF]));
    return this.transport.readResponse();
  }

  /** Throw when the response terminates with NO or BYE. */
  private assertOk(response: Buffer, action: string): void {
    const lines = response
      .toString("utf8")
      .split("\r\n")
      .filter(line => line.length > 0);
    const last = lines[lines.length - 1] ?? "";
    const code = last.slice(0, 3).trim().toUpperCase();
    if (code === "NO" || code === "BYE") {
      throw new SieveError(`${action}: ${last}`, code);
    }
  }

  private parseCapabilities(data: string): SieveCapabilities {
    const capabilities: SieveCapabilities = {
      implementation: "",
      version: "",
      saslMechanisms: [],
      sieveExtensions: [],
    };

    for (const rawLine of data.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^(OK|NO|BYE)\b/.test(line)) continue;

      // Lines are `"KEY" "value"` or, for STARTTLS, a bare `"STARTTLS"`.
      const keyValue = line.match(/^"([A-Za-z0-9-]+)"(?:\s+"([^"]*)")?/);
      if (!keyValue) continue;
      const key = keyValue[1].toUpperCase();
      const value = keyValue[2] ?? "";

      switch (key) {
        case "IMPLEMENTATION":
          capabilities.implementation = value;
          break;
        case "VERSION":
          capabilities.version = value;
          break;
        case "SASL":
          capabilities.saslMechanisms = value ? value.split(" ") : [];
          break;
        case "SIEVE":
          capabilities.sieveExtensions.push(
            ...(value ? value.split(" ") : []),
          );
          break;
        case "STARTTLS":
          capabilities.sieveExtensions.push("STARTTLS");
          break;
        default:
          break;
      }
    }

    return capabilities;
  }
}
