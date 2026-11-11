const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const VIEW_TYPE = 'codenodemap.view';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function validateExplicitLayout(data) {
    const invalid = [];
    for (const node of data.nodes || []) {
        const x = Number(node.x);
        const y = Number(node.y);
        const width = Number(node.width);
        const height = Number(node.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
            invalid.push(String(node.id || '(no id)'));
        }
    }
    return invalid;
}

async function resolveMapFile(workspaceRoot, uriArg, output) {
    const log = (message) => output.appendLine(message);
    log(`[workspace] ${workspaceRoot}`);

    if (uriArg && uriArg.fsPath) {
        log(`[resolve] from explorer: ${uriArg.fsPath}`);
        return uriArg.fsPath;
    }

    const configured = vscode.workspace.getConfiguration('codenodemap').get('file', '');
    if (configured) {
        const p = path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured);
        log(`[resolve] codenodemap.file = ${configured}`);
        if (fs.existsSync(p)) {
            log(`[resolve] configured file: ${p}`);
            return p;
        }
        log(`[resolve] configured file does not exist: ${p}`);
    }

    const found = await vscode.workspace.findFiles('**/*.codemap.json', '**/node_modules/**', 50);
    const candidates = found.map((u) => u.fsPath);
    const legacy = [
        path.join(workspaceRoot, 'codemap.json'),
        path.join(workspaceRoot, 'docs/codemap.json'),
    ];
    for (const p of legacy) {
        if (fs.existsSync(p) && !candidates.includes(p)) candidates.push(p);
    }

    log(`[resolve] found ${candidates.length} candidate(s)`);
    for (const p of candidates) log(`  - ${p}`);

    if (candidates.length === 1) {
        log(`[resolve] single candidate, opening: ${candidates[0]}`);
        return candidates[0];
    }
    if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(
            candidates.map((p) => ({ label: path.relative(workspaceRoot, p), description: p, fsPath: p })),
            { title: '选择 Code Node Map JSON', placeHolder: `找到 ${candidates.length} 个地图文件` }
        );
        if (picked) {
            log(`[resolve] picked: ${picked.fsPath}`);
            return picked.fsPath;
        }
        log('[resolve] cancelled');
        return null;
    }

    const open = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Code Node Map JSON': ['json'] },
        title: '选择 Code Node Map JSON',
    });
    const selected = open && open[0] ? open[0].fsPath : null;
    log(selected ? `[resolve] dialog: ${selected}` : '[resolve] dialog cancelled');
    return selected;
}

function createPanel(context, mapPath, data, output, existingPanel = null, restoreDirty = false) {
    const baseDir = path.resolve(path.dirname(mapPath), data.baseDir || '.');
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    const fileName = path.basename(mapPath);
    const title = fileName;
    const panelTitle = fileName;
    output.appendLine(`[map] ${mapPath}`);
    output.appendLine(`[baseDir] ${baseDir}`);

    const panel = existingPanel || vscode.window.createWebviewPanel(
        VIEW_TYPE,
        panelTitle,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [mediaDir],
        }
    );
    if (existingPanel) {
        panel.title = panelTitle;
        panel.webview.options = {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [mediaDir],
        };
    }

    const mediaUri = (name) => panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, name)).toString();

    const render = (mapData) => {
        const json = JSON.stringify(mapData).replace(/</g, '\\u003c');
        const csp = [
            "default-src 'none'",
            `img-src ${panel.webview.cspSource} data:`,
            `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
            `script-src ${panel.webview.cspSource}`,
            `font-src ${panel.webview.cspSource}`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${mediaUri('style.css')}">
<title>${escapeHtml(title)}</title>
</head>
<body data-map-path="${escapeHtml(mapPath)}" data-map-dirty="${restoreDirty ? 'true' : 'false'}">
<div id="app">
  <nav id="app-menu">
    <div class="app-mark">◈</div>
    <div class="app-identity">
      <span class="app-title">${escapeHtml(title)}</span>
      <span id="subtitle">loading...</span>
    </div>
    <div class="menu-roots">
      <div class="menu-root-wrap">
        <button type="button" class="menu-root" data-menu="file" aria-haspopup="menu" aria-expanded="false">文件</button>
        <div class="menu menu-panel" data-panel="file" hidden>
          <button type="button" class="menu-item" data-command="save"><span class="menu-icon">⌘</span><span class="menu-label">保存</span><span class="menu-hint">Ctrl+S</span></button>
          <button type="button" class="menu-item" data-command="reload"><span class="menu-icon">↻</span><span class="menu-label">重新加载</span></button>
        </div>
      </div>
      <div class="menu-root-wrap">
        <button type="button" class="menu-root" data-menu="edit" aria-haspopup="menu" aria-expanded="false">编辑</button>
        <div class="menu menu-panel" data-panel="edit" hidden>
          <button type="button" class="menu-item" data-command="undo"><span class="menu-icon">↶</span><span class="menu-label">撤销</span><span class="menu-hint">Ctrl+Z</span></button>
          <button type="button" class="menu-item" data-command="redo"><span class="menu-icon">↷</span><span class="menu-label">重做</span><span class="menu-hint">Ctrl+Shift+Z</span></button>
          <div class="menu-separator"></div>
          <button type="button" class="menu-item" data-command="add-node"><span class="menu-icon">＋</span><span class="menu-label">新增节点</span></button>
          <button type="button" class="menu-item" data-command="add-edge"><span class="menu-icon">→</span><span class="menu-label">新增连线</span></button>
          <button type="button" class="menu-item" data-command="delete-selected"><span class="menu-icon">×</span><span class="menu-label">删除选中</span><span class="menu-hint">Delete</span></button>
        </div>
      </div>
      <div class="menu-root-wrap">
        <button type="button" class="menu-root" data-menu="view" aria-haspopup="menu" aria-expanded="false">视图</button>
        <div class="menu menu-panel" data-panel="view" hidden>
          <button type="button" class="menu-item" data-command="fit"><span class="menu-icon">⤢</span><span class="menu-label">适配视图</span></button>
          <button type="button" class="menu-item" data-command="exit-focus"><span class="menu-icon">◌</span><span class="menu-label">退出聚焦</span></button>
        </div>
      </div>
    </div>
    <div class="menu-spacer"></div>
    <span id="save-state" class="save-state">已保存</span>
    <div class="mode-switch" role="group" aria-label="模式">
      <button type="button" id="mode-browse" data-mode="browse" aria-pressed="false" title="浏览模式：只保留相机和查看操作">浏览</button>
      <button type="button" id="mode-edit" data-mode="edit" aria-pressed="true" title="编辑模式：直接编辑节点、连线和布局">编辑</button>
    </div>
  </nav>
  <div id="app-toolbar">
    <div class="tool-group edit-only">
      <button type="button" id="add-node" class="tool-button" title="新增节点：点击画布放置">＋ 节点</button>
      <button type="button" id="add-edge" class="tool-button" title="新增连线：依次点击起点和终点">→ 连线</button>
      <button type="button" id="undo" class="tool-icon" title="撤销 (Ctrl+Z)">↶</button>
      <button type="button" id="redo" class="tool-icon" title="重做 (Ctrl+Shift+Z)">↷</button>
    </div>
    <span class="toolbar-sep edit-only"></span>
    <div id="lod-control" class="tool-control">
      <span class="tool-label">LOD</span>
      <button type="button" id="lod-trigger" class="menu-trigger compact" aria-haspopup="listbox" aria-expanded="false" title="选择 LOD 档位">
        <span id="lod-label">自动</span><span class="menu-caret" aria-hidden="true"></span>
      </button>
      <div id="lod-menu" class="menu menu-dropdown" role="listbox" aria-label="LOD 档位" hidden></div>
    </div>
    <div id="key-graph-control" class="tool-control focus-select-wrap">
      <span class="tool-label">关键图</span>
      <button type="button" id="key-graph-trigger" class="menu-trigger compact" aria-haspopup="listbox" aria-controls="key-graph-menu" aria-expanded="false">
        <span id="key-graph-label" class="menu-trigger-label">全部</span>
        <span class="menu-caret" aria-hidden="true"></span>
      </button>
      <div id="key-graph-menu" class="menu menu-dropdown" role="listbox" aria-label="关键图" hidden></div>
    </div>
    <div class="toolbar-spacer"></div>
    <label id="search-wrap" class="search-wrap" title="搜索节点或标签">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input id="search" type="search" placeholder="搜索节点或标签…" autocomplete="off" spellcheck="false">
    </label>
    <div id="focus-control" class="tool-control">
      <button type="button" id="focus-settings" class="tool-button" title="聚焦与补集透明度" aria-expanded="false">聚焦</button>
      <div id="focus-tools" class="focus-popover" hidden>
        <div class="focus-popover-title">关键图聚焦</div>
        <p id="focus-description" class="focus-description">未聚焦，显示全部节点</p>
        <label class="focus-opacity" for="focus-opacity" title="非关键节点和连线的透明度">
          <span>补集透明度</span>
          <input id="focus-opacity" type="range" min="0" max="100" step="5" value="20">
          <span id="focus-opacity-value" class="focus-value">20%</span>
        </label>
        <button type="button" id="focus-clear" class="focus-clear" hidden>退出聚焦</button>
      </div>
    </div>
    <span class="toolbar-sep"></span>
    <div class="tool-group">
      <button type="button" id="fit" class="tool-button" title="适配视图">适配</button>
      <button type="button" id="save" class="tool-button edit-only" title="保存 (Ctrl+S)">保存</button>
      <button type="button" id="reload" class="tool-button" title="重新加载 JSON">重载</button>
    </div>
  </div>
  <main id="stage">
    <div id="world">
      
      <svg id="edges" viewBox="-5000 -5000 10000 10000" aria-hidden="true"></svg>
      <div id="nodes"></div>
      <div id="edge-labels" aria-hidden="true"></div>
      <svg id="edge-handles" viewBox="-5000 -5000 10000 10000" aria-hidden="true"></svg>
    </div>
    <div id="empty" hidden>此图中没有节点。</div>
    <div id="legend"></div>
    <div id="hint">单击选择 · 拖动移动 · 点击标题改名</div>
    <aside id="inspector" aria-hidden="true">
      <div class="inspector-head">
        <div>
          <div id="inspector-group" class="group-pill"></div>
          <h2 id="inspector-title"></h2>
        </div>
        <div class="inspector-actions">
          <button id="inspector-edge" title="从此节点新增连线" hidden>连线</button>
          <button id="inspector-close" title="关闭">×</button>
        </div>
      </div>
      <div id="inspector-body" class="markdown"></div>
      <div id="inspector-tags" class="inspector-tags"></div>
      <div id="inspector-source-wrap">
        <button id="inspector-source" class="source-button">打开源码</button>
      </div>
      <div id="inspector-links"></div>
    </aside>
  </main>
</div>
<div id="menu-layer" class="menu-layer"></div>
<script type="application/json" id="codemap-data">${json}</script>
<script src="${mediaUri('d3.min.js')}"></script>
<script src="${mediaUri('marked.umd.js')}"></script>
<script src="${mediaUri('purify.min.js')}"></script>
<script src="${mediaUri('main.js')}"></script>
</body>
</html>`;
    };

    let currentData = data;
    panel.webview.html = render(currentData);

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg) return;
        if (msg.type === 'open') {
            try {
                let file = msg.filePath;
                if (!path.isAbsolute(file)) file = path.resolve(baseDir, file);
                if (!fs.existsSync(file)) {
                    const alt = path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || baseDir, msg.filePath);
                    if (fs.existsSync(alt)) file = alt;
                }
                if (!fs.existsSync(file)) {
                    vscode.window.showErrorMessage(`Code Node Map: file not found: ${file}`);
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
                const line = Math.max(0, Math.min((msg.line || 1) - 1, doc.lineCount - 1));
                const pos = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (err) {
                vscode.window.showErrorMessage(`Code Node Map: ${err.message}`);
            }
        } else if (msg.type === 'external' && msg.url) {
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } else if (msg.type === 'reload') {
            try {
                const next = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                const invalid = validateExplicitLayout(next);
                if (invalid.length) {
                    vscode.window.showErrorMessage(`Code Node Map: missing x/y/width/height for: ${invalid.slice(0, 8).join(', ')}`);
                    return;
                }
                currentData = next;
                panel.webview.postMessage({ type: 'data', data: currentData });
            } catch (err) {
                vscode.window.showErrorMessage(`Code Node Map: failed to reload ${mapPath}: ${err.message}`);
            }
        } else if (msg.type === 'save-map' && msg.data) {
            try {
                const next = msg.data;
                if (!next || !Array.isArray(next.nodes)) throw new Error('JSON needs a "nodes" array');
                const invalid = validateExplicitLayout(next);
                if (invalid.length) throw new Error(`missing x/y/width/height for: ${invalid.slice(0, 8).join(', ')}`);
                fs.writeFileSync(mapPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
                currentData = next;
                panel.title = fileName;
                panel.webview.postMessage({ type: 'saved', path: mapPath });
            } catch (err) {
                vscode.window.showErrorMessage(`Code Node Map: failed to save: ${err.message}`);
                panel.webview.postMessage({ type: 'save-error', message: err.message });
            }
        } else if (msg.type === 'dirty') {
            panel.title = msg.dirty ? `${fileName} •` : fileName;
        } else if (msg.type === 'set-tags' && msg.nodeId != null && Array.isArray(msg.tags)) {
            try {
                const updated = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                const node = (updated.nodes || []).find((item) => String(item.id) === String(msg.nodeId));
                if (!node) throw new Error(`node not found: ${msg.nodeId}`);

                const tags = [...new Set(msg.tags.map((tag) => String(tag).trim()).filter(Boolean))];
                if (tags.length) node.tags = tags;
                else delete node.tags;

                const catalog = Array.isArray(updated.tags) ? updated.tags : [];
                const known = new Set(catalog.map((item) => (
                    typeof item === 'string' ? item : (item && item.label ? String(item.label) : '')
                )).filter(Boolean));
                for (const item of updated.nodes || []) {
                    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
                        const label = typeof tag === 'string' ? tag.trim() : (tag && tag.label ? String(tag.label).trim() : '');
                        if (label && !known.has(label)) {
                            catalog.push({ label });
                            known.add(label);
                        }
                    }
                }
                if (catalog.length) updated.tags = catalog;

                fs.writeFileSync(mapPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
                currentData = updated;

                const tagCatalog = catalog.map((item) => {
                    if (typeof item === 'string') return { label: item };
                    if (!item || !item.label) return null;
                    return { label: String(item.label), description: item.description ? String(item.description) : '' };
                }).filter(Boolean);

                panel.webview.postMessage({
                    type: 'tags-updated',
                    nodeId: String(msg.nodeId),
                    tags: Array.isArray(node.tags) ? node.tags : [],
                    tagCatalog,
                });
            } catch (err) {
                panel.webview.postMessage({ type: 'tags-error', nodeId: String(msg.nodeId), message: err.message });
                vscode.window.showErrorMessage(`Code Node Map: failed to update tags: ${err.message}`);
            }
        }
    });
}

function activate(context) {
    const output = vscode.window.createOutputChannel('Code Node Map');
    context.subscriptions.push(output);

    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        async deserializeWebviewPanel(panel, state) {
            const mapPath = state && state.mapPath;
            if (!mapPath || !fs.existsSync(mapPath)) {
                panel.dispose();
                return;
            }
            let data;
            let dirty = false;
            try {
                if (state.data && Array.isArray(state.data.nodes)) {
                    data = state.data;
                    dirty = true;
                } else {
                    data = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Code Node Map: failed to restore ${mapPath}: ${err.message}`);
                panel.dispose();
                return;
            }
            const invalid = validateExplicitLayout(data);
            if (!data || !Array.isArray(data.nodes) || invalid.length) {
                vscode.window.showErrorMessage(`Code Node Map: cannot restore invalid map: ${mapPath}`);
                panel.dispose();
                return;
            }
            createPanel(context, mapPath, data, output, panel, dirty);
        }
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('codenodemap.open', async (uriArg) => {
            const folders = vscode.workspace.workspaceFolders;
            const workspaceRoot = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
            const mapPath = await resolveMapFile(workspaceRoot, uriArg, output);
            if (!mapPath) return;

            vscode.window.setStatusBarMessage(`Code Node Map: ${vscode.workspace.asRelativePath(mapPath)}`, 5000);

            let data;
            try {
                data = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            } catch (err) {
                vscode.window.showErrorMessage(`Code Node Map: failed to read ${mapPath}: ${err.message}`);
                return;
            }
            if (!data || !Array.isArray(data.nodes)) {
                vscode.window.showErrorMessage('Code Node Map: JSON needs a "nodes" array.');
                return;
            }
            const invalid = validateExplicitLayout(data);
            if (invalid.length) {
                vscode.window.showErrorMessage(`Code Node Map: every node needs explicit x/y/width/height. Missing: ${invalid.slice(0, 8).join(', ')}`);
                return;
            }

            createPanel(context, mapPath, data, output);
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
