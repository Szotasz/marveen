// GENERATED FILE, DO NOT EDIT. The support routine as one self-contained file:
// only node's own modules, no node_modules, nothing from the compiled tree.
// Source: src/support-standby-cli.ts. Rebuild: node scripts/build-support-standby.mjs

// src/support-standby-cli.ts
import { accessSync, constants as constants2, readFileSync as readFileSync2, realpathSync as realpathSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { fileURLToPath } from "node:url";

// src/support-access-pins.ts
import { createHash } from "node:crypto";
import { isIP } from "node:net";
var SUPPORT_KEY_TYPE = "sk-ssh-ed25519@openssh.com";
var SUPPORT_MAX_KEYS = 2;
var SUPPORT_MAX_FROM = 2;
var SUPPORT_KEYS = [];
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
function walkIncludes(fs, main = SSHD_MAIN_CONFIG) {
  const files = [];
  const mainDir = posix.dirname(main);
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
  const problem = visit(main, 0);
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
function isSupportLine(line, pinnedBlobs) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
  const fields = splitAuthorizedKeysLine(trimmed);
  if (fields === null) {
    const words = trimmed.split(/\s+/);
    return words.some((w) => w.startsWith(SUPPORT_COMMENT_PREFIX) || pinnedBlobs.has(w));
  }
  if (pinnedBlobs.has(fields.blob)) return true;
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
  const kept = splitLines(existing).filter((line) => {
    if (wanted.has(line) && !seen.has(line)) {
      seen.add(line);
      return true;
    }
    if (wanted.has(line) || isSupportLine(line, pinnedBlobs)) {
      removed++;
      return false;
    }
    return true;
  });
  return {
    content: removed === 0 ? existing : joinLines(kept),
    kept: seen.size,
    removed,
    missing: wanted.size - seen.size
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
    listenAddresses: [...addresses].sort()
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
  return { ok: true, version, keysFiles };
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
  const refused = (answers2) => assessSshd({ ...base, localAddresses, answers: answers2, nonRootProof });
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
    const daemon = !walk.ok ? walk : deps.platform === "linux" ? checkDaemon(deps.fs, pidfileOf(first.text), walk.files) : { ok: false, problem: "sshd_daemon_unknown" };
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
  }
};
function createSshdProbeDeps(user = currentLoginUser()) {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve2) => {
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
          if (err === null) resolve2({ code: 0, stdout, stderr });
          else resolve2({ code: typeof err.code === "number" && err.killed !== true ? err.code : null, stdout, stderr });
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

// src/support-standby.ts
var SUPPORT_ROUTINE_MIN_NODE_MAJOR = 20;
var SUPPORT_DISPATCH_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
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
    }
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
    "support_lines_second_file=" + keysFileText(report.keysFiles.authorized_keys2)
  ].join("\n") + "\n";
}

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
var defaultSleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
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
  const warnings = [];
  const authPath = join3(sshDir, AUTH_KEYS_NAME);
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
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: "write support access lines into", createDir: true, refuseSymlink: true, preserveBytes: true, ...lock },
    (existing) => {
      const merged = mergeSupportLines(existing, lines, pinnedBlobs);
      return { content: merged.content, result: merged.replaced };
    }
  );
  return { authorizedKeysPath: out.authorizedKeysPath, replaced: out.result, warnings: out.warnings };
}
async function revokeSupportLines(opts) {
  const { sshDir, pinnedBlobs, ...lock } = opts;
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: "remove support access lines from", preserveBytes: true, ...lock },
    (existing) => {
      const { content, removed } = removeSupportLines(existing, pinnedBlobs);
      const left = countSupportLines(content, pinnedBlobs);
      if (left !== 0) {
        throw new SupportLinesRemainError(`${left} support line(s) would remain after the removal`);
      }
      return { content: removed === 0 ? null : content, result: removed };
    }
  );
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result, warnings: out.warnings };
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
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: "reconcile support access lines in", preserveBytes: true, ...lock },
    (existing) => {
      const r = reconcileSupportLines(existing, expected, pinnedBlobs);
      return {
        content: r.removed === 0 ? null : r.content,
        result: { kept: r.kept, removed: r.removed, missing: r.missing }
      };
    }
  );
  return { authorizedKeysPath: out.authorizedKeysPath, ...out.result, unbuildable, warnings: out.warnings };
}

// src/support-standby-cli.ts
var SUPPORT_CLI_USAGE = "usage: support-standby.mjs status\n";
function createStatusDeps(account = currentLoginUser()) {
  const sshDir = join4(account.home, ".ssh");
  return {
    nodeVersion: process.version,
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    isExecutable: (path) => {
      try {
        accessSync(path, constants2.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readKeysFile: (name) => {
      try {
        return readFileSync2(join4(sshDir, name), "latin1");
      } catch (err) {
        return err.code === "ENOENT" ? null : "unreadable";
      }
    }
  };
}
async function runSupportCli(argv, io, deps) {
  if (argv.length === 1 && argv[0] === "status") {
    io.out(formatSupportStatus(await supportStatus(deps.status())));
    return 0;
  }
  io.err(SUPPORT_CLI_USAGE);
  return 2;
}
function startedDirectly() {
  try {
    return realpathSync2(process.argv[1] ?? "") === realpathSync2(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (startedDirectly()) {
  runSupportCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    { status: createStatusDeps }
  ).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("support-standby: stopped on an unexpected error\n");
      process.exitCode = 1;
    }
  );
}
export {
  SUPPORT_CLI_USAGE,
  SUPPORT_ROUTINE_MIN_NODE_MAJOR,
  buildSupportGrantLines,
  buildSupportLine,
  createStatusDeps,
  formatSupportStatus,
  grantSupportLines,
  reconcileSupportLinesOnDisk,
  revokeSupportLines,
  runSupportCli,
  supportStatus
};
