(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const DATA = JSON.parse(document.getElementById('codemap-data').textContent);

  let data;
  let nodes = [];
  let edges = [];
  let groups = [];
  let groupById = new Map();
  let tagCatalog = new Map();
  let nodeById = new Map();
  let selectedId = null;
  let currentTransform = d3.zoomIdentity;
  let drag = null;
  let suppressClick = false;
  let edgeRoutes = new Map();
  let childrenByParent = new Map();
  let visibleNodeList = [];
  let obstacleNodes = [];
  let viewEdges = [];
  let lastRouteOrder = [];
  let lodLevels = [1, 1, 1, 1, 1];
  let focusTransitionTimer = 0;
  let requiresFullRoute = true;
  let staleEdgeIds = new Set();
  let lastUiScale = 0;
  let focusActive = false;
  let focusIds = new Set();
  let focusKeyGraphId = '';
  let focusSnapshot = null;
  let appMode = 'edit';
  let lodMode = 'auto';
  let suppressLabelClick = false;
  let nodeCardRefreshTimer = 0;
  let contextMenuEl = null;
  let activeRouteFrame = 0;
  let editingNodeId = null;
  let interactionMode = null;
  let edgeSourceId = null;
  let selectedEdgeId = null;
  let edgeHandleFrame = 0;
  let modeBanner = null;
  let parentPick = null;
  let dragParentId = null;
  let dragHintKey = '';
  let undoStack = [];
  let redoStack = [];
  let clipboard = null;
  let pasteSerial = 0;
  let savedSnapshot = '';
  let dirty = false;

  const stage = document.getElementById('stage');
  const world = document.getElementById('world');
  const edgeLayer = document.getElementById('edges');
  const edgeLabelLayer = document.getElementById('edge-labels');
  const edgeHandleLayer = document.getElementById('edge-handles');
  const nodeLayer = document.getElementById('nodes');
  const inspector = document.getElementById('inspector');
  const inspectorTitle = document.getElementById('inspector-title');
  const inspectorGroup = document.getElementById('inspector-group');
  const inspectorBody = document.getElementById('inspector-body');
  const inspectorTags = document.getElementById('inspector-tags');
  const inspectorSource = document.getElementById('inspector-source');
  const inspectorSourceWrap = document.getElementById('inspector-source-wrap');
  const inspectorLinks = document.getElementById('inspector-links');
  const inspectorEdge = document.getElementById('inspector-edge');
  const saveButton = document.getElementById('save');
  const saveState = document.getElementById('save-state');
  const addNodeButton = document.getElementById('add-node');
  const addEdgeButton = document.getElementById('add-edge');
  const search = document.getElementById('search');
  const subtitle = document.getElementById('subtitle');
  const legend = document.getElementById('legend');
  const hint = document.getElementById('hint');
  const empty = document.getElementById('empty');
  const defaultHint = hint ? hint.textContent : '';
  const focusTools = document.getElementById('focus-tools');
  const keyGraphTrigger = document.getElementById('key-graph-trigger');
  const keyGraphLabel = document.getElementById('key-graph-label');
  const keyGraphMenu = document.getElementById('key-graph-menu');
  const menuLayer = document.getElementById('menu-layer');
  const focusOpacity = document.getElementById('focus-opacity');
  const focusOpacityValue = document.getElementById('focus-opacity-value');
  const focusDescription = document.getElementById('focus-description');
  const focusClear = document.getElementById('focus-clear');
  const focusSettings = document.getElementById('focus-settings');
  const lodTrigger = document.getElementById('lod-trigger');
  const lodLabel = document.getElementById('lod-label');
  const lodMenu = document.getElementById('lod-menu');
  const modeBrowseButton = document.getElementById('mode-browse');
  const modeEditButton = document.getElementById('mode-edit');
  const undoButton = document.getElementById('undo');
  const redoButton = document.getElementById('redo');

  const stageSel = d3.select(stage);
  const worldSel = d3.select(world);
  const edgeSel = d3.select(edgeLayer);
  const edgeLabelSel = d3.select(edgeLabelLayer);
  const edgeHandleSel = d3.select(edgeHandleLayer);

  const edgePreviewLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgePreviewLayer.id = 'edge-preview';
  edgePreviewLayer.setAttribute('viewBox', '-5000 -5000 10000 10000');
  edgePreviewLayer.setAttribute('aria-hidden', 'true');
  world.insertBefore(edgePreviewLayer, nodeLayer);
  const edgePreviewPath = d3.select(edgePreviewLayer).append('path');

  const resizeHandleLayer = document.createElement('div');
  resizeHandleLayer.id = 'resize-handles';
  resizeHandleLayer.classList.add('hidden');
  resizeHandleLayer.style.setProperty('--ui-scale', '1');
  world.appendChild(resizeHandleLayer);
  const resizeFrameEl = document.createElement('div');
  resizeFrameEl.id = 'resize-frame';
  resizeHandleLayer.appendChild(resizeFrameEl);
  const resizeHandleEls = new Map();
  for (const direction of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-${direction}`;
    handle.title = '拖动边框调整大小';
    handle.addEventListener('pointerdown', (event) => {
      const node = selectedId ? nodeById.get(selectedId) : null;
      if (node) startResize(event, node, handle, direction);
    });
    resizeHandleLayer.appendChild(handle);
    resizeHandleEls.set(direction, handle);
  }

  modeBanner = document.createElement('div');
  modeBanner.id = 'mode-banner';
  modeBanner.hidden = true;
  stage.appendChild(modeBanner);

  const zoom = d3.zoom()
    .scaleExtent([0.03, 3])
    .on('zoom', (event) => {
      currentTransform = event.transform;
      const t = event.transform;
      worldSel.style('transform', `translate(${t.x}px, ${t.y}px) scale(${t.k})`);
      const uiScale = Math.min(16, Math.max(1, 1 / Math.max(0.05, t.k)));
      if (uiScale !== lastUiScale) {
        lastUiScale = uiScale;
        resizeHandleLayer.style.setProperty('--ui-scale', String(uiScale));
        if (selectedId) renderResizeHandles();
      }
      applyLodVisibility(t.k);
    })
    .on('end', () => {
      scheduleActiveRoutes();
      if (selectedEdgeId) renderEdgeHandles();
    });

  stageSel.call(zoom).on('dblclick.zoom', null);

  function basename(file) {
    return String(file || '').split(/[\\/]/).pop() || file;
  }

  function parseData(raw) {
    data = raw;
    groups = Array.isArray(raw.groups) ? raw.groups.slice() : [];
    groupById = new Map(groups.map((g) => [String(g.id), g]));
    setTagCatalog(raw.tags);

    nodes = (raw.nodes || []).map((n, index) => {
      const id = String(n.id);
      const isContainer = n.type === 'container' || n.container === true;
      return {
        ...n,
        id,
        type: isContainer ? 'container' : 'node',
        parent: n.parent ? String(n.parent) : null,
        label: n.label || id,
        description: n.description || '',
        tags: normalizeTagList(n.tags),
        headerHeight: Number(n.headerHeight) || 50,
        width: Number(n.width),
        height: Number(n.height),
        x: Number(n.x),
        y: Number(n.y),
        index,
      };
    });

    nodeById = new Map(nodes.map((n) => [n.id, n]));

    for (const node of nodes) {
      if (!node.parent) continue;
      const parent = nodeById.get(node.parent);
      if (!parent || parent === node) node.parent = null;
    }

    for (const node of nodes) {
      let cur = node.parent ? nodeById.get(node.parent) : null;
      const seen = new Set([node.id]);
      while (cur) {
        if (seen.has(cur.id)) {
          node.parent = null;
          break;
        }
        seen.add(cur.id);
        cur = cur.parent ? nodeById.get(cur.parent) : null;
      }
    }

    childrenByParent = new Map(nodes.map((n) => [n.id, []]));
    for (const node of nodes) {
      if (node.parent) childrenByParent.get(node.parent).push(node);
    }
    const rawById = new Map((raw.nodes || []).map((n) => [String(n.id), n]));
    for (const node of nodes) {
      if ((childrenByParent.get(node.id) || []).length) {
        node.type = 'container';
        node.container = true;
        const rawNode = rawById.get(node.id);
        if (rawNode) rawNode.type = 'container';
      }
    }

    edges = (raw.edges || [])
      .filter((e) => nodeById.has(String(e.from)) && nodeById.has(String(e.to)))
      .map((e, index) => ({
        ...e,
        id: e.id || `edge-${index}`,
        from: String(e.from),
        to: String(e.to),
        label: e.label || '',
        dashed: e.style === 'dashed' || e.dashed === true,
        fromAnchor: normalizeAnchor(e.fromAnchor),
        toAnchor: normalizeAnchor(e.toAnchor),
        waypoints: normalizeWaypoints(e.waypoints),
        labelOffset: normalizeLabelOffset(e.labelOffset),
      }));

    for (const n of nodes) {
      if (n.group && !groupById.has(String(n.group))) {
        groupById.set(String(n.group), { id: String(n.group), label: String(n.group) });
      }
    }

    assignNodeRoles();
  }

  function groupLabel(id) {
    const group = groupById.get(String(id));
    return group && group.label ? group.label : (id || '');
  }

  const ROLE_LABELS = { start: '起点', process: '过程', end: '终点' };
  const ROLE_ORDER = ['start', 'process', 'end'];

  function roleLabel(role) {
    return ROLE_LABELS[role] || ROLE_LABELS.process;
  }

  function normalizeRole(value) {
    const role = String(value || '').trim().toLowerCase();
    if (role === 'start' || role === 'source' || role === '起点') return 'start';
    if (role === 'end' || role === 'sink' || role === '终点') return 'end';
    if (role === 'process' || role === 'intermediate' || role === '过程' || role === '中间过程') return 'process';
    return null;
  }

  function assignNodeRoles() {
    const inCount = new Map();
    const outCount = new Map();
    for (const edge of edges) {
      outCount.set(edge.from, (outCount.get(edge.from) || 0) + 1);
      inCount.set(edge.to, (inCount.get(edge.to) || 0) + 1);
    }
    for (const node of nodes) {
      const explicit = normalizeRole(node.role);
      const incoming = inCount.get(node.id) || 0;
      const outgoing = outCount.get(node.id) || 0;
      node.role = explicit || (incoming === 0 && outgoing > 0
        ? 'start'
        : outgoing === 0 && incoming > 0
          ? 'end'
          : 'process');
      node.roleLabel = roleLabel(node.role);
    }
  }

  function setTagCatalog(list) {
    tagCatalog = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      const label = typeof item === 'string' ? item : (item && item.label ? String(item.label) : '');
      const clean = label.trim();
      if (!clean || tagCatalog.has(clean)) continue;
      tagCatalog.set(clean, {
        label: clean,
        description: item && typeof item === 'object' && item.description ? String(item.description) : '',
      });
    }
  }

  function normalizeTagList(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const label = typeof item === 'string' ? item : (item && item.label ? String(item.label) : '');
      const clean = label.trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
  }

  function tagDescription(label) {
    const item = tagCatalog.get(label);
    return item && item.description ? item.description : '';
  }

  function allTagLabels() {
    const labels = new Set(tagCatalog.keys());
    for (const node of nodes) {
      for (const label of node.tags) labels.add(label);
    }
    return [...labels].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function normalizeAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    const side = String(anchor.side || '').toLowerCase();
    if (!['top', 'right', 'bottom', 'left'].includes(side)) return null;
    return {
      side,
      offset: Number.isFinite(Number(anchor.offset)) ? Number(anchor.offset) : 0,
    };
  }

  function normalizeWaypoints(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const x = Number(item && item.x);
      const y = Number(item && item.y);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    }
    return out;
  }

  function normalizeLabelOffset(value) {
    if (!value || typeof value !== 'object') return null;
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function isContainer(node) {
    return !!node && node.type === 'container';
  }

  function childrenOf(node) {
    return node ? (childrenByParent.get(node.id) || []) : [];
  }

  function parentOf(node) {
    return node && node.parent ? nodeById.get(node.parent) : null;
  }

  function depthOf(node) {
    let depth = 0;
    let cur = parentOf(node);
    const seen = new Set([node.id]);
    while (cur && !seen.has(cur.id) && depth < nodes.length) {
      seen.add(cur.id);
      depth++;
      cur = parentOf(cur);
    }
    return depth;
  }

  function smoothRange(value, start, end) {
    const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  const LOD_THRESHOLDS = [0, 0.23, 0.43, 0.63, 0.83];
  const LOD_REF_SCALE = [0.11, 0.30, 0.55, 0.80, 1.00];
  const LOD_FIXED_SCALE = [0.10, 0.30, 0.50, 0.70, 1.00];
  const LOD_OPTIONS = [
    { value: 'auto', label: '自动', hint: '跟随缩放' },
    { value: '0', label: 'L0 总览', hint: '阶段卡片' },
    { value: '1', label: 'L1 阶段', hint: '阶段内部' },
    { value: '2', label: 'L2 模块', hint: '模块细节' },
    { value: '3', label: 'L3 细节', hint: '深层节点' },
    { value: '4', label: 'L4 叶子', hint: '全部叶子' },
  ];
  const LOD_TRANSITION = 0.05;

  function effectiveLodScale(scale) {
    if (lodMode === 'auto') return scale;
    const level = Number(lodMode);
    return LOD_FIXED_SCALE[Math.max(0, Math.min(LOD_FIXED_SCALE.length - 1, level))] ?? scale;
  }

  function levelAlphaForDepth(depth, scale) {
    if (depth <= 0) return 1;
    const threshold = LOD_THRESHOLDS[Math.min(4, depth)] ?? (0.35 + (depth - 1) * 0.20);
    return smoothRange(scale, threshold - LOD_TRANSITION, threshold);
  }

  function applyEdgeLodAlphas() {
    for (let depth = 0; depth < lodLevels.length; depth++) {
      const alpha = lodLevels[depth].toFixed(3);
      edgeLayer.style.setProperty(`--edge-alpha-${depth}`, alpha);
      edgeLabelLayer.style.setProperty(`--edge-label-alpha-${depth}`, alpha);
    }
    edgeSel.selectAll('.edge').each(function () {
      const level = Number(this.getAttribute('data-lod')) || 0;
      const hidden = lodLevels[Math.min(lodLevels.length - 1, level)] <= 0.005;
      if (this._lodHidden !== hidden) {
        this.classList.toggle('lod-hidden', hidden);
        this._lodHidden = hidden;
      }
    });
    edgeLabelSel.selectAll('.edge-label-group').each(function () {
      const level = Number(this.getAttribute('data-lod')) || 0;
      const hidden = lodLevels[Math.min(lodLevels.length - 1, level)] <= 0.005;
      if (this._lodHidden !== hidden) {
        this.classList.toggle('lod-hidden', hidden);
        this._lodHidden = hidden;
      }
    });
  }

  function applyLodVisibility(scale, force = false) {
    const lodScale = effectiveLodScale(scale);
    const nextLevels = lodLevels.map((_, depth) => levelAlphaForDepth(depth, lodScale));
    let changed = force;
    if (!changed) {
      for (let depth = 0; depth < nextLevels.length; depth++) {
        if (Math.abs(nextLevels[depth] - lodLevels[depth]) > 0.001) { changed = true; break; }
      }
    }
    if (!changed) return;
    lodLevels = nextLevels;
    for (let depth = 0; depth < lodLevels.length; depth++) {
      const own = lodLevels[depth];
      const child = levelAlphaForDepth(depth + 1, lodScale);
      nodeLayer.style.setProperty(`--depth-alpha-${depth}`, own.toFixed(4));
      nodeLayer.style.setProperty(`--card-alpha-${depth}`, (own * (1 - child)).toFixed(4));
      nodeLayer.style.setProperty(`--frame-alpha-${depth}`, (own * child).toFixed(4));
    }
    for (const node of nodes) {
      const level = Math.min(lodLevels.length - 1, depthOf(node));
      const own = lodLevels[level];
      node.lodAlpha = own;
      if (!node.el) continue;
      const hidden = own <= 0.005;
      if (node._lodHidden !== hidden) {
        node.el.classList.toggle('lod-hidden', hidden);
        node._lodHidden = hidden;
      }
      if (isContainer(node)) {
        const child = levelAlphaForDepth(level + 1, lodScale);
        const cardActive = own * (1 - child) > 0.5;
        if (node._cardActive !== cardActive) {
          node.el.classList.toggle('card-active', cardActive);
          node._cardActive = cardActive;
        }
      }
    }
    applyEdgeLodAlphas();
    if (selectedId) renderResizeHandles();
    if (selectedEdgeId) renderEdgeHandles();
  }

  function refreshVisibility() {
    visibleNodeList = nodes;
    obstacleNodes = visibleNodeList.filter((node) => !isContainer(node));
  }

  function buildViewEdges() {
    viewEdges = edges.map((edge) => ({ ...edge, key: edge.id }));
  }

  function edgeIsActive(edge) {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) return false;
    return Math.min(source.lodAlpha ?? 1, target.lodAlpha ?? 1) > 0.005;
  }

  function activeViewEdges() {
    return viewEdges.filter(edgeIsActive);
  }

  function keyGraphList() {
    return Array.isArray(data.keyGraphs)
      ? data.keyGraphs.filter((item) => item && item.id && Array.isArray(item.nodes))
      : [];
  }

  function keyGraphEntries() {
    return [
      { id: '', label: '全部', description: '显示全部节点' },
      ...keyGraphList().map((item) => ({
        id: String(item.id),
        label: item.label || String(item.id),
        description: item.description || '',
      })),
    ];
  }

  function syncKeyGraphMenu() {
    if (!keyGraphMenu || !keyGraphTrigger) return;
    const activeId = focusActive ? String(focusKeyGraphId) : '';
    const entries = keyGraphEntries();
    const current = entries.find((entry) => entry.id === activeId) || entries[0];
    if (keyGraphLabel) keyGraphLabel.textContent = current.label;
    keyGraphTrigger.title = current.description || current.label;
    keyGraphTrigger.classList.toggle('active', !!activeId);
    if (focusSettings) focusSettings.classList.toggle('active', !!activeId);
    keyGraphMenu.querySelectorAll('.menu-option').forEach((item) => {
      const selected = String(item.dataset.value) === activeId;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function closeKeyGraphMenu(options = {}) {
    if (!keyGraphMenu || keyGraphMenu.hidden) return;
    keyGraphMenu.hidden = true;
    if (keyGraphTrigger) keyGraphTrigger.setAttribute('aria-expanded', 'false');
    if (options.focusTrigger && keyGraphTrigger) keyGraphTrigger.focus();
  }

  function openKeyGraphMenu(options = {}) {
    if (!keyGraphMenu || !keyGraphTrigger) return;
    if (keyGraphMenu.hidden) {
      closeContextMenu();
      closeLodMenu();
      keyGraphMenu.hidden = false;
      keyGraphTrigger.setAttribute('aria-expanded', 'true');
    }
    if (options.focusItem) {
      const target = keyGraphMenu.querySelector('.menu-option.selected') || keyGraphMenu.querySelector('.menu-option');
      if (target) target.focus();
    }
  }

  function menuItems(menu) {
    return [...menu.querySelectorAll('.menu-item:not([disabled])')];
  }

  function bindMenuKeyboard(menu, onClose) {
    menu.addEventListener('keydown', (event) => {
      const items = menuItems(menu);
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(index + 1 + items.length) % items.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose(event);
      } else if (event.key === 'Tab') {
        onClose(event);
      }
    });
  }

  function buildKeyGraphOptions() {
    const list = keyGraphList();
    if (keyGraphTrigger && keyGraphMenu) {
      keyGraphMenu.innerHTML = '';
      for (const entry of keyGraphEntries()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'menu-item menu-option';
        item.dataset.value = entry.id;
        item.setAttribute('role', 'option');
        item.title = entry.description || entry.label;

        const check = document.createElement('span');
        check.className = 'menu-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'menu-label';
        label.textContent = entry.label;

        item.append(check, label);
        item.addEventListener('click', () => {
          closeKeyGraphMenu();
          if (entry.id) applyKeyGraph(entry.id);
          else exitFocus();
          if (keyGraphTrigger) keyGraphTrigger.focus();
        });
        keyGraphMenu.appendChild(item);
      }
      syncKeyGraphMenu();
    }
    if (focusSettings) focusSettings.hidden = list.length === 0;
    if (focusTools && list.length === 0) focusTools.hidden = true;
    if (!focusActive) {
      if (focusDescription) focusDescription.textContent = '未聚焦，显示全部节点';
      if (focusClear) focusClear.hidden = true;
    }
  }

  function syncLodMenu() {
    if (!lodTrigger) return;
    const option = LOD_OPTIONS.find((item) => item.value === String(lodMode)) || LOD_OPTIONS[0];
    if (lodLabel) lodLabel.textContent = option.value === 'auto' ? '自动' : option.label;
    lodTrigger.classList.toggle('active', option.value !== 'auto');
    lodTrigger.title = option.value === 'auto'
      ? 'LOD 自动：跟随缩放'
      : `LOD 固定：${option.label}（${option.hint}）`;
    if (lodMenu) {
      lodMenu.querySelectorAll('.menu-option').forEach((item) => {
        const selected = item.dataset.value === String(lodMode);
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    }
  }

  function closeLodMenu(options = {}) {
    if (!lodMenu || lodMenu.hidden) return;
    lodMenu.hidden = true;
    if (lodTrigger) {
      lodTrigger.setAttribute('aria-expanded', 'false');
      if (options.focusTrigger) lodTrigger.focus();
    }
  }

  function openLodMenu() {
    if (!lodMenu || !lodTrigger) return;
    if (lodMenu.hidden) {
      closeContextMenu();
      closeKeyGraphMenu();
      lodMenu.hidden = false;
      lodTrigger.setAttribute('aria-expanded', 'true');
    }
    const target = lodMenu.querySelector('.menu-option.selected') || lodMenu.querySelector('.menu-option');
    if (target) target.focus();
  }

  function buildLodMenu() {
    if (!lodMenu || !lodTrigger) return;
    lodMenu.innerHTML = '';
    for (const option of LOD_OPTIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item menu-option';
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.title = option.value === 'auto' ? '跟随缩放自动切换层级' : `固定在此层级，不随缩放变化`;
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = option.label;
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = option.hint;
      item.append(check, label, hint);
      item.addEventListener('click', () => {
        closeLodMenu();
        setLodMode(option.value);
        if (lodTrigger) lodTrigger.focus();
      });
      lodMenu.appendChild(item);
    }
    syncLodMenu();
  }

  function setLodMode(value, options = {}) {
    const next = String(value);
    if (next !== 'auto' && !LOD_OPTIONS.some((item) => item.value === next)) return;
    lodMode = next;
    syncLodMenu();
    applyLodVisibility(currentTransform.k, true);
    if (!options.silent) persistWebviewState();
  }

  function updateModeHint() {
    if (!hint) return;
    hint.textContent = appMode === 'browse'
      ? '浏览模式 · 拖拽平移 · 滚轮缩放 · 适配 / LOD 可用'
      : '编辑模式 · 单击选择 · 拖动移动 · 点击标题改名 · 拖动提示文字';
  }

  function syncModeUI() {
    document.body.classList.toggle('mode-browse', appMode === 'browse');
    document.body.classList.toggle('mode-edit', appMode === 'edit');
    if (modeBrowseButton) {
      modeBrowseButton.classList.toggle('active', appMode === 'browse');
      modeBrowseButton.setAttribute('aria-pressed', appMode === 'browse' ? 'true' : 'false');
    }
    if (modeEditButton) {
      modeEditButton.classList.toggle('active', appMode === 'edit');
      modeEditButton.setAttribute('aria-pressed', appMode === 'edit' ? 'true' : 'false');
    }
    const editMenuRoot = document.querySelector('.menu-root[data-menu="edit"]');
    if (editMenuRoot) {
      editMenuRoot.tabIndex = appMode === 'edit' ? 0 : -1;
      editMenuRoot.setAttribute('aria-disabled', appMode === 'edit' ? 'false' : 'true');
      if (appMode !== 'edit') {
        editMenuRoot.classList.remove('active');
        editMenuRoot.setAttribute('aria-expanded', 'false');
      }
    }
    updateModeHint();
  }

  function setAppMode(mode, options = {}) {
    const next = mode === 'browse' ? 'browse' : 'edit';
    if (next === 'browse') {
      const active = document.activeElement;
      if (active && active.closest && active.closest('#node-edit-form') && typeof active.blur === 'function') {
        active.blur();
      }
      if (active && active.isContentEditable && typeof active.blur === 'function') {
        active.blur();
      }
      cancelInteractionMode();
      closeInspector();
      closeContextMenu();
      closeAppMenus();
      closeKeyGraphMenu();
      closeLodMenu();
      if (focusTools) focusTools.hidden = true;
    }
    appMode = next;
    syncModeUI();
    if (!options.silent) persistWebviewState();
  }

  function closeAppMenus(exceptPanel = null) {
    for (const wrap of document.querySelectorAll('.menu-root-wrap')) {
      const panel = wrap.querySelector('.menu-panel');
      const root = wrap.querySelector('.menu-root');
      if (!panel || panel === exceptPanel) continue;
      panel.hidden = true;
      if (root) {
        root.classList.remove('active');
        root.setAttribute('aria-expanded', 'false');
      }
    }
  }

  function toggleAppMenu(root) {
    const wrap = root.closest('.menu-root-wrap');
    const panel = wrap ? wrap.querySelector('.menu-panel') : null;
    if (!panel) return;
    const willOpen = panel.hidden;
    closeAppMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    root.classList.toggle('active', willOpen);
    root.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function runCommand(command) {
    if (!command) return;
    const editOnly = new Set(['undo', 'redo', 'add-node', 'add-edge', 'delete-selected']);
    if (editOnly.has(command) && appMode !== 'edit') return;
    switch (command) {
      case 'save':
        saveMap();
        break;
      case 'reload':
        vscode.postMessage({ type: 'reload' });
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'add-node':
        setInteractionMode('node');
        break;
      case 'add-edge':
        setInteractionMode('edge');
        break;
      case 'delete-selected':
        if (selectedEdgeId) deleteEdge(selectedEdgeId);
        else if (selectedId) deleteNode(selectedId);
        break;
      case 'fit':
        fit();
        break;
      case 'exit-focus':
        if (focusActive) exitFocus({ fitAll: true });
        break;
      default:
        break;
    }
    closeAppMenus();
  }

  function applyFocusOpacity() {
    if (!focusOpacity) return;
    const value = Math.max(0, Math.min(100, Number(focusOpacity.value) || 0));
    document.documentElement.style.setProperty('--focus-dim', String(value / 100));
    if (focusOpacityValue) focusOpacityValue.textContent = `${value}%`;
  }

  function applyKeyGraph(id) {
    const keyGraph = keyGraphList().find((item) => String(item.id) === String(id));
    if (!keyGraph) {
      if (focusActive) {
        exitFocus({ fitAll: true });
      } else {
        fitNodeList(visibleNodeList);
      }
      return;
    }
    if (!focusActive) {
      focusSnapshot = {
        selectedId,
        transform: currentTransform,
      };
    }

    const ids = new Set();
    for (const nid of keyGraph.nodes) {
      const node = nodeById.get(String(nid));
      if (!node) continue;
      for (const sub of subtreeNodes(node)) ids.add(sub.id);
      let parent = parentOf(node);
      const seen = new Set([node.id]);
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        ids.add(parent.id);
        parent = parentOf(parent);
      }
    }

    if (!ids.size) {
      exitFocus();
      return;
    }

    focusActive = true;
    focusIds = ids;
    focusKeyGraphId = String(keyGraph.id);
    syncKeyGraphMenu();
    if (focusDescription) focusDescription.textContent = keyGraph.description || keyGraph.label || '';
    if (focusClear) focusClear.hidden = false;
    selectedId = null;
    closeInspector();
    applyFocusState();
    requestAnimationFrame(() => {
      if (focusActive && keyGraph.view) {
        applySavedView(keyGraph.view);
      } else {
        fitFocusNodes();
      }
    });
  }

  function applyFocusState() {
    stage.classList.add('focus-transition');
    if (focusTransitionTimer) clearTimeout(focusTransitionTimer);
    focusTransitionTimer = setTimeout(() => {
      focusTransitionTimer = 0;
      stage.classList.remove('focus-transition');
    }, 420);
    for (const node of nodes) {
      if (!node.el) continue;
      node.el.classList.toggle('focus-out', focusActive && !focusIds.has(node.id));
    }
    edgeSel.selectAll('.edge').each(function () {
      const from = this.getAttribute('data-from');
      const to = this.getAttribute('data-to');
      const dim = focusActive && !(focusIds.has(from) && focusIds.has(to));
      this.classList.toggle('focus-out', dim);
    });
    edgeLabelSel.selectAll('.edge-label-group').each(function () {
      const from = this.getAttribute('data-from');
      const to = this.getAttribute('data-to');
      const dim = focusActive && !(focusIds.has(from) && focusIds.has(to));
      this.classList.toggle('focus-out', dim);
    });
  }

  function applySavedView(view) {
    const x = Number(view && view.x);
    const y = Number(view && view.y);
    const rawScale = Number(view && view.scale);
    if (![x, y, rawScale].every(Number.isFinite)) {
      fitFocusNodes();
      return;
    }
    const scale = Math.max(0.03, Math.min(3, rawScale));
    const tx = stage.clientWidth / 2 - x * scale;
    const ty = stage.clientHeight / 2 - y * scale;
    stageSel.transition()
      .duration(380)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  function exitFocus(options = {}) {
    if (!focusActive) return;
    const snapshot = focusSnapshot;
    focusActive = false;
    focusIds.clear();
    focusKeyGraphId = '';
    focusSnapshot = null;
    syncKeyGraphMenu();
    if (focusDescription) focusDescription.textContent = '未聚焦，显示全部节点';
    if (focusClear) focusClear.hidden = true;
    if (snapshot) selectedId = snapshot.selectedId || null;
    applyFocusState();
    if (selectedId && nodeById.get(selectedId)) {
      selectNode(selectedId);
    } else {
      closeInspector();
    }
    if (options.fitAll) {
      fitNodeList(visibleNodeList);
    } else if (snapshot && snapshot.transform) {
      stageSel.transition()
        .duration(380)
        .call(zoom.transform, snapshot.transform);
    }
  }

  function fitFocusNodes() {
    if (!focusActive) return;
    const targets = visibleNodeList.filter((node) => focusIds.has(node.id));
    fitNodeList(targets);
  }

  function markdown(text) {
    if (!text) return '';
    const html = marked.parse(text, { gfm: true, breaks: true });
    return DOMPurify.sanitize(html);
  }

  function openSource(node) {
    if (!node || !node.source || !node.source.file) return;
    vscode.postMessage({
      type: 'open',
      filePath: node.source.file,
      line: node.source.line || 1,
    });
  }

  function onMarkdownLink(event) {
    const link = event.currentTarget;
    const href = link.getAttribute('href') || '';
    event.preventDefault();
    event.stopPropagation();
    if (!href || href.startsWith('#')) return;
    if (/^(https?:|mailto:)/i.test(href)) {
      vscode.postMessage({ type: 'external', url: href });
    } else {
      vscode.postMessage({ type: 'open', filePath: href, line: 1 });
    }
  }

  function closeContextMenu() {
    if (!contextMenuEl) return;
    contextMenuEl.remove();
    contextMenuEl = null;
  }

  function contextMenuItemsForNode(node) {
    const items = [
      { icon: '◎', label: '查看详情', action: () => selectNode(node.id) },
      { icon: '✎', label: '编辑节点', action: () => {
        selectNode(node.id);
        requestAnimationFrame(() => openNodeEditor(nodeById.get(node.id) || node));
      } },
      { icon: '⧉', label: '复制', action: () => copyNode(node.id) },
      { icon: '✂', label: '剪切', action: () => cutNode(node.id) },
    ];
    items.push(
      { icon: '+', label: '新增子节点', action: () => createNodeAt(node.x, node.y, node.id) },
      { icon: '⌂', label: '选择父节点…', action: () => startParentPick(node.id, (pickedId) => {
        if (pickedId === node.id || isAncestorOf(node, nodeById.get(pickedId))) {
          setParentPickNote('不能选择自身或子节点');
          return false;
        }
        setNodeParent(node.id, pickedId);
        return true;
      }) }
    );
    if (node.parent) {
      items.push({ icon: '⤴', label: '移到顶层', action: () => setNodeParent(node.id, '') });
    }
    items.push({ icon: '→', label: '从此节点新增连线', action: () => startEdgeFromNode(node) });
    if (node.source && node.source.file) {
      items.push({
        icon: '↗',
        label: '打开源码',
        hint: `${basename(node.source.file)}:${node.source.line || 1}`,
        action: () => openSource(node),
      });
    }
    items.push({
      icon: '#',
      label: '编辑标签',
      action: () => {
        selectNode(node.id);
        requestAnimationFrame(() => {
          const input = inspectorTags && inspectorTags.querySelector('.tag-editor-input');
          if (input) input.focus({ preventScroll: true });
        });
      },
    });
    items.push({ separator: true });
    if (isContainer(node)) {
      items.push({
        icon: '⤢',
        label: '缩放到此容器',
        action: () => fitNodeList(subtreeNodes(node)),
      });
    } else {
      items.push({
        icon: '⤢',
        label: '缩放到此节点',
        action: () => fitNodeList([node]),
      });
    }
    items.push({ separator: true });
    items.push({
      icon: '×',
      label: isContainer(node) ? '删除容器及子节点' : '删除节点',
      action: () => deleteNode(node.id),
    });
    return items;
  }

  function appendContextMenuItem(menu, item) {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'menu-separator';
      separator.setAttribute('role', 'separator');
      menu.appendChild(separator);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item';
    button.setAttribute('role', 'menuitem');
    if (item.disabled) button.disabled = true;
    if (item.hint) button.title = item.hint;

    const icon = document.createElement('span');
    icon.className = 'menu-icon';
    icon.textContent = item.icon || '';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;

    button.append(icon, label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = item.hint;
      button.appendChild(hint);
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const action = item.action;
      closeContextMenu();
      if (action) action();
    });
    menu.appendChild(button);
  }

  function showContextMenu(options) {
    if (!menuLayer) return;
    if (interactionMode === 'parent') cancelInteractionMode();
    closeContextMenu();
    closeKeyGraphMenu();

    const menu = document.createElement('div');
    menu.className = 'menu context-menu';
    menu.setAttribute('role', 'menu');
    if (options.role) menu.classList.add(`role-${options.role}`);

    if (options.heading) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';

      const dot = document.createElement('span');
      dot.className = 'menu-heading-dot';
      dot.setAttribute('aria-hidden', 'true');

      const title = document.createElement('span');
      title.className = 'menu-heading-title';
      title.textContent = options.heading;

      heading.append(dot, title);
      if (options.meta) {
        const meta = document.createElement('span');
        meta.className = 'menu-heading-meta';
        meta.textContent = options.meta;
        heading.appendChild(meta);
      }
      menu.appendChild(heading);
    }

    for (const item of options.items || []) appendContextMenuItem(menu, item);

    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.visibility = 'hidden';
    menuLayer.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const gap = 8;
    const x = Math.max(gap, Math.min(options.x, window.innerWidth - rect.width - gap));
    const y = Math.max(gap, Math.min(options.y, window.innerHeight - rect.height - gap));
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
    menu.style.visibility = '';
    contextMenuEl = menu;

    bindMenuKeyboard(menu, closeContextMenu);
    const first = menu.querySelector('.menu-item');
    if (first) first.focus({ preventScroll: true });
  }

  function showNodeContextMenu(event, node) {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu({
      x: event.clientX,
      y: event.clientY,
      heading: node.label,
      meta: `${isContainer(node) ? '容器' : '节点'} · ${roleLabel(node.role)}`,
      role: node.role,
      items: contextMenuItemsForNode(node),
    });
  }

  function showEdgeContextMenu(event, edge) {
    event.preventDefault();
    event.stopPropagation();
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    showContextMenu({
      x: event.clientX,
      y: event.clientY,
      heading: edge.label || '连线',
      meta: `${source ? source.label : edge.from} -> ${target ? target.label : edge.to}`,
      items: [
        { icon: '✎', label: '编辑连线', action: () => selectEdge(edge.id) },
        { icon: '×', label: '删除连线', action: () => deleteEdge(edge.id) },
      ],
    });
  }

  function showCanvasContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const rect = stage.getBoundingClientRect();
    const t = currentTransform;
    const x = (event.clientX - rect.left - t.x) / Math.max(0.001, t.k);
    const y = (event.clientY - rect.top - t.y) / Math.max(0.001, t.k);
    const items = [
      { icon: '+', label: '新增节点', action: () => createNodeAt(x, y) },
      { icon: '→', label: '新增连线', action: () => setInteractionMode('edge') },
      { separator: true },
      { icon: '⧉', label: '粘贴', disabled: !clipboard, action: () => pasteClipboard() },
      { icon: '↶', label: '撤销', disabled: !undoStack.length, action: () => undo() },
      { icon: '↷', label: '重做', disabled: !redoStack.length, action: () => redo() },
      { separator: true },
      { icon: '⤢', label: '适配视图', action: fit },
    ];
    if (focusActive) {
      items.push({ icon: '✕', label: '退出聚焦', action: exitFocus });
    }
    items.push({ separator: true });
    items.push({
      icon: '⟳',
      label: '重新加载 JSON',
      action: () => vscode.postMessage({ type: 'reload' }),
    });
    showContextMenu({
      x: event.clientX,
      y: event.clientY,
      heading: '画布',
      meta: `${visibleNodeList.length} 个节点`,
      items,
    });
  }

  function createTagChip(label, options = {}) {
    const chip = document.createElement('span');
    chip.className = `tag-chip${options.more ? ' tag-more' : ''}`;
    chip.title = options.title || tagDescription(label) || label;

    if (options.more) {
      chip.textContent = label;
    } else {
      const hash = document.createElement('span');
      hash.className = 'tag-hash';
      hash.textContent = '#';
      const text = document.createElement('span');
      text.className = 'tag-text';
      text.textContent = label;
      chip.append(hash, text);
    }

    if (options.onRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-remove';
      remove.textContent = '×';
      remove.title = '移除标签';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onRemove();
      });
      chip.appendChild(remove);
    }
    return chip;
  }

  function renderTagChips(container, tags, max) {
    if (!container) return;
    container.innerHTML = '';
    if (!tags.length) return;
    const limit = Math.max(1, max);
    for (const label of tags.slice(0, limit)) {
      container.appendChild(createTagChip(label));
    }
    if (tags.length > limit) {
      const rest = tags.slice(limit);
      container.appendChild(createTagChip(`+${rest.length}`, {
        more: true,
        title: `其他标签：${rest.join('、')}`,
      }));
    }
  }

  function saveNodeTags(node, tags) {
    const nextTags = normalizeTagList(tags);
    pushUndo();
    const raw = rawNodeById(node.id);
    if (raw) {
      if (nextTags.length) raw.tags = nextTags.slice();
      else delete raw.tags;
      const catalog = Array.isArray(data.tags) ? data.tags : [];
      const known = new Set(catalog.map((item) => (typeof item === 'string' ? item : item && item.label ? String(item.label) : '')).filter(Boolean));
      for (const label of nextTags) {
        if (label && !known.has(label)) {
          catalog.push({ label });
          known.add(label);
        }
      }
      if (catalog.length) data.tags = catalog;
      setTagCatalog(catalog.map((item) => {
        if (typeof item === 'string') return { label: item };
        if (!item || !item.label) return null;
        return { label: String(item.label), description: item.description ? String(item.description) : '' };
      }).filter(Boolean));
    }
    node.tags = nextTags;
    markDirty();
    rebuildScene(false);
    if (selectedId === node.id) selectNode(node.id);
  }

  function addTagsFromInput(node, value) {
    const additions = String(value || '')
      .split(/[，,、;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!additions.length) return;
    saveNodeTags(node, [...node.tags, ...additions]);
  }

  function renderInspectorTags(node) {
    if (!inspectorTags) return;

    const head = document.createElement('div');
    head.className = 'inspector-section-title';
    head.textContent = '标签';

    const list = document.createElement('div');
    list.className = 'tag-editor-list';
    if (!node.tags.length) {
      const empty = document.createElement('span');
      empty.className = 'tag-editor-empty';
      empty.textContent = '暂无标签';
      list.appendChild(empty);
    } else {
      for (const label of node.tags) {
        list.appendChild(createTagChip(label, {
          onRemove: () => saveNodeTags(node, node.tags.filter((item) => item !== label)),
        }));
      }
    }

    const form = document.createElement('form');
    form.className = 'tag-editor-add';
    const inputWrap = document.createElement('div');
    inputWrap.className = 'tag-editor-input-wrap';
    const input = document.createElement('input');
    input.className = 'tag-editor-input';
    input.type = 'text';
    input.placeholder = '添加标签，如 长耗时';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const suggestions = document.createElement('div');
    suggestions.className = 'menu tag-autocomplete';
    suggestions.hidden = true;
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = '添加';
    add.title = '添加标签并写入地图 JSON';

    let suggestionItems = [];
    let activeSuggestion = -1;
    const selectSuggestion = (label) => {
      addTagsFromInput(node, label);
      input.value = '';
      suggestions.hidden = true;
      input.focus({ preventScroll: true });
    };
    const renderSuggestions = () => {
      const query = input.value.trim().toLowerCase();
      const labels = allTagLabels().filter((label) => !query || label.toLowerCase().includes(query));
      suggestionItems = [];
      activeSuggestion = -1;
      suggestions.replaceChildren();
      if (!labels.length) {
        const empty = document.createElement('div');
        empty.className = 'tag-autocomplete-empty';
        empty.textContent = '没有匹配的标签';
        suggestions.appendChild(empty);
      } else {
        for (const label of labels) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'menu-item tag-autocomplete-item';
          item.setAttribute('role', 'option');
          const hash = document.createElement('span');
          hash.className = 'tag-hash';
          hash.textContent = '#';
          const text = document.createElement('span');
          text.className = 'menu-label';
          text.textContent = label;
          item.append(hash, text);
          const description = tagDescription(label);
          if (description) {
            const hint = document.createElement('span');
            hint.className = 'menu-hint';
            hint.textContent = description;
            item.appendChild(hint);
          }
          item.addEventListener('mousedown', (event) => event.preventDefault());
          item.addEventListener('click', () => selectSuggestion(label));
          suggestions.appendChild(item);
          suggestionItems.push(item);
        }
      }
      suggestions.hidden = false;
    };
    const setActiveSuggestion = (index) => {
      activeSuggestion = index;
      suggestionItems.forEach((item, i) => item.classList.toggle('active', i === index));
      if (index >= 0 && index < suggestionItems.length) {
        suggestionItems[index].scrollIntoView({ block: 'nearest' });
      }
    };
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('focus', renderSuggestions);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (suggestions.hidden) renderSuggestions();
        if (!suggestionItems.length) return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveSuggestion((activeSuggestion + delta + suggestionItems.length) % suggestionItems.length);
      } else if (event.key === 'Enter' && activeSuggestion >= 0) {
        event.preventDefault();
        suggestionItems[activeSuggestion].click();
      } else if (event.key === 'Escape') {
        suggestions.hidden = true;
      }
    });
    form.addEventListener('focusout', (event) => {
      if (!inputWrap.contains(event.relatedTarget)) suggestions.hidden = true;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      addTagsFromInput(node, input.value);
      input.value = '';
      suggestions.hidden = true;
    });
    inputWrap.append(input, suggestions);
    form.append(inputWrap, add);
    inspectorTags.replaceChildren(head, list, form);
  }

  function cardMarkup() {
    return `
      <div class="node-head">
        <span class="node-dot"></span>
        <div class="node-title"></div>
        <span class="node-tags"></span>
      </div>
      <div class="node-body markdown"></div>
      <div class="node-foot">
        <span class="node-group"></span>
        <button class="node-source" type="button"></button>
      </div>`;
  }

  function renderCardTags(container, tags) {
    container.replaceChildren();
    if (!tags.length) return;
    const paint = (count, overflow) => {
      container.replaceChildren();
      for (const label of tags.slice(0, count)) {
        container.appendChild(createTagChip(label));
      }
      if (overflow > 0) {
        const hidden = tags.slice(count);
        container.appendChild(createTagChip(`+${overflow}`, {
          more: true,
          title: `其他标签：${hidden.join('、')}`,
        }));
      }
    };
    const rows = () => new Set([...container.children].map((el) => Math.round(el.offsetTop))).size;
    paint(tags.length, 0);
    if (rows() <= 2) return;
    let low = 0;
    let high = tags.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      paint(mid, tags.length - mid);
      if (rows() <= 2) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    paint(best, tags.length - best);
  }

  function layoutCardTags(card) {
    const slot = card.querySelector('.node-tags');
    if (!slot) return;
    renderCardTags(slot, slot.__tags || []);
  }

  function populateCard(card, node, groupText) {
    const titleEl = card.querySelector('.node-title');
    if (titleEl && !titleEl.isContentEditable) titleEl.textContent = node.label;
    card.querySelector('.node-group').textContent = groupText;
    const tagsSlot = card.querySelector('.node-tags');
    tagsSlot.__tags = node.tags;
    const body = card.querySelector('.node-body');
    if (node.description) {
      body.innerHTML = markdown(node.description);
      body.querySelectorAll('a').forEach((a) => a.addEventListener('click', onMarkdownLink));
      body.classList.remove('empty');
    } else {
      body.innerHTML = '';
      body.classList.add('empty');
    }

    let source = card.querySelector('.node-source');
    if (node.source && node.source.file) {
      if (!source) {
        source = document.createElement('button');
        source.className = 'node-source';
        source.type = 'button';
        const foot = card.querySelector('.node-foot');
        if (foot) foot.appendChild(source);
      }
      source.textContent = `${basename(node.source.file)}:${node.source.line || 1}`;
      source.title = `${node.source.file}:${node.source.line || 1}`;
      source.addEventListener('click', (event) => {
        event.stopPropagation();
        openSource(node);
      });
    } else if (source) {
      source.remove();
    }
  }

  function beginInlineTitleEdit(titleEl, node) {
    if (appMode !== 'edit' || !titleEl || titleEl.isContentEditable) return;
    selectNode(node.id);
    const original = node.label;
    let cancelled = false;
    titleEl.contentEditable = 'true';
    titleEl.spellcheck = false;
    titleEl.classList.add('inline-editing');
    const commit = () => {
      titleEl.removeEventListener('keydown', onKey);
      if (!titleEl.isContentEditable) return;
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('inline-editing');
      if (cancelled) {
        titleEl.textContent = original;
        return;
      }
      const value = titleEl.textContent.replace(/\s+/g, ' ').trim() || original;
      if (value === original) {
        titleEl.textContent = original;
        return;
      }
      pushUndo();
      const raw = rawNodeById(node.id);
      if (raw) raw.label = value;
      const model = nodeById.get(node.id);
      if (model) model.label = value;
      inspectorTitle.textContent = value;
      const input = inspectorBody.querySelector('[name=label]');
      if (input) input.value = value;
      if (node.el) {
        for (const title of node.el.querySelectorAll('.node-title')) title.textContent = value;
      }
      markDirty();
    };
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        titleEl.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelled = true;
        titleEl.blur();
      }
    };
    titleEl.addEventListener('keydown', onKey);
    titleEl.addEventListener('blur', commit, { once: true });
    requestAnimationFrame(() => {
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  }

  function renderNodeCards() {
    nodeLayer.innerHTML = '';
    edgeLabelSel.selectAll('.edge-label-group').remove();
    for (const node of nodes) node.el = null;

    const ordered = visibleNodeList.slice().sort((a, b) => {
      const da = depthOf(a);
      const db = depthOf(b);
      if (da !== db) return da - db;
      const ac = isContainer(a) ? 0 : 1;
      const bc = isContainer(b) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return a.index - b.index;
    });

    for (const node of ordered) {
      const el = document.createElement('div');
      el.className = `node role-${node.role}`;
      el.dataset.id = node.id;
      el.dataset.role = node.role;
      node.groupLabel = groupLabel(node.group);
      node.roleLabel = roleLabel(node.role);
      const groupText = [node.groupLabel, node.roleLabel].filter(Boolean).join(' · ');
      const container = isContainer(node);
      const level = Math.min(4, depthOf(node));
      const cardScale = container
        ? (18 / 12.5) / LOD_REF_SCALE[level]
        : (level <= 0 ? 1 : (12 / 12.5) / LOD_THRESHOLDS[level]);

      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.style.setProperty('--card-scale', String(cardScale));
      el.classList.add(`depth-${level}`);

      if (container) {
        const count = childrenOf(node).length;
        el.classList.add('node-container', 'expanded');
        el.style.setProperty('--container-head', `${node.headerHeight}px`);
        el.innerHTML = `
          <div class="container-card-view card-surface">${cardMarkup()}</div>
          <div class="container-frame-view">
            <div class="node-head container-head">
              <span class="node-dot"></span>
              <div class="node-title"></div>
              <span class="container-tags"></span>
              <span class="container-role"></span>
              <span class="container-count">${count} 项</span>
            </div>
            <div class="container-frame"></div>
          </div>`;

        populateCard(el.querySelector('.container-card-view'), node, groupText);

        const frameView = el.querySelector('.container-frame-view');
        frameView.querySelector('.node-title').textContent = node.label;
        const roleSlot = frameView.querySelector('.container-role');
        if (roleSlot) roleSlot.textContent = node.roleLabel;
        renderTagChips(frameView.querySelector('.container-tags'), node.tags, 2);
      } else {
        el.classList.add('card-surface');
        el.innerHTML = cardMarkup();
        populateCard(el, node, groupText);
      }

      const cardRoot = container ? el.querySelector('.container-card-view') : el;

      if (focusActive && !focusIds.has(node.id)) el.classList.add('focus-out');

      const bodyEl = cardRoot ? cardRoot.querySelector('.node-body') : null;
      if (bodyEl) {
        bodyEl.addEventListener('click', (event) => {
          if (appMode !== 'edit' || interactionMode || suppressClick) return;
          if (event.target.closest('a,button')) return;
          event.preventDefault();
          event.stopPropagation();
          selectNode(node.id);
          const descriptionInput = inspectorBody.querySelector('[name=description]');
          if (descriptionInput) {
            descriptionInput.focus({ preventScroll: true });
            const end = descriptionInput.value.length;
            descriptionInput.setSelectionRange(end, end);
          }
        });
      }

      el.addEventListener('click', (event) => {
        if (appMode !== 'edit') return;
        if (event.target.closest('a,button')) return;
        if (interactionMode === 'parent') {
          event.preventDefault();
          event.stopPropagation();
          finishParentPick(node.id);
          return;
        }
        if (interactionMode === 'edge') {
          event.preventDefault();
          event.stopPropagation();
          if (!edgeSourceId) {
            edgeSourceId = node.id;
            el.classList.add('edge-source');
            if (hint) hint.textContent = `起点：${node.label}；点击终点节点，Esc 取消`;
            refreshEdgeBanner();
            updateEdgePreviewAtNode(node);
          } else if (edgeSourceId !== node.id) {
            createEdgeBetween(edgeSourceId, node.id);
          }
          return;
        }
        if (interactionMode) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          openSource(node);
        } else {
          selectNode(node.id);
        }
      });

      el.addEventListener('dblclick', (event) => {
        if (appMode !== 'edit') return;
        if (event.target.closest('a,button')) return;
        event.preventDefault();
        event.stopPropagation();
        selectNode(node.id);
        openNodeEditor(nodeById.get(node.id) || node);
      });

      el.addEventListener('contextmenu', (event) => {
        if (appMode !== 'edit') return;
        showNodeContextMenu(event, node);
      });

      el.addEventListener('mousedown', (event) => {
        if (appMode !== 'edit') return;
        if (!event.target.closest('a,button')) event.stopPropagation();
      });
      el.addEventListener('pointerdown', (event) => startDrag(event, node, el));

      for (const titleEl of el.querySelectorAll('.node-title')) {
        titleEl.addEventListener('pointerdown', (event) => {
          if (titleEl.isContentEditable) event.stopPropagation();
        });
        titleEl.addEventListener('click', (event) => {
          if (appMode !== 'edit' || suppressClick || interactionMode) return;
          event.preventDefault();
          event.stopPropagation();
          beginInlineTitleEdit(titleEl, node);
        });
      }

      node.el = el;
      nodeLayer.appendChild(el);
      layoutCardTags(cardRoot);
    }
  }

  function selectNode(id) {
    if (appMode !== 'edit') return;
    const node = nodeById.get(id);
    if (!node) {
      closeInspector();
      return;
    }
    selectedId = id;
    selectedEdgeId = null;
    edgeHandleSel.selectAll('*').remove();
    for (const item of nodes) {
      if (item.el) item.el.classList.toggle('selected', item.id === id);
    }

    editingNodeId = null;
    if (inspectorEdge) {
      inspectorEdge.hidden = false;
      inspectorEdge.onclick = () => startEdgeFromNode(node);
    }
    if (inspectorTags) inspectorTags.hidden = false;
    if (inspectorLinks) inspectorLinks.hidden = false;
    inspectorTitle.textContent = node.label;
    updateInspectorPill(node);
    openNodeEditor(node);
    renderInspectorTags(node);

    if (node.source && node.source.file) {
      inspectorSourceWrap.hidden = false;
      inspectorSource.textContent = `打开 ${basename(node.source.file)}:${node.source.line || 1}`;
      inspectorSource.onclick = () => openSource(node);
    } else {
      inspectorSourceWrap.hidden = true;
      inspectorSource.onclick = null;
    }

    const rows = [];
    const parentNode = parentOf(node);
    if (parentNode) {
      rows.push(`<div class="link-row"><span>父级</span> ${escapeText(parentNode.label)}</div>`);
    }
    if (isContainer(node)) {
      const kids = childrenOf(node);
      rows.push(`<div class="link-row"><span>包含</span> ${kids.length} 个直接子节点</div>`);
      for (const child of kids) {
        rows.push(`<div class="link-row"><span>子项</span> ${escapeText(child.label)}</div>`);
      }
    }
    const incoming = viewEdges.filter((e) => e.to === id);
    const outgoing = viewEdges.filter((e) => e.from === id);
    for (const e of outgoing) {
      const target = nodeById.get(e.to);
      rows.push(`<div class="link-row"><span>输出</span> → ${escapeText(target ? target.label : e.to)}${e.label ? ' [' + escapeText(e.label) + ']' : ''}</div>`);
    }
    for (const e of incoming) {
      const source = nodeById.get(e.from);
      rows.push(`<div class="link-row"><span>输入</span> ← ${escapeText(source ? source.label : e.from)}${e.label ? ' [' + escapeText(e.label) + ']' : ''}</div>`);
    }
    inspectorLinks.innerHTML = rows.join('');
    inspector.classList.add('open');
    inspector.setAttribute('aria-hidden', 'false');
    updateEdgeClasses();
    renderResizeHandles();
  }

  function closeInspector() {
    const active = document.activeElement;
    if (active && active.closest && active.closest('#node-edit-form') && typeof active.blur === 'function') {
      active.blur();
    }
    selectedId = null;
    selectedEdgeId = null;
    editingNodeId = null;
    edgeHandleSel.selectAll('*').remove();
    inspector.classList.remove('open', 'node-editing');
    inspector.setAttribute('aria-hidden', 'true');
    inspectorBody.innerHTML = '';
    inspectorBody.className = 'markdown';
    if (inspectorTags) {
      inspectorTags.innerHTML = '';
      inspectorTags.hidden = true;
    }
    if (inspectorLinks) {
      inspectorLinks.innerHTML = '';
      inspectorLinks.hidden = true;
    }
    if (inspectorSourceWrap) inspectorSourceWrap.hidden = true;
    if (inspectorEdge) inspectorEdge.hidden = true;
    for (const node of nodes) if (node.el) node.el.classList.remove('selected');
    updateEdgeClasses();
    renderResizeHandles();
  }

  function rawNodeById(id) {
    return (data.nodes || []).find((item) => String(item.id) === String(id));
  }

  function persistWebviewState() {
    try {
      const mapPath = document.body.dataset.mapPath || '';
      if (typeof vscode.setState === 'function') {
        vscode.setState({ mapPath, appMode, lodMode, data: dirty ? buildSaveData() : null });
      }
      document.body.dataset.mapDirty = dirty ? 'true' : 'false';
    } catch (err) {
      // state persistence is best-effort
    }
  }

  function setDirty(value) {
    dirty = !!value;
    if (saveButton) saveButton.classList.toggle('dirty', dirty);
    if (saveState) {
      saveState.textContent = dirty ? '未保存' : '已保存';
      saveState.classList.toggle('dirty', dirty);
    }
    vscode.postMessage({ type: 'dirty', dirty });
    persistWebviewState();
  }

  function buildSaveData() {
    const saved = JSON.parse(JSON.stringify(data));
    const byId = new Map((saved.nodes || []).map((item) => [String(item.id), item]));
    for (const node of nodes) {
      const raw = byId.get(node.id);
      if (!raw) continue;
      raw.x = node.x;
      raw.y = node.y;
      raw.width = node.width;
      raw.height = node.height;
    }
    return saved;
  }

  function updateHistoryButtons() {
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
  }

  function pushUndo() {
    undoStack.push(JSON.stringify(buildSaveData()));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function restoreSnapshot(snapshot) {
    editingNodeId = null;
    requiresFullRoute = true;
    data = JSON.parse(snapshot);
    const keepId = selectedId;
    parseData(data);
    selectedId = keepId && nodeById.has(keepId) ? keepId : null;
    rebuildScene(false);
    setDirty(JSON.stringify(buildSaveData()) !== savedSnapshot);
    updateHistoryButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(buildSaveData()));
    restoreSnapshot(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(buildSaveData()));
    restoreSnapshot(redoStack.pop());
  }

  function copyNode(id) {
    const selected = nodeById.get(id);
    if (!selected) return false;
    const ids = new Set(subtreeNodes(selected).map((node) => node.id));
    const snapshot = buildSaveData();
    const rawNodes = (snapshot.nodes || []).filter((node) => ids.has(String(node.id)));
    const rawEdges = (snapshot.edges || []).filter((edge) => ids.has(String(edge.from)) && ids.has(String(edge.to)));
    clipboard = {
      nodes: JSON.parse(JSON.stringify(rawNodes)),
      edges: JSON.parse(JSON.stringify(rawEdges)),
      rootId: selected.id,
      rootParent: rawNodes.find((node) => String(node.id) === selected.id)?.parent || '',
    };
    pasteSerial = 0;
    return true;
  }

  function copySelectedNode() {
    return copyNode(selectedId);
  }

  function cutNode(id) {
    if (!copyNode(id)) return false;
    deleteNode(id);
    return true;
  }

  function pasteClipboard() {
    if (!clipboard || !clipboard.nodes.length) return false;
    pushUndo();
    const idMap = new Map();
    for (const raw of clipboard.nodes) {
      const oldId = String(raw.id);
      let base = `${oldId}-copy`;
      let nextId = base;
      let index = 1;
      while (nodeById.has(nextId) || idMap.has(nextId)) nextId = `${base}-${index++}`;
      idMap.set(oldId, nextId);
    }
    pasteSerial++;
    const offset = 60 * pasteSerial;
    const newNodes = clipboard.nodes.map((raw) => {
      const copy = JSON.parse(JSON.stringify(raw));
      copy.id = idMap.get(String(raw.id));
      copy.x = Number(copy.x) + offset;
      copy.y = Number(copy.y) + offset;
      if (copy.parent && idMap.has(String(copy.parent))) copy.parent = idMap.get(String(copy.parent));
      else if (String(raw.id) === clipboard.rootId) {
        if (clipboard.rootParent) copy.parent = clipboard.rootParent;
        else delete copy.parent;
      }
      return copy;
    });
    const edgeIds = new Set((data.edges || []).map((edge) => String(edge.id)));
    const newEdges = clipboard.edges.map((raw) => {
      const copy = JSON.parse(JSON.stringify(raw));
      let index = 1;
      let id = `edge-copy-${index}`;
      while (edgeIds.has(id)) id = `edge-copy-${++index}`;
      edgeIds.add(id);
      copy.id = id;
      copy.from = idMap.get(String(raw.from));
      copy.to = idMap.get(String(raw.to));
      if (Array.isArray(copy.waypoints)) {
        copy.waypoints = copy.waypoints.map((point) => ({ x: Number(point.x) + offset, y: Number(point.y) + offset }));
      }
      return copy;
    });
    data.nodes = data.nodes || [];
    data.nodes.push(...newNodes);
    data.edges = data.edges || [];
    data.edges.push(...newEdges);
    markDirty();
    parseData(data);
    selectedId = idMap.get(String(clipboard.rootId));
    rebuildScene(false);
    if (selectedId) selectNode(selectedId);
    return true;
  }

  function deleteNode(id) {
    const node = nodeById.get(id);
    if (!node) return;
    const ids = new Set(subtreeNodes(node).map((item) => item.id));
    if (!ids.size) return;
    pushUndo();
    data.nodes = (data.nodes || []).filter((item) => !ids.has(String(item.id)));
    data.edges = (data.edges || []).filter((edge) => !ids.has(String(edge.from)) && !ids.has(String(edge.to)));
    if (ids.has(selectedId)) selectedId = null;
    markDirty();
    parseData(data);
    rebuildScene(false);
    closeInspector();
  }

  function deleteEdge(id) {
    const has = (data.edges || []).some((edge) => String(edge.id) === String(id));
    if (!has) return;
    pushUndo();
    data.edges = (data.edges || []).filter((edge) => String(edge.id) !== String(id));
    if (String(selectedEdgeId) === String(id)) selectedEdgeId = null;
    markDirty();
    parseData(data);
    rebuildScene(false);
    closeInspector();
  }

  function saveMap() {
    if (saveState) {
      saveState.textContent = '保存中...';
      saveState.classList.remove('error');
    }
    const active = document.activeElement;
    if (active && active.closest && active.closest('#node-edit-form') && typeof active.blur === 'function') {
      active.blur();
    }
    vscode.postMessage({ type: 'save-map', data: buildSaveData() });
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function updateInspectorPill(node) {
    if (!inspectorGroup || !node) return;
    inspectorGroup.className = `group-pill role-${node.role}`;
    inspectorGroup.textContent = [
      node.groupLabel || (isContainer(node) ? '容器' : '节点'),
      isContainer(node) ? '容器' : '节点',
      node.roleLabel,
    ].filter((item, index, list) => item && list.indexOf(item) === index).join(' · ');
    inspector.dataset.role = node.role;
  }

  function refreshNodeCard(node) {
    if (!node || !node.el) return;
    node.groupLabel = groupLabel(node.group);
    node.roleLabel = roleLabel(node.role);
    const groupText = [node.groupLabel, node.roleLabel].filter(Boolean).join(' · ');
    if (isContainer(node)) {
      const card = node.el.querySelector('.container-card-view');
      if (card) populateCard(card, node, groupText);
      const frame = node.el.querySelector('.container-frame-view');
      if (frame) {
        const frameTitle = frame.querySelector('.node-title');
        if (frameTitle && !frameTitle.isContentEditable) frameTitle.textContent = node.label;
        const roleSlot = frame.querySelector('.container-role');
        if (roleSlot) roleSlot.textContent = node.roleLabel;
        renderTagChips(frame.querySelector('.container-tags'), node.tags, 2);
      }
      if (card) layoutCardTags(card);
    } else {
      populateCard(node.el, node, groupText);
      layoutCardTags(node.el);
    }
  }

  function scheduleNodeCardRefresh(node) {
    if (nodeCardRefreshTimer) clearTimeout(nodeCardRefreshTimer);
    nodeCardRefreshTimer = setTimeout(() => {
      nodeCardRefreshTimer = 0;
      refreshNodeCard(nodeById.get(node.id) || node);
    }, 220);
  }

  function openNodeEditor(node) {
    if (!node) return;
    if (appMode !== 'edit') return;
    editingNodeId = node.id;
    const raw = rawNodeById(node.id) || node;
    const role = raw.role || '';
    const blocked = new Set(subtreeNodes(node).map((item) => item.id));
    const currentParent = raw.parent ? nodeById.get(raw.parent) : null;
    inspector.classList.add('node-editing');
    if (inspectorEdge) {
      inspectorEdge.hidden = false;
      inspectorEdge.onclick = () => startEdgeFromNode(node);
    }
    if (inspectorTags) inspectorTags.hidden = false;
    if (inspectorSourceWrap) inspectorSourceWrap.hidden = false;
    if (inspectorLinks) inspectorLinks.hidden = false;
    inspectorBody.classList.remove('markdown');
    inspectorBody.innerHTML = `
      <form id="node-edit-form" class="node-editor" autocomplete="off">
        <label class="editor-field editor-title">
          <span>标题</span>
          <input name="label" value="${escapeAttr(raw.label || node.label)}" autocomplete="off">
        </label>
        <label class="editor-field">
          <span>描述</span>
          <textarea name="description" rows="8" spellcheck="false">${escapeText(raw.description || '')}</textarea>
        </label>
        <div class="editor-grid">
          <label class="editor-field">
            <span>分组</span>
            <input name="group" value="${escapeAttr(raw.group || '')}" autocomplete="off">
          </label>
          <label class="editor-field">
            <span>角色</span>
            <select name="role">
              <option value=""${role ? '' : ' selected'}>自动</option>
              <option value="start"${role === 'start' ? ' selected' : ''}>起点</option>
              <option value="process"${role === 'process' ? ' selected' : ''}>过程</option>
              <option value="end"${role === 'end' ? ' selected' : ''}>终点</option>
            </select>
          </label>
        </div>
        <div class="editor-section">
          <div class="editor-section-title">层级</div>
          <div class="editor-field editor-hierarchy-field">
            <span>父节点</span>
            <div class="hierarchy-control">
              <div class="hierarchy-value${raw.parent ? '' : ' is-top'}" id="node-parent-value">${
                currentParent ? `父节点：${escapeText(currentParent.label)}` : '顶层（无父节点）'
              }</div>
              <input type="hidden" name="parent" value="${escapeAttr(raw.parent || '')}">
              <button type="button" id="node-parent-pick">在画布中选择…</button>
              <button type="button" id="node-parent-detach"${raw.parent ? '' : ' disabled'}>移到顶层</button>
            </div>
          </div>
        </div>
        <div class="editor-section">
          <div class="editor-section-title">源码</div>
          <div class="editor-grid">
            <label class="editor-field">
              <span>源码文件</span>
              <input name="sourceFile" value="${escapeAttr(raw.source && raw.source.file || '')}" autocomplete="off">
            </label>
            <label class="editor-field">
              <span>源码行</span>
              <input name="sourceLine" type="number" min="1" step="1" value="${escapeAttr(raw.source && raw.source.line || 1)}">
            </label>
          </div>
        </div>
        <div class="editor-note">修改即时生效 · 拖动节点移动 · 拖动边角调整大小 · 拖动连线提示文字改位置 · Ctrl+S 保存到文件</div>
      </form>`;
    const form = inspectorBody.querySelector('#node-edit-form');
    const historyFields = new Set();
    const ensureHistory = (field) => {
      if (historyFields.has(field)) return;
      pushUndo();
      historyFields.add(field);
    };
    const currentRaw = () => rawNodeById(node.id) || raw;
    const currentModel = () => nodeById.get(node.id) || node;

    const labelInput = form.querySelector('[name=label]');
    labelInput.addEventListener('input', (event) => {
      ensureHistory('label');
      const text = String(event.target.value || '');
      const label = text.trim() || node.id;
      const target = currentRaw();
      target.label = label;
      const model = currentModel();
      model.label = label;
      inspectorTitle.textContent = label;
      if (node.el) {
        for (const title of node.el.querySelectorAll('.node-title')) title.textContent = label;
      }
      markDirty();
    });
    labelInput.addEventListener('blur', () => {
      if (!labelInput.value.trim()) labelInput.value = node.id;
    });

    const descriptionInput = form.querySelector('[name=description]');
    descriptionInput.addEventListener('input', (event) => {
      ensureHistory('description');
      const value = String(event.target.value || '');
      const target = currentRaw();
      if (value.trim()) target.description = value;
      else delete target.description;
      const model = currentModel();
      model.description = value;
      markDirty();
      scheduleNodeCardRefresh(model);
    });

    const groupInput = form.querySelector('[name=group]');
    groupInput.addEventListener('input', (event) => {
      ensureHistory('group');
      const value = String(event.target.value || '').trim();
      const target = currentRaw();
      if (value) target.group = value;
      else delete target.group;
      const model = currentModel();
      model.group = value;
      model.groupLabel = groupLabel(value);
      const groupText = [model.groupLabel, model.roleLabel].filter(Boolean).join(' · ');
      if (node.el) {
        for (const item of node.el.querySelectorAll('.node-group')) item.textContent = groupText;
      }
      updateInspectorPill(model);
      markDirty();
    });

    const roleSelect = form.querySelector('[name=role]');
    roleSelect.addEventListener('change', (event) => {
      ensureHistory('role');
      const value = String(event.target.value || '');
      const target = currentRaw();
      if (value) target.role = value;
      else delete target.role;
      markDirty();
      parseData(data);
      selectedId = node.id;
      rebuildScene(false);
    });

    const sourceFile = form.querySelector('[name=sourceFile]');
    const sourceLine = form.querySelector('[name=sourceLine]');
    const applySource = () => {
      ensureHistory('source');
      const file = String(sourceFile.value || '').trim();
      const line = Math.max(1, Math.floor(Number(sourceLine.value) || 1));
      const target = currentRaw();
      if (file) target.source = { file, line };
      else delete target.source;
      const model = currentModel();
      if (file) model.source = { file, line };
      else delete model.source;
      markDirty();
      refreshNodeCard(model);
      if (file) {
        if (inspectorSourceWrap) inspectorSourceWrap.hidden = false;
        if (inspectorSource) {
          inspectorSource.textContent = `打开 ${basename(file)}:${line}`;
          inspectorSource.onclick = () => openSource(model);
        }
      } else if (inspectorSourceWrap) {
        inspectorSourceWrap.hidden = true;
      }
    };
    sourceFile.addEventListener('change', applySource);
    sourceLine.addEventListener('change', applySource);

    const parentValue = form.querySelector('#node-parent-value');
    const parentDetach = form.querySelector('#node-parent-detach');
    form.querySelector('#node-parent-pick').addEventListener('click', () => {
      startParentPick(node.id, (pickedId) => {
        if (pickedId === node.id || blocked.has(String(pickedId))) {
          setParentPickNote('不能选择自身或子节点');
          return false;
        }
        setNodeParent(node.id, pickedId);
        return true;
      });
    });
    parentDetach.addEventListener('click', () => {
      setNodeParent(node.id, '');
    });

    form.addEventListener('submit', (event) => event.preventDefault());
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.target.blur();
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        event.target.blur();
      }
    });
  }

  function markDirty() {
    setDirty(true);
  }

  function setModeBanner(html) {
    if (!modeBanner) return;
    if (!html) {
      modeBanner.hidden = true;
      modeBanner.innerHTML = '';
      return;
    }
    modeBanner.hidden = false;
    modeBanner.innerHTML = html;
    const cancel = modeBanner.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('click', () => cancelInteractionMode());
  }

  function refreshEdgeBanner() {
    if (interactionMode !== 'edge') {
      setModeBanner('');
      return;
    }
    const source = edgeSourceId ? nodeById.get(edgeSourceId) : null;
    setModeBanner(`
      <span class="mode-banner-dot"></span>
      <span class="mode-banner-text">${
        source
          ? `连线起点：<b>${escapeText(source.label)}</b> · 点击终点节点完成连线`
          : '连线模式 · 点击起点节点，再点击终点节点'
      }<span class="mode-banner-key">Esc 取消</span></span>
      <button type="button" data-cancel>取消</button>`);
  }

  function setInteractionMode(mode) {
    if (appMode !== 'edit') return;
    if (interactionMode === mode) {
      cancelInteractionMode();
      return;
    }
    cancelInteractionMode();
    interactionMode = mode;
    edgeSourceId = null;
    const placing = mode === 'node';
    stage.classList.toggle('placing', placing);
    stage.classList.toggle('linking', mode === 'edge');
    if (addNodeButton) addNodeButton.classList.toggle('active', mode === 'node');
    if (addEdgeButton) addEdgeButton.classList.toggle('active', mode === 'edge');
    if (hint) {
      hint.textContent = placing
        ? '点击画布放置节点，Esc 取消'
        : mode === 'edge' ? '点击起点节点，再点击终点节点，Esc 取消' : defaultHint;
    }
    if (mode === 'edge') refreshEdgeBanner();
    else setModeBanner('');
  }

  function refreshParentPickBanner(note) {
    if (interactionMode !== 'parent' || !parentPick) {
      setModeBanner('');
      return;
    }
    setModeBanner(`
      <span class="mode-banner-dot"></span>
      <span class="mode-banner-text">${
        note ? `<b>${escapeText(note)}</b> · ` : ''
      }选择父节点 · 点击目标节点（会自动成为容器）<span class="mode-banner-key">Esc 取消</span></span>
      <button type="button" data-cancel>取消</button>`);
  }

  function setParentPickNote(note) {
    if (!parentPick) return;
    refreshParentPickBanner(note);
  }

  function startParentPick(nodeId, onPick) {
    if (appMode !== 'edit') return;
    const node = nodeById.get(nodeId);
    if (!node) return;
    cancelInteractionMode();
    interactionMode = 'parent';
    parentPick = { nodeId, onPick };
    const blocked = new Set(subtreeNodes(node).map((item) => item.id));
    for (const item of nodes) {
      if (item.el && !blocked.has(item.id)) item.el.classList.add('parent-pick-candidate');
    }
    stage.classList.add('picking-parent');
    if (hint) hint.textContent = '点击目标节点设为父节点，Esc 或点击空白处取消';
    refreshParentPickBanner();
  }

  function finishParentPick(pickedId) {
    if (!parentPick) return false;
    const result = parentPick.onPick(pickedId);
    if (result === false) return false;
    cancelInteractionMode();
    return true;
  }

  function setNodeParent(nodeId, parentId) {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const raw = rawNodeById(nodeId) || node;
    const next = String(parentId || '');
    if (next === String(raw.parent || '')) return;
    if (next) {
      const parentRaw = rawNodeById(next);
      if (!parentRaw || next === nodeId || isAncestorOf(node, nodeById.get(next))) return;
    }
    pushUndo();
    if (next) {
      const parentRaw = rawNodeById(next);
      if (parentRaw && parentRaw.type !== 'container') {
        parentRaw.type = 'container';
        parentRaw.width = Math.max(Number(parentRaw.width) || 0, 900);
        parentRaw.height = Math.max(Number(parentRaw.height) || 0, 420);
      }
      raw.parent = next;
    } else {
      delete raw.parent;
    }
    markDirty();
    parseData(data);
    selectedId = nodeId;
    rebuildScene(false);
  }

  function startEdgeFromNode(node) {
    if (appMode !== 'edit') return;
    if (interactionMode !== 'edge') setInteractionMode('edge');
    else setModeBanner('');
    if (!node) return;
    if (edgeSourceId && edgeSourceId !== node.id) {
      const previous = nodeById.get(edgeSourceId);
      if (previous && previous.el) previous.el.classList.remove('edge-source');
    }
    edgeSourceId = node.id;
    if (node.el) node.el.classList.add('edge-source');
    if (hint) hint.textContent = `起点：${node.label}；点击终点节点，Esc 取消`;
    refreshEdgeBanner();
    updateEdgePreviewAtNode(node);
  }

  function cancelInteractionMode() {
    if (edgeSourceId) {
      const source = nodeById.get(edgeSourceId);
      if (source && source.el) source.el.classList.remove('edge-source');
    }
    clearEdgePreview();
    clearEdgeDropTarget();
    interactionMode = null;
    edgeSourceId = null;
    parentPick = null;
    stage.classList.remove('placing', 'linking', 'picking-parent');
    for (const el of document.querySelectorAll('.node.parent-pick-candidate')) {
      el.classList.remove('parent-pick-candidate');
    }
    if (addNodeButton) addNodeButton.classList.remove('active');
    if (addEdgeButton) addEdgeButton.classList.remove('active');
    updateModeHint();
    setModeBanner('');
  }

  function createNodeAt(x, y, parentOverride = null) {
    const parent = String(parentOverride || '');
    const id = uniqueNodeId('new-node');
    const raw = {
      id,
      label: '新节点',
      x: Math.round(x),
      y: Math.round(y),
      width: 340,
      height: 140,
    };
    pushUndo();
    if (parent) {
      raw.parent = parent;
      const parentRaw = rawNodeById(parent);
      if (parentRaw && parentRaw.type !== 'container') {
        parentRaw.type = 'container';
        parentRaw.width = Math.max(Number(parentRaw.width) || 0, 900);
        parentRaw.height = Math.max(Number(parentRaw.height) || 0, 420);
      }
    }
    data.nodes = data.nodes || [];
    data.nodes.push(raw);
    markDirty();
    cancelInteractionMode();
    parseData(data);
    selectedId = id;
    rebuildScene(false);
    const node = nodeById.get(id);
    if (node) {
      selectNode(id);
      openNodeEditor(node);
    }
  }

  function createEdgeBetween(from, to) {
    const raw = { id: uniqueEdgeId(), from, to };
    pushUndo();
    data.edges = data.edges || [];
    data.edges.push(raw);
    markDirty();
    cancelInteractionMode();
    parseData(data);
    rebuildScene(false);
    selectEdge(raw.id);
  }

  function uniqueNodeId(prefix) {
    let index = 1;
    while (nodeById.has(`${prefix}-${index}`)) index++;
    return `${prefix}-${index}`;
  }

  function uniqueEdgeId() {
    let index = 1;
    const ids = new Set((data.edges || []).map((edge) => String(edge.id)));
    while (ids.has(`edge-${index}`)) index++;
    return `edge-${index}`;
  }

  function currentViewCenter() {
    const t = currentTransform;
    return {
      x: (stage.clientWidth / 2 - t.x) / Math.max(0.001, t.k),
      y: (stage.clientHeight / 2 - t.y) / Math.max(0.001, t.k),
    };
  }

  function rawEdgeById(id) {
    return (data.edges || []).find((edge) => String(edge.id) === String(id));
  }

  function modelEdgeById(id) {
    return edges.find((edge) => String(edge.id) === String(id)) || viewEdges.find((edge) => String(edge.id) === String(id));
  }

  function patchEdge(id, patch, reroute) {
    const raw = rawEdgeById(id);
    const model = edges.find((edge) => String(edge.id) === String(id));
    const view = viewEdges.find((edge) => String(edge.id) === String(id));
    if (raw) Object.assign(raw, patch);
    if (model) Object.assign(model, patch);
    if (view) Object.assign(view, patch);
    markDirty();
    if (reroute) {
      routeAllEdges();
      edgeLabelSel.selectAll('.edge-label-group').remove();
      drawEdges();
    } else {
      drawEdgeLabels(true);
    }
    applyEdgeSelection();
    renderEdgeHandles();
  }

  function applyEdgeSelection() {
    edgeSel.selectAll('.edge').classed('selected', function () {
      return String(this.getAttribute('data-id')) === String(selectedEdgeId);
    });
  }

  function anchorSideButtons(end, side) {
    const labels = [['', '自动'], ['top', '上'], ['right', '右'], ['bottom', '下'], ['left', '左']];
    return labels.map(([value, label]) => (
      `<button type="button" class="anchor-side${value === side ? ' active' : ''}" data-end="${end}" data-side="${value}">${label}</button>`
    )).join('');
  }

  function edgeWaypointRows(edge) {
    const points = Array.isArray(edge.waypoints) ? edge.waypoints : [];
    return points.map((point, index) => `
      <div class="edge-waypoint-row" data-index="${index}">
        <span>X</span><input class="wp-x" type="number" step="1" value="${escapeAttr(point.x)}">
        <span>Y</span><input class="wp-y" type="number" step="1" value="${escapeAttr(point.y)}">
        <button type="button" class="wp-remove" title="删除经过点">×</button>
      </div>`).join('');
  }

  function selectEdge(id) {
    if (appMode !== 'edit') return;
    const edge = modelEdgeById(id);
    if (!edge) return;
    if (interactionMode) cancelInteractionMode();
    selectedId = null;
    selectedEdgeId = String(id);
    for (const node of nodes) if (node.el) node.el.classList.remove('selected');
    editingNodeId = null;
    inspector.classList.add('open');
    inspector.classList.remove('node-editing');
    inspector.setAttribute('aria-hidden', 'false');
    inspector.dataset.role = 'process';
    inspectorTitle.textContent = edge.label || '连线';
    inspectorGroup.className = 'group-pill role-process';
    inspectorGroup.textContent = '连线';
    if (inspectorEdge) inspectorEdge.hidden = true;
    if (inspectorTags) inspectorTags.hidden = true;
    if (inspectorSourceWrap) inspectorSourceWrap.hidden = true;
    if (inspectorLinks) inspectorLinks.hidden = true;
    renderEdgeInspector(edge);
    updateEdgeClasses();
    applyEdgeSelection();
    renderEdgeHandles();
    renderResizeHandles();
  }

  function renderEdgeInspector(edge) {
    const raw = rawEdgeById(edge.id) || edge;
    const nodeOptions = nodes.slice().sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
    const options = nodeOptions.map((node) => `<option value="${escapeAttr(node.id)}"${String(node.id) === String(raw.from) ? ' selected' : ''}>${escapeText(node.label)} [${escapeAttr(node.id)}]</option>`).join('');
    const toOptions = nodeOptions.map((node) => `<option value="${escapeAttr(node.id)}"${String(node.id) === String(raw.to) ? ' selected' : ''}>${escapeText(node.label)} [${escapeAttr(node.id)}]</option>`).join('');
    const fromSide = raw.fromAnchor ? raw.fromAnchor.side : '';
    const toSide = raw.toAnchor ? raw.toAnchor.side : '';
    inspectorBody.innerHTML = `
      <form id="edge-edit-form" class="node-editor">
        <label class="editor-field"><span>提示文字</span><input name="label" value="${escapeAttr(raw.label || '')}" autocomplete="off"></label>
        <div class="editor-inline-actions">
          <button type="button" class="mini-button" id="edge-label-reset">重置文字位置</button>
          <span class="editor-hint">也可直接拖动连线上的提示文字</span>
        </div>
        <div class="editor-grid editor-grid-wide">
          <label class="editor-field"><span>起点节点</span><select name="from">${options}</select></label>
          <label class="editor-field"><span>终点节点</span><select name="to">${toOptions}</select></label>
        </div>
        <div class="editor-grid">
          <label class="editor-field"><span>线型</span><select name="style">
            <option value="solid"${raw.style === 'dashed' ? '' : ' selected'}>实线</option>
            <option value="dashed"${raw.style === 'dashed' ? ' selected' : ''}>虚线</option>
          </select></label>
          <label class="editor-field editor-checkbox"><span>显示箭头</span><input name="directed" type="checkbox"${raw.directed === false ? '' : ' checked'}></label>
        </div>
        <div class="edge-anchor-block">
          <div class="inspector-section-title">起点锚点</div>
          <div class="anchor-sides">${anchorSideButtons('from', fromSide)}</div>
          <label class="editor-field"><span>沿边偏移</span><input name="fromOffset" type="number" step="1" value="${escapeAttr(raw.fromAnchor ? raw.fromAnchor.offset || 0 : 0)}"></label>
        </div>
        <div class="edge-anchor-block">
          <div class="inspector-section-title">终点锚点</div>
          <div class="anchor-sides">${anchorSideButtons('to', toSide)}</div>
          <label class="editor-field"><span>沿边偏移</span><input name="toOffset" type="number" step="1" value="${escapeAttr(raw.toAnchor ? raw.toAnchor.offset || 0 : 0)}"></label>
        </div>
        <div class="edge-waypoints">
          <div class="inspector-section-title">经过点</div>
          <div class="edge-waypoint-list">${edgeWaypointRows(raw)}</div>
          <button type="button" id="edge-waypoint-add">+ 添加经过点</button>
        </div>
        <div class="editor-actions">
          <button type="button" class="danger" id="edge-delete">删除连线</button>
        </div>
      </form>`;
    const form = inspectorBody.querySelector('#edge-edit-form');
    let historyPushed = false;
    const ensureHistory = () => {
      if (historyPushed) return;
      pushUndo();
      historyPushed = true;
    };
    form.querySelector('[name=label]').addEventListener('input', (event) => {
      ensureHistory();
      patchEdge(edge.id, { label: event.target.value.trim() || undefined }, false);
      inspectorTitle.textContent = event.target.value.trim() || '连线';
    });
    form.querySelector('#edge-label-reset').addEventListener('click', () => {
      ensureHistory();
      const rawEdge = rawEdgeById(edge.id);
      const model = edges.find((item) => String(item.id) === String(edge.id));
      const view = viewEdges.find((item) => String(item.id) === String(edge.id));
      for (const target of [rawEdge, model, view]) {
        if (target) delete target.labelOffset;
      }
      markDirty();
      drawEdgeLabels(true);
    });
    form.querySelector('[name=from]').addEventListener('change', (event) => {
      ensureHistory();
      patchEdge(edge.id, { from: event.target.value }, true);
    });
    form.querySelector('[name=to]').addEventListener('change', (event) => {
      ensureHistory();
      patchEdge(edge.id, { to: event.target.value }, true);
    });
    form.querySelector('[name=style]').addEventListener('change', (event) => {
      ensureHistory();
      if (event.target.value === 'dashed') patchEdge(edge.id, { style: 'dashed' }, false);
      else {
        const rawEdge = rawEdgeById(edge.id);
        if (rawEdge) delete rawEdge.style;
        const model = edges.find((item) => item.id === edge.id);
        if (model) delete model.style;
        const view = viewEdges.find((item) => item.id === edge.id);
        if (view) delete view.style;
        markDirty();
        routeAllEdges();
        drawEdges();
        applyEdgeSelection();
        renderEdgeHandles();
      }
    });
    form.querySelector('[name=directed]').addEventListener('change', (event) => {
      ensureHistory();
      patchEdge(edge.id, { directed: event.target.checked ? undefined : false }, false);
    });
    form.querySelectorAll('.anchor-side').forEach((button) => {
      button.addEventListener('click', () => {
        ensureHistory();
        const end = button.dataset.end;
        const side = button.dataset.side;
        const key = end === 'from' ? 'fromAnchor' : 'toAnchor';
        const rawEdge = rawEdgeById(edge.id);
        if (!rawEdge) return;
        if (side) rawEdge[key] = { side, offset: Number(rawEdge[key] && rawEdge[key].offset) || 0 };
        else delete rawEdge[key];
        const model = edges.find((item) => item.id === edge.id);
        const view = viewEdges.find((item) => item.id === edge.id);
        for (const target of [model, view]) {
          if (!target) continue;
          if (side) target[key] = { side, offset: Number(target[key] && target[key].offset) || 0 };
          else delete target[key];
        }
        markDirty();
        routeAllEdges();
        drawEdges();
        applyEdgeSelection();
        renderEdgeHandles();
        form.querySelectorAll(`.anchor-side[data-end="${end}"]`).forEach((item) => item.classList.toggle('active', item.dataset.side === side));
      });
    });
    form.querySelector('[name=fromOffset]').addEventListener('change', (event) => {
      ensureHistory();
      const rawEdge = rawEdgeById(edge.id);
      if (!rawEdge || !rawEdge.fromAnchor) return;
      const offset = Number(event.target.value) || 0;
      rawEdge.fromAnchor.offset = offset;
      const model = edges.find((item) => item.id === edge.id);
      const view = viewEdges.find((item) => item.id === edge.id);
      if (model && model.fromAnchor) model.fromAnchor.offset = offset;
      if (view && view.fromAnchor) view.fromAnchor.offset = offset;
      markDirty();
      routeAllEdges();
      drawEdges();
      applyEdgeSelection();
      renderEdgeHandles();
    });
    form.querySelector('[name=toOffset]').addEventListener('change', (event) => {
      ensureHistory();
      const rawEdge = rawEdgeById(edge.id);
      if (!rawEdge || !rawEdge.toAnchor) return;
      const offset = Number(event.target.value) || 0;
      rawEdge.toAnchor.offset = offset;
      const model = edges.find((item) => item.id === edge.id);
      const view = viewEdges.find((item) => item.id === edge.id);
      if (model && model.toAnchor) model.toAnchor.offset = offset;
      if (view && view.toAnchor) view.toAnchor.offset = offset;
      markDirty();
      routeAllEdges();
      drawEdges();
      applyEdgeSelection();
      renderEdgeHandles();
    });
    form.querySelectorAll('.edge-waypoint-row').forEach((row) => {
      const updatePoint = () => {
        ensureHistory();
        const index = Number(row.dataset.index);
        const rawEdge = rawEdgeById(edge.id);
        if (!rawEdge || !Array.isArray(rawEdge.waypoints) || !rawEdge.waypoints[index]) return;
        const point = { x: Number(row.querySelector('.wp-x').value), y: Number(row.querySelector('.wp-y').value) };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        rawEdge.waypoints[index] = point;
        const model = edges.find((item) => item.id === edge.id);
        const view = viewEdges.find((item) => item.id === edge.id);
        if (model && Array.isArray(model.waypoints)) model.waypoints[index] = point;
        if (view && Array.isArray(view.waypoints)) view.waypoints[index] = point;
        markDirty();
        routeAllEdges();
        drawEdges();
        applyEdgeSelection();
        renderEdgeHandles();
      };
      row.querySelector('.wp-x').addEventListener('change', updatePoint);
      row.querySelector('.wp-y').addEventListener('change', updatePoint);
      row.querySelector('.wp-remove').addEventListener('click', () => {
        ensureHistory();
        const index = Number(row.dataset.index);
        const rawEdge = rawEdgeById(edge.id);
        if (!rawEdge || !Array.isArray(rawEdge.waypoints)) return;
        rawEdge.waypoints.splice(index, 1);
        if (!rawEdge.waypoints.length) delete rawEdge.waypoints;
        const model = edges.find((item) => item.id === edge.id);
        const view = viewEdges.find((item) => item.id === edge.id);
        for (const target of [model, view]) {
          if (!target) continue;
          if (Array.isArray(target.waypoints)) {
            target.waypoints.splice(index, 1);
            if (!target.waypoints.length) delete target.waypoints;
          }
        }
        markDirty();
        routeAllEdges();
        drawEdges();
        selectEdge(edge.id);
      });
    });
    form.querySelector('#edge-waypoint-add').addEventListener('click', () => {
      ensureHistory();
      const rawEdge = rawEdgeById(edge.id);
      if (!rawEdge) return;
      const route = edgeRoutes.get(edge.id);
      const point = route ? route.mid : currentViewCenter();
      rawEdge.waypoints = Array.isArray(rawEdge.waypoints) ? rawEdge.waypoints : [];
      rawEdge.waypoints.push({ x: Math.round(point.x), y: Math.round(point.y) });
      const model = edges.find((item) => item.id === edge.id);
      const view = viewEdges.find((item) => item.id === edge.id);
      if (model) model.waypoints = rawEdge.waypoints.map((p) => ({ ...p }));
      if (view) view.waypoints = rawEdge.waypoints.map((p) => ({ ...p }));
      markDirty();
      routeAllEdges();
      drawEdges();
      selectEdge(edge.id);
    });
    form.querySelector('#edge-delete').addEventListener('click', () => deleteEdge(edge.id));
  }

  function worldPointFromEvent(event) {
    const rect = stage.getBoundingClientRect();
    const t = currentTransform;
    return {
      x: (event.clientX - rect.left - t.x) / Math.max(0.001, t.k),
      y: (event.clientY - rect.top - t.y) / Math.max(0.001, t.k),
    };
  }

  function nearestAnchor(node, point) {
    const dx = point.x - node.x;
    const dy = point.y - node.y;
    const sides = [
      { side: 'left', distance: Math.abs(dx + node.width / 2), offset: dy },
      { side: 'right', distance: Math.abs(dx - node.width / 2), offset: dy },
      { side: 'top', distance: Math.abs(dy + node.height / 2), offset: dx },
      { side: 'bottom', distance: Math.abs(dy - node.height / 2), offset: dx },
    ];
    sides.sort((a, b) => a.distance - b.distance);
    const best = sides[0];
    const limit = best.side === 'left' || best.side === 'right' ? node.height / 2 : node.width / 2;
    return { side: best.side, offset: Math.max(-limit, Math.min(limit, best.offset)) };
  }

  function anchorPointOnNode(node, anchor) {
    const offset = Number(anchor && anchor.offset) || 0;
    const side = anchor && anchor.side;
    if (side === 'top') {
      return { x: node.x + Math.max(-node.width / 2, Math.min(node.width / 2, offset)), y: node.y - node.height / 2 };
    }
    if (side === 'bottom') {
      return { x: node.x + Math.max(-node.width / 2, Math.min(node.width / 2, offset)), y: node.y + node.height / 2 };
    }
    if (side === 'left') {
      return { x: node.x - node.width / 2, y: node.y + Math.max(-node.height / 2, Math.min(node.height / 2, offset)) };
    }
    if (side === 'right') {
      return { x: node.x + node.width / 2, y: node.y + Math.max(-node.height / 2, Math.min(node.height / 2, offset)) };
    }
    return { x: node.x, y: node.y };
  }

  function clearEdgePreview() {
    edgePreviewPath.attr('d', null);
  }

  function updateEdgePreview(point) {
    if (interactionMode !== 'edge' || !edgeSourceId || !point) {
      clearEdgePreview();
      return;
    }
    const source = nodeById.get(edgeSourceId);
    if (!source) {
      clearEdgePreview();
      return;
    }
    const anchor = nearestAnchor(source, point);
    const start = anchorPointOnNode(source, anchor);
    edgePreviewPath.attr('d', `M${start.x},${start.y} L${point.x},${point.y}`);
  }

  function updateEdgePreviewAtNode(node) {
    if (!node) {
      clearEdgePreview();
      return;
    }
    updateEdgePreview({ x: node.x + node.width / 2 + 90, y: node.y });
  }

  function nodeElementAt(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    return hit && hit.closest ? hit.closest('.node') : null;
  }

  function pickNodeAtWorldPoint(point) {
    let best = null;
    let bestDepth = -1;
    let bestArea = Infinity;
    for (const node of nodes) {
      if ((node.lodAlpha ?? 1) <= 0.005) continue;
      if (Math.abs(point.x - node.x) > node.width / 2) continue;
      if (Math.abs(point.y - node.y) > node.height / 2) continue;
      const depth = depthOf(node);
      const area = node.width * node.height;
      if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
        best = node;
        bestDepth = depth;
        bestArea = area;
      }
    }
    return best;
  }

  function nodeIdAtClient(clientX, clientY) {
    const el = nodeElementAt(clientX, clientY);
    if (el) return el.dataset.id;
    const node = pickNodeAtWorldPoint(worldPointFromEvent({ clientX, clientY }));
    return node ? node.id : '';
  }

  function highlightEdgeDropTarget(id) {
    for (const el of document.querySelectorAll('.node.edge-drop-target')) {
      if (!id || el.dataset.id !== id) el.classList.remove('edge-drop-target');
    }
    if (!id) return;
    const node = nodeById.get(id);
    if (node && node.el) node.el.classList.add('edge-drop-target');
  }

  function clearEdgeDropTarget() {
    highlightEdgeDropTarget(null);
  }

  function resizePreviewRoute(edge) {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) return null;
    const startAnchor = edge.fromAnchor || nearestAnchor(source, { x: target.x, y: target.y });
    const endAnchor = edge.toAnchor || nearestAnchor(target, { x: source.x, y: source.y });
    const start = anchorPointOnNode(source, startAnchor);
    const end = anchorPointOnNode(target, endAnchor);
    const waypoints = Array.isArray(edge.waypoints) ? edge.waypoints : [];
    let points;
    if (waypoints.length) {
      points = [start, ...waypoints.map((point) => ({ x: Number(point.x), y: Number(point.y) })), end];
    } else if (Math.abs(end.x - start.x) < 1 || Math.abs(end.y - start.y) < 1) {
      points = [start, end];
    } else if (Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)) {
      points = [start, { x: end.x, y: start.y }, end];
    } else {
      points = [start, { x: start.x, y: end.y }, end];
    }
    return routeFromPoints(points, true);
  }

  function collectIncidentEdgePaths(nodeIds) {
    const ids = nodeIds instanceof Set ? nodeIds : new Set([String(nodeIds)]);
    const out = [];
    for (const path of edgeLayer.querySelectorAll('.edge')) {
      const from = path.getAttribute('data-from');
      const to = path.getAttribute('data-to');
      if (!ids.has(from) && !ids.has(to)) continue;
      const edge = modelEdgeById(path.getAttribute('data-id'));
      if (edge) out.push({ path, edge });
    }
    return out;
  }

  function updateResizePreview(incident) {
    for (const item of incident) {
      const route = resizePreviewRoute(item.edge);
      if (route) item.path.setAttribute('d', route.d);
    }
  }

  function renderResizeHandles() {
    const node = selectedId ? nodeById.get(selectedId) : null;
    if (appMode !== 'edit' || !node || !node.el || node.el.classList.contains('lod-hidden')) {
      resizeHandleLayer.classList.add('hidden');
      return;
    }
    resizeHandleLayer.classList.remove('hidden');
    const uiScale = Math.min(16, Math.max(1, 1 / Math.max(0.05, currentTransform.k)));
    const gap = 4 * uiScale;
    const band = 8 * uiScale;
    const corner = 16 * uiScale;
    const left = node.x - node.width / 2 - gap;
    const top = node.y - node.height / 2 - gap;
    const width = node.width + gap * 2;
    const height = node.height + gap * 2;
    resizeFrameEl.style.left = `${left}px`;
    resizeFrameEl.style.top = `${top}px`;
    resizeFrameEl.style.width = `${width}px`;
    resizeFrameEl.style.height = `${height}px`;
    const zones = {
      n: [left, top - band / 2, width, band],
      s: [left, top + height - band / 2, width, band],
      w: [left - band / 2, top, band, height],
      e: [left + width - band / 2, top, band, height],
      nw: [left - corner / 2, top - corner / 2, corner, corner],
      ne: [left + width - corner / 2, top - corner / 2, corner, corner],
      sw: [left - corner / 2, top + height - corner / 2, corner, corner],
      se: [left + width - corner / 2, top + height - corner / 2, corner, corner],
    };
    for (const [direction, box] of Object.entries(zones)) {
      const handle = resizeHandleEls.get(direction);
      if (!handle) continue;
      handle.style.left = `${box[0]}px`;
      handle.style.top = `${box[1]}px`;
      handle.style.width = `${box[2]}px`;
      handle.style.height = `${box[3]}px`;
    }
  }

  function startResize(event, node, handle, corner) {
    if (appMode !== 'edit') return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = worldPointFromEvent(event);
    const startRect = {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      left: node.x - node.width / 2,
      right: node.x + node.width / 2,
      top: node.y - node.height / 2,
      bottom: node.y + node.height / 2,
    };
    const minWidth = isContainer(node) ? 260 : 180;
    const minHeight = isContainer(node) ? 140 : 48;
    const incident = collectIncidentEdgePaths(node.id);
    let moved = false;
    let historyPushed = false;
    let dirtyNotified = false;
    let frame = 0;
    const renderResize = () => {
      frame = 0;
      applyNodeGeometry(node);
      updateResizePreview(incident);
      renderResizeHandles();
    };
    const scheduleResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(renderResize);
    };
    const move = (moveEvent) => {
      const point = worldPointFromEvent(moveEvent);
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (!historyPushed) {
        pushUndo();
        historyPushed = true;
      }
      let left = startRect.left;
      let right = startRect.right;
      let top = startRect.top;
      let bottom = startRect.bottom;
      if (corner.includes('e')) right = Math.max(left + minWidth, startRect.right + dx);
      if (corner.includes('w')) left = Math.min(right - minWidth, startRect.left + dx);
      if (corner.includes('s')) bottom = Math.max(top + minHeight, startRect.bottom + dy);
      if (corner.includes('n')) top = Math.min(bottom - minHeight, startRect.top + dy);
      node.width = right - left;
      node.height = bottom - top;
      node.x = (left + right) / 2;
      node.y = (top + bottom) / 2;
      const raw = rawNodeById(node.id);
      if (raw) {
        raw.x = node.x;
        raw.y = node.y;
        raw.width = node.width;
        raw.height = node.height;
      }
      if (!dirtyNotified) {
        markDirty();
        dirtyNotified = true;
      }
      scheduleResize();
    };
    const up = (upEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(upEvent.pointerId); } catch (error) { /* ignore */ }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (moved) {
        applyNodeGeometry(node);
        updateResizePreview(incident);
        renderResizeHandles();
        routeAllEdges({ fast: true });
        edgeLabelSel.selectAll('.edge-label-group').remove();
        drawEdges();
        if (selectedEdgeId) renderEdgeHandles();
        persistWebviewState();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    try { handle.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
  }

  function scheduleEdgeHandleRoute() {
    if (edgeHandleFrame) return;
    edgeHandleFrame = requestAnimationFrame(() => {
      edgeHandleFrame = 0;
      routeAllEdges();
      edgeLabelSel.selectAll('.edge-label-group').remove();
      drawEdges();
      applyEdgeSelection();
      renderEdgeHandles();
    });
  }

  function dragEdgeHandle(event, kind, index) {
    if (appMode !== 'edit') return;
    const edge = modelEdgeById(selectedEdgeId);
    if (!edge) return;
    event.preventDefault();
    event.stopPropagation();
    pushUndo();
    markDirty();
    const move = (moveEvent) => {
      const point = worldPointFromEvent(moveEvent);
      const raw = rawEdgeById(edge.id);
      if (!raw) return;
      if (kind === 'waypoint') {
        if (!Array.isArray(raw.waypoints) || !raw.waypoints[index]) return;
        raw.waypoints[index] = { x: point.x, y: point.y };
        const model = edges.find((item) => item.id === edge.id);
        if (model && Array.isArray(model.waypoints)) model.waypoints[index] = { ...raw.waypoints[index] };
        const view = viewEdges.find((item) => item.id === edge.id);
        if (view && Array.isArray(view.waypoints)) view.waypoints[index] = { ...raw.waypoints[index] };
      } else {
        const isFrom = kind === 'from';
        const nodeId = isFrom ? edge.from : edge.to;
        const node = nodeById.get(nodeId);
        if (!node) return;
        const anchor = nearestAnchor(node, point);
        const key = isFrom ? 'fromAnchor' : 'toAnchor';
        raw[key] = anchor;
        const model = edges.find((item) => item.id === edge.id);
        const view = viewEdges.find((item) => item.id === edge.id);
        if (model) model[key] = { ...anchor };
        if (view) view[key] = { ...anchor };
      }
      scheduleEdgeHandleRoute();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      scheduleEdgeHandleRoute();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function renderEdgeHandles() {
    edgeHandleSel.selectAll('*').remove();
    if (!selectedEdgeId) return;
    const edge = modelEdgeById(selectedEdgeId);
    const route = edgeRoutes.get(selectedEdgeId);
    if (!edge || !route || !route.points.length) return;
    const edgeLevel = Math.min(4, edgeAlphaLevel(edge));
    if ((lodLevels[edgeLevel] ?? 1) <= 0.005) return;
    const size = 13 / Math.max(0.03, currentTransform.k);
    const makeHandle = (point, kind, index, label) => {
      const rect = edgeHandleSel.append('rect')
        .attr('class', `edge-handle${kind === 'waypoint' ? ' waypoint' : ''}`)
        .attr('x', point.x - size / 2)
        .attr('y', point.y - size / 2)
        .attr('width', size)
        .attr('height', size)
        .attr('rx', 0)
        .attr('data-handle', kind);
      rect.append('title').text(label);
      rect.on('pointerdown', (event) => dragEdgeHandle(event, kind, index));
    };
    makeHandle(route.points[0], 'from', -1, '拖动设置起点锚边');
    makeHandle(route.points[route.points.length - 1], 'to', -1, '拖动设置终点锚边');
    const waypoints = Array.isArray(edge.waypoints) ? edge.waypoints : [];
    for (let i = 0; i < waypoints.length; i++) {
      makeHandle({ x: Number(waypoints[i].x), y: Number(waypoints[i].y) }, 'waypoint', i, `经过点 ${i + 1}`);
    }
  }

  function escapeText(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function dragItemsFor(node) {
    return subtreeNodes(node);
  }

  function subtreeNodes(node) {
    const out = [];
    const walk = (cur) => {
      out.push(cur);
      for (const child of childrenOf(cur)) walk(child);
    };
    walk(node);
    return out;
  }

  function routeFromPoints(points, soft) {
    return {
      points,
      soft,
      d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '),
      mid: routeMid(points),
    };
  }

  function segmentHitsRect(a, b, left, top, right, bottom) {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - left, right - a.x, a.y - top, bottom - a.y];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-9) {
        if (q[i] < 0) return false;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
    return true;
  }

  function isAncestorOf(a, b) {
    let cur = parentOf(b);
    const seen = new Set([b.id]);
    while (cur && !seen.has(cur.id)) {
      if (cur === a) return true;
      seen.add(cur.id);
      cur = parentOf(cur);
    }
    return false;
  }

  function nodesOverlap(a, b, pad = 4) {
    return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + pad &&
           Math.abs(a.y - b.y) < (a.height + b.height) / 2 + pad;
  }

  function dragCollision() {
    if (!drag) return false;
    for (const moving of drag.movedNodes) {
      for (const other of drag.staticNodes) {
        if (isAncestorOf(moving, other) || isAncestorOf(other, moving)) continue;
        if (isContainer(other) && drag.targetParentIds && drag.targetParentIds.has(other.id)) continue;
        if (nodesOverlap(moving, other)) return true;
      }
    }
    return false;
  }

  function setDragDelta(dx, dy) {
    if (!drag) return;
    for (const item of drag.items) {
      item.node.x = item.x + dx;
      item.node.y = item.y + dy;
    }
  }

  function dragDeltaValid(dx, dy) {
    setDragDelta(dx, dy);
    return !dragCollision();
  }

  function clampDragAxis(axis, target) {
    const last = axis === 'x' ? drag.lastDx : drag.lastDy;
    if (Math.abs(target - last) < 0.01) return;
    const test = (value) => {
      const dx = axis === 'x' ? value : drag.lastDx;
      const dy = axis === 'y' ? value : drag.lastDy;
      return dragDeltaValid(dx, dy);
    };
    if (test(target)) {
      if (axis === 'x') drag.lastDx = target;
      else drag.lastDy = target;
      return;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const value = last + (target - last) * mid;
      if (test(value)) lo = mid;
      else hi = mid;
    }
    const value = last + (target - last) * lo;
    if (axis === 'x') drag.lastDx = value;
    else drag.lastDy = value;
  }

  function pickContainerAtWorldPoint(point, excludeIds) {
    let best = null;
    let bestDepth = -1;
    let bestArea = Infinity;
    for (const node of nodes) {
      if (!isContainer(node)) continue;
      if (excludeIds && excludeIds.has(node.id)) continue;
      if ((node.lodAlpha ?? 1) <= 0.005) continue;
      if (Math.abs(point.x - node.x) > node.width / 2) continue;
      if (Math.abs(point.y - node.y) > node.height / 2) continue;
      const depth = depthOf(node);
      const area = node.width * node.height;
      if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
        best = node;
        bestDepth = depth;
        bestArea = area;
      }
    }
    return best;
  }

  function clearDragParentTarget() {
    if (dragParentId) {
      const previous = nodeById.get(dragParentId);
      if (previous && previous.el) previous.el.classList.remove('drag-parent-target');
    }
    dragParentId = null;
    dragHintKey = '';
    if (hint) hint.textContent = defaultHint;
  }

  function updateDragParentTarget(event) {
    if (!drag) return;
    const point = worldPointFromEvent(event);
    const candidate = pickContainerAtWorldPoint(point, drag.movedIds);
    const targetId = candidate ? candidate.id : '';
    const currentParent = String(drag.node.parent || '');
    const key = `${targetId}|${currentParent}`;
    if (key !== dragHintKey) {
      drag.targetParentIds = new Set();
      let cursor = candidate;
      const seen = new Set();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        drag.targetParentIds.add(cursor.id);
        cursor = parentOf(cursor);
      }
    }
    if (key === dragHintKey) return;
    dragHintKey = key;
    if (dragParentId && dragParentId !== targetId) {
      const previous = nodeById.get(dragParentId);
      if (previous && previous.el) previous.el.classList.remove('drag-parent-target');
    }
    dragParentId = targetId || null;
    if (dragParentId && dragParentId !== currentParent) {
      const target = nodeById.get(dragParentId);
      if (target && target.el) target.el.classList.add('drag-parent-target');
      if (hint) hint.textContent = `松开后归入：${target ? target.label : dragParentId}`;
    } else if (!dragParentId && currentParent) {
      if (hint) hint.textContent = '松开后移到顶层（无父节点）';
    } else if (hint) {
      hint.textContent = '拖动节点移动位置，松开完成';
    }
  }

  function commitDragReparent(dragState, targetId) {
    if (!dragState) return;
    const node = dragState.node;
    const raw = rawNodeById(node.id);
    if (!raw) return;
    const next = String(targetId || '');
    if (next === String(raw.parent || '')) return;
    for (const item of dragState.items) {
      const itemRaw = rawNodeById(item.node.id);
      if (!itemRaw) continue;
      itemRaw.x = item.node.x;
      itemRaw.y = item.node.y;
      itemRaw.width = item.node.width;
      itemRaw.height = item.node.height;
    }
    if (next) {
      const parentRaw = rawNodeById(next);
      if (!parentRaw) return;
      if (parentRaw.type !== 'container') {
        parentRaw.type = 'container';
        parentRaw.width = Math.max(Number(parentRaw.width) || 0, 900);
        parentRaw.height = Math.max(Number(parentRaw.height) || 0, 420);
      }
      raw.parent = next;
    } else {
      delete raw.parent;
    }
    markDirty();
    parseData(data);
    selectedId = node.id;
    rebuildScene(false, true);
  }

  function startDrag(event, node, el) {
    if (appMode !== 'edit') return;
    if (interactionMode) return;
    if (event.target.closest('a,button')) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    const movedNodes = subtreeNodes(node);
    const movedIds = new Set(movedNodes.map((item) => item.id));
    const staticNodes = nodes.filter((item) => !movedIds.has(item.id));
    const items = dragItemsFor(node).map((item) => ({
      node: item,
      x: item.x,
      y: item.y,
    }));
    const incident = collectIncidentEdgePaths(movedIds);
    drag = {
      node,
      el,
      items,
      movedNodes,
      staticNodes,
      movedIds,
      dx: 0,
      dy: 0,
      lastDx: 0,
      lastDy: 0,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      captured: false,
      historyPushed: false,
      targetParentIds: new Set(),
    };

    const move = (ev) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      updateDragParentTarget(ev);
      const scale = currentTransform.k || 1;
      const dx = (ev.clientX - drag.clientX) / scale;
      const dy = (ev.clientY - drag.clientY) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.moved && !drag.captured) {
        try { el.setPointerCapture(ev.pointerId); drag.captured = true; } catch (error) { /* ignore */ }
      }
      if (drag.moved && !drag.historyPushed) {
        pushUndo();
        drag.historyPushed = true;
      }
      if (dragDeltaValid(dx, dy)) {
        drag.lastDx = dx;
        drag.lastDy = dy;
      } else {
        const firstAxis = Math.abs(dx - drag.lastDx) >= Math.abs(dy - drag.lastDy) ? 'x' : 'y';
        if (firstAxis === 'x') {
          clampDragAxis('x', dx);
          clampDragAxis('y', dy);
        } else {
          clampDragAxis('y', dy);
          clampDragAxis('x', dx);
        }
      }

      setDragDelta(drag.lastDx, drag.lastDy);
      drag.dx = drag.lastDx;
      drag.dy = drag.lastDy;
      for (const item of drag.items) applyNodeGeometry(item.node);
      updateResizePreview(incident);
      renderResizeHandles();
    };

    const up = (ev) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const dragState = drag;
      if (ev.type !== 'pointercancel' && drag.moved) updateDragParentTarget(ev);
      const targetParentId = dragParentId || '';
      const moved = drag.moved;
      suppressClick = moved;
      if (moved) setTimeout(() => { suppressClick = false; }, 0);
      if (dragState.captured) {
        try { drag.el.releasePointerCapture(ev.pointerId); } catch (error) { /* ignore */ }
      }
      drag.el.removeEventListener('pointermove', move);
      drag.el.removeEventListener('pointerup', up);
      drag.el.removeEventListener('pointercancel', up);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      drag = null;
      clearDragParentTarget();
      if (moved && ev.type !== 'pointercancel') {
        const raw = rawNodeById(dragState.node.id);
        const currentParent = String(raw && raw.parent || '');
        if (targetParentId !== currentParent) {
          commitDragReparent(dragState, targetParentId);
        } else {
          routeAllEdges({ fast: true });
          edgeLabelSel.selectAll('.edge-label-group').remove();
          drawEdges();
          markDirty();
        }
      }
      renderResizeHandles();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }


  const GRID_SIZE = 16;
  const NODE_PAD = 4;
  // Soft cost field: paths pay extra while running close to a node or a
  // container frame. It never blocks a cell, it only makes the A* prefer the
  // middle of a corridor instead of hugging an edge.
  const SOFT_CLEARANCE = 36;
  const SOFT_CLEARANCE_WEIGHT = 4;
  // A straight segment that runs parallel to a box within this distance for
  // at least CONNECT_CLEARANCE_OVERLAP pixels is rejected by canConnect().
  const CONNECT_CLEARANCE = 14;
  const CONNECT_CLEARANCE_OVERLAP = 28;

  function addSoftClearance(penalty, grid, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const frame = isContainer(node);
    const radius = SOFT_CLEARANCE;
    const gx0 = Math.max(0, Math.floor((left - radius - grid.minX) / GRID_SIZE));
    const gx1 = Math.min(grid.cols - 1, Math.ceil((right + radius - grid.minX) / GRID_SIZE));
    const gy0 = Math.max(0, Math.floor((top - radius - grid.minY) / GRID_SIZE));
    const gy1 = Math.min(grid.rows - 1, Math.ceil((bottom + radius - grid.minY) / GRID_SIZE));
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = grid.minY + (gy + 0.5) * GRID_SIZE;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = grid.minX + (gx + 0.5) * GRID_SIZE;
        const inside = x > left && x < right && y > top && y < bottom;
        let distance;
        if (frame) {
          distance = inside
            ? Math.min(x - left, right - x, y - top, bottom - y)
            : Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom));
        } else {
          if (inside) continue;
          distance = Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom));
        }
        if (distance >= radius) continue;
        const cost = SOFT_CLEARANCE_WEIGHT * (1 - distance / radius);
        const index = gy * grid.cols + gx;
        if (cost > penalty[index]) penalty[index] = cost;
      }
    }
  }

  function buildRoutingGrid() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of visibleNodeList) {
      minX = Math.min(minX, node.x - node.width / 2);
      maxX = Math.max(maxX, node.x + node.width / 2);
      minY = Math.min(minY, node.y - node.height / 2);
      maxY = Math.max(maxY, node.y + node.height / 2);
    }
    minX -= 480;
    maxX += 480;
    minY -= 480;
    maxY += 480;
    const cols = Math.max(1, Math.ceil((maxX - minX) / GRID_SIZE) + 1);
    const rows = Math.max(1, Math.ceil((maxY - minY) / GRID_SIZE) + 1);
    const blocked = new Uint8Array(cols * rows);
    const penalty = new Float32Array(cols * rows);
    const grid = { minX, minY, cols, rows, blocked, penalty, occ: new Uint8Array(cols * rows) };
    for (const node of obstacleNodes) {
      const left = node.x - node.width / 2 - NODE_PAD;
      const right = node.x + node.width / 2 + NODE_PAD;
      const top = node.y - node.height / 2 - NODE_PAD;
      const bottom = node.y + node.height / 2 + NODE_PAD;
      const gx0 = Math.max(0, Math.floor((left - minX) / GRID_SIZE));
      const gx1 = Math.min(cols - 1, Math.ceil((right - minX) / GRID_SIZE));
      const gy0 = Math.max(0, Math.floor((top - minY) / GRID_SIZE));
      const gy1 = Math.min(rows - 1, Math.ceil((bottom - minY) / GRID_SIZE));
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          blocked[gy * cols + gx] = 1;
        }
      }
    }
    for (const node of visibleNodeList) {
      if (!isContainer(node)) continue;
      blockFrameBorder(grid, node);
    }
    for (const node of obstacleNodes) {
      addSoftClearance(penalty, grid, node);
    }
    for (const node of visibleNodeList) {
      if (!isContainer(node)) continue;
      addSoftClearance(penalty, grid, node);
    }
    return grid;
  }

  function blockFrameBorder(grid, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const clearance = GRID_SIZE;
    const gx0 = Math.max(0, Math.floor((left - clearance - grid.minX) / GRID_SIZE));
    const gx1 = Math.min(grid.cols - 1, Math.ceil((right + clearance - grid.minX) / GRID_SIZE));
    const gy0 = Math.max(0, Math.floor((top - clearance - grid.minY) / GRID_SIZE));
    const gy1 = Math.min(grid.rows - 1, Math.ceil((bottom + clearance - grid.minY) / GRID_SIZE));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = grid.minX + (gx + 0.5) * GRID_SIZE;
        const y = grid.minY + (gy + 0.5) * GRID_SIZE;
        const inside = x > left && x < right && y > top && y < bottom;
        const distance = inside
          ? Math.min(x - left, right - x, y - top, bottom - y)
          : Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom));
        if (distance < clearance) {
          grid.blocked[gy * grid.cols + gx] = 1;
        }
      }
    }
  }

  function gridPoint(grid, gx, gy) {
    return {
      x: grid.minX + (gx + 0.5) * GRID_SIZE,
      y: grid.minY + (gy + 0.5) * GRID_SIZE,
    };
  }

  function cellOf(grid, x, y) {
    return {
      gx: Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.minX) / GRID_SIZE))),
      gy: Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.minY) / GRID_SIZE))),
    };
  }

  function nearestFreeCell(grid, gx, gy, dirX, dirY) {
    const allowed = (x, y) => {
      if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return false;
      if (grid.blocked[y * grid.cols + x]) return false;
      if (dirX && (x - gx) * dirX < 0) return false;
      if (dirY && (y - gy) * dirY < 0) return false;
      return true;
    };
    if (allowed(gx, gy)) return { gx, gy };
    for (let r = 1; r <= 22; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          if (allowed(gx + dx, gy + dy)) return { gx: gx + dx, gy: gy + dy };
        }
      }
    }
    return { gx, gy };
  }

  function heapPush(heap, idx, f) {
    heap.idx.push(idx);
    heap.f.push(f);
    let n = heap.idx.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heap.f[p] <= heap.f[n]) break;
      [heap.f[p], heap.f[n]] = [heap.f[n], heap.f[p]];
      [heap.idx[p], heap.idx[n]] = [heap.idx[n], heap.idx[p]];
      n = p;
    }
  }

  function heapPop(heap) {
    if (!heap.idx.length) return -1;
    const top = heap.idx[0];
    const lastIdx = heap.idx.pop();
    const lastF = heap.f.pop();
    if (heap.idx.length) {
      heap.idx[0] = lastIdx;
      heap.f[0] = lastF;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let best = n;
        if (l < heap.idx.length && heap.f[l] < heap.f[best]) best = l;
        if (r < heap.idx.length && heap.f[r] < heap.f[best]) best = r;
        if (best === n) break;
        [heap.f[best], heap.f[n]] = [heap.f[n], heap.f[best]];
        [heap.idx[best], heap.idx[n]] = [heap.idx[n], heap.idx[best]];
        n = best;
      }
    }
    return top;
  }

  const ROUTE_DIRS = [
    { dx: 1, dy: 0, dir: 0, mask: 1 },
    { dx: 1, dy: 1, dir: 1, mask: 4 },
    { dx: 0, dy: 1, dir: 2, mask: 2 },
    { dx: -1, dy: 1, dir: 3, mask: 8 },
    { dx: -1, dy: 0, dir: 4, mask: 1 },
    { dx: -1, dy: -1, dir: 5, mask: 8 },
    { dx: 0, dy: -1, dir: 6, mask: 2 },
    { dx: 1, dy: -1, dir: 7, mask: 4 },
  ];

  function directionIndex(dx, dy) {
    if (Math.abs(dx) < 0.1) return dy >= 0 ? 2 : 6;
    if (Math.abs(dy) < 0.1) return dx >= 0 ? 0 : 4;
    if (dx > 0) return dy > 0 ? 1 : 7;
    return dy > 0 ? 3 : 5;
  }

  function directionDiff(a, b) {
    const diff = Math.abs(a - b) % 8;
    return Math.min(diff, 8 - diff);
  }

  function turnOk(a, b, c) {
    const d1 = directionIndex(b.x - a.x, b.y - a.y);
    const d2 = directionIndex(c.x - b.x, c.y - b.y);
    return directionDiff(d1, d2) <= 2;
  }

  function pathHasAcuteTurn(points) {
    for (let i = 1; i < points.length - 1; i++) {
      if (!turnOk(points[i - 1], points[i], points[i + 1])) return true;
    }
    return false;
  }

  function turnsInPath(points) {
    let count = 0;
    for (let i = 1; i < points.length - 1; i++) {
      if (directionIndex(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) !==
          directionIndex(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)) count++;
    }
    return count;
  }

  function findGridPath(grid, start, end, hardBlock, startDir, endDir) {
    const total = grid.cols * grid.rows;
    const startCell = start.gy * grid.cols + start.gx;
    const endCell = end.gy * grid.cols + end.gx;
    if (startCell === endCell) {
      return directionDiff(startDir, endDir) <= 2 ? [startCell] : null;
    }

    const stateCount = total * 8;
    const dist = new Float64Array(stateCount);
    dist.fill(Infinity);
    const prev = new Int32Array(stateCount);
    prev.fill(-1);
    const done = new Uint8Array(stateCount);
    const heap = { idx: [], f: [] };

    const heuristic = (x, y) => {
      const dx = Math.abs(x - end.gx);
      const dy = Math.abs(y - end.gy);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };

    const startState = startCell * 8 + startDir;
    dist[startState] = 0;
    heapPush(heap, startState, heuristic(start.gx, start.gy));

    let endState = -1;
    while (heap.idx.length) {
      const state = heapPop(heap);
      if (state < 0 || done[state]) continue;
      const cell = (state / 8) | 0;
      const stateDir = state & 7;
      if (cell === endCell && directionDiff(stateDir, endDir) <= 2) {
        endState = state;
        break;
      }
      done[state] = 1;
      const x = cell % grid.cols;
      const y = (cell / grid.cols) | 0;

      for (const dir of ROUTE_DIRS) {
        const diff = directionDiff(stateDir, dir.dir);
        if (diff > 2) continue;
        const nx = x + dir.dx;
        const ny = y + dir.dy;
        if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
        const ni = ny * grid.cols + nx;
        if (grid.blocked[ni]) continue;
        if (dir.dx !== 0 && dir.dy !== 0) {
          if (grid.blocked[y * grid.cols + nx] || grid.blocked[ny * grid.cols + x]) continue;
        }
        const occ = grid.occ[ni];
        if (hardBlock && (occ & dir.mask)) continue;
        let traverse = 0;
        if (occ) traverse = 400;
        const turn = diff === 0 ? 0 : (diff === 1 ? 20 : 12);
        const soft = grid.penalty ? grid.penalty[ni] : 0;
        const step = (dir.dx !== 0 && dir.dy !== 0 ? Math.SQRT2 : 1) + turn + traverse + soft;
        const nextState = ni * 8 + dir.dir;
        const nd = dist[state] + step;
        if (nd + 1e-9 < dist[nextState]) {
          dist[nextState] = nd;
          prev[nextState] = state;
          heapPush(heap, nextState, nd + heuristic(nx, ny));
        }
      }
    }

    if (endState < 0) return null;
    const states = [];
    for (let cur = endState; cur !== -1; cur = prev[cur]) states.push(cur);
    states.reverse();
    const path = [];
    for (const state of states) {
      const cell = (state / 8) | 0;
      if (path[path.length - 1] !== cell) path.push(cell);
    }
    return path;
  }


  function markOccupancy(grid, points) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) continue;
      const mask = Math.abs(dx) < 0.1 ? 2 : Math.abs(dy) < 0.1 ? 1 : ((dx > 0) === (dy > 0) ? 4 : 8);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (GRID_SIZE / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + dx * s / steps;
        const y = a.y + dy * s / steps;
        const c = cellOf(grid, x, y);
        grid.occ[c.gy * grid.cols + c.gx] |= mask;
      }
    }
  }

  function simplifyPoints(points) {
    const out = [];
    for (const p of points) {
      if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.01 && Math.abs(out[out.length - 1].y - p.y) < 0.01) continue;
      out.push(p);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < out.length - 1; i++) {
        const a = out[i - 1];
        const b = out[i];
        const c = out[i + 1];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (Math.abs(cross) < 0.01) {
          out.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return out;
  }

  function routeMid(points) {
    let best = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!best || len > best.len) best = { a, b, len };
    }
    if (!best || best.len < 1) return { x: 0, y: 0 };
    const mx = (best.a.x + best.b.x) / 2;
    const my = (best.a.y + best.b.y) / 2;
    const nx = -(best.b.y - best.a.y) / best.len;
    const ny = (best.b.x - best.a.x) / best.len;
    return { x: mx + nx * 9, y: my + ny * 9 };
  }

  function sideCandidates(node, other) {
    const dx = other.x - node.x;
    const dy = other.y - node.y;
    const nx = Math.abs(dx) / Math.max(1, (node.width + other.width) / 2);
    const ny = Math.abs(dy) / Math.max(1, (node.height + other.height) / 2);
    const horizontal = nx >= ny;
    const primary = horizontal
      ? (dx >= 0 ? 'right' : 'left')
      : (dy >= 0 ? 'bottom' : 'top');
    const secondary = horizontal
      ? (dy >= 0 ? 'bottom' : 'top')
      : (dx >= 0 ? 'right' : 'left');
    const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[primary];
    const all = [primary, secondary, opposite, { left: 'top', right: 'bottom', top: 'left', bottom: 'right' }[primary]];
    return [...new Set(all)];
  }

  function makePort(node, side, offset, gap) {
    if (side === 'left' || side === 'right') {
      const sign = side === 'right' ? 1 : -1;
      return {
        axis: 'h',
        dir: { x: sign, y: 0 },
        point: { x: node.x + sign * (node.width / 2 + 2), y: node.y + offset },
        probe: { x: node.x + sign * (node.width / 2 + gap), y: node.y + offset },
      };
    }
    const sign = side === 'bottom' ? 1 : -1;
    return {
      axis: 'v',
      dir: { x: 0, y: sign },
      point: { x: node.x + offset, y: node.y + sign * (node.height / 2 + 2) },
      probe: { x: node.x + offset, y: node.y + sign * (node.height / 2 + gap) },
    };
  }

  function anchorPort(node, anchor, gap) {
    const side = anchor.side;
    const limit = side === 'left' || side === 'right'
      ? Math.max(0, node.height / 2 - 8)
      : Math.max(0, node.width / 2 - 8);
    const offset = Math.max(-limit, Math.min(limit, anchor.offset));
    const port = makePort(node, side, offset, gap);
    port.locked = true;
    return port;
  }

  function connectorBlocked(grid, node, side, offset, gap) {
    const a = makePort(node, side, offset, gap).point;
    const b = makePort(node, side, offset, gap).probe;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const mask = side === 'left' || side === 'right' ? 1 : 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (GRID_SIZE / 2)));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + (b.x - a.x) * s / steps;
      const y = a.y + (b.y - a.y) * s / steps;
      const c = cellOf(grid, x, y);
      if (grid.occ[c.gy * grid.cols + c.gx] & mask) return true;
    }
    for (const other of obstacleNodes) {
      if (other === node) continue;
      const left = other.x - other.width / 2 - 3;
      const right = other.x + other.width / 2 + 3;
      const top = other.y - other.height / 2 - 3;
      const bottom = other.y + other.height / 2 + 3;
      if (maxX > left && minX < right && maxY > top && minY < bottom) return true;
    }
    return false;
  }

  function choosePort(node, other, usedPorts, grid) {
    const gap = GRID_SIZE * 2.3;
    const sides = sideCandidates(node, other);
    if (sides.length > 1) {
      const sideUse = (side) => {
        const prefix = `${node.id}|${side}|`;
        let count = 0;
        for (const key of usedPorts) if (key.startsWith(prefix)) count++;
        return count;
      };
      const usedPrimary = sideUse(sides[0]);
      const usedSecondary = sideUse(sides[1]);
      const secondary = sides[1];
      const towardSecondary = secondary === 'top'
        ? other.y < node.y - (node.height + other.height) / 2
        : secondary === 'bottom'
          ? other.y > node.y + (node.height + other.height) / 2
          : secondary === 'left'
            ? other.x < node.x - (node.width + other.width) / 2
            : other.x > node.x + (node.width + other.width) / 2;
      if (usedSecondary === 0 && towardSecondary && usedPrimary >= 1) {
        [sides[0], sides[1]] = [sides[1], sides[0]];
      }
    }
    const limit = (side) => side === 'left' || side === 'right' ? node.height / 2 - 24 : node.width / 2 - 24;
    const offsets = [0, 14, -14, 28, -28, 42, -42, 56, -56, 70, -70];
    let fallback = null;
    for (const side of sides) {
      const max = Math.max(0, limit(side));
      for (const offset of offsets) {
        if (Math.abs(offset) > max) continue;
        const key = `${node.id}|${side}|${offset}`;
        if (usedPorts.has(key)) continue;
        if (!connectorBlocked(grid, node, side, offset, gap)) {
          usedPorts.add(key);
          return makePort(node, side, offset, gap);
        }
        if (!fallback) fallback = { side, offset, key };
      }
    }
    if (fallback) {
      usedPorts.add(fallback.key);
      return makePort(node, fallback.side, fallback.offset, gap);
    }
    const side = sides[0];
    const port = makePort(node, side, 0, gap);
    usedPorts.add(`${node.id}|${side}|0`);
    return port;
  }

  function insideAnyNode(x, y) {
    for (const node of obstacleNodes) {
      if (x > node.x - node.width / 2 - 2 && x < node.x + node.width / 2 + 2 &&
          y > node.y - node.height / 2 - 2 && y < node.y + node.height / 2 + 2) {
        return true;
      }
    }
    return false;
  }

  function clearCorridor(grid, a, b) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (GRID_SIZE / 2)));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + (b.x - a.x) * s / steps;
      const y = a.y + (b.y - a.y) * s / steps;
      const c = cellOf(grid, x, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = c.gx + dx;
          const gy = c.gy + dy;
          if (gx < 0 || gy < 0 || gx >= grid.cols || gy >= grid.rows) continue;
          const p = gridPoint(grid, gx, gy);
          if (!insideAnyNode(p.x, p.y)) grid.blocked[gy * grid.cols + gx] = 0;
        }
      }
    }
  }

  function pointOnRect(a, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const near = 2.5;
    return (a.x >= left - near && a.x <= right + near && (Math.abs(a.y - top) <= near || Math.abs(a.y - bottom) <= near)) ||
           (a.y >= top - near && a.y <= bottom + near && (Math.abs(a.x - left) <= near || Math.abs(a.x - right) <= near));
  }

  function segmentCrossesFrame(a, b, node) {
    if (pointOnRect(a, node) || pointOnRect(b, node)) return false;
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const aIn = a.x > left && a.x < right && a.y > top && a.y < bottom;
    const bIn = b.x > left && b.x < right && b.y > top && b.y < bottom;
    if (aIn && bIn) return false;
    if (aIn !== bIn) return true;
    return segmentHitsRect(a, b, left - 2, top - 2, right + 2, bottom + 2);
  }

  function endpointSide(point, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const near = 5;
    if (Math.abs(point.x - left) <= near && point.y >= top - near && point.y <= bottom + near) return 'left';
    if (Math.abs(point.x - right) <= near && point.y >= top - near && point.y <= bottom + near) return 'right';
    if (Math.abs(point.y - top) <= near && point.x >= left - near && point.x <= right + near) return 'top';
    if (Math.abs(point.y - bottom) <= near && point.x >= left - near && point.x <= right + near) return 'bottom';
    return '';
  }

  function leavesSidePerpendicular(a, b, node) {
    const horizontal = Math.abs(a.y - b.y) < 0.1;
    const vertical = Math.abs(a.x - b.x) < 0.1;
    if (!horizontal && !vertical) return false;
    const side = endpointSide(a, node) || endpointSide(b, node);
    if (!side) return false;
    if (horizontal) return side === 'left' || side === 'right';
    return side === 'top' || side === 'bottom';
  }

  function segmentParallelGap(a, b, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const horizontal = Math.abs(a.y - b.y) < 0.1;
    const vertical = Math.abs(a.x - b.x) < 0.1;
    if (horizontal) {
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      if (Math.min(maxX, right) - Math.max(minX, left) < CONNECT_CLEARANCE_OVERLAP) return Infinity;
      const y = a.y;
      if (y < top) return top - y;
      if (y > bottom) return y - bottom;
      if (!isContainer(node)) return Infinity;
      return Math.min(y - top, bottom - y);
    }
    if (vertical) {
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (Math.min(maxY, bottom) - Math.max(minY, top) < CONNECT_CLEARANCE_OVERLAP) return Infinity;
      const x = a.x;
      if (x < left) return left - x;
      if (x > right) return x - right;
      if (!isContainer(node)) return Infinity;
      return Math.min(x - left, right - x);
    }
    return Infinity;
  }

  function canConnect(grid, a, c) {
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    if (!(Math.abs(dx) < 0.1 || Math.abs(dy) < 0.1 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.1)) return false;
    for (const node of visibleNodeList) {
      if (isContainer(node) && segmentCrossesFrame(a, c, node)) return false;
      if (segmentParallelGap(a, c, node) < CONNECT_CLEARANCE && !leavesSidePerpendicular(a, c, node)) return false;
    }
    const mask = Math.abs(dx) < 0.1 ? 2 : Math.abs(dy) < 0.1 ? 1 : ((dx > 0) === (dy > 0) ? 4 : 8);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (GRID_SIZE / 2)));
    for (let i = 1; i < steps; i++) {
      const x = a.x + dx * i / steps;
      const y = a.y + dy * i / steps;
      if (insideAnyNode(x, y)) return false;
      const cell = cellOf(grid, x, y);
      if (grid.occ[cell.gy * grid.cols + cell.gx] & mask) return false;
    }
    return true;
  }

  function prunePoints(grid, points) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1];
        const b = points[i];
        const c = points[i + 1];
        const l1 = Math.hypot(b.x - a.x, b.y - a.y);
        const l2 = Math.hypot(c.x - b.x, c.y - b.y);
        if ((l1 < 14 || l2 < 14 || true) && canConnect(grid, a, c)) {
          points.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return points;
  }

  function simplifyBySight(grid, points) {
    let i = 0;
    while (i < points.length - 2) {
      let far = i + 1;
      for (let j = points.length - 1; j >= i + 2; j--) {
        if (canConnect(grid, points[i], points[j])) {
          far = j;
          break;
        }
      }
      if (far > i + 1) {
        points.splice(i + 1, far - i - 1);
      }
      i++;
    }
    return points;
  }

  function snapShortCorners(grid, points) {
    for (let i = points.length - 2; i >= 1; i--) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      if (l1 >= 18 && l2 >= 18) continue;
      const candidates = [
        { x: c.x, y: a.y },
        { x: a.x, y: c.y },
      ];
      let best = null;
      for (const d of candidates) {
        const dl1 = Math.hypot(d.x - a.x, d.y - a.y);
        const dl2 = Math.hypot(c.x - d.x, c.y - d.y);
        if (dl1 < 2 || dl2 < 2) continue;
        if (insideAnyNode(d.x, d.y)) continue;
        if (!canConnect(grid, a, d) || !canConnect(grid, d, c)) continue;
        const len = dl1 + dl2;
        if (len > l1 + l2 + 80) continue;
        if (!best || len < best.len) best = { d, len };
      }
      if (best) {
        points.splice(i, 1, best.d);
      }
    }
    return points;
  }

  function outwardCell(grid, port) {
    const minRun = 24;
    const maxRun = 80;
    const candidates = [];
    const tryCells = (point) => {
      const base = cellOf(grid, point.x, point.y);
      for (let step = 0; step <= 14; step++) {
        let gx = base.gx;
        let gy = base.gy;
        if (port.axis === 'h') {
          gx = base.gx + port.dir.x * step;
        } else {
          gy = base.gy + port.dir.y * step;
        }
        if (gx < 0 || gy < 0 || gx >= grid.cols || gy >= grid.rows) continue;
        if (grid.blocked[gy * grid.cols + gx]) continue;
        const center = gridPoint(grid, gx, gy);
        const run = port.axis === 'h'
          ? (center.x - port.point.x) * port.dir.x
          : (center.y - port.point.y) * port.dir.y;
        if (run < minRun || run > maxRun) continue;
        const aligned = port.axis === 'h'
          ? { x: port.point.x, y: center.y }
          : { x: center.x, y: port.point.y };
        if (!canConnect(grid, aligned, center)) continue;
        candidates.push({ gx, gy, run, center });
        break;
      }
    };
    const base = cellOf(grid, port.point.x, port.point.y);
    if (port.axis === 'h') {
      for (let d = 0; d <= 3; d++) {
        for (const sign of d === 0 ? [0] : [-1, 1]) {
          const gy = base.gy + sign * d;
          if (gy < 0 || gy >= grid.rows) continue;
          tryCells({ x: port.point.x, y: gridPoint(grid, base.gx, gy).y });
        }
        if (candidates.length) break;
      }
    } else {
      for (let d = 0; d <= 3; d++) {
        for (const sign of d === 0 ? [0] : [-1, 1]) {
          const gx = base.gx + sign * d;
          if (gx < 0 || gx >= grid.cols) continue;
          tryCells({ x: gridPoint(grid, gx, base.gy).x, y: port.point.y });
        }
        if (candidates.length) break;
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.run - b.run);
      const best = candidates[0];
      if (!port.locked) {
        if (port.axis === 'h') {
          port.point.y = best.center.y;
        } else {
          port.point.x = best.center.x;
        }
      }
      port.probe = { x: best.center.x, y: best.center.y };
      return { gx: best.gx, gy: best.gy };
    }
    const probeCell = cellOf(grid, port.probe.x, port.probe.y);
    return nearestFreeCell(grid, probeCell.gx, probeCell.gy, port.dir.x, port.dir.y);
  }

  function lineIntersection(a, b, c, d) {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = d.x - c.x;
    const vy = d.y - c.y;
    const den = ux * vy - uy * vx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / den;
    return { x: a.x + ux * t, y: a.y + uy * t };
  }

  function mergeShortBends(grid, points, minLen, protectEnds) {
    let changed = true;
    while (changed) {
      changed = false;
      const first = protectEnds ? 2 : 1;
      const last = points.length - (protectEnds ? 3 : 2);
      for (let i = first; i <= last; i++) {
        const a = points[i - 1];
        const b = points[i];
        const c = points[i + 1];
        const d = points[i + 2];
        if (!a || !b || !c || !d) continue;
        const shortLen = Math.hypot(c.x - b.x, c.y - b.y);
        if (shortLen >= minLen) continue;
        const q = lineIntersection(a, b, c, d);
        if (!q) continue;
        if (Math.hypot(q.x - b.x, q.y - b.y) > 48) continue;
        if (Math.hypot(q.x - c.x, q.y - c.y) > 48) continue;
        if (insideAnyNode(q.x, q.y)) continue;
        if (!canConnect(grid, a, q) || !canConnect(grid, q, d)) continue;
        const lenA = Math.hypot(q.x - a.x, q.y - a.y);
        const lenD = Math.hypot(d.x - q.x, d.y - q.y);
        if (lenA < 2 || lenD < 2) continue;
        if (protectEnds && i + 2 === points.length - 1 && lenD < minLen) continue;
        if (protectEnds && i - 1 === 0 && lenA < minLen) continue;
        points.splice(i, 2, q);
        changed = true;
        break;
      }
    }
    return points;
  }

  function alignEndpointJogs(grid, points, startPort, endPort, source, target) {
    const N = points.length;
    if (N >= 4) {
      const before = points[N - 3];
      const corner = points[N - 2];
      const portPoint = points[N - 1];
      const shortLen = Math.hypot(corner.x - before.x, corner.y - before.y);
      if (shortLen < 20) {
        if (endPort.axis === 'h' && Math.abs(corner.y - portPoint.y) < 0.1) {
          const ny = before.y;
          if (Math.abs(ny - target.y) <= target.height / 2 - 24) {
            const newPort = { x: portPoint.x, y: ny };
            if (canConnect(grid, before, newPort)) {
              endPort.point = newPort;
              endPort.probe = { x: endPort.probe.x, y: ny };
              points[N - 2] = { x: corner.x, y: ny };
              points[N - 1] = newPort;
            }
          }
        } else if (endPort.axis === 'v' && Math.abs(corner.x - portPoint.x) < 0.1) {
          const nx = before.x;
          if (Math.abs(nx - target.x) <= target.width / 2 - 24) {
            const newPort = { x: nx, y: portPoint.y };
            if (canConnect(grid, before, newPort)) {
              endPort.point = newPort;
              endPort.probe = { x: nx, y: endPort.probe.y };
              points[N - 2] = { x: nx, y: corner.y };
              points[N - 1] = newPort;
            }
          }
        }
      }
    }
    simplifyPoints(points);
    const M = points.length;
    if (M >= 4) {
      const portPoint = points[0];
      const corner = points[1];
      const after = points[2];
      const shortLen = Math.hypot(after.x - corner.x, after.y - corner.y);
      if (shortLen < 20) {
        if (startPort.axis === 'h' && Math.abs(portPoint.y - corner.y) < 0.1) {
          const ny = after.y;
          if (Math.abs(ny - source.y) <= source.height / 2 - 24) {
            const newPort = { x: portPoint.x, y: ny };
            if (canConnect(grid, newPort, after)) {
              startPort.point = newPort;
              startPort.probe = { x: startPort.probe.x, y: ny };
              points[0] = newPort;
              points[1] = { x: corner.x, y: ny };
            }
          }
        } else if (startPort.axis === 'v' && Math.abs(portPoint.x - corner.x) < 0.1) {
          const nx = after.x;
          if (Math.abs(nx - source.x) <= source.width / 2 - 24) {
            const newPort = { x: nx, y: portPoint.y };
            if (canConnect(grid, newPort, after)) {
              startPort.point = newPort;
              startPort.probe = { x: nx, y: startPort.probe.y };
              points[0] = newPort;
              points[1] = { x: nx, y: corner.y };
            }
          }
        }
      }
    }
    return simplifyPoints(points);
  }

  function crossesExistingRoutes(points, routes) {
    for (const route of routes) {
      for (let i = 0; i < points.length - 1; i++) {
        for (let j = 0; j < route.points.length - 1; j++) {
          if (segmentsCross(points[i], points[i + 1], route.points[j], route.points[j + 1])) return true;
        }
      }
    }
    return false;
  }

  function segmentRectClearance(a, b, node) {
    const left = node.x - node.width / 2;
    const right = node.x + node.width / 2;
    const top = node.y - node.height / 2;
    const bottom = node.y + node.height / 2;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const intersects = maxX >= left && minX <= right && maxY >= top && minY <= bottom;
    if (intersects) {
      if (!isContainer(node)) return 0;
      if (Math.abs(a.y - b.y) < 0.1) {
        const y = a.y;
        if (y < top || y > bottom) return Math.min(Math.abs(y - top), Math.abs(y - bottom));
        return Math.min(y - top, bottom - y);
      }
      if (Math.abs(a.x - b.x) < 0.1) {
        const x = a.x;
        if (x < left || x > right) return Math.min(Math.abs(x - left), Math.abs(x - right));
        return Math.min(x - left, right - x);
      }
      return 0;
    }
    const dx = maxX < left ? left - maxX : (minX > right ? minX - right : 0);
    const dy = maxY < top ? top - maxY : (minY > bottom ? minY - bottom : 0);
    return Math.hypot(dx, dy);
  }

  function laneScore(candidate, source, target) {
    let clearance = 56;
    for (const node of visibleNodeList) {
      if (node === source || node === target) continue;
      const d = segmentRectClearance(candidate.a, candidate.b, node);
      if (d < clearance) clearance = d;
      if (clearance <= 0) break;
    }
    return Math.min(clearance, 56) - candidate.offset * 0.02;
  }

  function chooseDirectLane(candidates, source, target, grid, existingRoutes) {
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.offset - b.offset);
    const scored = [];
    let best = null;
    for (const candidate of candidates) {
      if (best && best.score >= 56 - candidate.offset * 0.02) break;
      candidate.score = laneScore(candidate, source, target);
      scored.push(candidate);
      if (!best || candidate.score > best.score) best = candidate;
    }
    scored.sort((a, b) => b.score - a.score);
    for (const candidate of scored) {
      if (canConnect(grid, candidate.a, candidate.b) &&
          !crossesExistingRoutes([candidate.a, candidate.b], existingRoutes)) {
        return [candidate.a, candidate.b];
      }
    }
    const tried = new Set(scored);
    const rest = candidates.filter((candidate) => !tried.has(candidate));
    for (const candidate of rest) candidate.score = laneScore(candidate, source, target);
    rest.sort((a, b) => b.score - a.score);
    for (const candidate of rest) {
      if (canConnect(grid, candidate.a, candidate.b) &&
          !crossesExistingRoutes([candidate.a, candidate.b], existingRoutes)) {
        return [candidate.a, candidate.b];
      }
    }
    return null;
  }

  function directRoute(source, target, grid, existingRoutes) {
    const pad = 2;
    const edgePad = 20;
    const sourceLeft = source.x - source.width / 2;
    const sourceRight = source.x + source.width / 2;
    const sourceTop = source.y - source.height / 2;
    const sourceBottom = source.y + source.height / 2;
    const targetLeft = target.x - target.width / 2;
    const targetRight = target.x + target.width / 2;
    const targetTop = target.y - target.height / 2;
    const targetBottom = target.y + target.height / 2;

    if (sourceRight <= targetLeft || targetRight <= sourceLeft) {
      const top = Math.max(sourceTop, targetTop) + edgePad;
      const bottom = Math.min(sourceBottom, targetBottom) - edgePad;
      if (bottom >= top) {
        const base = Math.max(top, Math.min(bottom, (source.y + target.y) / 2));
        const lanes = [base];
        for (let delta = 12; delta <= bottom - top; delta += 12) {
          if (base + delta <= bottom) lanes.push(base + delta);
          if (base - delta >= top) lanes.push(base - delta);
        }
        const from = sourceRight <= targetLeft ? source : target;
        const to = sourceRight <= targetLeft ? target : source;
        const candidates = [];
        for (const y of lanes) {
          const a = { x: from.x + from.width / 2 + pad, y };
          const b = { x: to.x - to.width / 2 - pad, y };
          if (a.x < b.x) candidates.push({ a, b, offset: Math.abs(y - base) });
        }
        const lane = chooseDirectLane(candidates, source, target, grid, existingRoutes);
        if (lane) return routeFromPoints(lane, false);
      }
    }

    if (sourceBottom <= targetTop || targetBottom <= sourceTop) {
      const left = Math.max(sourceLeft, targetLeft) + edgePad;
      const right = Math.min(sourceRight, targetRight) - edgePad;
      if (right >= left) {
        const base = Math.max(left, Math.min(right, (source.x + target.x) / 2));
        const lanes = [base];
        for (let delta = 12; delta <= right - left; delta += 12) {
          if (base + delta <= right) lanes.push(base + delta);
          if (base - delta >= left) lanes.push(base - delta);
        }
        const from = sourceBottom <= targetTop ? source : target;
        const to = sourceBottom <= targetTop ? target : source;
        const candidates = [];
        for (const x of lanes) {
          const a = { x, y: from.y + from.height / 2 + pad };
          const b = { x, y: to.y - to.height / 2 - pad };
          if (a.y < b.y) candidates.push({ a, b, offset: Math.abs(x - base) });
        }
        const lane = chooseDirectLane(candidates, source, target, grid, existingRoutes);
        if (lane) return routeFromPoints(lane, false);
      }
    }

    return null;
  }

  function connectPoints(a, b, grid, existingRoutes) {
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) return [];
    if (canConnect(grid, a, b) && !crossesExistingRoutes([a, b], existingRoutes)) return [b];

    const corners = [
      { x: b.x, y: a.y },
      { x: a.x, y: b.y },
    ];
    let best = null;
    for (const corner of corners) {
      if (Math.abs(corner.x - a.x) < 0.01 && Math.abs(corner.y - a.y) < 0.01) continue;
      if (Math.abs(corner.x - b.x) < 0.01 && Math.abs(corner.y - b.y) < 0.01) continue;
      if (!canConnect(grid, a, corner) || !canConnect(grid, corner, b)) continue;
      if (crossesExistingRoutes([a, corner], existingRoutes)) continue;
      if (crossesExistingRoutes([corner, b], existingRoutes)) continue;
      const length = Math.hypot(corner.x - a.x, corner.y - a.y) + Math.hypot(b.x - corner.x, b.y - corner.y);
      if (!best || length < best.length) best = { corner, length };
    }
    return best ? [best.corner, b] : null;
  }

  function routeViaWaypoints(edge, startPort, endPort, grid, existingRoutes) {
    const points = [startPort.point, ...edge.waypoints, endPort.point];
    const out = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const leg = connectPoints(points[i], points[i + 1], grid, existingRoutes);
      if (!leg) return null;
      out.push(...leg);
    }
    const clean = simplifyPoints(out);
    if (pathHasAcuteTurn(clean)) return null;
    return routeFromPoints(clean, false);
  }

  function routeEdge(edge, grid, usedPorts, existingRoutes = []) {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) return null;

    const gap = GRID_SIZE * 2.3;
    const startPort = edge.fromAnchor
      ? anchorPort(source, edge.fromAnchor, gap)
      : choosePort(source, target, usedPorts, grid);
    const endPort = edge.toAnchor
      ? anchorPort(target, edge.toAnchor, gap)
      : choosePort(target, source, usedPorts, grid);

    if (edge.waypoints.length) {
      const via = routeViaWaypoints(edge, startPort, endPort, grid, existingRoutes);
      if (via) {
        markOccupancy(grid, via.points);
        return via;
      }
    }

    if (!edge.fromAnchor && !edge.toAnchor && !edge.waypoints.length) {
      const direct = directRoute(source, target, grid, existingRoutes);
      if (direct) {
        markOccupancy(grid, direct.points);
        return direct;
      }
    } else if (edge.fromAnchor && edge.toAnchor && !edge.waypoints.length) {
      const points = [startPort.point, endPort.point];
      if (canConnect(grid, startPort.point, endPort.point) &&
          !crossesExistingRoutes(points, existingRoutes)) {
        const direct = routeFromPoints(points, false);
        markOccupancy(grid, direct.points);
        return direct;
      }
    }

    const simple = connectPoints(startPort.point, endPort.point, grid, existingRoutes);
    if (simple) {
      const clean = simplifyPoints([startPort.point, ...simple]);
      if (!pathHasAcuteTurn(clean)) {
        const route = routeFromPoints(clean, false);
        markOccupancy(grid, route.points);
        return route;
      }
    }

    const start = outwardCell(grid, startPort);
    const end = outwardCell(grid, endPort);
    clearCorridor(grid, startPort.point, startPort.probe);
    clearCorridor(grid, endPort.probe, endPort.point);
    const startDir = directionIndex(startPort.dir.x, startPort.dir.y);
    const endDir = directionIndex(endPort.dir.x, endPort.dir.y);
    const endTurnDir = (endDir + 4) % 8;
    let cells = findGridPath(grid, start, end, true, startDir, endTurnDir);
    const soft = !cells;
    if (!cells) cells = findGridPath(grid, start, end, false, startDir, endTurnDir);
    if (!cells) return null;

    const startCenter = gridPoint(grid, start.gx, start.gy);
    const endCenter = gridPoint(grid, end.gx, end.gy);
    if (!startPort.locked) {
      if (startPort.axis === 'h' && Math.abs(startCenter.y - source.y) < source.height / 2 - 8) {
        startPort.point.y = startCenter.y;
        startPort.probe.y = startCenter.y;
      } else if (startPort.axis === 'v' && Math.abs(startCenter.x - source.x) < source.width / 2 - 8) {
        startPort.point.x = startCenter.x;
        startPort.probe.x = startCenter.x;
      }
    }
    if (!endPort.locked) {
      if (endPort.axis === 'h' && Math.abs(endCenter.y - target.y) < target.height / 2 - 8) {
        endPort.point.y = endCenter.y;
        endPort.probe.y = endCenter.y;
      } else if (endPort.axis === 'v' && Math.abs(endCenter.x - target.x) < target.width / 2 - 8) {
        endPort.point.x = endCenter.x;
        endPort.probe.x = endCenter.x;
      }
    }
    const rawInner = simplifyPoints(cells.map((idx) => gridPoint(grid, idx % grid.cols, (idx / grid.cols) | 0)));
    let inner = rawInner.slice();
    inner = prunePoints(grid, inner);
    inner = simplifyBySight(grid, inner);
    inner = snapShortCorners(grid, inner);
    inner = simplifyPoints(inner);
    inner = mergeShortBends(grid, inner, 20, false);

    const buildPoints = (innerPoints) => {
      const out = [startPort.point];
      if (startPort.axis === 'h') {
        out.push({ x: startCenter.x, y: startPort.point.y });
      } else {
        out.push({ x: startPort.point.x, y: startCenter.y });
      }
      out.push(...innerPoints);
      if (endPort.axis === 'h') {
        out.push({ x: endCenter.x, y: endPort.point.y });
      } else {
        out.push({ x: endPort.point.x, y: endCenter.y });
      }
      out.push(endPort.point);
      return out;
    };

    const points = buildPoints(inner);
    const fallback = simplifyPoints(buildPoints(rawInner));
    let clean = simplifyPoints(points);
    clean = mergeShortBends(grid, clean, 20, true);
    clean = alignEndpointJogs(grid, clean, startPort, endPort, source, target);
    if (pathHasAcuteTurn(clean)) clean = fallback;
    markOccupancy(grid, clean);
    return {
      points: clean,
      soft,
      d: clean.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '),
      mid: routeMid(clean),
    };
  }

  function edgeDisplayLength(edge) {
    const a = nodeById.get(edge.from);
    const b = nodeById.get(edge.to);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  }

  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function segmentsCross(a, b, c, d) {
    const near = (p, q) => Math.abs(p.x - q.x) < 1.5 && Math.abs(p.y - q.y) < 1.5;
    if (near(a, c) || near(a, d) || near(b, c) || near(b, d)) return false;
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return ((o1 > 1e-6 && o2 < -1e-6) || (o1 < -1e-6 && o2 > 1e-6)) &&
           ((o3 > 1e-6 && o4 < -1e-6) || (o3 < -1e-6 && o4 > 1e-6));
  }

  function evaluateRoutes(routes, expectedCount = viewEdges.length) {
    const segments = [];
    let length = 0;
    let turns = 0;
    let acute = 0;
    let soft = 0;
    for (const [id, route] of routes) {
      if (route.soft) soft++;
      if (pathHasAcuteTurn(route.points)) acute++;
      turns += turnsInPath(route.points);
      for (let i = 0; i < route.points.length - 1; i++) {
        const a = route.points[i];
        const b = route.points[i + 1];
        length += Math.hypot(b.x - a.x, b.y - a.y);
        segments.push({ id, a, b });
      }
    }
    let crossings = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const s1 = segments[i];
        const s2 = segments[j];
        if (s1.id === s2.id) continue;
        if (segmentsCross(s1.a, s1.b, s2.a, s2.b)) crossings++;
      }
    }
    const missing = expectedCount - routes.size;
    const score = missing * 1e9 + soft * 1e8 + acute * 1e7 + crossings * 1e5 + length * 0.05 + turns * 20;
    return { score, crossings, length, turns, acute, soft, missing };
  }

  function edgeGrid(baseGrid) {
    return {
      minX: baseGrid.minX,
      minY: baseGrid.minY,
      cols: baseGrid.cols,
      rows: baseGrid.rows,
      blocked: baseGrid.blocked.slice(),
      penalty: baseGrid.penalty,
      occ: baseGrid.occ,
    };
  }

  function routeAllEdges(options = {}) {
    if (!nodes.length) {
      edgeRoutes.clear();
      return;
    }
    const fast = !!options.fast;
    const active = options.all ? viewEdges.slice() : activeViewEdges();
    if (!active.length) {
      edgeRoutes = new Map();
      return;
    }
    const longest = active.slice().sort((a, b) => edgeDisplayLength(b) - edgeDisplayLength(a));
    let orders;
    if (fast) {
      const byId = new Map(active.map((edge) => [edge.id, edge]));
      const preferred = [];
      for (const id of lastRouteOrder) {
        const edge = byId.get(id);
        if (edge) {
          preferred.push(edge);
          byId.delete(id);
        }
      }
      for (const edge of byId.values()) preferred.push(edge);
      orders = [preferred];
    } else {
      const shortest = longest.slice().reverse();
      orders = active.length <= 60
        ? [longest, shortest]
        : [longest];
    }
    let best = null;

    for (const order of orders) {
      const baseGrid = buildRoutingGrid();
      const usedPorts = new Set();
      const routes = new Map();
      const routed = [];
      for (const edge of order) {
        const route = routeEdge(edge, edgeGrid(baseGrid), usedPorts, routed);
        if (route) {
          routes.set(edge.id, route);
          routed.push(route);
        }
      }
      const metrics = evaluateRoutes(routes, active.length);
      if (!best || metrics.score < best.metrics.score) {
        best = { routes, metrics, grid: baseGrid, order: order.map((e) => e.id) };
      }
    }

    const nextRoutes = best ? best.routes : new Map();
    if (!options.all) {
      for (const [id, route] of edgeRoutes) {
        if (!nextRoutes.has(id)) nextRoutes.set(id, route);
      }
    }
    const validIds = new Set(viewEdges.map((edge) => edge.id));
    if (options.all) {
      staleEdgeIds.clear();
    } else {
      const routedIds = new Set(active.map((edge) => edge.id));
      for (const edge of viewEdges) {
        if (!nextRoutes.has(edge.id) || !routedIds.has(edge.id)) staleEdgeIds.add(edge.id);
      }
      for (const [id, route] of edgeRoutes) {
        if (validIds.has(id) && !nextRoutes.has(id)) nextRoutes.set(id, route);
      }
    }
    for (const id of staleEdgeIds) {
      if (!validIds.has(id)) staleEdgeIds.delete(id);
    }
    edgeRoutes = nextRoutes;
    if (!fast && best) lastRouteOrder = best.order;
    window.__codenodemap = {
      nodes,
      edges,
      viewEdges,
      visible: visibleNodeList,
      routes: edgeRoutes,
      routeMetrics: best ? best.metrics : null,
      grid: best ? best.grid : null,
    };
  }

  function routeMissingActiveEdges() {
    const active = activeViewEdges();
    const missing = active
      .filter((edge) => !edgeRoutes.has(edge.id) || staleEdgeIds.has(edge.id))
      .sort((a, b) => edgeDisplayLength(b) - edgeDisplayLength(a));
    if (!missing.length) return { active: active.length, missing: 0, routed: 0 };

    const baseGrid = buildRoutingGrid();
    const existingRoutes = [];
    for (const edge of active) {
      const route = edgeRoutes.get(edge.id);
      if (!route) continue;
      markOccupancy(baseGrid, route.points);
      existingRoutes.push(route);
    }
    const usedPorts = new Set();
    let routed = 0;
    for (const edge of missing) {
      const route = routeEdge(edge, edgeGrid(baseGrid), usedPorts, existingRoutes);
      if (route) {
        edgeRoutes.set(edge.id, route);
        existingRoutes.push(route);
        staleEdgeIds.delete(edge.id);
        routed++;
      }
    }
    if (routed) edgeLabelSel.selectAll('.edge-label-group').remove();
    drawEdges();
    return { active: active.length, missing: missing.length, routed };
  }

  function scheduleActiveRoutes() {
    if (activeRouteFrame) return;
    activeRouteFrame = requestAnimationFrame(() => {
      activeRouteFrame = 0;
      routeMissingActiveEdges();
    });
  }

  function ensureDefs() {
    const defs = edgeSel.select('defs');
    if (!defs.empty()) return;
    const created = edgeSel.append('defs');
    created.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 8.5)
      .attr('refY', 5)
      .attr('markerUnits', 'strokeWidth')
      .attr('markerWidth', 2.0)
      .attr('markerHeight', 2.0)
      .attr('orient', 'auto-start-reverse')
      .append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('fill', 'context-stroke');
  }

  function isAncestorNode(ancestor, node) {
    let cur = parentOf(node);
    let guard = 0;
    while (cur && guard++ < nodes.length) {
      if (cur.id === ancestor.id) return true;
      cur = parentOf(cur);
    }
    return false;
  }

  function edgeLevel(edge) {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) return 0;
    return Math.min(4, Math.min(depthOf(source), depthOf(target)));
  }

  function edgeAlphaLevel(edge) {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) return 0;
    return Math.min(4, Math.max(depthOf(source), depthOf(target)));
  }

  const EDGE_LABEL_SIZES = [160, 56, 36, 26, 20];
  const EDGE_WIDTH_RATIO = 0.1;

  function edgeLabelSize(edge) {
    return EDGE_LABEL_SIZES[edgeLevel(edge)];
  }

  function edgeWidth(edge) {
    return edgeLabelSize(edge) * EDGE_WIDTH_RATIO;
  }

  function edgeLabelMetrics(label, fontSize) {
    const textWidth = Math.max(fontSize * 1.5, String(label).length * fontSize * 0.92);
    const padX = fontSize * 0.42;
    const padY = fontSize * 0.18;
    return {
      width: textWidth + padX * 2,
      height: fontSize * 1.15 + padY * 2,
      padX,
      padY,
    };
  }

  function labelOverlapsNode(label, point, fontSize, edge) {
    const metrics = edgeLabelMetrics(label, fontSize);
    const source = edge ? nodeById.get(edge.from) : null;
    const target = edge ? nodeById.get(edge.to) : null;
    for (const node of visibleNodeList) {
      if (source && isAncestorNode(node, source)) continue;
      if (target && isAncestorNode(node, target)) continue;
      if (Math.abs(point.x - node.x) < node.width / 2 + metrics.width / 2 + 4 &&
          Math.abs(point.y - node.y) < node.height / 2 + metrics.height / 2 + 4) {
        return true;
      }
    }
    return false;
  }

  function labelRectOverlaps(a, b) {
    return Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
      Math.abs(a.y - b.y) < (a.height + b.height) / 2;
  }

  function edgeLabelPoint(edge, route, fontSize, placed) {
    const metrics = edgeLabelMetrics(edge.label, fontSize);
    const segments = [];
    let total = 0;
    for (let i = 0; i < route.points.length - 1; i++) {
      const a = route.points[i];
      const b = route.points[i + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1) continue;
      segments.push({ a, b, length, start: total });
      total += length;
    }
    const fits = (point) => {
      if (labelOverlapsNode(edge.label, point, fontSize, edge)) return false;
      const box = { x: point.x, y: point.y, width: metrics.width, height: metrics.height };
      return !placed.some((other) => labelRectOverlaps(box, other));
    };
    const candidates = [];
    for (const segment of segments) {
      const ux = (segment.b.x - segment.a.x) / segment.length;
      const uy = (segment.b.y - segment.a.y) / segment.length;
      const px = -uy;
      const py = ux;
      const segmentCenter = segment.start + segment.length / 2;
      const segmentRank = Math.abs(segmentCenter - total / 2) / Math.max(1, total);
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const baseX = segment.a.x + (segment.b.x - segment.a.x) * t;
        const baseY = segment.a.y + (segment.b.y - segment.a.y) * t;
        for (const offset of [0, -1.5 * metrics.height, 1.5 * metrics.height, -3 * metrics.height, 3 * metrics.height]) {
          candidates.push({
            x: baseX + px * offset,
            y: baseY + py * offset,
            rank: segmentRank + Math.abs(t - 0.5) + Math.abs(offset) / Math.max(1, metrics.height) * 0.25,
          });
        }
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const point of candidates) {
      if (fits(point)) return point;
    }
    return null;
  }

  function setEdgeLabelGeometry(group, point, fontSize) {
    const metrics = edgeLabelMetrics(group.attr('data-label') || '', fontSize);
    group
      .attr('data-x', point.x)
      .attr('data-y', point.y)
      .attr('data-w', metrics.width)
      .attr('data-h', metrics.height)
      .style('left', `${point.x}px`)
      .style('top', `${point.y}px`)
      .style('font-size', `${fontSize}px`)
      .style('padding', `${metrics.padY}px ${metrics.padX}px`)
      .style('border-width', `${Math.max(1, fontSize * 0.02)}px`);
  }

  function bindEdgeLabelDrag(group, edge) {
    group.on('pointerdown', (event) => {
      if (appMode !== 'edit' || event.button !== 0) return;
      const el = group.node();
      const pointerId = event.pointerId;
      const start = worldPointFromEvent(event);
      const startX = Number(group.attr('data-x'));
      const startY = Number(group.attr('data-y'));
      const base = el.__labelBase || { x: startX, y: startY };
      let moved = false;
      let history = false;
      event.preventDefault();
      event.stopPropagation();
      try { el.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
      const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        const point = worldPointFromEvent(ev);
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          moved = true;
          if (!history) {
            pushUndo();
            history = true;
          }
          group.classed('dragging', true);
        }
        if (!moved) return;
        const x = startX + dx;
        const y = startY + dy;
        group
          .attr('data-x', x)
          .attr('data-y', y)
          .style('left', `${x}px`)
          .style('top', `${y}px`);
      };
      const up = (ev) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(ev.pointerId); } catch (error) { /* ignore */ }
        group.classed('dragging', false);
        if (!moved) return;
        suppressLabelClick = true;
        setTimeout(() => { suppressLabelClick = false; }, 0);
        const x = Number(group.attr('data-x'));
        const y = Number(group.attr('data-y'));
        const offset = normalizeLabelOffset({ x: Math.round(x - base.x), y: Math.round(y - base.y) });
        const raw = rawEdgeById(edge.id);
        const model = edges.find((item) => String(item.id) === String(edge.id));
        const view = viewEdges.find((item) => String(item.id) === String(edge.id));
        for (const target of [raw, model, view]) {
          if (!target) continue;
          if (offset && (offset.x || offset.y)) target.labelOffset = { ...offset };
          else delete target.labelOffset;
        }
        markDirty();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  function drawEdgeLabels(rebuild = false) {
    if (rebuild) edgeLabelSel.selectAll('.edge-label-group').remove();
    const active = new Map();
    for (const edge of viewEdges) {
      if (!edge.label) continue;
      const route = edgeRoutes.get(edge.id);
      if (route) active.set(edge.id, { edge, route });
    }

    const existing = new Map();
    edgeLabelSel.selectAll('.edge-label-group').each(function () {
      existing.set(this.getAttribute('data-id'), this);
    });

    for (const [id, { edge }] of active) {
      const current = existing.get(id);
      if (current && current.getAttribute('data-label') !== edge.label) {
        current.remove();
        existing.delete(id);
      }
    }

    const placed = [];
    for (const [id] of active) {
      const group = existing.get(id);
      if (!group) continue;
      const x = Number(group.getAttribute('data-x'));
      const y = Number(group.getAttribute('data-y'));
      const width = Number(group.getAttribute('data-w'));
      const height = Number(group.getAttribute('data-h'));
      if ([x, y, width, height].every(Number.isFinite)) {
        placed.push({ x, y, width, height });
      }
    }

    for (const [id, { edge, route }] of active) {
      const focusOut = focusActive && !(focusIds.has(edge.from) && focusIds.has(edge.to));
      const current = existing.get(id);
      if (current) {
        current.classList.toggle('focus-out', focusOut);
        continue;
      }
      const fontSize = edgeLabelSize(edge);
      const offset = normalizeLabelOffset(edge.labelOffset);
      const routeBase = routeMid(route.points);
      let base = null;
      let point = null;
      if (offset) {
        base = routeBase;
        point = { x: base.x + offset.x, y: base.y + offset.y };
      } else {
        base = edgeLabelPoint(edge, route, fontSize, placed);
        if (!base) continue;
        point = base;
      }
      const metrics = edgeLabelMetrics(edge.label, fontSize);
      placed.push({ x: point.x, y: point.y, width: metrics.width, height: metrics.height });
      const group = edgeLabelSel.append('div')
        .attr('class', `edge-label-group${focusOut ? ' focus-out' : ''}`)
        .attr('data-lod', String(edgeAlphaLevel(edge)))
        .attr('data-id', edge.id)
        .attr('data-from', edge.from)
        .attr('data-to', edge.to)
        .attr('data-label', edge.label)
        .attr('data-x', point.x)
        .attr('data-y', point.y);
      group.append('span')
        .attr('class', 'edge-label')
        .text(edge.label);
      group.node().__labelBase = { x: routeBase.x, y: routeBase.y };
      group.on('click', (event) => {
        if (appMode !== 'edit' || suppressLabelClick) return;
        event.stopPropagation();
        selectEdge(edge.id);
      });
      group.on('contextmenu', (event) => {
        if (appMode !== 'edit') return;
        showEdgeContextMenu(event, edge);
      });
      bindEdgeLabelDrag(group, edge);
      setEdgeLabelGeometry(group, point, fontSize);
    }
  }

  function drawEdges() {
    ensureDefs();
    edgeSel.selectAll('.edge').remove();

    for (const edge of viewEdges) {
      const source = nodeById.get(edge.from);
      const target = nodeById.get(edge.to);
      if (!source || !target) continue;
      const route = edgeRoutes.get(edge.id);
      if (!route) continue;
      const focusOut = focusActive && !(focusIds.has(edge.from) && focusIds.has(edge.to));

      const path = edgeSel.append('path')
        .attr('class', `edge${edge.dashed ? ' dashed' : ''}${focusOut ? ' focus-out' : ''}`)
        .attr('data-lod', String(edgeAlphaLevel(edge)))
        .attr('data-id', edge.id)
        .attr('data-from', edge.from)
        .attr('data-to', edge.to)
        .attr('d', route.d)
        .style('stroke-width', `${edgeWidth(edge)}px`)
        .style('stroke-dasharray', edge.dashed ? `${edgeWidth(edge) * 2.6} ${edgeWidth(edge) * 2}` : null)
        .attr('marker-end', edge.directed === false ? null : 'url(#arrow)');
      path.on('click', (event) => {
        if (appMode !== 'edit') return;
        event.stopPropagation();
        selectEdge(edge.id);
      });
      path.on('contextmenu', (event) => {
        if (appMode !== 'edit') return;
        showEdgeContextMenu(event, edge);
      });
      path.on('dblclick', (event) => {
        if (appMode !== 'edit') return;
        event.stopPropagation();
        selectEdge(edge.id);
        const raw = rawEdgeById(edge.id);
        if (!raw) return;
        pushUndo();
        const point = worldPointFromEvent(event);
        raw.waypoints = Array.isArray(raw.waypoints) ? raw.waypoints : [];
        raw.waypoints.push({ x: Math.round(point.x), y: Math.round(point.y) });
        const model = edges.find((item) => item.id === edge.id);
        const view = viewEdges.find((item) => item.id === edge.id);
        if (model) model.waypoints = raw.waypoints.map((p) => ({ ...p }));
        if (view) view.waypoints = raw.waypoints.map((p) => ({ ...p }));
        markDirty();
        routeAllEdges();
        edgeLabelSel.selectAll('.edge-label-group').remove();
        drawEdges();
        selectEdge(edge.id);
      });
      path.append('title')
        .text(`${source.label} -> ${target.label}${edge.label ? ` (${edge.label})` : ''}`);
    }

    updateEdgeClasses();
    drawEdgeLabels();
    applyEdgeLodAlphas();
  }

  function updateEdgeClasses() {
    if (!selectedId) {
      edgeSel.selectAll('.edge').classed('dim', false).classed('active', false)
        .classed('selected', function () {
          return String(this.getAttribute('data-id')) === String(selectedEdgeId);
        });
      return;
    }
    const linkedIds = new Set(
      viewEdges.filter((edge) => edge.from === selectedId || edge.to === selectedId).map((edge) => edge.id)
    );
    edgeSel.selectAll('.edge')
      .classed('active', function () {
        return linkedIds.has(this.getAttribute('data-id'));
      })
      .classed('dim', function () {
        return !linkedIds.has(this.getAttribute('data-id'));
      })
      .classed('selected', false);
  }

  function applyNodeGeometry(node) {
    if (!node || !node.el) return;
    node.el.style.left = `${node.x}px`;
    node.el.style.top = `${node.y}px`;
    node.el.style.width = `${node.width}px`;
    if (isContainer(node)) {
      node.el.style.height = `${node.height}px`;
    } else {
      node.el.style.height = 'auto';
      node.el.style.minHeight = `${node.height}px`;
    }
  }

  function applyPositions() {
    for (const node of visibleNodeList) applyNodeGeometry(node);
  }

  function boundsOf(list) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of list) {
      minX = Math.min(minX, node.x - node.width / 2);
      maxX = Math.max(maxX, node.x + node.width / 2);
      minY = Math.min(minY, node.y - node.height / 2);
      maxY = Math.max(maxY, node.y + node.height / 2);
    }
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  function fitNodeList(list, animate = true) {
    if (!list.length) return;
    const box = boundsOf(list);
    if (!Number.isFinite(box.width) || box.width <= 0) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const pad = 90;
    const scale = Math.max(0.03, Math.min((width - pad * 2) / box.width, (height - pad * 2) / box.height, 1.1));
    const tx = (width - box.width * scale) / 2 - box.minX * scale;
    const ty = (height - box.height * scale) / 2 - box.minY * scale;
    const target = d3.zoomIdentity.translate(tx, ty).scale(scale);
    if (!animate) {
      stageSel.call(zoom.transform, target);
      return;
    }
    stageSel.transition()
      .duration(380)
      .call(zoom.transform, target);
  }

  function fit() {
    fitNodeList(visibleNodeList);
  }

  function buildLegend() {
    if (legend) {
      legend.title = '节点颜色表示逻辑角色：无入边为起点，无出边为终点，其余为过程；可在节点上用 role 字段覆盖。';
    }
    legend.innerHTML = ROLE_ORDER.map((role) => (
      `<span class="legend-item role-${role}"><span class="legend-swatch"></span>${roleLabel(role)}</span>`
    )).join('');
  }

  function updateSubtitle(matches) {
    const base = `${visibleNodeList.length}/${nodes.length} 个节点 · ${viewEdges.length} 条连线`;
    subtitle.textContent = typeof matches === 'number' ? `${base} · ${matches} 个匹配` : base;
  }

  function searchText(node) {
    const parts = [
      node.label,
      node.description,
      node.groupLabel || '',
      node.roleLabel || '',
      node.tags.join(' '),
      node.source ? `${node.source.file}:${node.source.line || 1}` : '',
    ];
    if (isContainer(node)) {
      for (const child of childrenOf(node)) parts.push(searchText(child));
    }
    return parts.join(' ');
  }

  function applySearch(query) {
    const q = String(query || '').trim().toLowerCase();
    let matches = 0;
    for (const node of visibleNodeList) {
      if (!node.el) continue;
      const haystack = searchText(node).toLowerCase();
      const hit = !!q && haystack.includes(q);
      if (hit) matches++;
      node.el.classList.toggle('dim', !!q && !hit);
      node.el.classList.toggle('match', hit);
    }
    updateSubtitle(q ? matches : undefined);
  }

  function rebuildScene(fitAfter, fastRouting = false) {
    const keepEdgeId = selectedEdgeId;
    refreshVisibility();
    renderNodeCards();
    buildViewEdges();
    applyPositions();
    if (selectedId && nodeById.get(selectedId)) {
      selectNode(selectedId);
    } else if (!keepEdgeId) {
      closeInspector();
    }
    applySearch(search.value);
    applyLodVisibility(fitAfter ? 0.22 : currentTransform.k, true);
    const fullRoute = requiresFullRoute;
    requiresFullRoute = false;
    routeAllEdges({ all: fullRoute, ...(fastRouting ? { fast: true } : {}) });
    drawEdges();
    if (keepEdgeId && rawEdgeById(keepEdgeId)) {
      selectedEdgeId = keepEdgeId;
      selectEdge(keepEdgeId);
    }
    if (fitAfter) requestAnimationFrame(() => fitNodeList(visibleNodeList, false));
  }

  function initGraph() {
    requiresFullRoute = true;
    staleEdgeIds.clear();
    const restoreDirty = document.body.dataset.mapDirty === 'true';
    closeContextMenu();
    closeKeyGraphMenu();
    focusActive = false;
    focusIds.clear();
    focusKeyGraphId = '';
    focusSnapshot = null;
    buildKeyGraphOptions();
    applyFocusOpacity();
    selectedId = null;
    closeInspector();
    empty.hidden = nodes.length > 0;
    search.value = '';
    undoStack = [];
    redoStack = [];
    clipboard = null;
    pasteSerial = 0;
    updateHistoryButtons();
    rebuildScene(true);
    savedSnapshot = restoreDirty ? '' : JSON.stringify(buildSaveData());
    setDirty(false);
    if (restoreDirty) {
      setDirty(true);
      if (saveState) saveState.textContent = '未保存';
    }
    syncModeUI();
    syncLodMenu();
  }

  function reload(raw) {
    parseData(raw);
    initGraph();
  }

  document.getElementById('fit').addEventListener('click', () => fit());
  document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  if (saveButton) saveButton.addEventListener('click', saveMap);
  if (addNodeButton) addNodeButton.addEventListener('click', () => setInteractionMode('node'));
  if (addEdgeButton) addEdgeButton.addEventListener('click', () => setInteractionMode('edge'));
  if (undoButton) undoButton.addEventListener('click', () => undo());
  if (redoButton) redoButton.addEventListener('click', () => redo());
  document.getElementById('inspector-close').addEventListener('click', closeInspector);
  search.addEventListener('input', (event) => applySearch(event.target.value));
  if (modeBrowseButton) modeBrowseButton.addEventListener('click', () => setAppMode('browse'));
  if (modeEditButton) modeEditButton.addEventListener('click', () => setAppMode('edit'));

  document.querySelectorAll('.menu-root').forEach((root) => {
    root.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAppMenu(root);
    });
  });
  document.querySelectorAll('[data-command]').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      runCommand(item.dataset.command);
    });
  });

  if (lodTrigger && lodMenu) {
    lodTrigger.addEventListener('click', () => {
      if (lodMenu.hidden) openLodMenu();
      else closeLodMenu();
    });
    lodTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openLodMenu();
      } else if (event.key === 'Escape') {
        closeLodMenu();
      }
    });
    bindMenuKeyboard(lodMenu, (event) => closeLodMenu({ focusTrigger: event.key === 'Escape' }));
  }

  if (focusSettings && focusTools) {
    focusSettings.addEventListener('click', (event) => {
      event.stopPropagation();
      closeKeyGraphMenu();
      closeLodMenu();
      const open = focusTools.hidden;
      focusTools.hidden = !open;
      focusSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if (keyGraphTrigger && keyGraphMenu) {
    keyGraphTrigger.addEventListener('click', () => {
      if (focusTools) focusTools.hidden = true;
      closeLodMenu();
      if (keyGraphMenu.hidden) openKeyGraphMenu();
      else closeKeyGraphMenu();
    });
    keyGraphTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openKeyGraphMenu({ focusItem: true });
      } else if (event.key === 'Escape') {
        closeKeyGraphMenu();
      }
    });
    bindMenuKeyboard(keyGraphMenu, (event) => closeKeyGraphMenu({ focusTrigger: event.key === 'Escape' }));
  }
  if (focusOpacity) {
    focusOpacity.addEventListener('input', applyFocusOpacity);
  }
  if (focusClear) {
    focusClear.addEventListener('click', () => {
      exitFocus();
      if (focusTools) focusTools.hidden = true;
      if (focusSettings) focusSettings.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.menu-root-wrap')) closeAppMenus();
    if (lodMenu && !lodMenu.hidden && !event.target.closest('#lod-control')) {
      closeLodMenu();
    }
    if (focusTools && !focusTools.hidden && !event.target.closest('#focus-control')) {
      focusTools.hidden = true;
      if (focusSettings) focusSettings.setAttribute('aria-expanded', 'false');
    }
    if (keyGraphMenu && !keyGraphMenu.hidden && !event.target.closest('#key-graph-control')) {
      closeKeyGraphMenu();
    }
    if (contextMenuEl && !event.target.closest('.context-menu')) {
      closeContextMenu();
    }
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (interactionMode !== 'edge' || !edgeSourceId) return;
    updateEdgePreview(worldPointFromEvent(event));
    const hitId = nodeIdAtClient(event.clientX, event.clientY);
    highlightEdgeDropTarget(hitId && hitId !== edgeSourceId ? hitId : null);
  });

  function isEditableTarget(target) {
    return target && target.closest && target.closest('input,textarea,select,[contenteditable="true"]');
  }

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = String(event.key).toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      saveMap();
      return;
    }
    if (event.key === 'Escape') {
      cancelInteractionMode();
      closeAppMenus();
      if (focusTools) focusTools.hidden = true;
      return;
    }
    if (appMode !== 'edit') return;
    if (isEditableTarget(event.target)) return;
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && key === 'c') {
      if (selectedId) {
        event.preventDefault();
        copySelectedNode();
      }
      return;
    }
    if (mod && key === 'x') {
      if (selectedId) {
        event.preventDefault();
        cutNode(selectedId);
      }
      return;
    }
    if (mod && key === 'v') {
      if (clipboard) {
        event.preventDefault();
        pasteClipboard();
      }
      return;
    }
    if (event.key === 'Delete' && selectedId) {
      event.preventDefault();
      deleteNode(selectedId);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (contextMenuEl) closeContextMenu();
    if (keyGraphMenu && !keyGraphMenu.hidden) closeKeyGraphMenu({ focusTrigger: true });
    if (lodMenu && !lodMenu.hidden) closeLodMenu({ focusTrigger: true });
    closeAppMenus();
    if (focusTools) focusTools.hidden = true;
  });

  window.addEventListener('resize', () => {
    closeContextMenu();
    closeKeyGraphMenu();
    closeLodMenu();
    closeAppMenus();
    if (focusTools) focusTools.hidden = true;
  });

  stage.addEventListener('click', (event) => {
    if (appMode !== 'edit') return;
    if (interactionMode === 'parent') {
      if (event.target.closest('.node, #inspector, #mode-banner')) return;
      const rect = stage.getBoundingClientRect();
      const t = currentTransform;
      const point = {
        x: (event.clientX - rect.left - t.x) / Math.max(0.001, t.k),
        y: (event.clientY - rect.top - t.y) / Math.max(0.001, t.k),
      };
      const node = pickNodeAtWorldPoint(point);
      if (node) finishParentPick(node.id);
      else cancelInteractionMode();
      return;
    }
    if (interactionMode === 'edge') {
      if (event.target.closest('#mode-banner')) return;
      if (event.target.closest('.node, #inspector')) return;
      const rect = stage.getBoundingClientRect();
      const t = currentTransform;
      const point = {
        x: (event.clientX - rect.left - t.x) / Math.max(0.001, t.k),
        y: (event.clientY - rect.top - t.y) / Math.max(0.001, t.k),
      };
      const node = pickNodeAtWorldPoint(point);
      if (!node) return;
      if (!edgeSourceId) {
        edgeSourceId = node.id;
        if (node.el) node.el.classList.add('edge-source');
        if (hint) hint.textContent = `起点：${node.label}；点击终点节点，Esc 取消`;
        refreshEdgeBanner();
        updateEdgePreviewAtNode(node);
      } else if (edgeSourceId !== node.id) {
        createEdgeBetween(edgeSourceId, node.id);
      }
      return;
    }
    if (interactionMode === 'node') {
      if (event.target.closest('.node, #inspector')) return;
      const rect = stage.getBoundingClientRect();
      const t = currentTransform;
      const x = (event.clientX - rect.left - t.x) / Math.max(0.001, t.k);
      const y = (event.clientY - rect.top - t.y) / Math.max(0.001, t.k);
      createNodeAt(x, y);
      return;
    }
    if (event.target === stage || event.target === world || event.target === edgeLayer) {
      closeInspector();
    }
  });

  stage.addEventListener('dblclick', (event) => {
    if (appMode !== 'edit') return;
    if (interactionMode) return;
    if (event.target.closest('.node, #inspector, #mode-banner, #legend, #hint, #resize-handles, #focus-tools, .edge, .edge-label-group')) return;
    const rect = stage.getBoundingClientRect();
    const t = currentTransform;
    const x = (event.clientX - rect.left - t.x) / Math.max(0.001, t.k);
    const y = (event.clientY - rect.top - t.y) / Math.max(0.001, t.k);
    createNodeAt(x, y);
  });

  stage.addEventListener('contextmenu', (event) => {
    if (appMode !== 'edit') return;
    if (event.target.closest('.node, #inspector')) return;
    showCanvasContextMenu(event);
  });

  stage.addEventListener('wheel', () => closeContextMenu(), { passive: true });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'data' && message.data) {
      reload(message.data);
    } else if (message.type === 'tags-updated') {
      if (Array.isArray(message.tagCatalog)) setTagCatalog(message.tagCatalog);
      const node = nodeById.get(String(message.nodeId));
      if (node) {
        node.tags = normalizeTagList(message.tags);
        const raw = rawNodeById(node.id);
        if (raw) {
          if (node.tags.length) raw.tags = node.tags.slice();
          else delete raw.tags;
        }
        rebuildScene(false);
      }
    } else if (message.type === 'saved') {
      savedSnapshot = JSON.stringify(buildSaveData());
      setDirty(false);
      if (saveState) {
        saveState.textContent = '已保存';
        saveState.classList.remove('error');
      }
    } else if (message.type === 'save-error') {
      if (saveState) {
        saveState.textContent = '保存失败';
        saveState.classList.add('error');
      }
    }
  });

  try {
    const restoredState = typeof vscode.getState === 'function' ? vscode.getState() : null;
    if (restoredState) {
      if (restoredState.appMode === 'browse' || restoredState.appMode === 'edit') {
        appMode = restoredState.appMode;
      }
      if (restoredState.lodMode === 'auto' || /^[0-4]$/.test(String(restoredState.lodMode))) {
        lodMode = String(restoredState.lodMode);
      }
    }
  } catch (err) {
    // state restoration is best-effort
  }

  buildLodMenu();
  syncModeUI();
  buildLegend();
  parseData(DATA);
  initGraph();
}());
