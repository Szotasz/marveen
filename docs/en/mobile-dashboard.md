# Dashboard on mobile (secure access)

By default the Marveen dashboard listens only on the host's own localhost (127.0.0.1:3420), so it is not reachable from a phone directly. This guide shows how to access the dashboard securely from mobile, with an app-like icon.

## Security in short

The recommended approach is Tailscale Serve, which gives three layers:

1. **Private network (tailnet)**: the dashboard is reachable only from devices on your own Tailscale account, NOT from the public internet. (This is Tailscale Serve, which is tailnet-only, not Funnel, which would be public.)
2. **Encryption + HTTPS**: traffic is WireGuard-encrypted, and Tailscale provisions an automatic HTTPS certificate (a secure context is required for the PWA anyway).
3. **Access token**: the dashboard additionally requires an access token. So you must be ON the tailnet AND know the token.

The dashboard stays bound to localhost; Tailscale Serve only proxies from the tailnet to localhost. This means you are not exposing the machine to the local network or the internet.

## Host setup (one-time)

1. Install Tailscale on the host and sign in with your account.
2. Start the proxy:
   ```
   tailscale serve --bg 3420
   ```
   This serves localhost:3420 over HTTPS on the machine's Tailscale name, for your tailnet only.
3. The address: `https://<machine-name>.<tailnet>.ts.net/` (exact name: `tailscale serve status`).
4. Disable anytime: `tailscale serve --https=443 off`.

## On the phone (iPhone / Android)

1. Install the Tailscale app, sign in with the SAME account, and turn it on.
2. In the browser, open the access link with the token:
   `https://<machine-name>.<tailnet>.ts.net/?token=<ACCESS_TOKEN>`
   (The access token is in `store/.dashboard-token` on the host, and the dashboard startup log prints it in a "Dashboard access URL" line.)
3. Add it to the home screen: in the browser Share menu, "Add to Home Screen". It launches as an app icon (PWA).
4. On first launch the home-screen app asks for a token (it gets separate storage from the browser). Paste the FULL link or just the token; the field extracts the token automatically and signs you in. You only do this once.

## Who does it work for?

- The PWA (app icon, token-paste, mobile view) ships in every install by default.
- Secure remote mobile access requires the Tailscale setup above on the host (not automatic). Without Tailscale, alternatives are same-LAN access or your own VPN/tunnel.

## Pitfalls

- iOS saves the home-screen icon at the moment you add it. If the icon changes (e.g. a new version), delete the existing icon and add it again.
- The token is bearer-style: it is a valid entry pass within your tailnet. Keep your tailnet limited to your own devices.
