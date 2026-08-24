# CLAUDE.md

ALWAYS verify your changes by running the tests with `bun run test`!

## Fork-Status (Hendrik, Stand 2026-08-23)

Dies ist ein Fork von `soenkenils/mailbox-mcp-server` (git-Remote `origin`, upstream, kein
Push-Recht). Eigener Fork-Remote `fork` = `Trac3rTong/mailbox-mcp-server`. Der Server läuft produktiv
und liefert Hendriks `mcp__mailbox__*`-Tools in Claude Desktop.

**Entrypoint ist `src/main.ts`** (nicht `src/index.ts`, wie weiter unten in diesem Dokument steht —
das ist generischer Upstream-Text).

**Dual-Password (Fork-Erweiterung):** mailbox.org trennt App-Passwörter nach Protokoll. Neben
`MAILBOX_PASSWORD` (= CalDAV/CardDAV) gibt es die optionale Variable `MAILBOX_EMAIL_PASSWORD`
(= IMAP/SMTP/Sieve). Ohne sie Fallback auf `MAILBOX_PASSWORD`. Werte mit Sonderzeichen in der `.env`
in Anführungszeichen setzen (dotenv kappt sonst am `#`).

**Happy-Eyeballs:** `src/utils/happyEyeballs.ts` löst A+AAAA auf und rennt parallele TCP-Connects,
weil nodemailer kein Happy-Eyeballs macht und je nach Netz/VPN nur eine Adress-Family erreichbar ist.

**Erledigt:**
1. Der Commit `4cc80cc` (Dual-Password + `.gitignore`) liegt als Branch `dual-password-local` auf dem
   Fork (`fork/dual-password-local`) und ist damit gesichert. PR #4 (`fix/smtp-happy-eyeballs-windows`)
   enthält weiterhin nur Happy-Eyeballs + Windows-Fix; ob Dual-Password dort dazu soll, ist bewusst
   offen gelassen (wäre Scope-Erweiterung).
2. **SMTP-Zertifikatsprüfung aktiv (2026-08-23).** `src/services/SmtpConnectionPool.ts` steht auf
   `rejectUnauthorized: true`. `tls.servername` ist durch den Happy-Eyeballs-Fix auf `smtp.mailbox.org`
   gesetzt, damit verifiziert TLS korrekt trotz IP-Literal-Host. IMAP/CalDAV/Sieve prüften immer korrekt.

**Offene Punkte:**
1. **Sieve-Werkzeuge gesperrt (Incident 2026-08-23).** Der `SieveService` meldet nachweislich Falsches:
   `LISTSCRIPTS` lieferte null Skripte bei drei vorhandenen, `GETSCRIPT` gab die Login-Antwort zurück
   (Antwort-Zuordnung im Response-Reader). Client-Literale werden als `{n}` statt `{n+}` gesendet
   (RFC 5804), die Länge kommt aus `content.length` statt aus der Oktett-Länge. Ein `SETACTIVE` aus
   einer Claude-Sitzung hat 47 produktive Filterregeln der App Suite stillgelegt — ManageSieve erlaubt
   genau ein aktives Skript. Bis zur Reparatur nicht benutzen. Für Sieve-Arbeiten den unabhängigen
   Client `C:\Projects\Familien-Kalender\sieve_add_rule.py` verwenden (Backup, `CHECKSCRIPT`,
   Zurückleseprobe, Rollback).
2. **Review durchgeführt (2026-08-23), Stufen 1 und 2 umgesetzt** auf Branch `fix/silent-failures`
   (8 Commits, nicht gepusht). Befundbericht: `_claude-memory/plans/BEFUND_mailbox_mcp_2026-08-23.md`.
   Leitbefund: ein Fehlschlag drang nirgends als Fehlschlag nach außen. Behoben für E-Mail,
   Kalender und SMTP; Sieve steht noch aus (Stufe 3, Neubau des Protokoll-Lesers).

   **Regeln, die daraus für diesen Code gelten:**
   - Fehler per `classifyTransportError()` typisieren, nie am Meldungstext erkennen. Nur
     `ConnectionError` darf zu Cache oder Default aufgeweicht werden; TLS-Fehler bewusst nicht.
   - `withCacheFallback` ohne `defaultValue` aufrufen, außer der Ersatzwert ist vom echten
     Ergebnis nicht unterscheidbar. Ein erfundener Default ist eine Falschauskunft.
   - Bei ImapFlow, nodemailer und tsdav den Rückgabewert schreibender Aufrufe prüfen. Diese
     Bibliotheken melden Ablehnung per `false` bzw. `Response.ok`, nicht per Exception.
   - Mocks müssen diese Rückgabe-Semantik nachbilden (`mockResolvedValue(true)`), sonst ist
     die Prüfung im Test unsichtbar.
   - Nach `biome check --write` die Tests erneut laufen lassen. Die Regel `useArrowFunction`
     hat schon einmal alle Mock-Konstruktoren zerlegt; betroffene Stellen tragen ein
     `biome-ignore` mit Begründung.
3. **Testsuite: kein Kontakt zum Produktivhost.** `tests/SieveService.test.ts` zeigte auf
   `imap.mailbox.org:4190` und erzeugte pro Suite-Lauf einen Fehl-Login gegen einen Host mit
   fail2ban. Steht jetzt auf `127.0.0.1`. Nicht zurückstellen, bevor es einen injizierbaren
   Transport-Mock gibt.

Projekt-Memory (cross-system): `_claude-memory/projects/familien-kalender/memory/`.

## Project Overview

This is a Model Context Protocol (MCP) server for mailbox.org integration, providing:

- IMAP email access and management
- SMTP email sending
- CalDAV calendar operations
- Sieve email filter management

Built with TypeScript and Bun runtime, designed to be used with Claude Desktop.

## Architecture

### Core Services

- **ImapService** (`src/services/ImapService.ts`) - Email fetching, searching, folder management
- **SmtpService** (`src/services/SmtpService.ts`) - Email sending with attachments
- **CalendarService** (`src/services/CalendarService.ts`) - CalDAV operations for events
- **SieveService** (`src/services/SieveService.ts`) - Email filter script management

### Connection Management

- **ConnectionPool** (`src/services/ConnectionPool.ts`) - Manages persistent IMAP connections
- Implements connection reuse, health checks, and automatic cleanup
- Configurable pool size and connection timeouts
- Graceful degradation on connection failures

### Security

- Credentials stored in environment variables (`.env` file)
- Never log sensitive data (passwords, tokens, email content)
- App passwords recommended for mailbox.org (see `APP_PASSWORDS.md`)
- Password validation: 10+ chars for standard, 6+ for app passwords

## Code Style

### Language Features

- ES modules with destructured imports
- Double quotes, 2 spaces indentation, semicolons
- Arrow functions preferred
- async/await over promises
- Object/array destructuring where appropriate

### Patterns

- Dependency injection for services (constructor parameters)
- Error handling with try-catch and custom error messages
- Logging via Logger utility (see `src/utils/logger.ts`)
- Type-safe interfaces for all data structures

### Naming Conventions

- PascalCase for classes and interfaces
- camelCase for variables, functions, and methods
- SCREAMING_SNAKE_CASE for constants
- Descriptive names over abbreviations

## Development Commands

### Running & Building

- `bun dev` - Start development server with file watching
- `bun run build` - Build TypeScript to JavaScript

### Testing

- `bun run test` - Run all tests (using vitest)
- `bun run test:watch` - Run tests in watch mode
- `bun run test:coverage` - Run tests with coverage report
- `bun run test:ui` - Run tests with interactive UI

### Code Quality

- `bun run check` - Run linting and formatting checks
- `bun run format` - Auto-format code with Biome

## Workflow

### Test-Driven Development

1. Write a failing test first
2. Implement minimal code to pass the test
3. Refactor and improve
4. Run full test suite to ensure no regressions

### Making Changes

1. Create a feature branch from `main`
2. Write tests for new functionality
3. Implement the feature
4. Run `bun run check` before committing
5. Ensure all tests pass with `bun run test`
6. Create PR with descriptive commit message

### Performance Tips

- Use `bun run test -t "test name"` to run single tests during development
- Connection pool warmup happens automatically
- IMAP connections are reused across operations

## Testing Guidelines

### Unit Tests

- Located in `__tests__` directories next to source files
- Mock external dependencies (IMAP, SMTP, CalDAV clients)
- Test error cases and edge conditions
- Use descriptive test names: `should do X when Y`

### Integration Tests

- Test actual protocol interactions when needed
- Use test fixtures for sample data
- Clean up resources after tests (connections, temp files)

### Coverage Goals

- Aim for >80% coverage on service classes
- 100% coverage on critical paths (authentication, email sending)
- Don't sacrifice test quality for coverage numbers

## Common Tasks

### Adding a New MCP Tool

1. Define tool schema in `src/index.ts` (`server.tool()`)
2. Implement handler logic (usually delegates to service)
3. Add tests for the tool handler
4. Update documentation

### Adding a New Service Method

1. Add method signature to service class
2. Write unit tests for the method
3. Implement the method
4. Update dependent code if needed

### Debugging Connection Issues

- Check `.env` file for correct credentials
- Verify mailbox.org server addresses (see `APP_PASSWORDS.md`)
- Enable debug logging in ConnectionPool
- Check connection pool health status

## Dependencies

### Key Libraries

- `imapflow` - Modern IMAP client
- `nodemailer` - SMTP email sending
- `tsdav` - CalDAV client for calendar operations
- `sieve` - Sieve email filter parser (custom fork)

### Development Tools

- `bun` - JavaScript runtime and package manager
- `vitest` - Fast unit testing framework
- `@biomejs/biome` - Linting and formatting
- `typescript` - Type checking and compilation

## Environment Setup

### Required Variables

Create a `.env` file with:

```env
MAILBOX_EMAIL=your-email@mailbox.org
MAILBOX_PASSWORD=your-app-password
```

### Optional Configuration

- Connection pool settings in `ConnectionPool` constructor
- Logger level in `src/utils/logger.ts`
- MCP server name and version in `package.json`

## Documentation

- `README.md` - Project overview and setup instructions
- `APP_PASSWORDS.md` - Mailbox.org app password guide
- `SIEVE.md` - Sieve email filter management guide
- `docs/` - Additional protocol documentation (IMAP, CalDAV)

## Troubleshooting

### Tests Failing

- Run `bun install` to ensure dependencies are up to date
- Check for TypeScript errors with `bun run build`
- Verify test mocks are properly configured

### Connection Errors

- Verify credentials in `.env` file
- Check internet connectivity
- Ensure mailbox.org services are accessible
- Try regenerating app password if authentication fails

### Build Issues

- Clear `dist/` directory and rebuild
- Check TypeScript version compatibility
- Verify all imports use correct paths
