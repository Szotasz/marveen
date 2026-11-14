// GENERATED FILE, DO NOT EDIT. The support routine as one self-contained file:
// only node's own modules, no node_modules, nothing from the compiled tree.
// Source: src/support-standby-cli.ts. Rebuild: node scripts/build-support-standby.mjs

// src/support-standby-cli.ts
import { accessSync as accessSync2, constants as constants2, readFileSync as readFileSync3, realpathSync as realpathSync2 } from "node:fs";
import { join as join5 } from "node:path";
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
import { networkInterfaces, userInfo } from "node:os";

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
    bytes = [...pinnedBlobs].map((blob) => Buffer.from(blob, "base64")).filter((b) => b.length > 0);
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
  if (!input.loginIsRoot) return refuse("sshd_config_not_fully_readable");
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
  if (!configs.every((c) => ROOT_LOGIN_BY_KEY.has(c.permitRootLogin))) return refuse("root_login_disabled");
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
  if (versionText === null || !deps.user.isRoot) return assessSshd({ ...base, localAddresses: [], answers: [] });
  const localAddresses = reachableLocalAddresses(deps.interfaceAddresses());
  const refused = (answers2) => assessSshd({ ...base, localAddresses, answers: answers2 });
  const ask = async (spec) => {
    const connection = formatSshdConnectionSpec(spec);
    if (connection === null) return { spec, text: null };
    const out = await deps.run(SSHD_PROGRAM, ["-T", "-C", connection], SSHD_PROBE_TIMEOUT_MS);
    return { spec, text: out.code === 0 ? out.stdout : null };
  };
  const discovery = planSshdProbes({ ...base, localAddresses, listenPorts: null });
  if (discovery === null) return refused([]);
  const first = await ask(discovery[0]);
  const firstConfig = first.text === null ? null : parseSshdEffectiveConfig(first.text);
  if (firstConfig === null) return refused([first]);
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
    interfaceAddresses: () => Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => ({ address: a.address, internal: a.internal })))
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

// src/support-kit.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join, resolve } from "node:path";
var KIT_SUBFOLDER = "kit";
var KIT_MANIFEST_NAME = "manifest";
var KIT_LOCK_NAME = "kit.lock";
var KIT_MANIFEST_HEADER = "marveen-support-kit 1";
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
var SAFE_ABSOLUTE_PATH2 = /^\/[A-Za-z0-9._/-]+$/;
var SAFE_NODE_PATH = /^\/[A-Za-z0-9._@/-]+$/;
var LEFTOVER = /^\.kit-(?:new|old)-[0-9a-f]{16}$/;
function sha256Hex(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
function manifestProblem(m) {
  const names = Object.keys(m.files);
  if (names.length === 0) return "the kit has no file";
  for (const name of names) {
    if (!FILE_NAME.test(name) || name === KIT_MANIFEST_NAME) return "a file name is not a plain lower case name";
    if (!SHA256_HEX.test(m.files[name])) return "a hash is not 64 lower case hex digits";
  }
  if (!SAFE_ABSOLUTE_PATH2.test(m.installRoot)) return "the install root is not a plain absolute path";
  if (!SAFE_NODE_PATH.test(m.nodePath)) return "the node path is not a plain absolute path";
  if (!RELEASE.test(m.release)) return "the release is not a commit id";
  return null;
}
function formatKitManifest(m) {
  const problem = manifestProblem(m);
  if (problem !== null) throw new KitError("kit_input_invalid", problem);
  const lines = [KIT_MANIFEST_HEADER];
  for (const name of Object.keys(m.files).sort()) lines.push("file " + name + " " + m.files[name]);
  lines.push("install-root " + m.installRoot, "node " + m.nodePath, "release " + m.release);
  return lines.join("\n") + "\n";
}
function parseKitManifest(text) {
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== KIT_MANIFEST_HEADER) return null;
  const files = {};
  const single = /* @__PURE__ */ new Map();
  for (const line of lines.slice(1)) {
    const parts = line.split(" ");
    if (parts[0] === "file" && parts.length === 3) {
      if (Object.prototype.hasOwnProperty.call(files, parts[1])) return null;
      files[parts[1]] = parts[2];
    } else if ((parts[0] === "install-root" || parts[0] === "node" || parts[0] === "release") && parts.length === 2) {
      if (single.has(parts[0])) return null;
      single.set(parts[0], parts[1]);
    } else return null;
  }
  const manifest = {
    files,
    installRoot: single.get("install-root") ?? "",
    nodePath: single.get("node") ?? "",
    release: single.get("release") ?? ""
  };
  if (manifestProblem(manifest) !== null) return null;
  return formatKitManifest(manifest) === text ? manifest : null;
}
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function ownUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
function folderFinding(path, uid) {
  const st = lstatOrNull(path);
  if (st === null) return { problem: "kit_missing", detail: path + " does not exist" };
  if (st.isSymbolicLink()) return { problem: "kit_link", detail: path + " is a symbolic link" };
  if (!st.isDirectory()) return { problem: "kit_not_a_folder", detail: path + " is not a folder" };
  if (uid !== null && st.uid !== uid) return { problem: "kit_foreign_owner", detail: path + " belongs to another user" };
  return null;
}
function fileFinding(path, uid) {
  const st = lstatOrNull(path);
  if (st === null) return { problem: "kit_file_missing", detail: path + " does not exist" };
  if (st.isSymbolicLink()) return { problem: "kit_link", detail: path + " is a symbolic link" };
  if (!st.isFile()) return { problem: "kit_mismatch", detail: path + " is not a regular file" };
  if (uid !== null && st.uid !== uid) return { problem: "kit_foreign_owner", detail: path + " belongs to another user" };
  return null;
}
function verifyKit(opts) {
  const supportDir = resolve(opts.supportDir);
  const uid = opts.uid === void 0 ? ownUid() : opts.uid;
  const kitDir = join(supportDir, KIT_SUBFOLDER);
  const refuse = (finding) => ({ ok: false, ...finding });
  for (const folder of [supportDir, kitDir]) {
    const finding = folderFinding(folder, uid);
    if (finding !== null) return refuse(finding);
  }
  const manifestPath = join(kitDir, KIT_MANIFEST_NAME);
  const manifestFinding = fileFinding(manifestPath, uid);
  if (manifestFinding !== null) {
    return refuse(manifestFinding.problem === "kit_file_missing" ? { problem: "kit_manifest_unreadable", detail: manifestFinding.detail } : manifestFinding);
  }
  const manifest = parseKitManifest(readFileSync(manifestPath, "latin1"));
  if (manifest === null) return refuse({ problem: "kit_manifest_unreadable", detail: manifestPath + " is not a manifest" });
  for (const name of Object.keys(manifest.files).sort()) {
    const path = join(kitDir, name);
    const finding = fileFinding(path, uid);
    if (finding !== null) return refuse(finding);
    if (sha256Hex(readFileSync(path)) !== manifest.files[name]) {
      return refuse({ problem: "kit_mismatch", detail: path + " is not the file the manifest names" });
    }
  }
  return { ok: true, kitDir, manifest };
}
var defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function withKitLock(supportDir, tuning, work) {
  const { lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15e3, sleep = defaultSleep } = tuning;
  const lockPath = join(resolve(supportDir), KIT_LOCK_NAME);
  let fd = null;
  for (let attempt = 0; attempt < lockRetries && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx", 384);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > staleLockMs;
      } catch {
        continue;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
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
      closeSync(fd);
    } catch {
    }
    try {
      unlinkSync(lockPath);
    } catch {
    }
  }
}
function writeNewFile(path, content, mode) {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncFolder(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}
async function writeKit(opts) {
  const { files, installRoot, nodePath, release, ...tuning } = opts;
  const supportDir = resolve(opts.supportDir);
  if (!SAFE_ABSOLUTE_PATH2.test(supportDir)) {
    throw new KitError("kit_input_invalid", "the support folder is not a plain absolute path");
  }
  const hashes = {};
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(hashes, file.name)) throw new KitError("kit_input_invalid", "a file name is given twice");
    hashes[file.name] = file.sha256;
  }
  const manifest = { files: hashes, installRoot, nodePath, release };
  const manifestText = formatKitManifest(manifest);
  for (const file of files) {
    if (sha256Hex(file.content) !== file.sha256) {
      throw new KitError("kit_source_mismatch", `${file.name} in the install tree is not the file of this release (its hash is not the stored one); nothing was written`);
    }
  }
  const uid = ownUid();
  if (lstatOrNull(supportDir) === null) mkdirSync(supportDir, { recursive: true, mode: 448 });
  const parentFinding = folderFinding(supportDir, uid);
  if (parentFinding !== null) throw new KitError(parentFinding.problem, parentFinding.detail + "; the kit is not written there");
  const kitDir = join(supportDir, KIT_SUBFOLDER);
  return withKitLock(supportDir, tuning, () => {
    const cleaned = [];
    for (const name of readdirSync(supportDir).sort()) {
      if (!LEFTOVER.test(name)) continue;
      rmSync(join(supportDir, name), { recursive: true, force: true });
      cleaned.push(name);
    }
    const existing = lstatOrNull(kitDir);
    if (existing !== null) {
      const finding = folderFinding(kitDir, uid);
      if (finding !== null) throw new KitError(finding.problem, finding.detail + "; the kit is not written over it");
    }
    const suffix = randomBytes(8).toString("hex");
    const staging = join(supportDir, ".kit-new-" + suffix);
    const aside = join(supportDir, ".kit-old-" + suffix);
    mkdirSync(staging, { mode: 448 });
    try {
      for (const file of files) writeNewFile(join(staging, file.name), file.content, file.executable ? 448 : 384);
      writeNewFile(join(staging, KIT_MANIFEST_NAME), Buffer.from(manifestText, "latin1"), 384);
      for (const file of files) {
        if (sha256Hex(readFileSync(join(staging, file.name))) !== file.sha256) {
          throw new KitError("kit_mismatch", `${file.name} does not hold what was just written`);
        }
      }
      syncFolder(staging);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    if (existing !== null) {
      try {
        renameSync(kitDir, aside);
      } catch (err) {
        rmSync(staging, { recursive: true, force: true });
        throw err;
      }
    }
    renameSync(staging, kitDir);
    syncFolder(supportDir);
    if (existing !== null) rmSync(aside, { recursive: true, force: true });
    const verdict = verifyKit({ supportDir });
    if (!verdict.ok) throw new KitError(verdict.problem, "the kit that was just written does not verify: " + verdict.detail);
    return { kitDir, replaced: existing !== null, cleaned };
  });
}

// src/support-kit-install.ts
import { accessSync, constants, closeSync as closeSync2, fstatSync, lstatSync as lstatSync2, openSync as openSync2, readSync, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/support-kit-sources.ts
var KIT_HASHES_FILE = "scripts/support-kit.sha256";
var KIT_SOURCES = [
  { name: "support-dispatch.sh", treePath: "scripts/support-dispatch.sh", executable: false },
  { name: "support-standby.mjs", treePath: "scripts/support-standby.mjs", executable: false }
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

// src/support-kit-install.ts
var SUPPORT_DIR_IN_HOME = ".marveen/support";
var KIT_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
var HASHES_MAX_BYTES = 4096;
var SAFE_ABSOLUTE_PATH3 = /^\/[A-Za-z0-9._/-]+$/;
function readTreeFile(path, max) {
  let fd;
  try {
    fd = openSync2(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return null;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync2(fd);
  }
}
async function installKit(input) {
  const { installRoot, nodePath, release, supportDir, ...tuning } = input;
  for (const [what, path] of [["install root", installRoot], ["support folder", supportDir]]) {
    if (!SAFE_ABSOLUTE_PATH3.test(path)) throw new KitError("kit_input_invalid", "the " + what + " is not a plain absolute path");
  }
  if (!SAFE_NODE_PATH.test(nodePath)) throw new KitError("kit_input_invalid", "the node path is not a plain absolute path");
  let rootIsFolder = false;
  try {
    rootIsFolder = lstatSync2(installRoot).isDirectory();
  } catch {
  }
  if (!rootIsFolder) throw new KitError("kit_input_invalid", "the install root is not a folder");
  try {
    if (!statSync2(nodePath).isFile()) throw new Error("not a file");
    accessSync(nodePath, constants.X_OK);
  } catch {
    throw new KitError("kit_input_invalid", "the node path is not an executable file");
  }
  const hashesBytes = readTreeFile(join2(installRoot, KIT_HASHES_FILE), HASHES_MAX_BYTES);
  const stored = hashesBytes === null ? null : parseKitHashes(hashesBytes.toString("latin1"));
  if (stored === null) {
    throw new KitError("kit_source_mismatch", "the stored hashes of this release are missing or unreadable; nothing was written");
  }
  const files = [];
  for (const source of KIT_SOURCES) {
    const content = readTreeFile(join2(installRoot, source.treePath), KIT_SOURCE_MAX_BYTES);
    if (content === null) {
      throw new KitError("kit_source_mismatch", source.name + " is missing from the install tree or is not a plain file; nothing was written");
    }
    files.push({ name: source.name, content, sha256: stored.get(source.name), executable: source.executable });
  }
  return writeKit({ supportDir, files, installRoot, nodePath, release, ...tuning });
}

// src/remote-enroll-fs.ts
import {
  openSync as openSync3,
  closeSync as closeSync3,
  writeSync as writeSync2,
  fsyncSync as fsyncSync2,
  readFileSync as readFileSync2,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  mkdirSync as mkdirSync2,
  statSync as statSync3,
  lstatSync as lstatSync3,
  existsSync,
  chmodSync,
  realpathSync
} from "node:fs";
import { join as join4, resolve as resolve2 } from "node:path";

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
import { join as join3 } from "node:path";
var SSH_DIR_GUARD_CODE = "ENROLL813";
var SshDirGuardError = class extends Error {
  code = SSH_DIR_GUARD_CODE;
  constructor(message) {
    super(message);
    this.name = "SshDirGuardError";
  }
};
function realSshDir() {
  return join3(homedir(), ".ssh");
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
    return resolve2(p);
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
var defaultSleep2 = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
function looserThan(mode, ownerMask) {
  return (mode & 511 & ~ownerMask) !== 0;
}
function fmtMode(mode) {
  return "0" + (mode & 511).toString(8).padStart(3, "0");
}
function ensureSshDir(sshDir, warnings) {
  if (!existsSync(sshDir)) {
    mkdirSync2(sshDir, { recursive: true, mode: SSH_DIR_MODE });
    chmodSync(sshDir, SSH_DIR_MODE);
    return;
  }
  const st = statSync3(sshDir);
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
      const fd = openSync3(lockPath, "wx", AUTH_KEYS_MODE);
      try {
        writeSync2(fd, `${process.pid}
`);
      } catch {
      }
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = statSync3(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          unlinkSync2(lockPath);
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
    closeSync3(fd);
  } catch {
  }
  try {
    unlinkSync2(lockPath);
  } catch {
  }
}
function writeAtomic(sshDir, authPath, content, encoding = "utf8") {
  const tmpPath = join4(sshDir, `.${AUTH_KEYS_NAME}.${process.pid}.${Date.now()}.tmp`);
  const tfd = openSync3(tmpPath, "wx", AUTH_KEYS_MODE);
  try {
    writeSync2(tfd, content, null, encoding);
    fsyncSync2(tfd);
  } finally {
    closeSync3(tfd);
  }
  chmodSync(tmpPath, AUTH_KEYS_MODE);
  try {
    renameSync2(tmpPath, authPath);
  } catch (err) {
    try {
      unlinkSync2(tmpPath);
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
    sleep = defaultSleep2
  } = opts;
  const sshDir = resolve2(opts.sshDir);
  assertSafeSshDir(sshDir, operation);
  if (fileName !== AUTH_KEYS_NAME && fileName !== SECOND_KEYS_NAME) {
    throw new AuthorizedKeysRewriteError("AUTHORIZED_KEYS_FILE_NAME", "only authorized_keys and authorized_keys2 can be rewritten");
  }
  const warnings = [];
  const authPath = join4(sshDir, fileName);
  const lockPath = join4(sshDir, LOCK_NAME);
  const encoding = preserveBytes ? "latin1" : "utf8";
  if (refuseSymlink && lstatOrNull2(sshDir)?.isSymbolicLink()) {
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
    const link = lstatOrNull2(authPath);
    if (link !== null) {
      if (link.isSymbolicLink() && refuseSymlink) {
        throw new AuthorizedKeysRewriteError(
          "AUTHORIZED_KEYS_SYMLINK",
          `${authPath} is a symbolic link; refusing to add access through it`
        );
      }
      if (existsSync(authPath)) {
        const st = statSync3(authPath);
        if (looserThan(st.mode, AUTH_KEYS_MODE)) {
          warnings.push(
            `${authPath} permissions were ${fmtMode(st.mode)} (looser than 0600); the rewritten file is 0600`
          );
        }
        existing = readFileSync2(authPath, encoding);
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
    if (readFileSync2(authPath, encoding) !== out.content) {
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
function lstatOrNull2(path) {
  try {
    return lstatSync3(path);
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
async function removeEverySupportLine(base, fileName, operation) {
  const { sshDir, pinnedBlobs, ...lock } = base;
  const out = await rewriteAuthorizedKeysLocked({ sshDir, fileName, operation, preserveBytes: true, ...lock }, (existing) => {
    const { content, removed } = removeSupportLines(existing, pinnedBlobs);
    const left = countSupportLines(content, pinnedBlobs);
    if (left !== 0) {
      throw new SupportLinesRemainError(`${left} support line(s) would remain in ${fileName} after the removal`);
    }
    return { content: removed === 0 ? null : content, result: removed };
  });
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result, warnings: out.warnings };
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
    warnings: [...first.warnings, ...second.warnings]
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
    warnings: [...first.warnings, ...second.warnings]
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

// src/support-standby-cli.ts
var SUPPORT_CLI_USAGE = "usage: support-standby.mjs status\n       support-standby.mjs install-kit --install-root <path> --node <path> --release <commit>\n";
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
  return (args) => installKit({ ...args, supportDir: join5(account.home, SUPPORT_DIR_IN_HOME) });
}
function createStatusDeps(account = currentLoginUser()) {
  const sshDir = join5(account.home, ".ssh");
  return {
    nodeVersion: process.version,
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    isExecutable: (path) => {
      try {
        accessSync2(path, constants2.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readKeysFile: (name) => {
      try {
        return readFileSync3(join5(sshDir, name), "latin1");
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
    { status: createStatusDeps, installKit: createInstallKit() }
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
  createInstallKit,
  createStatusDeps,
  formatSupportStatus,
  grantSupportLines,
  parseInstallKitArgs,
  reconcileSupportLinesOnDisk,
  revokeSupportLines,
  runSupportCli,
  supportStatus
};
