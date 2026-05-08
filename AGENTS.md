# Repository Instructions

- This is the user's fork of Pocodex. When making code or asset changes, rebuild and restart the locally running Pocodex app before handing the work back, unless the user explicitly asks not to.
- The local Pocodex instance is managed by `~/Library/LaunchAgents/app.pocodex.server.plist` and should listen on `127.0.0.1:8787`, not `0.0.0.0`, so remote access goes through Tailscale instead of raw LAN HTTP.
- HTTPS-over-Tailscale is provided by persistent Tailscale Serve background config on this Mac:
  - Setup command: `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --yes --https=443 http://127.0.0.1:8787`
  - Tailnet URL: `https://radeks-macbook-pro-m5-pro.taild5233b.ts.net/`
  - Verify with `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status --json` and `curl https://radeks-macbook-pro-m5-pro.taild5233b.ts.net/healthz`.
  - Disable with `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off`.
  - Do not add a separate LaunchAgent for this command; the Mac App Store Tailscale CLI logs a GUI-start error when invoked headlessly by launchd, while `serve --bg` is already persistent.
- Do not put Pocodex session tokens in committed files. The active token lives in the local Pocodex LaunchAgent arguments.
