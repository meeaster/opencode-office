# The panel in the user's Windows app

The final check, when the user runs the desktop app on Windows and the office in WSL. It looks at the copy `office sync` installed in `%LOCALAPPDATA%\office\gui\<name>\` and registered in `%USERPROFILE%\.config\opencode\opencode.json`, in the user's own app. The app is theirs: read from it, and leave closing or restarting it to them.

WSL reaches Windows programs through interop; when `powershell.exe` isn't on PATH, use `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`.

## 1. Installed and listed

Run `office sync` on the WSL host (never in the container), then `office check`: the panel's line says installed, registered and this office's build. Then ask the app's sidecar, which listens on Windows' loopback and records its address and password in `%USERPROFILE%\.local\state\opencode\service.json`:

```sh
powershell.exe -NoProfile -Command '
  $s = Get-Content "$env:USERPROFILE\.local\state\opencode\service.json" | ConvertFrom-Json
  $h = @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:" + $s.password)) }
  (Invoke-RestMethod -Uri "$($s.url)/api/plugin" -Headers $h).data | Where-Object id -like "office-*" | ConvertTo-Json -Depth 5'
```

Done when `office-<name>` is listed with `features.gui` and `state.status` `active`. Its source path is the Windows folder; a `\\wsl.localhost` path never reloads, since Windows sees no file changes there. This prints no password; keep it that way.

## 2. Seen rendering

1. CDP needs the app started with `--remote-debugging-port=<port>`, and the flag works only at launch. Pick a port free on Windows and WSL (start at 9222). If the app is running without it, ask the user to quit it and start it again with the flag:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\@opencode-aidesktop\OpenCode.exe" --remote-debugging-port=<port>
   ```

   Done when `http://127.0.0.1:<port>/json/version` answers from Windows.
2. Reach the port from WSL. With WSL's default NAT networking Windows' loopback isn't visible from WSL; run the relay in the background, with any Windows `node.exe` or `bun.exe`:

   ```sh
   bun scripts/cdp-relay.ts <port> <WSL path to node.exe or bun.exe>
   ```

   It listens on WSL's loopback only and starts one Windows process per connection; avoid `netsh portproxy`, which listens on a network address. With mirrored networking, skip it. Done when `curl http://127.0.0.1:<port>/json/list` lists the app's page.
3. `agent-browser --session <name> connect <port>`, then as in the headless recipe: a session in the office (Home, then the session, or a new one in the office's project), **Toggle review**, the panel's tab, `snapshot`. Check `agent-browser get url` first: a stray `about:blank` tab gives empty snapshots; `tab list` and switch to the app's page.
4. Rebuild, let `office gui dev <name>` (or `office sync`) install it, and snapshot again. Done when the change shows.

## Afterwards

Close the `agent-browser` session (`close` detaches from the app without quitting it) and stop the relay. Tell the user the app keeps its debugging port open until they restart it normally: any local program can drive it meanwhile.
