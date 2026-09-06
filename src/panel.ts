import * as vscode from 'vscode';
import { GraphSpec, LayerAnchor, parseSpec } from './spec';

export interface GraphState {
  uri: vscode.Uri;
  spec: GraphSpec;
  anchors: LayerAnchor[];
  unitCount: number;
}

export type ViewEvent =
  | { kind: 'graph'; view: GraphView; state: GraphState }
  | { kind: 'invalid'; view: GraphView; uri: vscode.Uri; message: string; line?: number }
  | { kind: 'select'; view: GraphView; layer: number; unit: number; label: string }
  | { kind: 'decision'; view: GraphView; action: string; confidence: number }
  | { kind: 'activations'; view: GraphView; values: Record<string, number> }
  | { kind: 'export'; view: GraphView; payload: unknown }
  | { kind: 'error'; view: GraphView; message: string }
  | { kind: 'focus'; view: GraphView }
  | { kind: 'dispose'; view: GraphView };

/** One webview bound to one spec document. */
export class GraphView {
  private ready = false;
  private pending: unknown[] = [];
  private disposables: vscode.Disposable[] = [];

  state: GraphState | undefined;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly document: vscode.TextDocument,
    private readonly extUri: vscode.Uri,
    private readonly onEvent: (e: ViewEvent) => void
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')]
    };
    panel.webview.html = this.html(panel.webview);

    this.disposables.push(
      panel.webview.onDidReceiveMessage(m => this.receive(m)),
      panel.onDidChangeViewState(e => { if (e.webviewPanel.active) this.onEvent({ kind: 'focus', view: this }); })
    );
    panel.onDidDispose(() => {
      this.disposables.forEach(d => d.dispose());
      this.onEvent({ kind: 'dispose', view: this });
    });
  }

  get uri(): vscode.Uri { return this.document.uri; }
  get isActive(): boolean { return this.panel.active; }

  reveal() { this.panel.reveal(); }

  /** Re-reads the document, validates, and pushes the result to the webview. */
  refresh() {
    const res = parseSpec(this.document.getText());
    if (!res.ok) {
      this.state = undefined;
      this.post({ type: 'invalid', message: res.message });
      this.onEvent({ kind: 'invalid', view: this, uri: this.uri, message: res.message, line: res.line });
      return;
    }
    this.state = { uri: this.uri, spec: res.spec, anchors: res.anchors, unitCount: res.unitCount };
    this.post({ type: 'spec', spec: res.spec, config: readConfig() });
    this.onEvent({ kind: 'graph', view: this, state: this.state });
  }

  pushConfig() { this.post({ type: 'config', config: readConfig() }); }
  focus(layer: number, unit?: number) { this.post({ type: 'focus', layer, unit: unit ?? -1 }); }
  run(name: string) { this.post({ type: 'cmd', name }); }
  applyTrace(trace: unknown) { this.post({ type: 'trace', trace }); }

  private post(msg: unknown) {
    if (!this.ready) { this.pending.push(msg); return; }
    void this.panel.webview.postMessage(msg);
  }

  private receive(m: any) {
    switch (m && m.type) {
      case 'ready':
        this.ready = true;
        this.pending.forEach(p => void this.panel.webview.postMessage(p));
        this.pending = [];
        this.refresh();
        break;
      case 'select':
        this.onEvent({ kind: 'select', view: this, layer: m.layer, unit: m.unit, label: String(m.label ?? '') });
        break;
      case 'decision':
        this.onEvent({ kind: 'decision', view: this, action: String(m.action ?? ''), confidence: Number(m.confidence) || 0 });
        break;
      case 'activations':
        this.onEvent({ kind: 'activations', view: this, values: m.values || {} });
        break;
      case 'export':
        this.onEvent({ kind: 'export', view: this, payload: m.payload });
        break;
      case 'error':
        this.onEvent({ kind: 'error', view: this, message: String(m.message ?? '') });
        break;
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', f));
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      "img-src " + webview.cspSource + " data:",
      "style-src " + webview.cspSource + " 'unsafe-inline'",
      "script-src 'nonce-" + nonce + "'",
      "font-src " + webview.cspSource
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${media('style.css')}" />
<title>Inference Graph</title>
</head>
<body>
<div id="fail" role="alert"><p><b>WebGL didn't start</b>This view renders on the GPU. Turn on hardware acceleration, or run <code>code --ignore-gpu-blocklist</code>.</p></div>
<div id="invalid" role="alert"><p><b>Spec has a problem</b><span id="invalidMsg"></span></p></div>
<div id="labels" aria-hidden="true"></div>
<div id="tip" aria-hidden="true"></div>

<div id="ui">
  <div id="top">
    <div class="panel brand enter">
      <p class="eyebrow" id="metaNote">network</p>
      <h1 id="metaName">Inference Graph</h1>
      <p class="sub"><b id="mLayers">0</b> layers · <b id="mNodes">0</b> units · <b id="mEdges">0</b> connections</p>
    </div>
    <div class="panel enter" id="stats">
      <div class="row"><span>fps</span><span id="sFps">—</span></div>
      <div class="row"><span>frame</span><span id="sMs">—</span></div>
      <div class="row"><span>draws</span><span id="sCalls">—</span></div>
      <div class="row"><span>pass</span><span id="sPass">idle</span></div>
    </div>
  </div>

  <div id="mid">
    <div class="panel enter" id="legend">
      <h2>Reading the graph</h2>
      <div class="k"><i class="sw" style="background:#35f0a8"></i> positive weight</div>
      <div class="k"><i class="sw" style="background:#ff54cf"></i> negative weight</div>
      <div class="k"><i class="dot" style="background:#38e8ff"></i> input</div>
      <div class="k"><i class="dot" style="background:#ff54cf"></i> attention</div>
      <div class="k"><i class="dot" style="background:#8fa6c4"></i> add &amp; norm</div>
      <div class="k"><i class="dot" style="background:#35f0a8"></i> feed forward</div>
      <div class="k"><i class="dot" style="background:#ffc46b"></i> policy head</div>
    </div>
    <aside class="panel" id="inspect" aria-label="Unit detail">
      <header><h2>Unit</h2><button class="btn" id="closeInspect">Close</button></header>
      <div class="body" id="inspectBody"></div>
    </aside>
  </div>

  <div class="panel enter" id="rail">
    <div id="railHead">
      <p class="t">Decision</p>
      <p class="v" id="decision">—</p>
      <p class="s" id="decisionSub">waiting for signal</p>
    </div>
    <div id="acts"></div>
  </div>

  <div class="panel enter" id="bar" role="toolbar" aria-label="Playback and view controls">
    <button class="btn on" id="bRun">Pause</button>
    <button class="btn" id="bNew">New input</button>
    <button class="btn" id="bTrace">Trace path</button>
    <div class="sep"></div>
    <div class="rng"><label for="rSpeed">Speed</label><input id="rSpeed" type="range" min="25" max="300" value="100"><b id="vSpeed">1.0×</b></div>
    <div class="sep"></div>
    <button class="btn on" id="bLabels">Labels</button>
    <button class="btn on" id="bBloom">Glow</button>
    <button class="btn on" id="bOrbit">Auto-orbit</button>
    <button class="btn" id="bReset">Reset view</button>
  </div>
</div>

<script nonce="${nonce}" src="${media('three.min.js')}"></script>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

export function readConfig() {
  const c = vscode.workspace.getConfiguration('inferenceGraph');
  return {
    speed: c.get<number>('speed', 1),
    glow: c.get<boolean>('glow', true),
    autoOrbit: c.get<boolean>('autoOrbit', true),
    labels: c.get<boolean>('labels', true)
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** Binds .netgraph.json files to the graph view instead of the text editor. */
export class GraphEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'inferenceGraph.editor';

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly onEvent: (e: ViewEvent) => void,
    private readonly track: (v: GraphView) => void
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const view = new GraphView(panel, document, this.extUri, this.onEvent);
    this.track(view);
  }
}
