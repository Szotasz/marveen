#!/usr/bin/env python3
"""Upload a file to Slack (and optionally share to a channel) via the bot token.

Usage:
  slack-upload.py <file> [channel_id] [initial_comment]

Reads SLACK_BOT_TOKEN from store/.slack-tokens. The bot token needs files:write.
If channel_id is omitted, the file is uploaded but not shared to any channel (test mode).
"""
import sys, os, json, urllib.request, urllib.parse, uuid

TOKENS = "/root/marveen/store/.slack-tokens"

def bot_token():
    for line in open(TOKENS):
        if line.startswith("SLACK_BOT_TOKEN="):
            return line.strip().split("=", 1)[1]
    raise SystemExit("SLACK_BOT_TOKEN not found in " + TOKENS)

def api_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(req))

def api_post_json(url, token, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8"})
    return json.load(urllib.request.urlopen(req))

def post_file(upload_url, filepath):
    # multipart/form-data POST of the file bytes to Slack's upload URL
    boundary = "----marveen" + uuid.uuid4().hex
    fn = os.path.basename(filepath)
    body = b""
    body += ("--" + boundary + "\r\n").encode()
    body += ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % fn).encode()
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += open(filepath, "rb").read()
    body += ("\r\n--" + boundary + "--\r\n").encode()
    req = urllib.request.Request(upload_url, data=body, headers={
        "Content-Type": "multipart/form-data; boundary=" + boundary})
    return urllib.request.urlopen(req).read().decode(errors="replace")

def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    filepath = sys.argv[1]
    channel_id = sys.argv[2] if len(sys.argv) > 2 else None
    comment = sys.argv[3] if len(sys.argv) > 3 else None
    token = bot_token()
    size = os.path.getsize(filepath)
    fn = os.path.basename(filepath)

    # 1) get upload URL
    u = "https://slack.com/api/files.getUploadURLExternal?" + urllib.parse.urlencode(
        {"filename": fn, "length": size})
    r1 = api_get(u, token)
    if not r1.get("ok"):
        raise SystemExit("getUploadURLExternal failed: " + json.dumps(r1))
    upload_url, file_id = r1["upload_url"], r1["file_id"]

    # 2) upload bytes
    post_file(upload_url, filepath)

    # 3) complete (and share to channel if given)
    payload = {"files": [{"id": file_id, "title": fn}]}
    if channel_id:
        payload["channel_id"] = channel_id
    if comment:
        payload["initial_comment"] = comment
    r3 = api_post_json("https://slack.com/api/files.completeUploadExternal", token, payload)
    print(json.dumps({"ok": r3.get("ok"), "error": r3.get("error"),
                      "file_id": file_id,
                      "files": [{"id": f.get("id"), "permalink": f.get("permalink")}
                                for f in r3.get("files", [])]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
