import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  classifyTransportError,
  ConfigurationError,
  ConnectionError,
  ErrorCode,
  MailboxError,
  MCPError,
} from "../src/types/errors.js";

/**
 * classifyTransportError decides, for every transport failure, whether it may be
 * softened into cached or default data downstream. Only ConnectionError may be.
 *
 * The rule it replaces was a substring match on the error message. Because
 * ConnectionPool wrapped every cause in "Failed to create connection after N
 * attempts: …", that match succeeded for wrong passwords and rejected
 * certificates too, and the cache fallback answered them with an empty result.
 */
describe("classifyTransportError", () => {
  const withCode = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  it("passes an already-typed MCPError through unchanged", () => {
    const original = new AuthenticationError(
      "nope",
      ErrorCode.AUTH_INVALID_CREDENTIALS,
    );
    expect(classifyTransportError(original)).toBe(original);
  });

  describe("network failures become ConnectionError", () => {
    it.each([
      ["ECONNREFUSED", ErrorCode.CONNECTION_REFUSED],
      ["ETIMEDOUT", ErrorCode.CONNECTION_TIMEOUT],
      ["ENOTFOUND", ErrorCode.CONNECTION_FAILED],
      ["ECONNRESET", ErrorCode.CONNECTION_FAILED],
      ["EHOSTUNREACH", ErrorCode.CONNECTION_FAILED],
    ])("%s", (code, expectedCode) => {
      const result = classifyTransportError(withCode("boom", code));
      expect(result).toBeInstanceOf(ConnectionError);
      expect(result.code).toBe(expectedCode);
    });
  });

  describe("authentication failures must NOT be softened", () => {
    it.each(["AUTHENTICATIONFAILED", "EAUTH", "PRIVACYREQUIRED"])(
      "%s becomes AuthenticationError",
      code => {
        const result = classifyTransportError(withCode("denied", code));
        expect(result).toBeInstanceOf(AuthenticationError);
        expect(result).not.toBeInstanceOf(ConnectionError);
      },
    );

    it("recognises imapflow's authenticationFailed boolean", () => {
      const error = Object.assign(new Error("Invalid credentials"), {
        authenticationFailed: true,
      });
      expect(classifyTransportError(error)).toBeInstanceOf(AuthenticationError);
    });

    it("is not retryable, so the pool stops instead of producing more failed logins", () => {
      // mailbox.org runs fail2ban; retrying a rejected password three times per
      // call is what gets an IP blocked.
      expect(
        classifyTransportError(withCode("denied", "EAUTH")).isRetryable,
      ).toBe(false);
    });
  });

  describe("TLS failures must NOT be softened", () => {
    it.each([
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ])("%s becomes a loud ConfigurationError", code => {
      const result = classifyTransportError(withCode("bad cert", code));
      expect(result).toBeInstanceOf(ConfigurationError);
      expect(result).not.toBeInstanceOf(ConnectionError);
      expect(result.isRetryable).toBe(false);
    });
  });

  it("follows error.cause, because Node's fetch hides the real code there", () => {
    // tsdav uses fetch for CalDAV: the outer error is "TypeError: fetch failed"
    // with no code of its own.
    const outer = Object.assign(new TypeError("fetch failed"), {
      cause: withCode("connect ECONNREFUSED 127.0.0.1:9", "ECONNREFUSED"),
    });
    expect(classifyTransportError(outer)).toBeInstanceOf(ConnectionError);
  });

  it("does not loop forever on a self-referential cause", () => {
    const looped: Error & { cause?: unknown } = new Error("round and round");
    looped.cause = looped;
    expect(() => classifyTransportError(looped)).not.toThrow();
  });

  describe("the regression this function exists to prevent", () => {
    it("does not treat a message merely containing 'connection' as a connection error", () => {
      const result = classifyTransportError(
        new Error(
          "Failed to create connection after 3 attempts: Invalid credentials",
        ),
      );
      expect(result).not.toBeInstanceOf(ConnectionError);
      expect(result).toBeInstanceOf(MailboxError);
    });

    it.each(["timeout", "socket hang up", "network is unreachable"])(
      "does not classify %s by wording alone",
      message => {
        expect(classifyTransportError(new Error(message))).not.toBeInstanceOf(
          ConnectionError,
        );
      },
    );
  });

  it("wraps an unclassifiable failure so it still reaches the caller", () => {
    const result = classifyTransportError("just a string");
    expect(result).toBeInstanceOf(MCPError);
    expect(result).not.toBeInstanceOf(ConnectionError);
  });

  it("keeps the original message instead of flattening it", () => {
    expect(
      classifyTransportError(withCode("connect ECONNREFUSED", "ECONNREFUSED"))
        .message,
    ).toBe("connect ECONNREFUSED");
  });
});
