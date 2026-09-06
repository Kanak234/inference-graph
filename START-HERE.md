# Start here

Everything is in this folder. One command does the whole thing.

## Install

```bash
bash install.sh
```

That installs dependencies, vendors three.js, compiles, runs a render smoke
test, packages a `.vsix`, and installs it into VS Code. It stops at the first
failure and tells you which step broke.

Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`

Then restart VS Code and open `examples/policy-net.netgraph.json`.

## Skip the build

A prebuilt package is already here:

```bash
code --install-extension inference-graph-1.0.0.vsix
```

Nothing to compile. Restart VS Code and open the example.

## If the panel is blank

The smoke test catches renderer crashes before install, so a blank panel now
almost always means WebGL is off in your VS Code:

1. Command Palette, run **Developer: Toggle Developer Tools**, check Console.
2. If it says WebGL is unavailable, launch with `code --ignore-gpu-blocklist`.
3. Turn off the bloom pass: Settings, `inferenceGraph.glow`, uncheck.

The renderer also reports its own errors now — if it stops, VS Code shows a
notification with the message and line number instead of a black rectangle.

## Publishing to the Marketplace

The package already has an icon, a LICENSE, and repository fields.

1. Create the GitHub repo `Kanak234/inference-graph` and push this folder,
   or edit `repository`, `bugs`, and `homepage` in `package.json` to match
   whatever you name it.
2. Sign in at dev.azure.com, create a Personal Access Token with
   **Organization: All accessible organizations** and scope
   **Marketplace → Manage**. Copy it once.
3. Create your publisher at marketplace.visualstudio.com/manage. If the ID you
   get is not `kanak`, change the `publisher` field in `package.json`.
4. Publish:

```bash
npx @vscode/vsce login <your-publisher-id>
npx @vscode/vsce publish
```

Live in fifteen to twenty minutes.

## Useful commands

| Command | Does |
| --- | --- |
| `npm run verify` | vendor, compile, and smoke test — run this after any edit |
| `npm test` | smoke test alone |
| `npm run compile` | TypeScript only |
| `npm run package` | build a `.vsix` without installing |

## What was fixed

The blank panel came from a missing `sCalls` element. The renderer wrote a
draw-call count to it every frame; it was not in the webview HTML, so the first
frame threw and the loop died silently.

Two things changed. The stats row is there now, and the webview reports
uncaught errors to the extension, so a future crash surfaces as a notification.
`tests/render-smoke.js` runs the real renderer headless and would have caught
it — it now runs before every package.
