// GENERATED FILE, DO NOT EDIT. The support routine as one self-contained file:
// only node's own modules, no node_modules, nothing from the compiled tree.
// Source: src/support-standby-cli.ts. Rebuild: node scripts/build-support-standby.mjs

// src/support-standby-cli.ts
import { randomUUID } from "node:crypto";
import { accessSync as accessSync2, constants as constants7, readFileSync as readFileSync4, realpathSync as realpathSync2 } from "node:fs";
import { join as join10 } from "node:path";
import { fileURLToPath } from "node:url";

// src/support-access-pins.ts
import { createHash } from "node:crypto";
import { isIP } from "node:net";
var SUPPORT_KEY_TYPE = "sk-ssh-ed25519@openssh.com";
var SUPPORT_MAX_KEYS = 2;
var SUPPORT_MAX_FROM = 2;
var SUPPORT_KEYS = [
  {
    name: "owner",
    pub: "AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIHLMzY1CCtV2IFehNnYjZE6wFvpislH2aT8ZAC31OIoqAAAAE3NzaDptYXJ2ZWVuLXN1cHBvcnQ=",
    fingerprint: "SHA256:z0v+T57GHbJHUkp6H1EQ3Z7wbkax9DxQYUNtBM9pAAY"
  },
  {
    name: "eva",
    pub: "AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIEVQi3MvWfHpqcxDjcq1nRPxAK9aywz/Fv5xNqGPhFlKAAAAE3NzaDptYXJ2ZWVuLXN1cHBvcnQ=",
    fingerprint: "SHA256:6Xc4IPpnXluHEdITNQFygVCr3OyBvnkdBtD8LOqJP+E"
  }
];
var SUPPORT_FROM_CIDRS = [];
var KEY_NAME = /^[a-z0-9]{1,16}$/;
var SK_APPLICATION = /^ssh:[A-Za-z0-9._-]{0,64}$/;
function isCanonicalBase64(s) {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  return Buffer.from(s, "base64").toString("base64") === s;
}
function parseSkEd25519Blob(base64) {
  if (!isCanonicalBase64(base64)) return { ok: false, reason: "not canonical base64" };
  const buf = Buffer.from(base64, "base64");
  let off = 0;
  const readString = () => {
    if (off + 4 > buf.length) return null;
    const len = buf.readUInt32BE(off);
    off += 4;
    if (off + len > buf.length) return null;
    const out = buf.subarray(off, off + len);
    off += len;
    return out;
  };
  const type = readString();
  if (type === null || type.toString("latin1") !== SUPPORT_KEY_TYPE) {
    return { ok: false, reason: "embedded key type is not " + SUPPORT_KEY_TYPE };
  }
  const key = readString();
  if (key === null || key.length !== 32) return { ok: false, reason: "public key is not 32 bytes" };
  const application = readString();
  if (application === null) return { ok: false, reason: "application field is missing" };
  if (off !== buf.length) return { ok: false, reason: "trailing bytes after the application field" };
  const app = application.toString("latin1");
  if (!SK_APPLICATION.test(app)) return { ok: false, reason: "application field is not an ssh: application" };
  return { ok: true, application: app };
}
function fingerprintOfBlob(base64) {
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64");
  return "SHA256:" + digest.replace(/=+$/, "");
}
function ipv6Groups(address) {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + (a << 8 | b).toString(16) + ":" + (c << 8 | d).toString(16);
  }
  const halves = text.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length < 2 || halves[1] === "" ? [] : halves[1].split(":");
  const gap = halves.length < 2 ? 0 : 8 - head.length - tail.length;
  return [...head, ...Array.from({ length: gap }, () => "0"), ...tail].map((group) => parseInt(group, 16));
}
function isExactHostCidr(value) {
  const m = /^([0-9A-Fa-f:.]{2,45})\/(32|128)$/.exec(value);
  if (m === null) return false;
  const family = isIP(m[1]);
  if (family === 4) {
    if (m[2] !== "32" || !m[1].split(".").every((part) => String(Number(part)) === part)) return false;
    return m[1] !== "0.0.0.0";
  }
  if (family === 6) {
    if (m[2] !== "128") return false;
    const groups = ipv6Groups(m[1]);
    if (groups.every((group) => group === 0)) return false;
    const mappedV4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
    return !mappedV4;
  }
  return false;
}
function validateSupportPins(keys, fromCidrs) {
  const invalid = (reason) => ({ ok: false, code: "support_pins_invalid", reason });
  if (keys.length > SUPPORT_MAX_KEYS) return invalid("more than " + SUPPORT_MAX_KEYS + " keys");
  if (fromCidrs.length > SUPPORT_MAX_FROM) return invalid("more than " + SUPPORT_MAX_FROM + " source addresses");
  const names = /* @__PURE__ */ new Set();
  const blobs = /* @__PURE__ */ new Set();
  for (const key of keys) {
    if (!KEY_NAME.test(key.name)) return invalid("key name is not a short lowercase label");
    if (names.has(key.name)) return invalid("duplicate key name " + key.name);
    names.add(key.name);
    const parsed = parseSkEd25519Blob(key.pub);
    if (!parsed.ok) return invalid("key " + key.name + ": " + parsed.reason);
    if (blobs.has(key.pub)) return invalid("key " + key.name + " repeats another key");
    blobs.add(key.pub);
    if (fingerprintOfBlob(key.pub) !== key.fingerprint) {
      return invalid("key " + key.name + ": the fingerprint does not belong to the key");
    }
  }
  const seenFrom = /* @__PURE__ */ new Set();
  for (const cidr of fromCidrs) {
    if (!isExactHostCidr(cidr)) return invalid("source address is not an exact /32 or /128 host");
    if (seenFrom.has(cidr)) return invalid("duplicate source address");
    seenFrom.add(cidr);
  }
  if (keys.length === 0) return { ok: false, code: "support_keys_unset", reason: "no support key is pinned" };
  if (fromCidrs.length === 0) return { ok: false, code: "support_from_unset", reason: "no source address is pinned" };
  return { ok: true };
}

// src/support-access-sshd-run.ts
import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// src/support-access-sshd-nonroot.ts
import { posix } from "node:path";
var SSHD_LISTENER_PROGRAM = "/usr/sbin/sshd";
var SSHD_MAIN_CONFIG = "/etc/ssh/sshd_config";
var SSHD_CONFIG_DIR = "/etc/ssh";
var NONROOT_MAX_DEPTH = 16;
var NONROOT_MAX_FILES = 256;
var NONROOT_MAX_FILE_BYTES = 256 * 1024;
var UNPARSED_CHARS = /["'\\~%$#]/;
var GLOB_CHARS = /[*?[\]{}]/;
function includeArguments(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+|$)(.*)$/.exec(line);
    if (m === null || m[1].toLowerCase() !== "include") continue;
    const value = m[2].trim();
    if (value.length === 0 || UNPARSED_CHARS.test(value)) return null;
    out.push(...value.split(/\s+/));
  }
  return out;
}
function includeTarget(arg) {
  if (arg.length === 0 || UNPARSED_CHARS.test(arg)) return null;
  const full = arg.startsWith("/") ? arg : SSHD_CONFIG_DIR + "/" + arg;
  if (posix.normalize(full) !== full || full.endsWith("/")) return null;
  const dir = posix.dirname(full);
  const pattern = posix.basename(full);
  if (GLOB_CHARS.test(dir) || /[[\]{}]/.test(pattern) || pattern.length === 0) return null;
  return { dir, pattern };
}
function patternMatches(pattern, name) {
  const re = "^" + pattern.replace(/[.+^$()|\\/]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(name);
}
function walkIncludes(fs, main2 = SSHD_MAIN_CONFIG) {
  const files = [];
  const mainDir = posix.dirname(main2);
  const mainDirTime = fs.ctimeNs(mainDir);
  if (mainDirTime === null) return { ok: false, problem: "sshd_config_unknown" };
  files.push({ path: mainDir, ctimeNs: mainDirTime });
  const listedDirs = /* @__PURE__ */ new Set([mainDir]);
  const seen = /* @__PURE__ */ new Set();
  const visit = (path, depth) => {
    if (depth > NONROOT_MAX_DEPTH || files.length >= NONROOT_MAX_FILES) return "sshd_config_include_unparsed";
    if (seen.has(path)) return null;
    seen.add(path);
    const read = fs.readText(path, NONROOT_MAX_FILE_BYTES);
    if (read.kind === "missing") return depth === 0 ? "sshd_config_unknown" : null;
    if (read.kind === "unreadable") return "sshd_config_unknown";
    files.push({ path, ctimeNs: read.ctimeNs });
    const args = includeArguments(read.text);
    if (args === null) return "sshd_config_include_unparsed";
    for (const arg of args) {
      const target = includeTarget(arg);
      if (target === null) return "sshd_config_include_unparsed";
      const listed = fs.listDir(target.dir);
      if (listed.kind === "unlistable") return "sshd_config_include_unlistable";
      if (listed.kind === "missing") continue;
      if (!listedDirs.has(target.dir)) {
        listedDirs.add(target.dir);
        files.push({ path: target.dir, ctimeNs: listed.ctimeNs });
      }
      for (const name of [...listed.names].sort()) {
        if (!patternMatches(target.pattern, name)) continue;
        const problem2 = visit(target.dir + "/" + name, depth + 1);
        if (problem2 !== null) return problem2;
      }
    }
    return null;
  };
  const problem = visit(main2, 0);
  return problem === null ? { ok: true, files } : { ok: false, problem };
}
var LISTENER_PREFIX = "sshd: " + SSHD_LISTENER_PROGRAM + " ";
var LISTENER_FLAGS = /^((?:-[De] )*)\[listener\] /;
function listenerTitleProblem(cmdline) {
  const title = cmdline.replace(/\0/g, " ").trim() + " ";
  if (!title.startsWith(LISTENER_PREFIX)) return "sshd_daemon_unknown";
  const rest = title.slice(LISTENER_PREFIX.length);
  if (LISTENER_FLAGS.test(rest)) return null;
  return /\[listener\] /.test(rest) ? "sshd_daemon_options" : "sshd_daemon_unknown";
}
function pidfileOf(sshdT) {
  let found = null;
  for (const raw of sshdT.split("\n")) {
    const m = /^pidfile (.*)$/i.exec(raw.trim());
    if (m === null) continue;
    if (found !== null) return null;
    found = m[1];
  }
  return found !== null && /^\/[A-Za-z0-9._/-]+$/.test(found) ? found : null;
}
function checkDaemon(fs, pidfile, walked) {
  if (pidfile === null) return { ok: false, problem: "sshd_daemon_unknown" };
  const pidText = fs.readText(pidfile, 64);
  if (pidText.kind !== "ok" || !/^[1-9][0-9]{0,9}\n?$/.test(pidText.text)) return { ok: false, problem: "sshd_daemon_unknown" };
  const pidTime = pidText.ctimeNs;
  const pid = pidText.text.trim();
  const comm = fs.readText("/proc/" + pid + "/comm", 64);
  if (comm.kind !== "ok" || comm.text !== "sshd\n") return { ok: false, problem: "sshd_daemon_unknown" };
  const cmdline = fs.readText("/proc/" + pid + "/cmdline", 4096);
  if (cmdline.kind !== "ok") return { ok: false, problem: "sshd_daemon_unknown" };
  const title = listenerTitleProblem(cmdline.text);
  if (title !== null) return { ok: false, problem: title };
  if (walked.some((f) => f.ctimeNs > pidTime)) return { ok: false, problem: "sshd_reload_pending" };
  return { ok: true };
}

// src/support-access-sshd-darwin.ts
var DARWIN_SSH_PLIST = "/System/Library/LaunchDaemons/ssh.plist";
var DARWIN_SSH_LABEL = "com.openssh.sshd";
var DARWIN_SSH_PROGRAM = "/usr/libexec/sshd-keygen-wrapper";
var DARWIN_SSH_ARGUMENTS = ["sshd-keygen-wrapper"];
var PLUTIL_PROGRAM = "/usr/bin/plutil";
var LAUNCHCTL_PROGRAM = "/bin/launchctl";
var NETSTAT_PROGRAM = "/usr/sbin/netstat";
var PLIST_KEYS = /* @__PURE__ */ new Set([
  "Label",
  "Program",
  "ProgramArguments",
  "inetdCompatibility",
  "Sockets",
  "Disabled",
  "MaterializeDatalessFiles",
  "POSIXSpawnType",
  "StandardErrorPath",
  "SHAuthorizationRight"
]);
var UNKNOWN = { ok: false, problem: "sshd_daemon_unknown" };
var OK = { ok: true };
var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function darwinPlistCheck(json) {
  if (json === null) return UNKNOWN;
  let p;
  try {
    p = JSON.parse(json);
  } catch {
    return UNKNOWN;
  }
  if (!isObject(p) || Object.keys(p).some((k) => !PLIST_KEYS.has(k))) return UNKNOWN;
  if (p.Label !== DARWIN_SSH_LABEL || p.Program !== DARWIN_SSH_PROGRAM) return UNKNOWN;
  const args = p.ProgramArguments;
  if (!Array.isArray(args) || args.length === 0 || args[0] !== DARWIN_SSH_ARGUMENTS[0]) return UNKNOWN;
  if (args.length !== DARWIN_SSH_ARGUMENTS.length) return { ok: false, problem: "sshd_daemon_options" };
  const inetd = p.inetdCompatibility;
  if (!isObject(inetd) || inetd.Wait !== false || Object.keys(inetd).some((k) => k !== "Wait" && k !== "Instances")) return UNKNOWN;
  const sockets = p.Sockets;
  if (!isObject(sockets) || Object.keys(sockets).join(",") !== "Listeners") return UNKNOWN;
  const listeners = sockets.Listeners;
  if (!isObject(listeners) || listeners.SockServiceName !== "ssh") return UNKNOWN;
  if (Object.keys(listeners).some((k) => k !== "SockServiceName" && k !== "Bonjour")) return UNKNOWN;
  return OK;
}
function darwinEnabledCheck(text) {
  if (text === null) return UNKNOWN;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"' + DARWIN_SSH_LABEL + '" '));
  return lines.length === 1 && lines[0] === '"' + DARWIN_SSH_LABEL + '" => enabled' ? OK : UNKNOWN;
}
function darwinJobCheck(text) {
  if (text === null) return UNKNOWN;
  const lines = text.split("\n").map((l) => l.trim());
  const has = (line) => lines.includes(line);
  if (!has("path = " + DARWIN_SSH_PLIST) || !has("program = " + DARWIN_SSH_PROGRAM)) return UNKNOWN;
  const at = lines.indexOf("arguments = {");
  if (at < 0) return UNKNOWN;
  const end = lines.indexOf("}", at);
  if (end < 0) return UNKNOWN;
  const args = lines.slice(at + 1, end);
  if (args[0] !== DARWIN_SSH_ARGUMENTS[0]) return UNKNOWN;
  if (args.length !== DARWIN_SSH_ARGUMENTS.length) return { ok: false, problem: "sshd_daemon_options" };
  const sockets = lines.indexOf("sockets = {");
  if (sockets < 0 || lines[sockets + 1] !== '"Listeners" = {' || !lines.slice(sockets + 2, sockets + 6).includes("service name = ssh")) return UNKNOWN;
  const properties = lines.find((l) => l.startsWith("properties = "));
  if (properties === void 0 || !properties.slice("properties = ".length).split(" | ").includes("inetd-compatible")) return UNKNOWN;
  return OK;
}
function darwinListenersCheck(text) {
  if (text === null) return UNKNOWN;
  const on22 = [];
  for (const raw of text.split("\n")) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 6 || cols[5] !== "LISTEN" || !/^tcp[46]*$/.test(cols[0])) continue;
    if (/[.:]22$/.test(cols[3])) on22.push(cols[0] + " " + cols[3]);
  }
  return on22.sort().join(",") === "tcp4 *.22,tcp6 *.22" ? OK : UNKNOWN;
}
function darwinWalkOwnerCheck(owners) {
  return owners.every((o) => o !== null && o.uid === 0 && (o.mode & 18) === 0) ? OK : UNKNOWN;
}
function checkDarwinDaemon(evidence) {
  for (const check of [
    darwinWalkOwnerCheck(evidence.walkOwners),
    darwinPlistCheck(evidence.plistJson),
    darwinEnabledCheck(evidence.printDisabled),
    darwinJobCheck(evidence.printJob),
    darwinListenersCheck(evidence.netstat)
  ]) {
    if (!check.ok) return check;
  }
  return OK;
}

// src/support-access-sshd.ts
import { isIP as isIP2 } from "node:net";

// src/support-access-line.ts
var SUPPORT_COMMENT_PREFIX = "marveen-support:";
var SUPPORT_MIN_SSHD = { major: 8, minor: 4 };
var SupportLineError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SupportLineError";
    this.code = code;
  }
};
var KEY_NAME2 = /^[a-z0-9]{1,16}$/;
var GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
function sshdAtLeast(version, floor) {
  return version.major > floor.major || version.major === floor.major && version.minor >= floor.minor;
}
function supportLineComment(grantId, keyName) {
  return SUPPORT_COMMENT_PREFIX + grantId + ":" + keyName;
}
function buildSupportLine(input) {
  const { key, grantId, consentVersion, dispatchPath, fromCidrs, sshd } = input;
  if (!KEY_NAME2.test(key.name) || !parseSkEd25519Blob(key.pub).ok) {
    throw new SupportLineError("key_invalid", "the key is not a named " + SUPPORT_KEY_TYPE + " key");
  }
  if (!GRANT_ID.test(grantId)) throw new SupportLineError("grant_id_invalid", "the grant id is not a lowercase UUID v4");
  if (!Number.isInteger(consentVersion) || consentVersion < 1 || consentVersion > 9999) {
    throw new SupportLineError("consent_version_invalid", "the consent version is not a small positive integer");
  }
  if (!SAFE_ABSOLUTE_PATH.test(dispatchPath)) {
    throw new SupportLineError("install_path_unsupported", "the dispatcher path contains a character a bound command cannot carry");
  }
  if (fromCidrs.length < 1 || fromCidrs.length > SUPPORT_MAX_FROM || !fromCidrs.every(isExactHostCidr)) {
    throw new SupportLineError("from_invalid", "the source list is not one or two exact hosts");
  }
  if (!sshdAtLeast(sshd, SUPPORT_MIN_SSHD)) {
    throw new SupportLineError("sshd_too_old", "verify-required is unknown to this sshd; the line would be silently dead");
  }
  const fingerprint = fingerprintOfBlob(key.pub);
  const command = "/bin/sh " + dispatchPath + " --key " + key.name + " --fp " + fingerprint + " --grant " + grantId + " --consent " + consentVersion;
  const options = 'restrict,command="' + command + '",from="' + fromCidrs.join(",") + '",verify-required';
  return options + " " + SUPPORT_KEY_TYPE + " " + key.pub + " " + supportLineComment(grantId, key.name);
}
function buildSupportGrantLines(grant) {
  const pins = validateSupportPins(grant.keys, grant.fromCidrs);
  if (!pins.ok) throw new SupportLineError("pins_invalid", "the keys and sources do not pass the pins check: " + pins.reason);
  return grant.keys.map(
    (key) => buildSupportLine({
      key,
      grantId: grant.grantId,
      consentVersion: grant.consentVersion,
      dispatchPath: grant.dispatchPath,
      fromCidrs: grant.fromCidrs,
      sshd: grant.sshd
    })
  );
}
var KEY_TYPE_NAME = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(-cert-v01@openssh\.com)?$/;
function readField(line, start) {
  let i = start;
  while (i < line.length && (line[i] === " " || line[i] === "	")) i++;
  if (i >= line.length) return null;
  const begin = i;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\" && line[i + 1] === '"') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === " " || c === "	") break;
  }
  if (quoted) return null;
  return { value: line.slice(begin, i), next: i };
}
function splitAuthorizedKeysLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const first = readField(trimmed, 0);
  if (first === null) return null;
  let options = null;
  let type = first;
  if (!KEY_TYPE_NAME.test(first.value)) {
    options = first.value;
    const second = readField(trimmed, first.next);
    if (second === null || !KEY_TYPE_NAME.test(second.value)) return null;
    type = second;
  }
  const blob = readField(trimmed, type.next);
  if (blob === null) return null;
  return { options, keyType: type.value, blob: blob.value, comment: trimmed.slice(blob.next).trim() };
}
var pinnedBytesCache = /* @__PURE__ */ new WeakMap();
function pinnedBytesOf(pinnedBlobs) {
  let bytes = pinnedBytesCache.get(pinnedBlobs);
  if (bytes === void 0) {
    bytes = [...pinnedBlobs].filter((blob) => parseSkEd25519Blob(blob).ok).map((blob) => Buffer.from(blob, "base64"));
    pinnedBytesCache.set(pinnedBlobs, bytes);
  }
  return bytes;
}
function holdsPinnedKey(word, pinnedBlobs) {
  const decoded = Buffer.from(word, "base64");
  return pinnedBytesOf(pinnedBlobs).some((pinned) => decoded.subarray(0, pinned.length).equals(pinned));
}
function isSupportLine(line, pinnedBlobs) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
  const fields = splitAuthorizedKeysLine(trimmed);
  if (fields === null) {
    const words = trimmed.split(/\s+/);
    return words.some((w) => w.startsWith(SUPPORT_COMMENT_PREFIX) || holdsPinnedKey(w, pinnedBlobs));
  }
  if (holdsPinnedKey(fields.blob, pinnedBlobs)) return true;
  return fields.comment.split(/\s+/).some((w) => w.startsWith(SUPPORT_COMMENT_PREFIX));
}
function splitLines(existing) {
  const lines = existing.length ? existing.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function joinLines(lines) {
  let content = lines.join("\n");
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  return content;
}
function removeSupportLines(existing, pinnedBlobs) {
  const lines = splitLines(existing);
  const kept = lines.filter((line) => !isSupportLine(line, pinnedBlobs));
  const removed = lines.length - kept.length;
  return { content: removed === 0 ? existing : joinLines(kept), removed };
}
function countSupportLines(existing, pinnedBlobs) {
  return splitLines(existing).filter((line) => isSupportLine(line, pinnedBlobs)).length;
}
function mergeSupportLines(existing, newLines, pinnedBlobs) {
  if (newLines.length === 0) throw new Error("mergeSupportLines needs at least one line");
  for (const line of newLines) {
    if (/[^\x20-\x7e]/.test(line)) {
      throw new SupportLineError("line_refused", "a line to write holds a character that is not printable ASCII");
    }
    if (!isSupportLine(line, pinnedBlobs)) {
      throw new SupportLineError("line_refused", "a line to write is not recognised as a support line");
    }
  }
  const kept = splitLines(existing).filter((line) => !isSupportLine(line, pinnedBlobs));
  const replaced = splitLines(existing).length - kept.length;
  return { content: joinLines([...kept, ...newLines]), replaced };
}
function reconcileSupportLines(existing, expected, pinnedBlobs) {
  const wanted = new Set(expected);
  const seen = /* @__PURE__ */ new Set();
  let removed = 0;
  let lineEndOnly = 0;
  const kept = splitLines(existing).filter((line) => {
    if (wanted.has(line) && !seen.has(line)) {
      seen.add(line);
      return true;
    }
    if (wanted.has(line) || isSupportLine(line, pinnedBlobs)) {
      removed++;
      if (line.endsWith("\r") && wanted.has(line.slice(0, -1))) lineEndOnly++;
      return false;
    }
    return true;
  });
  return {
    content: removed === 0 ? existing : joinLines(kept),
    kept: seen.size,
    removed,
    missing: wanted.size - seen.size,
    lineEndOnly
  };
}

// src/support-access-sshd.ts
function parseSshdVersion(text) {
  let found = null;
  for (const raw of text.split("\n")) {
    const m = /^OpenSSH_(\d{1,3})\.(\d{1,3})(?:[^0-9]|$)/.exec(raw.trim());
    if (m === null) continue;
    const version = { major: Number(m[1]), minor: Number(m[2]) };
    if (found !== null && (found.major !== version.major || found.minor !== version.minor)) return null;
    found = version;
  }
  return found;
}
var SETTING_VALUE = /^[A-Za-z0-9._%/-]+$/;
var SINGLE_SETTINGS = [
  "permitrootlogin",
  "permittunnel",
  "usedns",
  "authorizedkeysfile",
  "authorizedkeyscommand",
  "trustedusercakeys",
  "forcecommand"
];
var LISTEN_ADDRESS = /^(?:\[([0-9A-Fa-f:.]+)\]|([0-9.]+)):(\d{1,5})$/;
function portOf(text) {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}
function parseSshdEffectiveConfig(text) {
  const seen = /* @__PURE__ */ new Map();
  const ports = /* @__PURE__ */ new Set();
  const addresses = /* @__PURE__ */ new Set();
  const acceptEnv = [];
  const hostKeys = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    if (key === "port") {
      const port = portOf(value);
      if (port === null) return null;
      ports.add(port);
    } else if (key === "listenaddress") {
      const m = LISTEN_ADDRESS.exec(value);
      const port = m === null ? null : portOf(m[3]);
      if (m === null || port === null) return null;
      const address = (m[1] ?? m[2]).toLowerCase();
      if (isIP2(address) !== (m[1] === void 0 ? 4 : 6)) return null;
      ports.add(port);
      addresses.add(address);
    } else if (key === "hostkey") {
      hostKeys.push(value);
    } else if (key === "acceptenv") {
      if (value.length === 0) return null;
      acceptEnv.push(...value.split(/\s+/));
    } else if (SINGLE_SETTINGS.includes(key)) {
      if (seen.has(key) || value.length === 0) return null;
      seen.set(key, value);
    }
  }
  if (ports.size === 0 || SINGLE_SETTINGS.some((key) => !seen.has(key))) return null;
  const one = (key) => {
    const value = seen.get(key);
    return SETTING_VALUE.test(value) ? value.toLowerCase() : null;
  };
  const permitRootLogin = one("permitrootlogin");
  const permitTunnel = one("permittunnel");
  const useDns = one("usedns");
  const files = seen.get("authorizedkeysfile").split(/\s+/);
  if (permitRootLogin === null || permitTunnel === null || useDns === null) return null;
  if (!files.every((f) => SETTING_VALUE.test(f))) return null;
  return {
    permitRootLogin,
    permitTunnel,
    useDns,
    authorizedKeysFiles: files,
    authorizedKeysCommand: seen.get("authorizedkeyscommand"),
    trustedUserCaKeys: seen.get("trustedusercakeys"),
    forceCommand: seen.get("forcecommand"),
    acceptEnv,
    listenPorts: [...ports].sort((a, b) => a - b),
    listenAddresses: [...addresses].sort(),
    hostKeys
  };
}
function isArrivalAddress(address) {
  const a = address.toLowerCase();
  if (!PLAIN_ADDRESS.test(a)) return false;
  const family = isIP2(a);
  if (family === 4) return !(a.startsWith("127.") || a.startsWith("169.254.") || a === "0.0.0.0");
  if (family === 6) return !(a === "::1" || /^fe[89ab]/.test(a) || /^[0:]+$/.test(a));
  return false;
}
function probeLocalAddresses(interfaceAddresses, listenAddresses) {
  const out = new Set(interfaceAddresses.map((a) => a.toLowerCase()));
  for (const address of listenAddresses) if (isArrivalAddress(address)) out.add(address.toLowerCase());
  return [...out].sort();
}
var LOGIN_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
var PLAIN_ADDRESS = /^[0-9A-Fa-f:.]+$/;
function formatSshdConnectionSpec(spec) {
  if (!LOGIN_USER.test(spec.user)) return null;
  if (!PLAIN_ADDRESS.test(spec.addr) || !PLAIN_ADDRESS.test(spec.laddr)) return null;
  if (isIP2(spec.addr) === 0 || isIP2(spec.laddr) === 0) return null;
  if (!Number.isInteger(spec.lport) || spec.lport < 1 || spec.lport > 65535) return null;
  return "user=" + spec.user + ",addr=" + spec.addr + ",host=" + spec.addr + ",laddr=" + spec.laddr + ",lport=" + spec.lport;
}
var SSHD_DISCOVERY_PORT = 22;
function planSshdProbes(input) {
  const sources = input.fromCidrs.map((cidr) => cidr.replace(/\/(32|128)$/, ""));
  const ports = input.listenPorts === null ? [SSHD_DISCOVERY_PORT] : input.listenPorts;
  if (sources.length === 0 || input.localAddresses.length === 0 || ports.length === 0) return null;
  const specs = [];
  for (const addr of sources) {
    for (const laddr of input.localAddresses) {
      for (const lport of ports) {
        const spec = { user: input.loginUser, addr, laddr, lport };
        if (formatSshdConnectionSpec(spec) === null) return null;
        specs.push(spec);
      }
    }
  }
  return input.listenPorts === null ? specs.slice(0, 1) : specs;
}
var ROOT_LOGIN_BY_KEY = /* @__PURE__ */ new Set(["yes", "without-password", "prohibit-password", "forced-commands-only"]);
var HARMLESS_ENV = /^(?:LANG|LANGUAGE|LC_\*|LC_[A-Z]+|COLORTERM|COLORFGBG|NO_COLOR)$/;
function acceptEnvPatternIsHarmless(pattern) {
  return HARMLESS_ENV.test(pattern);
}
var ACCOUNT_HOME = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
function expandKeysFileEntry(entry, account) {
  if (!LOGIN_USER.test(account.user)) return null;
  if (account.home !== "/" && !ACCOUNT_HOME.test(account.home)) return null;
  let out = "";
  for (let i = 0; i < entry.length; i++) {
    if (entry[i] !== "%") {
      out += entry[i];
      continue;
    }
    const token = entry[++i];
    if (token === "%") out += "%";
    else if (token === "h") out += account.home;
    else if (token === "u") out += account.user;
    else return null;
  }
  if (out.length === 0) return null;
  return out.startsWith("/") ? out : (account.home === "/" ? "" : account.home) + "/" + out;
}
function supportKeysFiles(entries, account) {
  const dir = (account.home === "/" ? "" : account.home) + "/.ssh/";
  let first = false;
  let second = false;
  for (const entry of entries) {
    const path = expandKeysFileEntry(entry, account);
    if (path === dir + "authorized_keys") first = true;
    else if (path === dir + "authorized_keys2") second = true;
    else return null;
  }
  if (!first) return null;
  return second ? ["authorized_keys", "authorized_keys2"] : ["authorized_keys"];
}
function assessSshd(input) {
  const version = input.versionText === null ? null : parseSshdVersion(input.versionText);
  if (version === null) return { ok: false, problem: "sshd_version_unknown", version };
  if (!sshdAtLeast(version, SUPPORT_MIN_SSHD)) return { ok: false, problem: "sshd_too_old", version };
  const refuse = (problem) => ({ ok: false, problem, version });
  if (!input.loginIsRoot) {
    if (input.nonRootProof === void 0) return refuse("sshd_config_not_fully_readable");
    if (!input.nonRootProof.ok) return refuse(input.nonRootProof.problem);
  }
  const configs = [];
  for (const answer of input.answers) {
    const config = answer.text === null ? null : parseSshdEffectiveConfig(answer.text);
    if (config === null) return refuse("sshd_config_unknown");
    configs.push(config);
  }
  if (configs.length === 0) return refuse("sshd_config_unknown");
  const ports = configs[0].listenPorts;
  if (!configs.every((c) => c.listenPorts.join(",") === ports.join(","))) return refuse("sshd_config_unknown");
  const listening = configs[0].listenAddresses;
  if (!configs.every((c) => c.listenAddresses.join(",") === listening.join(","))) return refuse("sshd_config_unknown");
  const planned = planSshdProbes({
    loginUser: input.loginUser,
    fromCidrs: input.fromCidrs,
    localAddresses: probeLocalAddresses(input.localAddresses, listening),
    listenPorts: ports
  });
  if (planned === null) return refuse("sshd_config_unknown");
  const asked = new Set(input.answers.map((a) => formatSshdConnectionSpec(a.spec)));
  if (!planned.every((spec) => asked.has(formatSshdConnectionSpec(spec)))) return refuse("sshd_config_unknown");
  if (!configs.every((c) => c.useDns === "no")) return refuse("sshd_usedns_enabled");
  if (input.loginIsRoot && !configs.every((c) => ROOT_LOGIN_BY_KEY.has(c.permitRootLogin))) return refuse("root_login_disabled");
  if (!configs.every((c) => c.permitTunnel === "no")) return refuse("tunnel_permitted");
  const account = { user: input.loginUser, home: input.loginHome };
  const keysFiles = supportKeysFiles(configs[0].authorizedKeysFiles, account);
  if (keysFiles === null) return refuse("authorized_keys_path_unsupported");
  for (const c of configs) {
    if (supportKeysFiles(c.authorizedKeysFiles, account)?.join(" ") !== keysFiles.join(" ")) {
      return refuse("authorized_keys_path_unsupported");
    }
  }
  if (!configs.every((c) => c.authorizedKeysCommand === "none" && c.trustedUserCaKeys === "none")) {
    return refuse("other_key_source");
  }
  if (!configs.every((c) => c.forceCommand === "none")) return refuse("force_command_set");
  if (!configs.every((c) => c.acceptEnv.every(acceptEnvPatternIsHarmless))) return refuse("accept_env_too_wide");
  const hostKeyFiles = configs[0].hostKeys.filter((path) => path !== input.probeHostKey);
  return { ok: true, version, keysFiles, listenPorts: ports, hostKeyFiles };
}

// src/support-access-sshd-run.ts
var SSHD_PROGRAM = "/usr/sbin/sshd";
var SSH_KEYGEN_PROGRAM = "/usr/bin/ssh-keygen";
var SSHD_PROBE_TIMEOUT_MS = 5e3;
var SSHD_PROBE_MAX_QUERIES = 64;
function reachableLocalAddresses(all) {
  const out = /* @__PURE__ */ new Set();
  for (const entry of all) {
    if (entry.internal) continue;
    if (isArrivalAddress(entry.address)) out.add(entry.address.toLowerCase());
  }
  return [...out].sort();
}
async function probeSshd(input, deps) {
  try {
    return await askSshd(input, deps);
  } catch {
    return { ok: false, problem: "sshd_config_unknown", version: null };
  }
}
async function askSshd(input, deps) {
  const version = await deps.run(SSHD_PROGRAM, ["-V"], SSHD_PROBE_TIMEOUT_MS);
  const versionText = version.code === null ? null : version.stdout + "\n" + version.stderr;
  const base = {
    versionText,
    loginIsRoot: deps.user.isRoot,
    loginUser: deps.user.name,
    loginHome: deps.user.home,
    fromCidrs: input.fromCidrs
  };
  if (versionText === null) return assessSshd({ ...base, localAddresses: [], answers: [] });
  if (deps.user.isRoot) return askAll(base, [], deps, null);
  let keyDir = null;
  try {
    keyDir = deps.makePrivateDir();
    const keyPath = join(keyDir, "probe_host_key");
    const made = await deps.run(SSH_KEYGEN_PROGRAM, ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], SSHD_PROBE_TIMEOUT_MS);
    if (made.code !== 0) return assessSshd({ ...base, localAddresses: [], answers: [], nonRootProof: { ok: false, problem: "sshd_config_unknown" } });
    return await askAll(base, ["-h", keyPath], deps, keyPath);
  } finally {
    if (keyDir !== null) deps.removeDir(keyDir);
  }
}
async function askAll(base, hostKeyArgs, deps, keyPath) {
  const localAddresses = reachableLocalAddresses(deps.interfaceAddresses());
  let nonRootProof;
  const refused = (answers2) => assessSshd({ ...base, localAddresses, answers: answers2, nonRootProof, probeHostKey: keyPath ?? void 0 });
  const ask = async (spec, extra = []) => {
    const connection = formatSshdConnectionSpec(spec);
    if (connection === null) return { spec, text: null };
    const out = await deps.run(SSHD_PROGRAM, ["-T", ...hostKeyArgs, ...extra, "-C", connection], SSHD_PROBE_TIMEOUT_MS);
    return { spec, text: out.code === 0 ? out.stdout : null };
  };
  const discovery = planSshdProbes({ ...base, localAddresses, listenPorts: null });
  if (discovery === null) return refused([]);
  const first = await ask(discovery[0]);
  const firstConfig = first.text === null ? null : parseSshdEffectiveConfig(first.text);
  if (firstConfig === null) return refused([first]);
  if (keyPath !== null) {
    const named = await ask(discovery[0], ["-f", SSHD_MAIN_CONFIG]);
    if (named.text !== first.text) {
      nonRootProof = { ok: false, problem: "sshd_config_unknown" };
      return refused([]);
    }
    const walk = walkIncludes(deps.fs);
    const daemon = !walk.ok ? walk : deps.platform === "linux" ? checkDaemon(deps.fs, pidfileOf(first.text), walk.files) : deps.platform === "darwin" ? await askDarwinDaemon(deps, walk.files) : { ok: false, problem: "sshd_daemon_unknown" };
    nonRootProof = daemon.ok ? { ok: true } : { ok: false, problem: daemon.problem };
    if (!nonRootProof.ok) return refused([]);
  }
  const plan = planSshdProbes({
    ...base,
    localAddresses: probeLocalAddresses(localAddresses, firstConfig.listenAddresses),
    listenPorts: firstConfig.listenPorts
  });
  if (plan === null || plan.length > SSHD_PROBE_MAX_QUERIES) return refused([]);
  const answers = [];
  for (const spec of plan) {
    answers.push(formatSshdConnectionSpec(spec) === formatSshdConnectionSpec(first.spec) ? first : await ask(spec));
  }
  return refused(answers);
}
async function askDarwinDaemon(deps, walked) {
  const out = async (file, args) => {
    const r = await deps.run(file, args, SSHD_PROBE_TIMEOUT_MS);
    return r.code === 0 ? r.stdout : null;
  };
  return checkDarwinDaemon({
    walkOwners: walked.map((f) => deps.fs.owner?.(f.path) ?? null),
    plistJson: await out(PLUTIL_PROGRAM, ["-convert", "json", "-o", "-", DARWIN_SSH_PLIST]),
    printDisabled: await out(LAUNCHCTL_PROGRAM, ["print-disabled", "system"]),
    printJob: await out(LAUNCHCTL_PROGRAM, ["print", "system/" + DARWIN_SSH_LABEL]),
    netstat: await out(NETSTAT_PROGRAM, ["-an"])
  });
}
function currentLoginUser() {
  const info = userInfo();
  return { name: info.username, isRoot: process.getuid?.() === 0, home: info.homedir };
}
function readCapped(path, max) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    return err.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { kind: "unreadable" };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return { kind: "unreadable" };
    }
    return { kind: "ok", text: buf.subarray(0, n).toString("latin1"), ctimeNs: st.ctimeNs };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}
var realNonRootFs = {
  readText: readCapped,
  listDir: (path) => {
    try {
      const names = readdirSync(path);
      return { kind: "ok", names, ctimeNs: statSync(path, { bigint: true }).ctimeNs };
    } catch (err) {
      return err.code === "ENOENT" ? { kind: "missing" } : { kind: "unlistable" };
    }
  },
  ctimeNs: (path) => {
    try {
      return statSync(path, { bigint: true }).ctimeNs;
    } catch {
      return null;
    }
  },
  owner: (path) => {
    try {
      const st = statSync(path);
      return { uid: st.uid, mode: st.mode };
    } catch {
      return null;
    }
  }
};
function createSshdProbeDeps(user = currentLoginUser()) {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve3) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" }
        },
        (err, stdout, stderr) => {
          if (err === null) resolve3({ code: 0, stdout, stderr });
          else resolve3({ code: typeof err.code === "number" && err.killed !== true ? err.code : null, stdout, stderr });
        }
      );
    }),
    user,
    interfaceAddresses: () => Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => ({ address: a.address, internal: a.internal }))),
    makePrivateDir: () => mkdtempSync(join(tmpdir(), "marveen-sshd-probe-")),
    removeDir: (path) => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
      }
    },
    fs: realNonRootFs,
    platform: process.platform
  };
}

// src/support-standby-enable.ts
import { join as join8 } from "node:path";

// src/support-access-fs.ts
import { lstatSync as lstatSync2, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/remote-enroll-fs.ts
import {
  openSync as openSync2,
  closeSync as closeSync2,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync as statSync2,
  lstatSync,
  existsSync,
  chmodSync,
  realpathSync
} from "node:fs";
import { join as join3, resolve } from "node:path";

// src/remote-enroll-core.ts
var REMOTE_PORT = 3420;
var HOSTNAME_LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
var HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*\\.?$`);
function restrictOptions(webPort = REMOTE_PORT) {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${webPort}",command="/bin/false"`;
}
var RESTRICT_OPTIONS = restrictOptions(REMOTE_PORT);

// src/test-run-marker.ts
function isTestRun() {
  return process.env["VITEST"] !== void 0 || process.env["NODE_ENV"] === "test";
}

// src/ssh-dir.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var SSH_DIR_GUARD_CODE = "ENROLL813";
var SshDirGuardError = class extends Error {
  code = SSH_DIR_GUARD_CODE;
  constructor(message) {
    super(message);
    this.name = "SshDirGuardError";
  }
};
function realSshDir() {
  return join2(homedir(), ".ssh");
}
function describeTestRunSignal() {
  const signals = [];
  if (process.env["VITEST"] !== void 0) signals.push(`VITEST=${process.env["VITEST"]}`);
  if (process.env["NODE_ENV"] === "test") signals.push("NODE_ENV=test");
  return signals.length > 0 ? signals.join(" + ") : "no test signal";
}

// src/remote-enroll-fs.ts
function assertSafeSshDir(sshDir, operation) {
  if (!isTestRun()) return;
  if (!isRealSshDir(sshDir)) return;
  throw new SshDirGuardError(
    `ENROLL813: refusing to ${operation} the REAL ${realSshDir()}/${AUTH_KEYS_NAME} from a test run (${describeTestRunSignal()}). Pass a scratch sshDir (the suite sets MARVEEN_SSH_DIR per worker in src/__tests__/setup/default-ssh-dir-seam.ts). This guard exists because a route test silently enrolled real keys for weeks.`
  );
}
function isRealSshDir(sshDir) {
  return canonical(sshDir) === canonical(realSshDir());
}
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
var SSH_DIR_MODE = 448;
var AUTH_KEYS_MODE = 384;
var AUTH_KEYS_NAME = "authorized_keys";
var SECOND_KEYS_NAME = "authorized_keys2";
var LOCK_NAME = "authorized_keys.lock";
var AuthorizedKeysLockError = class extends Error {
  code = "AUTHORIZED_KEYS_LOCKED";
  constructor(message) {
    super(message);
    this.name = "AuthorizedKeysLockError";
  }
};
var AuthorizedKeysRewriteError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "AuthorizedKeysRewriteError";
    this.code = code;
  }
};
var defaultSleep = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
function looserThan(mode, ownerMask) {
  return (mode & 511 & ~ownerMask) !== 0;
}
function fmtMode(mode) {
  return "0" + (mode & 511).toString(8).padStart(3, "0");
}
function ensureSshDir(sshDir, warnings) {
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: SSH_DIR_MODE });
    chmodSync(sshDir, SSH_DIR_MODE);
    return;
  }
  const st = statSync2(sshDir);
  if (!st.isDirectory()) {
    throw new Error(`${sshDir} exists but is not a directory`);
  }
  if (looserThan(st.mode, SSH_DIR_MODE)) {
    warnings.push(
      `${sshDir} permissions are ${fmtMode(st.mode)} (looser than 0700); leaving as-is`
    );
  }
}
async function acquireLock(lockPath, retries, delayMs, staleMs, sleep) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const fd = openSync2(lockPath, "wx", AUTH_KEYS_MODE);
      try {
        writeSync(fd, `${process.pid}
`);
      } catch {
      }
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = statSync2(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await sleep(delayMs);
    }
  }
  throw new AuthorizedKeysLockError(
    `could not acquire ${lockPath} after ${retries} attempts; another enrollment may be running`
  );
}
function releaseLock(fd, lockPath) {
  try {
    closeSync2(fd);
  } catch {
  }
  try {
    unlinkSync(lockPath);
  } catch {
  }
}
function writeAtomic(sshDir, authPath, content, encoding = "utf8") {
  const tmpPath = join3(sshDir, `.${AUTH_KEYS_NAME}.${process.pid}.${Date.now()}.tmp`);
  const tfd = openSync2(tmpPath, "wx", AUTH_KEYS_MODE);
  try {
    writeSync(tfd, content, null, encoding);
    fsyncSync(tfd);
  } finally {
    closeSync2(tfd);
  }
  chmodSync(tmpPath, AUTH_KEYS_MODE);
  try {
    renameSync(tmpPath, authPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
async function rewriteAuthorizedKeysLocked(opts, transform) {
  const {
    operation,
    fileName = AUTH_KEYS_NAME,
    createDir = false,
    refuseSymlink = false,
    preserveBytes = false,
    lockRetries = 20,
    lockRetryDelayMs = 100,
    staleLockMs = 15e3,
    sleep = defaultSleep
  } = opts;
  const sshDir = resolve(opts.sshDir);
  assertSafeSshDir(sshDir, operation);
  if (fileName !== AUTH_KEYS_NAME && fileName !== SECOND_KEYS_NAME) {
    throw new AuthorizedKeysRewriteError("AUTHORIZED_KEYS_FILE_NAME", "only authorized_keys and authorized_keys2 can be rewritten");
  }
  const warnings = [];
  const authPath = join3(sshDir, fileName);
  const lockPath = join3(sshDir, LOCK_NAME);
  const encoding = preserveBytes ? "latin1" : "utf8";
  if (refuseSymlink && lstatOrNull(sshDir)?.isSymbolicLink()) {
    throw new AuthorizedKeysRewriteError(
      "AUTHORIZED_KEYS_SYMLINK",
      `${sshDir} is a symbolic link; refusing to add access through it`
    );
  }
  if (createDir) ensureSshDir(sshDir, warnings);
  else if (!existsSync(sshDir)) {
    const out = transform("");
    assertSyncTransform(out);
    if (out.content !== null && out.content !== "") {
      throw new Error(`${sshDir} does not exist; refusing to create it for this operation`);
    }
    return { result: out.result, wrote: false, authorizedKeysPath: authPath, warnings };
  }
  const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep);
  try {
    let existing = "";
    const link = lstatOrNull(authPath);
    if (link !== null) {
      if (link.isSymbolicLink() && refuseSymlink) {
        throw new AuthorizedKeysRewriteError(
          "AUTHORIZED_KEYS_SYMLINK",
          `${authPath} is a symbolic link; refusing to add access through it`
        );
      }
      if (existsSync(authPath)) {
        const st = statSync2(authPath);
        if (looserThan(st.mode, AUTH_KEYS_MODE)) {
          warnings.push(
            `${authPath} permissions were ${fmtMode(st.mode)} (looser than 0600); the rewritten file is 0600`
          );
        }
        existing = readFileSync(authPath, encoding);
      }
    }
    const out = transform(existing);
    assertSyncTransform(out);
    if (out.content === null || out.content === existing) {
      return { result: out.result, wrote: false, authorizedKeysPath: authPath, warnings };
    }
    if (preserveBytes && /[^\u0000-\u00ff]/.test(out.content)) {
      throw new AuthorizedKeysRewriteError(
        "AUTHORIZED_KEYS_NOT_BYTES",
        `the new content of ${authPath} holds a character that is not one byte; nothing was written`
      );
    }
    writeAtomic(sshDir, authPath, out.content, encoding);
    if (readFileSync(authPath, encoding) !== out.content) {
      throw new AuthorizedKeysRewriteError(
        "AUTHORIZED_KEYS_READBACK",
        `${authPath} does not hold what was just written`
      );
    }
    if (link !== null && link.isSymbolicLink()) {
      warnings.push(
        `${authPath} was a symbolic link; it is now a regular file. The file the link pointed at was not changed and still holds its old lines: linking it back would bring them back`
      );
    }
    return { result: out.result, wrote: true, authorizedKeysPath: authPath, warnings };
  } finally {
    releaseLock(fd, lockPath);
  }
}
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function assertSyncTransform(out) {
  if (out !== null && typeof out === "object" && typeof out.then === "function") {
    throw new AuthorizedKeysRewriteError(
      "AUTHORIZED_KEYS_ASYNC_TRANSFORM",
      "the transform returned a promise; nothing slow may run while the lock is held"
    );
  }
}

// src/support-access-fs.ts
var SECOND_FILE = "authorized_keys2";
var SupportKeysLayoutError = class extends Error {
  code = "SUPPORT_KEYS_LAYOUT";
  constructor(message) {
    super(message);
    this.name = "SupportKeysLayoutError";
  }
};
function lstatOrNull2(path) {
  try {
    return lstatSync2(path);
  } catch {
    return null;
  }
}
function statOrNull(path) {
  try {
    return statSync3(path);
  } catch {
    return null;
  }
}
function keysFileLayout(sshDir) {
  const second = lstatOrNull2(join4(sshDir, SECOND_FILE));
  if (second === null) return "separate";
  const first = lstatOrNull2(join4(sshDir, "authorized_keys"));
  const sameAsFirst = (st) => first !== null && first.isFile() && st.dev === first.dev && st.ino === first.ino;
  if (second.isSymbolicLink()) {
    const target = statOrNull(join4(sshDir, SECOND_FILE));
    if (target === null) return "link-to-nothing";
    return sameAsFirst(target) ? "link-to-first" : "link-elsewhere";
  }
  return second.isFile() && sameAsFirst(second) ? "hard-link" : "separate";
}
function assertLayoutForGrant(sshDir) {
  const layout = keysFileLayout(sshDir);
  const second = join4(sshDir, SECOND_FILE);
  if (layout === "link-elsewhere") throw new SupportKeysLayoutError(`${second} is a symbolic link to another file than authorized_keys; nothing was written`);
  if (layout === "hard-link") throw new SupportKeysLayoutError(`${second} is a hard link of authorized_keys; nothing was written`);
}
function splitWarning(sshDir, before) {
  if (before !== "hard-link" || keysFileLayout(sshDir) === "hard-link") return [];
  return [
    `${join4(sshDir, "authorized_keys")} and ${join4(sshDir, SECOND_FILE)} were one file under two names; taking the support lines out split them into two files. Both hold the other lines as they were, but an edit of one no longer shows in the other`
  ];
}
async function removeEverySupportLine(base, fileName, operation, guard) {
  const { sshDir, pinnedBlobs, ...lock } = base;
  if (fileName === SECOND_FILE) {
    const secondPath = join4(sshDir, SECOND_FILE);
    const layout = keysFileLayout(sshDir);
    if (layout === "link-to-first" || layout === "link-to-nothing") {
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [`${secondPath} is a link to authorized_keys (or to nothing); it was cleaned through that file`] };
    }
    if (layout === "hard-link") {
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [] };
    }
    if (layout === "link-elsewhere") {
      let held = 0;
      try {
        held = countSupportLines(readFileSync2(secondPath, "latin1"), pinnedBlobs);
      } catch {
        throw new SupportKeysLayoutError(`${secondPath} is a symbolic link to a file that cannot be read; it was not written`);
      }
      if (held > 0) {
        throw new SupportKeysLayoutError(
          `${secondPath} is a symbolic link to another file that holds ${held} support line(s); it was not written. Remove the line(s) from that file by hand`
        );
      }
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [`${secondPath} is a symbolic link to another file; it holds no support line and was not written`] };
    }
  }
  let skipped = false;
  const out = await rewriteAuthorizedKeysLocked({ sshDir, fileName, operation, preserveBytes: true, ...lock }, (existing) => {
    if (guard !== void 0 && !guard()) {
      skipped = true;
      return { content: null, result: 0 };
    }
    const { content, removed } = removeSupportLines(existing, pinnedBlobs);
    const left = countSupportLines(content, pinnedBlobs);
    if (left !== 0) {
      throw new SupportLinesRemainError(`${left} support line(s) would remain in ${fileName} after the removal`);
    }
    return { content: removed === 0 ? null : content, result: removed };
  });
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result, warnings: out.warnings, ...skipped ? { skipped: true } : {} };
}
var SupportLinesRemainError = class extends Error {
  code = "SUPPORT_LINES_REMAIN";
  constructor(message) {
    super(message);
    this.name = "SupportLinesRemainError";
  }
};
async function grantSupportLines(opts) {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts;
  if (!grant.keys.every((key) => pinnedBlobs.has(key.pub))) {
    throw new SupportLineError("pins_invalid", "a key of the grant is not one of the pinned keys");
  }
  const lines = buildSupportGrantLines(grant);
  assertLayoutForGrant(sshDir);
  const second = await removeEverySupportLine({ sshDir, pinnedBlobs, ...lock }, SECOND_FILE, "remove support access lines from");
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: "write support access lines into", createDir: true, refuseSymlink: true, preserveBytes: true, ...lock },
    (existing) => {
      const merged = mergeSupportLines(existing, lines, pinnedBlobs);
      return { content: merged.content, result: merged.replaced };
    }
  );
  return {
    authorizedKeysPath: out.authorizedKeysPath,
    replaced: out.result,
    removedFromSecond: second.removed,
    warnings: [...second.warnings, ...out.warnings]
  };
}
async function revokeSupportLines(opts) {
  const operation = "remove support access lines from";
  const layoutBefore = keysFileLayout(opts.sshDir);
  const failures = [];
  const done = [];
  for (const fileName of ["authorized_keys", SECOND_FILE]) {
    try {
      done.push(await removeEverySupportLine(opts, fileName, operation));
    } catch (err) {
      failures.push(err);
      done.push(null);
    }
  }
  const [first, second] = done;
  if (first === null || second === null) throw failures[0];
  return {
    authorizedKeysPath: first.authorizedKeysPath,
    removed: first.removed + second.removed,
    removedFromSecond: second.removed,
    warnings: [...first.warnings, ...second.warnings, ...splitWarning(opts.sshDir, layoutBefore)]
  };
}
async function reconcileSupportLinesOnDisk(opts) {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts;
  let expected = [];
  let unbuildable = null;
  if (grant !== null) {
    try {
      expected = buildSupportGrantLines(grant);
    } catch (err) {
      unbuildable = err instanceof SupportLineError ? err.code : "grant_malformed";
    }
  }
  const operation = "reconcile support access lines in";
  const layoutBefore = keysFileLayout(sshDir);
  const failures = [];
  let first = null;
  let second = null;
  try {
    first = await reconcileFirstFile({ sshDir, pinnedBlobs, ...lock }, expected, operation);
  } catch (err) {
    failures.push(err);
  }
  try {
    second = await removeEverySupportLine({ sshDir, pinnedBlobs, ...lock }, SECOND_FILE, operation);
  } catch (err) {
    failures.push(err);
  }
  if (first === null || second === null) throw failures[0];
  return {
    authorizedKeysPath: first.authorizedKeysPath,
    kept: first.result.kept,
    removed: first.result.removed + second.removed,
    removedFromSecond: second.removed,
    missing: first.result.missing,
    lineEndOnly: first.result.lineEndOnly,
    unbuildable,
    warnings: [...first.warnings, ...second.warnings, ...splitWarning(sshDir, layoutBefore)]
  };
}
function reconcileFirstFile(base, expected, operation) {
  const { sshDir, pinnedBlobs, ...lock } = base;
  return rewriteAuthorizedKeysLocked({ sshDir, operation, preserveBytes: true, ...lock }, (existing) => {
    const r = reconcileSupportLines(existing, expected, pinnedBlobs);
    return {
      content: r.removed === 0 ? null : r.content,
      result: { kept: r.kept, removed: r.removed, missing: r.missing, lineEndOnly: r.lineEndOnly }
    };
  });
}

// src/support-access-redeem.ts
import { request } from "node:https";

// src/support-access-token.ts
import {
  closeSync as closeSync3,
  constants as constants2,
  fchmodSync,
  fstatSync as fstatSync2,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync3,
  openSync as openSync3,
  readSync as readSync2,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  writeSync as writeSync2
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join as join5 } from "node:path";
var SUPPORT_TOKEN_FILE = "support-access.token";
var TOKEN_MODE = 384;
var TOKEN_READ_CAP = 64;
var SUPPORT_TOKEN_SHAPE = /^mst_[A-Za-z0-9_-]{43}$/;
function isSupportToken(value) {
  return typeof value === "string" && SUPPORT_TOKEN_SHAPE.test(value);
}
var SENTENCES = {
  token_shape: "the value is not a support token",
  token_dir_unsafe: "the token directory is missing, is not a directory of this user, or is writable by others",
  token_path_unsafe: "the token path exists and is not a regular file",
  token_readback: "the token file does not hold what was written",
  token_remains: "the token file is still there after the removal"
};
var SupportTokenError = class extends Error {
  code;
  constructor(code) {
    super(SENTENCES[code]);
    this.name = "SupportTokenError";
    this.code = code;
  }
};
function lstatOrNull3(path) {
  try {
    return lstatSync3(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function effectiveUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}
function dirState(dir) {
  const st = lstatOrNull3(dir);
  if (st === null) return "missing";
  const uid = effectiveUid();
  if (!st.isDirectory() || (st.mode & 18) !== 0 || uid !== null && st.uid !== uid) return "unsafe";
  return "ok";
}
function assertSafeDir(dir) {
  if (dirState(dir) !== "ok") throw new SupportTokenError("token_dir_unsafe");
}
function writeSupportToken(dir, token) {
  if (!isSupportToken(token)) throw new SupportTokenError("token_shape");
  assertSafeDir(dir);
  const target = join5(dir, SUPPORT_TOKEN_FILE);
  const existing = lstatOrNull3(target);
  if (existing !== null && !existing.isFile()) throw new SupportTokenError("token_path_unsafe");
  const tmp = join5(dir, "." + SUPPORT_TOKEN_FILE + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  const fd = openSync3(tmp, "wx", TOKEN_MODE);
  try {
    try {
      fchmodSync(fd, TOKEN_MODE);
      writeSync2(fd, token + "\n");
      fsyncSync2(fd);
    } finally {
      closeSync3(fd);
    }
    renameSync2(tmp, target);
  } catch (err) {
    try {
      unlinkSync2(tmp);
    } catch {
    }
    throw err;
  }
  const back = readSupportToken(dir);
  if (back.kind !== "ok" || back.token !== token) {
    removeSupportToken(dir);
    throw new SupportTokenError("token_readback");
  }
}
function readSupportToken(dir) {
  const state = dirState(dir);
  if (state === "missing") return { kind: "missing" };
  if (state === "unsafe") return { kind: "invalid", reason: "dir" };
  const target = join5(dir, SUPPORT_TOKEN_FILE);
  let fd;
  try {
    fd = openSync3(target, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: "not_a_file" };
  }
  let content;
  try {
    const st = fstatSync2(fd);
    if (!st.isFile()) return { kind: "invalid", reason: "not_a_file" };
    const uid = effectiveUid();
    if (uid !== null && st.uid !== uid) return { kind: "invalid", reason: "owner" };
    if ((st.mode & 63) !== 0) return { kind: "invalid", reason: "mode" };
    const buf = Buffer.alloc(TOKEN_READ_CAP + 1);
    const n = readSync2(fd, buf, 0, buf.length, 0);
    if (n > TOKEN_READ_CAP) return { kind: "invalid", reason: "size" };
    content = buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync3(fd);
  }
  const token = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!isSupportToken(token)) return { kind: "invalid", reason: "shape" };
  return { kind: "ok", token };
}
function removeSupportToken(dir) {
  const target = join5(dir, SUPPORT_TOKEN_FILE);
  if (lstatOrNull3(target) === null) return { removed: false };
  try {
    unlinkSync2(target);
  } catch {
  }
  if (lstatOrNull3(target) !== null) throw new SupportTokenError("token_remains");
  return { removed: true };
}

// src/support-access-redeem.ts
var SUPPORT_CODE_SHAPE = /^msc_[A-Za-z0-9_-]{32}$/;
var SUPPORT_SERVICE_ORIGIN = "https://api.marveen.io";
var SUPPORT_REDEEM_PATH = "/support/v1/code-redeem";
var SUPPORT_REDEEM_TIMEOUT_MS = 1e4;
var SUPPORT_REDEEM_MAX_BODY_BYTES = 1024;
function classifySupportCode(input) {
  if (typeof input !== "string") return { ok: false, problem: "code_required" };
  const code = input.trim();
  if (code.length === 0) return { ok: false, problem: "code_required" };
  if (code.startsWith("mrv_")) return { ok: false, problem: "license_key_not_accepted" };
  if (!SUPPORT_CODE_SHAPE.test(code)) return { ok: false, problem: "code_shape" };
  return { ok: true, code };
}
function tokenFromBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "token") return null;
  const token = parsed.token;
  return isSupportToken(token) ? token : null;
}
async function redeemSupportCode(code, deps) {
  if (!SUPPORT_CODE_SHAPE.test(code)) throw new Error("redeemSupportCode needs a code that classifySupportCode accepted");
  let res;
  try {
    res = await deps.transport({
      origin: SUPPORT_SERVICE_ORIGIN,
      path: SUPPORT_REDEEM_PATH,
      body: JSON.stringify({ code, purpose: "support" }),
      timeoutMs: SUPPORT_REDEEM_TIMEOUT_MS,
      maxBodyBytes: SUPPORT_REDEEM_MAX_BODY_BYTES
    });
  } catch {
    return { ok: false, problem: "service_unavailable" };
  }
  if (res.status === 401) return { ok: false, problem: "code_rejected" };
  if (res.status === 429) return { ok: false, problem: "rate_limited" };
  if (res.status !== 200) return { ok: false, problem: "service_unavailable" };
  const token = tokenFromBody(res.body);
  if (token === null) return { ok: false, problem: "answer_unreadable" };
  return { ok: true, token };
}
function createHttpsRedeemTransport(opts = {}) {
  return (req) => new Promise((resolve3, reject) => {
    let url;
    try {
      url = new URL(req.path, req.origin);
    } catch {
      reject(new Error("the service address is not a URL"));
      return;
    }
    if (url.protocol !== "https:") {
      reject(new Error("the service address is not https"));
      return;
    }
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const call = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(req.body),
          ...req.bearer === void 0 ? {} : { authorization: "Bearer " + req.bearer }
        },
        rejectUnauthorized: true,
        ...opts.extraCa === void 0 ? {} : { ca: opts.extraCa }
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > req.maxBodyBytes) {
            call.destroy();
            finish(() => reject(new Error("the answer is longer than the limit")));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(() => resolve3({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
        res.on("error", () => finish(() => reject(new Error("the answer could not be read"))));
      }
    );
    const deadline = setTimeout(() => {
      call.destroy();
      finish(() => reject(new Error("no answer within the time limit")));
    }, req.timeoutMs);
    call.on("error", () => finish(() => reject(new Error("the request failed"))));
    call.end(req.body);
  });
}

// src/support-group-record.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import {
  closeSync as closeSync4,
  constants as constants3,
  fchmodSync as fchmodSync2,
  fstatSync as fstatSync3,
  fsyncSync as fsyncSync3,
  lstatSync as lstatSync4,
  openSync as openSync4,
  readdirSync as readdirSync2,
  readSync as readSync3,
  renameSync as renameSync3,
  unlinkSync as unlinkSync3,
  writeSync as writeSync3
} from "node:fs";
import { join as join6 } from "node:path";
var SUPPORT_GROUP_RECORD_FILE = "support-access.group";
var SUPPORT_RUN_DIR = "support-access.run";
var HEADER = "marveen-support-group 1";
var RECORD_MODE = 384;
var GROUP_RECORD_MAX_BYTES = 2048;
var GRANT_ID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var KEY_NAME3 = /^[a-z0-9]{1,16}$/;
var FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
var CIDR = /^[0-9A-Fa-f:.]+\/(?:32|128)$/;
var SAFE_ABSOLUTE_PATH2 = /^\/[A-Za-z0-9._/-]+$/;
var UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
var GroupRecordError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "GroupRecordError";
    this.code = code;
  }
};
function recordProblem(r) {
  if (!GRANT_ID2.test(r.grantId)) return "the grant id is not a uuid";
  if (!Number.isInteger(r.consentVersion) || r.consentVersion < 1 || r.consentVersion > 9999) return "the consent version is not a small positive number";
  if (!UTC_SECOND.test(r.consentAt) || Number.isNaN(Date.parse(r.consentAt))) return "the consent time is not a UTC second";
  if (r.keys.length < 1 || r.keys.length > 2) return "a group has one or two keys";
  const names = r.keys.map((k) => k.name);
  if (new Set(names).size !== names.length || names.join("\n") !== [...names].sort().join("\n")) return "the keys are not distinct and in name order";
  if (!r.keys.every((k) => KEY_NAME3.test(k.name) && FINGERPRINT.test(k.fingerprint))) return "a key is not a name and a fingerprint";
  if (r.fromCidrs.length < 1 || r.fromCidrs.length > 2 || !r.fromCidrs.every((c) => CIDR.test(c))) return "the sources are not one or two host addresses";
  if (!SAFE_ABSOLUTE_PATH2.test(r.dispatchPath)) return "the dispatcher path is not a plain absolute path";
  const { major, minor } = r.sshd;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 1 || major > 99 || minor < 0 || minor > 99) return "the sshd version is not a version";
  return null;
}
function formatGroupRecord(r) {
  const problem = recordProblem(r);
  if (problem !== null) throw new GroupRecordError("group_record_invalid", problem);
  const lines = [HEADER, "grant-id " + r.grantId, "consent " + r.consentVersion, "consent-at " + r.consentAt];
  for (const k of r.keys) lines.push("key " + k.name + " " + k.fingerprint);
  for (const c of r.fromCidrs) lines.push("from " + c);
  lines.push("dispatch " + r.dispatchPath, "sshd " + r.sshd.major + "." + r.sshd.minor);
  return lines.join("\n") + "\n";
}
function parseGroupRecord(text) {
  if (text.length > GROUP_RECORD_MAX_BYTES || !text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== HEADER) return null;
  const single = /* @__PURE__ */ new Map();
  const keys = [];
  const fromCidrs = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(" ");
    if (parts[0] === "key" && parts.length === 3) keys.push({ name: parts[1], fingerprint: parts[2] });
    else if (parts[0] === "from" && parts.length === 2) fromCidrs.push(parts[1]);
    else if (["grant-id", "consent", "consent-at", "dispatch", "sshd"].includes(parts[0]) && parts.length === 2) {
      if (single.has(parts[0])) return null;
      single.set(parts[0], parts[1]);
    } else return null;
  }
  const sshd = /^(\d{1,2})\.(\d{1,2})$/.exec(single.get("sshd") ?? "");
  const consent = single.get("consent") ?? "";
  const record = {
    grantId: single.get("grant-id") ?? "",
    consentVersion: /^[1-9][0-9]{0,3}$/.test(consent) ? Number(consent) : NaN,
    consentAt: single.get("consent-at") ?? "",
    keys,
    fromCidrs,
    dispatchPath: single.get("dispatch") ?? "",
    sshd: { major: sshd === null ? NaN : Number(sshd[1]), minor: sshd === null ? NaN : Number(sshd[2]) }
  };
  if (recordProblem(record) !== null) return null;
  return formatGroupRecord(record) === text ? record : null;
}
function lstatOrNull4(path) {
  try {
    return lstatSync4(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function effectiveUid2() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}
function dirIsSafe(dir) {
  const st = lstatOrNull4(dir);
  const uid = effectiveUid2();
  return st !== null && st.isDirectory() && (st.mode & 18) === 0 && (uid === null || st.uid === uid);
}
function readGroupRecord(supportDir) {
  const dir = lstatOrNull4(supportDir);
  if (dir === null) return { kind: "missing" };
  if (!dirIsSafe(supportDir)) return { kind: "invalid" };
  let fd;
  try {
    fd = openSync4(join6(supportDir, SUPPORT_GROUP_RECORD_FILE), constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_NONBLOCK);
  } catch (err) {
    return err.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const st = fstatSync3(fd);
    const uid = effectiveUid2();
    if (!st.isFile() || (st.mode & 63) !== 0 || uid !== null && st.uid !== uid) return { kind: "invalid" };
    const buf = Buffer.alloc(GROUP_RECORD_MAX_BYTES + 1);
    const n = readSync3(fd, buf, 0, buf.length, 0);
    if (n > GROUP_RECORD_MAX_BYTES) return { kind: "invalid" };
    const record = parseGroupRecord(buf.subarray(0, n).toString("latin1"));
    return record === null ? { kind: "invalid" } : { kind: "ok", record };
  } finally {
    closeSync4(fd);
  }
}
function writeGroupRecord(supportDir, record) {
  const text = formatGroupRecord(record);
  if (!dirIsSafe(supportDir)) throw new GroupRecordError("group_dir_unsafe", "the support folder is missing, not a folder of this user, or writable by others");
  const target = join6(supportDir, SUPPORT_GROUP_RECORD_FILE);
  const existing = lstatOrNull4(target);
  if (existing !== null && !existing.isFile()) throw new GroupRecordError("group_record_unsafe", "something that is not a regular file stands at the record path");
  const tmp = join6(supportDir, "." + SUPPORT_GROUP_RECORD_FILE + "." + process.pid + "." + randomBytes2(6).toString("hex") + ".tmp");
  const fd = openSync4(tmp, "wx", RECORD_MODE);
  try {
    try {
      fchmodSync2(fd, RECORD_MODE);
      writeSync3(fd, text);
      fsyncSync3(fd);
    } finally {
      closeSync4(fd);
    }
    renameSync3(tmp, target);
  } catch (err) {
    try {
      unlinkSync3(tmp);
    } catch {
    }
    throw err;
  }
  const back = readGroupRecord(supportDir);
  if (back.kind !== "ok" || formatGroupRecord(back.record) !== text) {
    removeGroupRecord(supportDir);
    throw new GroupRecordError("group_record_readback", "the record file does not hold what was written");
  }
}
function removeGroupRecord(supportDir) {
  const target = join6(supportDir, SUPPORT_GROUP_RECORD_FILE);
  if (lstatOrNull4(target) === null) return false;
  unlinkSync3(target);
  if (lstatOrNull4(target) !== null) throw new GroupRecordError("group_record_unsafe", "the record file is still there after the removal");
  return true;
}
function stopRunningDispatchers(supportDir) {
  const dir = join6(supportDir, SUPPORT_RUN_DIR);
  const st = lstatOrNull4(dir);
  if (st === null || !st.isDirectory()) return 0;
  let removed = 0;
  for (const name of readdirSync2(dir)) {
    if (!/^[0-9]{1,10}$/.test(name)) continue;
    const target = join6(dir, name);
    if (!lstatOrNull4(target)?.isFile()) continue;
    try {
      unlinkSync3(target);
      removed++;
    } catch {
    }
  }
  return removed;
}

// src/support-kit.ts
import { createHash as createHash2, randomBytes as randomBytes3 } from "node:crypto";
import {
  closeSync as closeSync5,
  constants as constants4,
  fstatSync as fstatSync4,
  fsyncSync as fsyncSync4,
  lstatSync as lstatSync5,
  mkdirSync as mkdirSync2,
  openSync as openSync5,
  readFileSync as readFileSync3,
  readSync as readSync4,
  readdirSync as readdirSync3,
  renameSync as renameSync4,
  rmSync as rmSync2,
  statSync as statSync4,
  unlinkSync as unlinkSync4,
  writeSync as writeSync4
} from "node:fs";
import { join as join7, resolve as resolve2 } from "node:path";
var KIT_SUBFOLDER = "kit";
var KIT_MANIFEST_NAME = "manifest";
var KIT_LOCK_NAME = "kit.lock";
var KIT_MANIFEST_HEADER = "marveen-support-kit 1";
var KIT_MANIFEST_MAX_BYTES = 4096;
var KIT_MAX_FILES = 16;
var KitError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "KitError";
    this.code = code;
  }
};
var FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var SHA256_HEX = /^[0-9a-f]{64}$/;
var RELEASE = /^[0-9a-f]{7,40}$/;
var SAFE_ABSOLUTE_PATH3 = /^\/[A-Za-z0-9._/-]+$/;
var SAFE_NODE_PATH = /^\/[A-Za-z0-9._@/-]+$/;
var LEFTOVER = /^\.kit-(?:new|old)-[0-9a-f]{16}$/;
function sha256Hex(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
function manifestProblem(m) {
  const names = Object.keys(m.files);
  if (names.length === 0) return "the kit has no file";
  if (names.length > KIT_MAX_FILES) return "the kit has more files than a manifest may name";
  for (const name of names) {
    if (!FILE_NAME.test(name) || name === KIT_MANIFEST_NAME) return "a file name is not a plain lower case name";
    if (!SHA256_HEX.test(m.files[name])) return "a hash is not 64 lower case hex digits";
  }
  if (!SAFE_ABSOLUTE_PATH3.test(m.installRoot)) return "the install root is not a plain absolute path";
  if (!SAFE_NODE_PATH.test(m.nodePath)) return "the node path is not a plain absolute path";
  if (!RELEASE.test(m.release)) return "the release is not a commit id";
  if (!Number.isInteger(m.nodeMin) || m.nodeMin < 1 || m.nodeMin > 999) return "the node minimum is not a major version";
  return null;
}
function formatKitManifest(m) {
  const problem = manifestProblem(m);
  if (problem !== null) throw new KitError("kit_input_invalid", problem);
  const lines = [KIT_MANIFEST_HEADER];
  for (const name of Object.keys(m.files).sort()) lines.push("file " + name + " " + m.files[name]);
  lines.push("install-root " + m.installRoot, "node " + m.nodePath, "node-min " + m.nodeMin, "release " + m.release);
  const text = lines.join("\n") + "\n";
  if (text.length > KIT_MANIFEST_MAX_BYTES) throw new KitError("kit_input_invalid", "the manifest would be larger than a manifest may be");
  return text;
}
function parseKitManifest(text) {
  if (text.length > KIT_MANIFEST_MAX_BYTES || !text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== KIT_MANIFEST_HEADER) return null;
  const files = {};
  const single = /* @__PURE__ */ new Map();
  for (const line of lines.slice(1)) {
    const parts = line.split(" ");
    if (parts[0] === "file" && parts.length === 3) {
      if (Object.prototype.hasOwnProperty.call(files, parts[1])) return null;
      files[parts[1]] = parts[2];
    } else if ((parts[0] === "install-root" || parts[0] === "node" || parts[0] === "node-min" || parts[0] === "release") && parts.length === 2) {
      if (single.has(parts[0])) return null;
      single.set(parts[0], parts[1]);
    } else return null;
  }
  const manifest = {
    files,
    installRoot: single.get("install-root") ?? "",
    nodePath: single.get("node") ?? "",
    // Only digits are a number here; the canonical-text check below refuses a leading zero or a sign.
    nodeMin: /^[0-9]{1,3}$/.test(single.get("node-min") ?? "") ? Number(single.get("node-min")) : NaN,
    release: single.get("release") ?? ""
  };
  if (manifestProblem(manifest) !== null) return null;
  return formatKitManifest(manifest) === text ? manifest : null;
}
function lstatOrNull5(path) {
  try {
    return lstatSync5(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function ownUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
function folderFinding(path, uid) {
  const st = lstatOrNull5(path);
  if (st === null) return { problem: "kit_missing", detail: path + " does not exist" };
  if (st.isSymbolicLink()) return { problem: "kit_link", detail: path + " is a symbolic link" };
  if (!st.isDirectory()) return { problem: "kit_not_a_folder", detail: path + " is not a folder" };
  if (uid !== null && st.uid !== uid) return { problem: "kit_foreign_owner", detail: path + " belongs to another user" };
  if ((st.mode & 18) !== 0) return { problem: "kit_writable_by_others", detail: path + " can be written by group or others" };
  return null;
}
var KIT_FILE_MAX_BYTES = 4 * 1024 * 1024;
function readKitFile(path, uid, max) {
  const no = (problem, detail, tooLarge = false) => ({ ok: false, finding: { problem, detail: path + detail }, tooLarge });
  let fd;
  try {
    fd = openSync5(path, constants4.O_RDONLY | constants4.O_NOFOLLOW | constants4.O_NONBLOCK);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") return no("kit_file_missing", " does not exist");
    if (code === "ELOOP") return no("kit_link", " is a symbolic link");
    return no("kit_mismatch", " cannot be opened");
  }
  try {
    const st = fstatSync4(fd);
    if (!st.isFile()) return no("kit_mismatch", " is not a regular file");
    if (uid !== null && st.uid !== uid) return no("kit_foreign_owner", " belongs to another user");
    if ((st.mode & 18) !== 0) return no("kit_writable_by_others", " can be written by group or others");
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync4(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return no("kit_mismatch", " is larger than a kit file may be", true);
    }
    return { ok: true, bytes: buf.subarray(0, n) };
  } finally {
    closeSync5(fd);
  }
}
function verifyKit(opts) {
  const supportDir = resolve2(opts.supportDir);
  const uid = opts.uid === void 0 ? ownUid() : opts.uid;
  const kitDir = join7(supportDir, KIT_SUBFOLDER);
  const refuse = (finding) => ({ ok: false, ...finding });
  for (const folder of [supportDir, kitDir]) {
    const finding = folderFinding(folder, uid);
    if (finding !== null) return refuse(finding);
  }
  const manifestPath = join7(kitDir, KIT_MANIFEST_NAME);
  const manifestRead = readKitFile(manifestPath, uid, KIT_MANIFEST_MAX_BYTES);
  if (!manifestRead.ok) {
    const missingOrLarge = manifestRead.finding.problem === "kit_file_missing" || manifestRead.tooLarge;
    return refuse(missingOrLarge ? { problem: "kit_manifest_unreadable", detail: manifestRead.finding.detail } : manifestRead.finding);
  }
  const manifest = parseKitManifest(manifestRead.bytes.toString("latin1"));
  if (manifest === null) return refuse({ problem: "kit_manifest_unreadable", detail: manifestPath + " is not a manifest" });
  for (const name of Object.keys(manifest.files).sort()) {
    const path = join7(kitDir, name);
    const read = readKitFile(path, uid, KIT_FILE_MAX_BYTES);
    if (!read.ok) return refuse(read.finding);
    if (sha256Hex(read.bytes) !== manifest.files[name]) {
      return refuse({ problem: "kit_mismatch", detail: path + " is not the file the manifest names" });
    }
  }
  return { ok: true, kitDir, manifest };
}
var defaultSleep2 = (ms) => new Promise((done) => setTimeout(done, ms));
async function withKitLock(supportDir, tuning, work) {
  const { lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15e3, sleep = defaultSleep2 } = tuning;
  const lockPath = join7(resolve2(supportDir), KIT_LOCK_NAME);
  let fd = null;
  for (let attempt = 0; attempt < lockRetries && fd === null; attempt++) {
    try {
      fd = openSync5(lockPath, "wx", 384);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync4(lockPath).mtimeMs > staleLockMs;
      } catch {
        continue;
      }
      if (stale) {
        try {
          unlinkSync4(lockPath);
        } catch {
        }
        continue;
      }
      await sleep(lockRetryDelayMs);
    }
  }
  if (fd === null) {
    throw new KitError("kit_locked", `could not take ${lockPath} after ${lockRetries} attempts; another kit write or a reconcile is running`);
  }
  try {
    const out = work();
    if (out !== null && typeof out === "object" && typeof out.then === "function") {
      throw new KitError("kit_input_invalid", "the work under the kit lock returned a promise; nothing slow may run while the lock is held");
    }
    return out;
  } finally {
    try {
      closeSync5(fd);
    } catch {
    }
    try {
      unlinkSync4(lockPath);
    } catch {
    }
  }
}
function writeNewFile(path, content, mode) {
  const fd = openSync5(path, "wx", mode);
  try {
    writeSync4(fd, content);
    fsyncSync4(fd);
  } finally {
    closeSync5(fd);
  }
}
function syncFolder(path) {
  try {
    const fd = openSync5(path, "r");
    try {
      fsyncSync4(fd);
    } finally {
      closeSync5(fd);
    }
  } catch {
  }
}
async function writeKit(opts) {
  const { files, installRoot, nodePath, nodeMin, release, ...tuning } = opts;
  const supportDir = resolve2(opts.supportDir);
  if (!SAFE_ABSOLUTE_PATH3.test(supportDir)) {
    throw new KitError("kit_input_invalid", "the support folder is not a plain absolute path");
  }
  const hashes = {};
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(hashes, file.name)) throw new KitError("kit_input_invalid", "a file name is given twice");
    hashes[file.name] = file.sha256;
  }
  const manifest = { files: hashes, installRoot, nodePath, nodeMin, release };
  const manifestText = formatKitManifest(manifest);
  for (const file of files) {
    if (sha256Hex(file.content) !== file.sha256) {
      throw new KitError("kit_source_mismatch", `${file.name} in the install tree is not the file of this release (its hash is not the stored one); nothing was written`);
    }
  }
  const uid = ownUid();
  if (lstatOrNull5(supportDir) === null) mkdirSync2(supportDir, { recursive: true, mode: 448 });
  const parentFinding = folderFinding(supportDir, uid);
  if (parentFinding !== null) throw new KitError(parentFinding.problem, parentFinding.detail + "; the kit is not written there");
  const kitDir = join7(supportDir, KIT_SUBFOLDER);
  return withKitLock(supportDir, tuning, () => {
    const cleaned = [];
    for (const name of readdirSync3(supportDir).sort()) {
      if (!LEFTOVER.test(name)) continue;
      rmSync2(join7(supportDir, name), { recursive: true, force: true });
      cleaned.push(name);
    }
    const existing = lstatOrNull5(kitDir);
    if (existing !== null) {
      const finding = folderFinding(kitDir, uid);
      if (finding !== null) throw new KitError(finding.problem, finding.detail + "; the kit is not written over it");
    }
    const suffix = randomBytes3(8).toString("hex");
    const staging = join7(supportDir, ".kit-new-" + suffix);
    const aside = join7(supportDir, ".kit-old-" + suffix);
    mkdirSync2(staging, { mode: 448 });
    try {
      for (const file of files) writeNewFile(join7(staging, file.name), file.content, file.executable ? 448 : 384);
      writeNewFile(join7(staging, KIT_MANIFEST_NAME), Buffer.from(manifestText, "latin1"), 384);
      for (const file of files) {
        if (sha256Hex(readFileSync3(join7(staging, file.name))) !== file.sha256) {
          throw new KitError("kit_mismatch", `${file.name} does not hold what was just written`);
        }
      }
      syncFolder(staging);
    } catch (err) {
      rmSync2(staging, { recursive: true, force: true });
      throw err;
    }
    if (existing !== null) {
      try {
        renameSync4(kitDir, aside);
      } catch (err) {
        rmSync2(staging, { recursive: true, force: true });
        throw err;
      }
    }
    renameSync4(staging, kitDir);
    syncFolder(supportDir);
    if (existing !== null) rmSync2(aside, { recursive: true, force: true });
    const verdict = verifyKit({ supportDir });
    if (!verdict.ok) throw new KitError(verdict.problem, "the kit that was just written does not verify: " + verdict.detail);
    return { kitDir, replaced: existing !== null, cleaned };
  });
}

// src/support-access-hostkey.ts
import { closeSync as closeSync6, constants as constants5, fstatSync as fstatSync5, openSync as openSync6, readSync as readSync5 } from "node:fs";
var DEFAULT_ED25519_HOST_KEY_PUB = "/etc/ssh/ssh_host_ed25519_key.pub";
var HOST_KEY_PUB_MAX_BYTES = 4096;
var SSH_KEYSCAN_PROGRAM = "/usr/bin/ssh-keyscan";
var SUPPORT_HOST_KEY_SCAN_TIMEOUT_S = 5;
var SUPPORT_HOST_KEY_SCAN_RUN_MS = 7e3;
var SUPPORT_HOST_KEY_SCAN_ADDRESS = "127.0.0.1";
var SUPPORT_HOST_KEY_PATH = "/support/v1/host-key";
var SUPPORT_HOST_KEY_TIMEOUT_MS = 1e4;
var SUPPORT_HOST_KEY_MAX_BODY_BYTES = 2048;
var ED25519_TYPE = "ssh-ed25519";
var ED25519_LINE = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/;
function ed25519HostKey(text) {
  const m = ED25519_LINE.exec(text);
  if (m === null) return null;
  const blob = Buffer.from(m[1], "base64");
  if (blob.readUInt32BE(0) !== ED25519_TYPE.length || blob.subarray(4, 15).toString("latin1") !== ED25519_TYPE) return null;
  if (blob.readUInt32BE(15) !== 32) return null;
  return text;
}
function hostKeyFromKeyscan(stdout) {
  let found = null;
  for (const line of stdout.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(" ");
    if (fields.length !== 3 || fields[0] === "") return null;
    const key = ed25519HostKey(fields[1] + " " + fields[2]);
    if (key === null || found !== null) return null;
    found = key;
  }
  return found;
}
async function scanOwnHostKey(port, run) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const out = await run(
      SSH_KEYSCAN_PROGRAM,
      ["-T", String(SUPPORT_HOST_KEY_SCAN_TIMEOUT_S), "-t", "ed25519", "-p", String(port), SUPPORT_HOST_KEY_SCAN_ADDRESS],
      SUPPORT_HOST_KEY_SCAN_RUN_MS
    );
    return out.code === 0 ? hostKeyFromKeyscan(out.stdout) : null;
  } catch {
    return null;
  }
}
function confirmsAsRootFile(st) {
  return st.isFile && st.uid === 0 && (st.mode & 18) === 0;
}
function readRootOwnedPub(path) {
  let fd;
  try {
    fd = openSync6(path, constants5.O_RDONLY | constants5.O_NOFOLLOW | constants5.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync5(fd);
    if (!confirmsAsRootFile({ uid: st.uid, mode: st.mode, isFile: st.isFile() })) return null;
    const buf = Buffer.alloc(HOST_KEY_PUB_MAX_BYTES + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync5(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > HOST_KEY_PUB_MAX_BYTES) return null;
    }
    return buf.subarray(0, n).toString("latin1");
  } catch {
    return null;
  } finally {
    closeSync6(fd);
  }
}
function keyOfPub(text) {
  const fields = text.replace(/\n$/, "").split(" ");
  return fields.length < 2 ? null : ed25519HostKey(fields[0] + " " + fields[1]);
}
function hostKeyPubCandidates(hostKeyFiles) {
  const out = hostKeyFiles.filter((p) => p.startsWith("/")).map((p) => p + ".pub");
  out.push(DEFAULT_ED25519_HOST_KEY_PUB);
  return [...new Set(out)];
}
async function readOwnHostKey(sshd, deps) {
  const key = await scanOwnHostKey(sshd.listenPorts[0], deps.run);
  if (key === null) return { kind: "missing" };
  for (const path of hostKeyPubCandidates(sshd.hostKeyFiles)) {
    let text;
    try {
      text = deps.readRootPub(path);
    } catch {
      text = null;
    }
    if (text !== null && keyOfPub(text) === key) return { kind: "ok", key };
  }
  return { kind: "unverified" };
}
async function sendSupportHostKey(input, transport) {
  try {
    const res = await transport({
      origin: SUPPORT_SERVICE_ORIGIN,
      path: SUPPORT_HOST_KEY_PATH,
      body: JSON.stringify({ host_key: input.hostKey }),
      timeoutMs: SUPPORT_HOST_KEY_TIMEOUT_MS,
      maxBodyBytes: SUPPORT_HOST_KEY_MAX_BODY_BYTES,
      bearer: input.token
    });
    return res.status === 200 ? "stored" : "not_stored";
  } catch {
    return "not_stored";
  }
}

// src/support-kit-sources.ts
var KIT_HASHES_FILE = "scripts/support-kit.sha256";
var KIT_LAUNCHER_NAME = "support-access";
var KIT_DISPATCHER_NAME = "support-dispatch.sh";
var KIT_ROUTINE_NAME = "support-standby.mjs";
var KIT_SOURCES = [
  { name: KIT_LAUNCHER_NAME, treePath: "scripts/support-access", executable: true },
  { name: KIT_DISPATCHER_NAME, treePath: "scripts/support-dispatch.sh", executable: false },
  { name: KIT_ROUTINE_NAME, treePath: "scripts/support-standby.mjs", executable: false }
];
var HASH_LINE = /^([0-9a-f]{64}) {2}([a-z0-9][a-z0-9._-]{0,63})$/;
function parseKitHashes(text) {
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  const out = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const m = HASH_LINE.exec(line);
    if (m === null || out.has(m[2])) return null;
    out.set(m[2], m[1]);
  }
  const expected = KIT_SOURCES.map((s) => s.name);
  return [...out.keys()].join("\n") === expected.join("\n") ? out : null;
}

// src/support-standby-enable.ts
var SUPPORT_CONSENT_VERSION = 2;
function utcSecond(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
async function enableSupportStandby(input, deps) {
  const no = (problem) => ({ ok: false, problem });
  if (!deps.startedFromKit) return no("enable_not_from_kit");
  const code = classifySupportCode(input.code);
  if (!code.ok) return no(code.problem);
  if (input.consentVersion !== SUPPORT_CONSENT_VERSION) return no("consent_invalid");
  const { keys, fromCidrs } = deps.pins;
  const pins = validateSupportPins(keys, fromCidrs);
  if (!pins.ok) return no(pins.code);
  if (readSupportToken(deps.supportDir).kind !== "missing" || readGroupRecord(deps.supportDir).kind !== "missing") return no("already_on");
  const sshd = await deps.probeSshd(fromCidrs);
  if (!sshd.ok) return no(sshd.problem);
  const own = await deps.readHostKey(sshd);
  if (own.kind !== "ok") return no(own.kind === "missing" ? "host_key_missing" : "host_key_unverified");
  const hostKey = own.key;
  const kit = verifyKit({ supportDir: deps.supportDir });
  if (!kit.ok) return no(kit.problem);
  if (kit.manifest.files[KIT_DISPATCHER_NAME] === void 0) return no("kit_mismatch");
  const dispatchPath = join8(kit.kitDir, KIT_DISPATCHER_NAME);
  const layout = keysFileLayout(deps.sshDir);
  if (layout === "link-elsewhere" || layout === "hard-link") return no("keys_file_layout");
  const redeemed = await redeemSupportCode(code.code, { transport: deps.redeemTransport });
  if (!redeemed.ok) return no(redeemed.problem);
  const pinnedBlobs = new Set(keys.map((k) => k.pub));
  const grantId = deps.newGrantId();
  const sortedKeys = [...keys].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  try {
    writeSupportToken(deps.supportDir, redeemed.token);
    writeGroupRecord(deps.supportDir, {
      grantId,
      consentVersion: SUPPORT_CONSENT_VERSION,
      consentAt: utcSecond(deps.now()),
      keys: sortedKeys.map((k) => ({ name: k.name, fingerprint: k.fingerprint })),
      fromCidrs: [...fromCidrs],
      dispatchPath,
      sshd: sshd.version
    });
    await grantSupportLines({
      sshDir: deps.sshDir,
      pinnedBlobs,
      grant: { keys: sortedKeys, fromCidrs, grantId, consentVersion: SUPPORT_CONSENT_VERSION, dispatchPath, sshd: sshd.version }
    });
  } catch (err) {
    try {
      await revokeSupportLines({ sshDir: deps.sshDir, pinnedBlobs });
    } catch {
    }
    try {
      removeGroupRecord(deps.supportDir);
    } catch {
    }
    try {
      removeSupportToken(deps.supportDir);
    } catch {
    }
    if (err instanceof SupportKeysLayoutError) return no("keys_file_layout");
    if (err instanceof SupportLineError) return no("support_pins_invalid");
    return no("enable_write_failed");
  }
  const sent = await sendSupportHostKey({ token: redeemed.token, hostKey }, deps.redeemTransport);
  return { ok: true, keys: sortedKeys.map((k) => k.name), lines: sortedKeys.length, hostKey: sent };
}
async function disableSupportStandby(deps) {
  const pinnedBlobs = new Set(deps.pins.keys.map((k) => k.pub));
  let removedLines = 0;
  let linesFailed = false;
  try {
    removedLines = (await revokeSupportLines({ sshDir: deps.sshDir, pinnedBlobs })).removed;
  } catch {
    linesFailed = true;
  }
  let tokenFailed = false;
  try {
    removeSupportToken(deps.supportDir);
  } catch {
    tokenFailed = true;
  }
  let recordFailed = false;
  try {
    removeGroupRecord(deps.supportDir);
  } catch {
    recordFailed = true;
  }
  try {
    stopRunningDispatchers(deps.supportDir);
  } catch {
  }
  if (linesFailed) return { ok: false, problem: "lines_remain", removedLines };
  if (tokenFailed) return { ok: false, problem: "token_remains", removedLines };
  if (recordFailed) return { ok: false, problem: "record_remains", removedLines };
  return { ok: true, removedLines };
}

// src/support-consent-text.ts
import { createHash as createHash3 } from "node:crypto";
var SUPPORT_CONSENT_LAUNCHER_LANG = "hu";
var SUPPORT_CONSENT_TEXTS = {
  1: null,
  2: {
    hu: "Mit tehet\xFCnk a g\xE9peden\nA bel\xE9p\xE9s alatt a Marveen csapata, munkat\xE1rsaink \xE9s AI-\xFCgyn\xF6keink, mindent megtehetnek a g\xE9peden, ami a hiba felt\xE1r\xE1s\xE1hoz \xE9s kijav\xEDt\xE1s\xE1hoz sz\xFCks\xE9ges: parancsokat futtathatnak, f\xE1jlokat \xE9s be\xE1ll\xEDt\xE1sokat olvashatnak \xE9s m\xF3dos\xEDthatnak, \xE9s \xFAjraind\xEDthatj\xE1k a Marveent \xE9s a szolg\xE1ltat\xE1sait. Azzal a felhaszn\xE1l\xF3val dolgozunk, amelyikkel a Marveened fut; enn\xE9l t\xF6bb jogot nem szerz\xFCnk. Ha a Marveened rendszergazdak\xE9nt (root) fut, mi is \xEDgy l\xE9p\xFCnk be. A g\xE9peden futtatott parancsokkal csak a hib\xE1t keress\xFCk \xE9s jav\xEDtjuk; a helyi h\xE1l\xF3zatodon l\xE9v\u0151 m\xE1s eszk\xF6z\xF6kh\xF6z nem ny\xFAlunk.\nEgy kapcsolaton legfeljebb 60 percig adhatunk ki parancsot; ut\xE1na \xFAjat csak egy munkat\xE1rsunk nyithat, a saj\xE1t fizikai kulcs\xE1val.\nMit l\xE1tunk\nMindent, amit a jav\xEDt\xE1shoz meg kell n\xE9zn\xFCnk a g\xE9peden: a Marveen napl\xF3it, be\xE1ll\xEDt\xE1sait \xE9s adatait, ha kell, a t\xE1rolt hozz\xE1f\xE9r\xE9si kulcsokat \xE9s a besz\xE9lget\xE9seid r\xE9szleteit is, azt is, amit te vagy a partnereid a csatorn\xE1idra \xEDrtatok.\nAmit a jav\xEDt\xE1s k\xF6zben l\xE1tunk, kitakarva t\xE1roljuk: a munka r\xE9szletes lefoly\xE1s\xE1t legfeljebb 30 napig.\nNyom \xE9s ellen\u0151rz\xE9s\nMinden lefuttatott parancs napl\xF3z\xF3dik a g\xE9peden. A bel\xE9p\xE9sekr\u0151l sz\xF3l\xF3 napl\xF3t 12 h\xF3napig \u0151rizz\xFCk. Az engedett bel\xE9p\xE9sekr\u0151l e-mailt kapsz.\nA hozz\xE1f\xE9r\xE9st a Profil oldaladon egy kattint\xE1ssal b\xE1rmikor lez\xE1rhatod; az \xE9ppen fut\xF3 m\u0171velet ezut\xE1n m\xE9g befejez\u0151dhet, \xFAjat nem ind\xEDthatunk.",
    en: "What we can do on your machine\nWhile we are signed in, the Marveen team, our staff and our AI agents, can do whatever is needed on your machine to find and fix the problem: run commands, read and change files and settings, and restart Marveen and its services. We work as the user your Marveen runs as; we do not gain any further rights. If your Marveen runs as the system administrator (root), we sign in that way too. We use the commands on your machine only to find and fix the problem; we do not touch other devices on your local network.\nOn one connection we can issue commands for at most 60 minutes; after that only a staff member can open a new one, with their own physical key.\nWhat we see\nWhatever we need to look at on your machine to fix the problem: Marveen's logs, settings and data, and if needed the stored access keys and the details of your conversations, including what you or your partners wrote on your channels.\nWhat we see while fixing is stored with secrets masked: the detailed record of the work for at most 30 days.\nRecord and control\nEvery command we run is logged on your machine. We keep the record of sign-ins for 12 months. You get an e-mail about allowed sign-ins.\nYou can lock access with one click on your Profile page at any time; an operation already running may still finish, but we cannot start a new one."
  }
};
function approved(version, lang) {
  if (!Object.prototype.hasOwnProperty.call(SUPPORT_CONSENT_TEXTS, version)) return void 0;
  const byLang = SUPPORT_CONSENT_TEXTS[version];
  if (byLang === null) return null;
  const text = byLang[lang];
  return typeof text === "string" && text.length > 0 ? text : null;
}
function supportConsentText(version, lang = SUPPORT_CONSENT_LAUNCHER_LANG) {
  const text = approved(version, lang);
  if (text === void 0) return { ok: false, problem: "consent_invalid" };
  if (text === null) return { ok: false, problem: "consent_text_unset" };
  return { ok: true, text: text.endsWith("\n") ? text : text + "\n" };
}
function supportConsentSha256(version, lang) {
  if (lang === null) return null;
  const text = approved(version, lang);
  if (typeof text !== "string") return null;
  return createHash3("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// src/support-standby.ts
var SUPPORT_ROUTINE_MIN_NODE_MAJOR = 20;
var SUPPORT_DISPATCH_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
function standbyOf(files) {
  const { token, record } = files;
  if (token === "invalid" || record.kind === "invalid") return { state: "invalid", keys: [] };
  if (token === "missing" && record.kind === "missing") return { state: "off", keys: [] };
  if (token === "ok" && record.kind === "ok") return { state: "on", keys: record.keys };
  return { state: "partial", keys: [] };
}
function nodeMajor(version) {
  const m = /^v(\d{1,3})\.\d{1,3}\.\d{1,3}/.exec(version);
  return m === null ? null : Number(m[1]);
}
function keysFileState(content, pinnedBlobs) {
  if (content === null) return { state: "absent" };
  if (content === "unreadable") return { state: "unreadable" };
  return { state: "read", supportLines: countSupportLines(content, pinnedBlobs) };
}
async function supportStatus(deps) {
  const major = nodeMajor(deps.nodeVersion);
  const pinsCheck = validateSupportPins(deps.pins.keys, deps.pins.fromCidrs);
  const pinnedBlobs = new Set(deps.pins.keys.filter((k) => parseSkEd25519Blob(k.pub).ok).map((k) => k.pub));
  let sshd = "not_asked";
  let sshdVersion = null;
  if (pinsCheck.ok) {
    const assessed = await deps.probeSshd(deps.pins.fromCidrs);
    sshd = assessed.ok ? "ok" : assessed.problem;
    sshdVersion = assessed.version === null ? null : assessed.version.major + "." + assessed.version.minor;
  }
  const curl = SUPPORT_DISPATCH_PATH.map((dir) => dir + "/curl").find((path) => deps.isExecutable(path)) ?? null;
  return {
    node: { version: deps.nodeVersion, ok: major !== null && major >= SUPPORT_ROUTINE_MIN_NODE_MAJOR },
    pins: pinsCheck.ok ? "ok" : pinsCheck.code,
    sshd,
    sshdVersion,
    curl,
    keysFiles: {
      authorized_keys: keysFileState(deps.readKeysFile("authorized_keys"), pinnedBlobs),
      authorized_keys2: keysFileState(deps.readKeysFile("authorized_keys2"), pinnedBlobs)
    },
    standby: standbyOf(deps.readStandbyFiles())
  };
}
function keysFileText(state) {
  return state.state === "read" ? String(state.supportLines) : state.state;
}
function formatSupportStatus(report) {
  return [
    "node=" + (report.node.ok ? "ok" : "too_old"),
    "node_version=" + report.node.version,
    "node_minimum=" + SUPPORT_ROUTINE_MIN_NODE_MAJOR,
    "pins=" + report.pins,
    "sshd=" + report.sshd,
    "sshd_version=" + (report.sshdVersion ?? "unknown"),
    "curl=" + (report.curl === null ? "missing" : "present"),
    "support_lines=" + keysFileText(report.keysFiles.authorized_keys),
    "support_lines_second_file=" + keysFileText(report.keysFiles.authorized_keys2),
    "standby=" + report.standby.state,
    "standby_keys=" + (report.standby.keys.length === 0 ? "none" : report.standby.keys.join(",")),
    // The launcher takes the version it shows and passes to enable from here (Samu 78475, Geri 78479).
    "consent_version=" + SUPPORT_CONSENT_VERSION,
    // which text that version is, in the language the launcher shows it (RUFLOIDEAS1115, Samu 79440 / 79453);
    // the launcher does not read these two
    "consent_lang=" + SUPPORT_CONSENT_LAUNCHER_LANG,
    "consent_sha256=" + (supportConsentSha256(SUPPORT_CONSENT_VERSION, SUPPORT_CONSENT_LAUNCHER_LANG) ?? "none")
  ].join("\n") + "\n";
}

// src/support-kit-install.ts
import { accessSync, constants as constants6, closeSync as closeSync7, fstatSync as fstatSync6, lstatSync as lstatSync6, openSync as openSync7, readSync as readSync6, statSync as statSync5 } from "node:fs";
import { join as join9 } from "node:path";
var SUPPORT_DIR_IN_HOME = ".marveen/support";
var KIT_SOURCE_MAX_BYTES = KIT_FILE_MAX_BYTES;
var HASHES_MAX_BYTES = 4096;
var SAFE_ABSOLUTE_PATH4 = /^\/[A-Za-z0-9._/-]+$/;
function readTreeFile(path, max) {
  let fd;
  try {
    fd = openSync7(path, constants6.O_RDONLY | constants6.O_NOFOLLOW | constants6.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync6(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync6(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return null;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync7(fd);
  }
}
async function installKit(input) {
  const { installRoot, nodePath, release, supportDir, ...tuning } = input;
  for (const [what, path] of [["install root", installRoot], ["support folder", supportDir]]) {
    if (!SAFE_ABSOLUTE_PATH4.test(path)) throw new KitError("kit_input_invalid", "the " + what + " is not a plain absolute path");
  }
  if (!SAFE_NODE_PATH.test(nodePath)) throw new KitError("kit_input_invalid", "the node path is not a plain absolute path");
  let rootIsFolder = false;
  try {
    rootIsFolder = lstatSync6(installRoot).isDirectory();
  } catch {
  }
  if (!rootIsFolder) throw new KitError("kit_input_invalid", "the install root is not a folder");
  try {
    if (!statSync5(nodePath).isFile()) throw new Error("not a file");
    accessSync(nodePath, constants6.X_OK);
  } catch {
    throw new KitError("kit_input_invalid", "the node path is not an executable file");
  }
  const hashesBytes = readTreeFile(join9(installRoot, KIT_HASHES_FILE), HASHES_MAX_BYTES);
  const stored = hashesBytes === null ? null : parseKitHashes(hashesBytes.toString("latin1"));
  if (stored === null) {
    throw new KitError("kit_source_mismatch", "the stored hashes of this release are missing or unreadable; nothing was written");
  }
  const files = [];
  for (const source of KIT_SOURCES) {
    const content = readTreeFile(join9(installRoot, source.treePath), KIT_SOURCE_MAX_BYTES);
    if (content === null) {
      throw new KitError("kit_source_mismatch", source.name + " is missing from the install tree or is not a plain file; nothing was written");
    }
    files.push({ name: source.name, content, sha256: stored.get(source.name), executable: source.executable });
  }
  return writeKit({ supportDir, files, installRoot, nodePath, nodeMin: SUPPORT_ROUTINE_MIN_NODE_MAJOR, release, ...tuning });
}

// src/support-standby-cli.ts
var SUPPORT_CLI_USAGE = "usage: support-standby.mjs status\n       support-standby.mjs verify-kit\n       support-standby.mjs install-kit --install-root <path> --node <path> --release <commit>\n       support-standby.mjs enable --consent <version>   (the code on standard input)\n       support-standby.mjs disable\n       support-standby.mjs consent-text --consent <version>\n";
var SUPPORT_CODE_MAX_INPUT = 64;
function startedFromKit(moduleUrl = import.meta.url) {
  try {
    return new URL(moduleUrl).protocol === "data:";
  } catch {
    return false;
  }
}
var INSTALL_KIT_FLAGS = {
  "--install-root": "installRoot",
  "--node": "nodePath",
  "--release": "release"
};
function parseInstallKitArgs(argv) {
  if (argv.length !== 6) return null;
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = Object.prototype.hasOwnProperty.call(INSTALL_KIT_FLAGS, argv[i]) ? INSTALL_KIT_FLAGS[argv[i]] : void 0;
    if (key === void 0 || out[key] !== void 0 || argv[i + 1].length === 0) return null;
    out[key] = argv[i + 1];
  }
  return out.installRoot !== void 0 && out.nodePath !== void 0 && out.release !== void 0 ? { installRoot: out.installRoot, nodePath: out.nodePath, release: out.release } : null;
}
function createInstallKit(account = currentLoginUser()) {
  return (args) => installKit({ ...args, supportDir: join10(account.home, SUPPORT_DIR_IN_HOME) });
}
function createStatusDeps(account = currentLoginUser()) {
  const sshDir = join10(account.home, ".ssh");
  return {
    nodeVersion: process.version,
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    isExecutable: (path) => {
      try {
        accessSync2(path, constants7.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readKeysFile: (name) => {
      try {
        return readFileSync4(join10(sshDir, name), "latin1");
      } catch (err) {
        return err.code === "ENOENT" ? null : "unreadable";
      }
    },
    readStandbyFiles: () => {
      const supportDir = join10(account.home, SUPPORT_DIR_IN_HOME);
      const token = readSupportToken(supportDir);
      const record = readGroupRecord(supportDir);
      return {
        token: token.kind === "ok" ? "ok" : token.kind,
        record: record.kind === "ok" ? { kind: "ok", keys: record.record.keys.map((k) => k.name) } : record
      };
    }
  };
}
function createStandbyDeps(account = currentLoginUser(), moduleUrl = import.meta.url) {
  return {
    supportDir: join10(account.home, SUPPORT_DIR_IN_HOME),
    sshDir: join10(account.home, ".ssh"),
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    readHostKey: (sshd) => readOwnHostKey(sshd, { run: createSshdProbeDeps(account).run, readRootPub: readRootOwnedPub }),
    redeemTransport: createHttpsRedeemTransport(),
    now: () => /* @__PURE__ */ new Date(),
    newGrantId: () => randomUUID(),
    startedFromKit: startedFromKit(moduleUrl)
  };
}
async function readStdinCapped(max, stdin = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function createVerifyKit(account = currentLoginUser()) {
  return () => verifyKit({ supportDir: join10(account.home, SUPPORT_DIR_IN_HOME) });
}
async function runSupportCli(argv, io, deps) {
  if (argv.length === 1 && argv[0] === "status") {
    io.out(formatSupportStatus(await supportStatus(deps.status())));
    return 0;
  }
  if (argv.length === 1 && argv[0] === "verify-kit" && deps.verifyKit !== void 0) {
    const verdict = deps.verifyKit();
    io.out("kit=" + (verdict.ok ? "ok" : verdict.problem) + "\n");
    return 0;
  }
  const installArgs = argv[0] === "install-kit" ? parseInstallKitArgs(argv.slice(1)) : null;
  if (installArgs !== null) {
    try {
      const done = await deps.installKit(installArgs);
      io.out("kit=written\nreplaced=" + (done.replaced ? "yes" : "no") + "\ncleaned=" + done.cleaned.length + "\n");
      return 0;
    } catch (err) {
      if (!(err instanceof KitError)) throw err;
      io.err("install-kit: refused: " + err.code + "\n");
      return 1;
    }
  }
  if (argv.length === 3 && argv[0] === "enable" && argv[1] === "--consent" && /^[1-9][0-9]{0,3}$/.test(argv[2])) {
    const code = await deps.readCode();
    const done = await enableSupportStandby({ code: code ?? "", consentVersion: Number(argv[2]) }, deps.standby());
    if (!done.ok) {
      io.err("enable: refused: " + done.problem + "\n");
      return 1;
    }
    io.out("standby=on\nstandby_keys=" + done.keys.join(",") + "\nsupport_lines=" + done.lines + "\nhost_key=" + done.hostKey + "\nlogins=refused_by_this_release\n");
    return 0;
  }
  if (argv.length === 3 && argv[0] === "consent-text" && argv[1] === "--consent" && /^[1-9][0-9]{0,3}$/.test(argv[2])) {
    const consent = supportConsentText(Number(argv[2]));
    if (!consent.ok) {
      io.err("consent-text: refused: " + consent.problem + "\n");
      return 1;
    }
    io.out(consent.text);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "disable") {
    const done = await disableSupportStandby(deps.standby());
    if (!done.ok) {
      io.err("disable: incomplete: " + done.problem + "\n");
      return 1;
    }
    io.out("standby=off\nremoved_lines=" + done.removedLines + "\n");
    return 0;
  }
  io.err(SUPPORT_CLI_USAGE);
  return 2;
}
async function main(argv) {
  try {
    return await runSupportCli(
      argv,
      { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
      {
        status: createStatusDeps,
        installKit: createInstallKit(),
        verifyKit: createVerifyKit(),
        standby: () => createStandbyDeps(),
        readCode: () => readStdinCapped(SUPPORT_CODE_MAX_INPUT)
      }
    );
  } catch {
    process.stderr.write("support-standby: stopped on an unexpected error\n");
    return 1;
  }
}
function startedDirectly() {
  try {
    return realpathSync2(process.argv[1] ?? "") === realpathSync2(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (startedDirectly()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  SUPPORT_CLI_USAGE,
  SUPPORT_CODE_MAX_INPUT,
  SUPPORT_ROUTINE_MIN_NODE_MAJOR,
  buildSupportGrantLines,
  buildSupportLine,
  createInstallKit,
  createStandbyDeps,
  createStatusDeps,
  createVerifyKit,
  formatSupportStatus,
  grantSupportLines,
  main,
  parseInstallKitArgs,
  readStdinCapped,
  reconcileSupportLinesOnDisk,
  revokeSupportLines,
  runSupportCli,
  startedFromKit,
  supportStatus
};
