import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { GraphEditorProvider, GraphView, ViewEvent } from './panel';
import { layerAtLine, templateSpec } from './spec';
import { LayerTree } from './tree';

let views: GraphView[] = [];
let active: GraphView | undefined;
let tree: LayerTree;
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  tree = new LayerTree();
  diagnostics = vscode.languages.createDiagnosticCollection('inferenceGraph');

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'inferenceGraph.tracePath';
  status.tooltip = 'Trace the path that produced this decision';

  const treeView = vscode.window.createTreeView('inferenceGraph.layers', { treeDataProvider: tree });

  const provider = new GraphEditorProvider(context.extensionUri, onEvent, track);

  context.subscriptions.push(
    diagnostics, status, treeView,
    vscode.window.registerCustomEditorProvider(GraphEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),

    vscode.commands.registerCommand('inferenceGraph.open', openActiveDocument.bind(null, context)),
    vscode.commands.registerCommand('inferenceGraph.runInference', () => active?.run('run')),
    vscode.commands.registerCommand('inferenceGraph.newInput', () => active?.run('newInput')),
    vscode.commands.registerCommand('inferenceGraph.tracePath', () => active?.run('trace')),
    vscode.commands.registerCommand('inferenceGraph.exportTrace', () => active?.run('export')),
    vscode.commands.registerCommand('inferenceGraph.fetchLiveTrace', fetchLiveTrace),
    vscode.commands.registerCommand('inferenceGraph.newSpecFile', newSpecFile),
    vscode.commands.registerCommand('inferenceGraph.focusLayer', (layer: number, unit?: number) => {
      active?.focus(layer, unit);
    }),
    vscode.commands.registerCommand('inferenceGraph.revealLayer', (node: { anchor?: { index: number } }) => {
      const i = node?.anchor?.index;
      if (i !== undefined && active) revealLayer(active, i);
    }),

    vscode.workspace.onDidChangeTextDocument(debounce(e => {
      views.filter(v => v.uri.toString() === e.document.uri.toString()).forEach(v => v.refresh());
    }, 220)),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('inferenceGraph')) views.forEach(v => v.pushConfig());
    }),

    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!vscode.workspace.getConfiguration('inferenceGraph').get<boolean>('syncCursor', true)) return;
      const view = views.find(v => v.uri.toString() === e.textEditor.document.uri.toString());
      if (!view?.state) return;
      const i = layerAtLine(view.state.anchors, e.selections[0].active.line);
      if (i >= 0) view.focus(i);
    })
  );
}

export function deactivate() {
  views = [];
}

/* ── view registry ─────────────────────────────────────────── */

function track(view: GraphView) {
  views.push(view);
  active = view;
}

function onEvent(e: ViewEvent) {
  switch (e.kind) {
    case 'graph': {
      active = e.view;
      diagnostics.set(e.state.uri, []);
      const labels = new Map<number, string[]>();
      e.state.spec.layers.forEach((l, i) => { if (l.labels) labels.set(i, l.labels); });
      tree.setGraph(e.state.uri, e.state.anchors, labels);
      break;
    }
    case 'invalid': {
      const line = e.line ?? 0;
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        e.message,
        vscode.DiagnosticSeverity.Error
      );
      d.source = 'Inference Graph';
      diagnostics.set(e.uri, [d]);
      tree.clear();
      status.hide();
      break;
    }
    case 'select': {
      if (vscode.workspace.getConfiguration('inferenceGraph').get<boolean>('revealOnClick', true)) {
        revealLayer(e.view, e.layer);
      }
      break;
    }
    case 'decision': {
      status.text = '$(circuit-board) ' + e.action + '  ' + (e.confidence * 100).toFixed(0) + '%';
      status.show();
      break;
    }
    case 'activations': {
      tree.setActivations(e.values);
      break;
    }
    case 'export': {
      void saveTrace(e.payload);
      break;
    }
    case 'error': {
      vscode.window.showErrorMessage('The graph renderer stopped: ' + e.message);
      break;
    }
    case 'focus': {
      active = e.view;
      if (e.view.state) {
        const labels = new Map<number, string[]>();
        e.view.state.spec.layers.forEach((l, i) => { if (l.labels) labels.set(i, l.labels); });
        tree.setGraph(e.view.state.uri, e.view.state.anchors, labels);
      }
      break;
    }
    case 'dispose': {
      views = views.filter(v => v !== e.view);
      if (active === e.view) active = views[0];
      if (!views.length) { tree.clear(); status.hide(); }
      break;
    }
  }
}

/* ── commands ──────────────────────────────────────────────── */

async function openActiveDocument(context: vscode.ExtensionContext) {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    vscode.window.showInformationMessage('Open a graph spec file first, then run this command.');
    return;
  }
  const existing = views.find(v => v.uri.toString() === doc.uri.toString());
  if (existing) { existing.reveal(); return; }

  const panel = vscode.window.createWebviewPanel(
    'inferenceGraph.panel',
    'Graph · ' + doc.uri.path.split('/').pop(),
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  track(new GraphView(panel, doc, context.extensionUri, onEvent));
}

async function newSpecFile() {
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content: templateSpec() });
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    'Save this as a .netgraph.json file to open it in the graph view.',
    'Save as…'
  ).then(pick => { if (pick) vscode.commands.executeCommand('workbench.action.files.saveAs'); });
}

async function revealLayer(view: GraphView, layerIndex: number) {
  const anchor = view.state?.anchors[layerIndex];
  if (!anchor) return;
  const doc = await vscode.workspace.openTextDocument(view.uri);
  const range = new vscode.Range(anchor.line, 0, anchor.line, 0);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
    selection: range
  });
}

async function saveTrace(payload: unknown) {
  const target = await vscode.window.showSaveDialog({
    filters: { JSON: ['json'] },
    saveLabel: 'Save trace',
    defaultUri: vscode.Uri.file('inference-trace.json')
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  const open = await vscode.window.showInformationMessage('Trace saved.', 'Open');
  if (open) {
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  }
}

async function fetchLiveTrace() {
  const endpoint = vscode.workspace.getConfiguration('inferenceGraph').get<string>('traceEndpoint', '').trim();
  if (!endpoint) {
    const pick = await vscode.window.showWarningMessage(
      'No trace endpoint is set. The graph runs its own forward pass until you point it at a model.',
      'Set endpoint'
    );
    if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'inferenceGraph.traceEndpoint');
    return;
  }
  if (!active) {
    vscode.window.showInformationMessage('Open a graph first.');
    return;
  }
  try {
    const body = await getJson(endpoint);
    active.applyTrace(body);
    vscode.window.setStatusBarMessage('$(cloud-download) Trace pulled from ' + endpoint, 2500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage('Could not read a trace from ' + endpoint + '. ' + msg);
  }
}

/* ── helpers ───────────────────────────────────────────────── */

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let mod: typeof http | typeof https;
    try {
      mod = new URL(url).protocol === 'https:' ? https : http;
    } catch {
      reject(new Error('That is not a valid URL.'));
      return;
    }
    const req = mod.get(url, { timeout: 4000 }, res => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error('The server answered ' + res.statusCode + '.'));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('The response was not JSON.')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('The request timed out.')); });
    req.on('error', reject);
  });
}

function debounce<T>(fn: (arg: T) => void, ms: number): (arg: T) => void {
  let timer: NodeJS.Timeout | undefined;
  return (arg: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(arg), ms);
  };
}
