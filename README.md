# Inference Graph

A VS Code extension that renders a network spec as a live 3D graph. Open a
`.netgraph.json` file and a signal crosses every layer, activations light up,
and the policy head commits to one action. Click a unit and the editor jumps to
the line that defines its layer.

Not a video. The forward pass is real: seeded weights, actual sums, softmax at
the head. The same input always produces the same decision.

---

## Setup

```bash
npm install          # installs typescript + three@0.128.0
npm run vendor       # copies three.min.js into media/
npm run compile      # builds out/
```

Then press **F5** in VS Code. A second window opens with the extension loaded
and the `examples/` folder as its workspace. Open
`examples/policy-net.netgraph.json`.

To build an installable package:

```bash
npm install -g @vscode/vsce
npm run package      # produces inference-graph-1.0.0.vsix
code --install-extension inference-graph-1.0.0.vsix
```

`npm run vendor` matters. Webviews get no network access under the extension's
content security policy, so three.js ships inside the package rather than
loading from a CDN.

---

## What it does

**Editor-bound.** Any file matching `*.netgraph.json` opens in the graph view
instead of the text editor. Edit the spec in a split text editor and the graph
rebuilds as you type, debounced.

**Both directions of navigation.** Move the cursor through the spec and the
camera follows to that layer. Click a unit in the graph and the editor reveals
the line that declares its layer. Either can be turned off in settings.

**Validation with a line number.** A bad spec becomes a diagnostic in the
Problems panel pointing at the offending line, not a blank canvas.

**Sidebar tree.** Layers and their units, with live activation values after each
pass. Click any entry to focus it in 3D.

**Status bar.** The committed action and its confidence, updated every pass.
Click it to trace the path that produced it.

**Trace export.** Writes the input vector, the full probability distribution,
and the contributing path — units and weighted edges — to JSON.

### Commands

| Command | Does |
| --- | --- |
| `Inference Graph: Open Inference Graph` | Opens the active JSON in a side panel |
| `Inference Graph: Run Inference` | Pause / resume the pass |
| `Inference Graph: New Input Vector` | Re-seeds the input and restarts |
| `Inference Graph: Trace Decision Path` | Lights the path behind the decision |
| `Inference Graph: Export Trace as JSON` | Saves the current pass |
| `Inference Graph: Pull Trace from Endpoint` | Reads activations from a running model |
| `Inference Graph: New Graph Spec File` | Starts from a template |

### In the graph

Drag to orbit, shift-drag to pan, scroll to zoom. Click a unit to inspect it.
`Space` pause, `N` new input, `T` trace, `L` labels, `R` reset view, `Esc` clear.

---

## The spec

```json
{
  "meta": { "name": "policy-net", "note": "3 encoder blocks" },
  "seed": 20260826,
  "layers": [
    { "id": "tok", "name": "Token input", "kind": "input", "n": 8 },
    { "id": "emb", "name": "Embedding", "kind": "dense", "n": 14 },
    { "id": "a1",  "name": "Attention · 01", "kind": "attn", "n": 12 },
    { "id": "n1",  "name": "Add & norm", "kind": "norm", "n": 8, "residualFrom": "emb" },
    { "id": "out", "name": "Policy head", "kind": "output", "n": 6,
      "labels": ["Go to food", "Eat", "Hide", "Flee", "Idle", "Sleep"] }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique. Also how `residualFrom` refers to a layer. |
| `kind` | `input`, `dense`, `attn`, `norm`, `ffn`, `relu`, `output`. Sets colour and activation function. |
| `n` | Units in the layer. Up to 256; wide layers should be sampled down. |
| `labels` | Names for units, one per unit. The output layer's labels become the decision rail. |
| `residualFrom` | Draws a skip connection from that layer — the long outer arcs. |
| `seed` | Fixes the weights. Same seed, same network, same trace. |

`//` and `/* */` comments are allowed, so a spec can carry notes.

---

## Pointing it at a real model

### From PyTorch

```bash
python tools/export_torch_graph.py mymodel.py:build_model -o net.netgraph.json
```

The walker reads the module tree, maps Linear / Conv / Embedding / Norm /
Attention to kinds, and caps each layer at 64 drawn units. It produces a picture
of the architecture, not a copy of the weights.

### From a running model

Set `inferenceGraph.traceEndpoint` to something like
`http://127.0.0.1:8000/trace`, then run **Pull Trace from Endpoint**. The
endpoint should answer with either:

```json
{ "input": [0.2, 0.9, 0.1, 0.4, 0.7, 0.3, 0.5, 0.8] }
```

— an input vector the graph runs through its own weights, or:

```json
{ "act": [ /* one value per unit, in spec order */ ],
  "probs": [0.61, 0.12, 0.08, 0.05, 0.09, 0.05] }
```

— activations computed by the real model, which the graph displays directly.
The second form is what a router or orchestrator should emit: pass your own
per-stage confidences as `act` and the model-selection distribution as `probs`,
and the rail shows which worker won.

---

## Layout

```
src/extension.ts   commands, cursor sync, diagnostics, status bar, endpoint fetch
src/panel.ts       webview host, CSP, message protocol, custom editor provider
src/spec.ts        types, validation, source-line anchoring
src/tree.ts        sidebar tree
media/main.js      renderer — geometry, shaders, forward pass, bloom
media/style.css    HUD
tools/             PyTorch exporter
examples/          a spec to open first
```

The renderer keeps its own copy of the network and runs the forward pass in the
webview. The extension host never blocks on it.

MIT.
