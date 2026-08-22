// Dumps today's macOS Calendar events as JSON, for the morning briefing.
//
// WHY THIS EXISTS AT ALL: the main agent runs under a long-lived tmux server,
// and macOS binds TCC permissions to the RESPONSIBLE process -- which is that
// tmux server, started days before any permission was granted. Restarting the
// agent does not help; every child inherits the same stale permission
// snapshot. So the calendar is read by THIS binary instead, launched from a
// LaunchAgent (com.marveen.calendar), which gets its own TCC identity and can
// actually show the consent dialog. The agent then just reads the JSON file.
//
// Build (stable identity matters -- see below):
//   swiftc -O scripts/calendar-events.swift -o scripts/bin/calendar-events
//   codesign -s - --force scripts/bin/calendar-events
//
// TCC keys the grant to the binary's identity. Ad-hoc signing keeps that
// identity stable across rebuilds; an unsigned binary can lose the grant when
// recompiled, silently sending us back to square one.
//
// The output ALWAYS carries a status field. "No events today" and "I could not
// read the calendar" are different facts, and a bare empty array would conflate
// them -- the exact silent-zero failure this project keeps hunting down.

import EventKit
import Foundation

struct Event: Codable {
    let start: String
    let end: String
    let title: String
    let location: String?
    let allDay: Bool
    let calendar: String
}

struct Output: Codable {
    let generatedAt: String
    let status: String  // ok | not_determined | denied | restricted | write_only | error
    let detail: String?
    let dayStart: String
    let dayEnd: String
    let events: [Event]
}

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f
}()

func emit(_ out: Output) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]

    if let data = try? enc.encode(out), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        // Last resort: still emit valid JSON with a status, never nothing.
        print("{\"status\":\"error\",\"detail\":\"json encoding failed\",\"events\":[]}")
    }

    exit(out.status == "ok" ? 0 : 3)
}

// Day window: local midnight to local midnight, so "today" means what the
// operator means by today. `--days N` widens it for manual queries.
var days = 1

if let idx = CommandLine.arguments.firstIndex(of: "--days"),
   idx + 1 < CommandLine.arguments.count,
   let n = Int(CommandLine.arguments[idx + 1]), n > 0 {
    days = n
}

let cal = Calendar.current
let dayStart = cal.startOfDay(for: Date())
let dayEnd = cal.date(byAdding: .day, value: days, to: dayStart) ?? dayStart.addingTimeInterval(86_400)

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var granted = false
var requestError: Error?

// requestFullAccessToEvents is async and its consent dialog only appears for a
// process that owns a GUI session -- under tmux it silently resolves to false.
store.requestFullAccessToEvents { ok, err in
    granted = ok
    requestError = err
    semaphore.signal()
}

// A hung consent dialog must not wedge the LaunchAgent forever.
if semaphore.wait(timeout: .now() + 30) == .timedOut {
    emit(Output(generatedAt: iso.string(from: Date()), status: "error",
                detail: "consent request timed out after 30s",
                dayStart: iso.string(from: dayStart), dayEnd: iso.string(from: dayEnd), events: []))
}

if !granted {
    let status = EKEventStore.authorizationStatus(for: .event)
    let name: String

    switch status {
    case .notDetermined: name = "not_determined"
    case .restricted: name = "restricted"
    case .denied: name = "denied"
    case .writeOnly: name = "write_only"
    default: name = "denied"
    }

    emit(Output(generatedAt: iso.string(from: Date()), status: name,
                detail: requestError.map { String(describing: $0) },
                dayStart: iso.string(from: dayStart), dayEnd: iso.string(from: dayEnd), events: []))
}

let predicate = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: nil)
let events = store.events(matching: predicate)
    .sorted { ($0.startDate ?? dayStart) < ($1.startDate ?? dayStart) }
    .map {
        Event(
            start: iso.string(from: $0.startDate ?? dayStart),
            end: iso.string(from: $0.endDate ?? dayStart),
            title: $0.title ?? "(nincs cím)",
            location: ($0.location?.isEmpty ?? true) ? nil : $0.location,
            allDay: $0.isAllDay,
            calendar: $0.calendar?.title ?? "?"
        )
    }

emit(Output(generatedAt: iso.string(from: Date()), status: "ok", detail: nil,
            dayStart: iso.string(from: dayStart), dayEnd: iso.string(from: dayEnd), events: events))
