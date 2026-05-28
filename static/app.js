// ── State ──────────────────────────────────────────────────────────────────
// Per-file state, keyed by base64 path
const fileStates = new Map(); // key -> { totalRecords, currentPage, ... }
let tabOrder = [];  // display order of tab keys
let activeKey = null;

// ── DOM Refs ───────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  tabList: $("#tab-list"),
  tabAdd: $("#tab-add"),
  tabEmpty: $("#tab-empty"),
  filename: $("#filename"),
  recordCount: $("#record-count"),
  fieldSelect: $("#field-select"),
  filterInput: $("#filter-input"),
  filterBtn: $("#filter-btn"),
  filterNegateBtn: $("#filter-negate-btn"),
  clearFilterBtn: $("#clear-filter-btn"),
  pageSize: $("#page-size"),
  statusText: $("#status-text"),
  filterInfo: $("#filter-info"),
  recordList: $("#record-list"),
  pageInfo: $("#page-info"),
  btnFirst: $("#btn-first"),
  btnPrev: $("#btn-prev"),
  btnNext: $("#btn-next"),
  btnLast: $("#btn-last"),
  pageJump: $("#page-jump"),
  // Actions bar
  actionsBar: $("#actions-bar"),
  btnSelectPage: $("#btn-select-page"),
  btnClearSelection: $("#btn-clear-selection"),
  selectionCount: $("#selection-count"),
  btnExportSelected: $("#btn-export-selected"),
  btnExportFiltered: $("#btn-export-filtered"),
  // Modal
  modalOverlay: $("#modal-overlay"),
  modalCloseBtn: $("#modal-close-btn"),
  modalUpBtn: $("#modal-up-btn"),
  modalCurrentDir: $("#modal-current-dir"),
  modalPathInput: $("#modal-path-input"),
  modalOpenBtn: $("#modal-open-btn"),
  modalFileList: $("#modal-file-list"),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function getState() {
  return fileStates.get(activeKey);
}

function ensureState(key) {
  if (!fileStates.has(key)) {
    fileStates.set(key, {
      totalRecords: 0,
      currentPage: 1,
      pageSize: 50,
      totalPages: 0,
      filterQuery: "",
      filterField: "",
      filterNegate: false,
      isFiltering: false,
      filteredTotal: 0,
      availableFields: [],
      cachedRecords: [],
      selectedIndices: new Set(),
      scrollTop: 0,
    });
  }
  return fileStates.get(key);
}

// ── API Helpers ────────────────────────────────────────────────────────────
async function apiListFiles() {
  const res = await fetch("/api/files");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiBrowse(dir) {
  const params = new URLSearchParams({ dir });
  const res = await fetch(`/api/browse?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiOpenFile(path) {
  const res = await fetch("/api/files/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiCloseFile(path) {
  const res = await fetch("/api/files/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiFileMeta(key) {
  const res = await fetch(`/api/files/${key}/metadata`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiFileRecords(key, offset, limit, query = "", field = "", negate = false) {
  const params = new URLSearchParams({ offset, limit });
  if (query) params.set("query", query);
  if (field) params.set("field", field);
  if (negate) params.set("negate", "true");
  const res = await fetch(`/api/files/${key}/records?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiExport(key, body) {
  const res = await fetch(`/api/files/${key}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.blob();
}

// ── Selection & Export ─────────────────────────────────────────────────────
function toggleSelect(idx) {
  const st = getState();
  if (!st) return;
  if (st.selectedIndices.has(idx)) {
    st.selectedIndices.delete(idx);
  } else {
    st.selectedIndices.add(idx);
  }
  updateActionsBar();
  // Update the individual checkbox
  const cb = document.querySelector(`.record-checkbox[data-index="${idx}"]`);
  if (cb) cb.checked = st.selectedIndices.has(idx);
}

function selectPage() {
  const st = getState();
  if (!st) return;
  for (const rec of st.cachedRecords) {
    st.selectedIndices.add(rec._index);
  }
  updateActionsBar();
  for (const cb of document.querySelectorAll(".record-checkbox")) {
    cb.checked = true;
  }
}

function clearSelection() {
  const st = getState();
  if (!st) return;
  st.selectedIndices.clear();
  updateActionsBar();
  for (const cb of document.querySelectorAll(".record-checkbox")) {
    cb.checked = false;
  }
}

function updateActionsBar() {
  const st = getState();
  if (!st) {
    dom.actionsBar.classList.add("hidden");
    return;
  }

  dom.actionsBar.classList.remove("hidden");

  const n = st.selectedIndices.size;
  dom.selectionCount.textContent = `${n} selected`;
  dom.btnExportSelected.disabled = n === 0;

  if (n > 0) {
    dom.btnExportSelected.textContent = `Export selected (${n})`;
  } else {
    dom.btnExportSelected.textContent = "Export selected";
  }

  if (st.isFiltering && st.filteredTotal > 0) {
    dom.btnExportFiltered.classList.remove("hidden");
    dom.btnExportFiltered.textContent = `Export filtered (${st.filteredTotal})`;
  } else {
    dom.btnExportFiltered.classList.add("hidden");
  }
}

async function exportSelected() {
  const st = getState();
  if (!st || st.selectedIndices.size === 0) return;
  try {
    const blob = await apiExport(activeKey, {
      indices: Array.from(st.selectedIndices),
    });
    downloadBlob(blob, `${st.name.replace(/\.jsonl$/i, "")}_selected.jsonl`);
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
}

async function exportFiltered() {
  const st = getState();
  if (!st || !st.isFiltering) return;
  try {
    const blob = await apiExport(activeKey, {
      query: st.filterQuery,
      field: st.filterField,
      negate: st.filterNegate,
    });
    downloadBlob(blob, `${st.name.replace(/\.jsonl$/i, "")}_filtered.jsonl`);
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Tab Tooltip ────────────────────────────────────────────────────────────
let tooltipEl = null;

function showTabTooltip(anchor, text) {
  hideTabTooltip();
  tooltipEl = document.createElement("div");
  tooltipEl.className = "tab-tooltip";
  tooltipEl.textContent = text;
  document.body.appendChild(tooltipEl);
  const rect = anchor.getBoundingClientRect();
  tooltipEl.style.left = rect.left + "px";
  tooltipEl.style.top = (rect.bottom + 4) + "px";
}

function hideTabTooltip() {
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}

// ── Tab Management ─────────────────────────────────────────────────────────
function renderTabs() {
  dom.tabList.innerHTML = "";
  // Sync tabOrder with currently open files
  const currentKeys = new Set(fileStates.keys());
  tabOrder = tabOrder.filter(k => currentKeys.has(k));
  for (const k of currentKeys) {
    if (!tabOrder.includes(k)) tabOrder.push(k);
  }

  if (tabOrder.length === 0) {
    dom.tabEmpty.style.display = "block";
    dom.tabList.style.display = "none";
    dom.filename.textContent = "JSONL Viewer";
    dom.recordCount.classList.add("hidden");
    dom.recordList.innerHTML =
      '<div class="center-message">No file open. Click <strong>+</strong> to open a JSONL file.</div>';
    dom.pageInfo.textContent = "Page 0 of 0";
    dom.statusText.textContent = "No file open";
    dom.filterInfo.classList.add("hidden");
    updatePaginationDisabled();
    return;
  }

  dom.tabEmpty.style.display = "none";
  dom.tabList.style.display = "flex";

  for (const key of tabOrder) {
    const fi = fileStates.get(key);
    if (!fi) continue;

    const tab = document.createElement("div");
    tab.className = "tab" + (key === activeKey ? " active" : "");
    tab.dataset.key = key;
    tab.draggable = true;

    const tooltipText = fi.path || fi.name || key;
    tab.addEventListener("mouseenter", () => showTabTooltip(tab, tooltipText));
    tab.addEventListener("mouseleave", hideTabTooltip);

    const nameSpan = document.createElement("span");
    nameSpan.className = "tab-filename";
    nameSpan.textContent = fi.name || "Unknown";

    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close file";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFileTab(key);
    });

    tab.appendChild(nameSpan);
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => switchTab(key));

    // Drag-and-drop handlers
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", key);
      e.dataTransfer.effectAllowed = "move";
      tab.classList.add("dragging");
    });
    tab.addEventListener("dragend", () => {
      tab.classList.remove("dragging");
      // Remove drop-target styling from all tabs
      dom.tabList.querySelectorAll(".tab").forEach(t => t.classList.remove("drop-target"));
    });
    tab.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Highlight the tab we're hovering over
      dom.tabList.querySelectorAll(".tab").forEach(t => t.classList.remove("drop-target"));
      if (!tab.classList.contains("dragging")) {
        tab.classList.add("drop-target");
      }
    });
    tab.addEventListener("dragleave", () => {
      tab.classList.remove("drop-target");
    });
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      tab.classList.remove("drop-target");
      const fromKey = e.dataTransfer.getData("text/plain");
      const toKey = key;
      if (fromKey && fromKey !== toKey) {
        const fromIdx = tabOrder.indexOf(fromKey);
        const toIdx = tabOrder.indexOf(toKey);
        if (fromIdx !== -1 && toIdx !== -1) {
          tabOrder.splice(fromIdx, 1);
          tabOrder.splice(toIdx, 0, fromKey);
          renderTabs();
        }
      }
    });

    dom.tabList.appendChild(tab);
  }
}

async function switchTab(key) {
  if (key === activeKey) return;

  // Save scroll position of current tab
  if (activeKey) {
    const prevSt = fileStates.get(activeKey);
    if (prevSt) prevSt.scrollTop = dom.recordList.scrollTop;
  }

  activeKey = key;
  const st = getState();
  if (!st) return;

  // Restore UI from state
  dom.filename.textContent = st.name || "JSONL Viewer";
  dom.recordCount.textContent = `${st.totalRecords.toLocaleString()} records`;
  dom.recordCount.classList.remove("hidden");
  document.title = `${st.name || "JSONL Viewer"} — JSONL Viewer`;
  dom.pageSize.value = st.pageSize;
  dom.filterInput.value = st.filterQuery;
  dom.fieldSelect.value = st.filterField;

  populateFieldSelect(st.availableFields);

  if (st.filterQuery) {
    dom.filterInfo.classList.remove("hidden");
  } else {
    dom.filterInfo.classList.add("hidden");
  }
  updateNegateButton();

  renderTabs();
  loadPage(st.currentPage);
}

async function openFileTab(path) {
  try {
    dom.modalOverlay.classList.add("hidden");
    const data = await apiOpenFile(path);
    const key = data.key;
    const st = ensureState(key);
    st.totalRecords = data.total_records;
    st.availableFields = data.fields || [];
    st.name = data.name;
    st.path = data.path;
    st.currentPage = 1;
    st.filterQuery = "";
    st.filterField = "";
    st.isFiltering = false;

    activeKey = key;
    dom.filename.textContent = data.name;
    dom.recordCount.textContent = `${data.total_records.toLocaleString()} records`;
    dom.recordCount.classList.remove("hidden");
    document.title = `${data.name} — JSONL Viewer`;
    dom.pageSize.value = st.pageSize;
    dom.filterInput.value = "";
    dom.fieldSelect.value = "";
    populateFieldSelect(st.availableFields);
    dom.filterInfo.classList.add("hidden");

    renderTabs();
    loadPage(1);
  } catch (err) {
    alert(`Failed to open file: ${err.message}`);
  }
}

async function closeFileTab(key) {
  const fi = fileStates.get(key);
  if (!fi) return;

  try {
    await apiCloseFile(fi.path);
  } catch {
    // Server may not have it open; proceed anyway
  }

  fileStates.delete(key);

  const keys = Array.from(fileStates.keys());
  if (key === activeKey) {
    if (keys.length > 1) {
      // Switch to the neighboring tab
      const oldIdx = keys.indexOf(key);
      const newIdx = oldIdx > 0 ? oldIdx - 1 : 0;
      // Actually, since we just deleted the key, let's recalculate
      const remainingKeys = Array.from(fileStates.keys());
      if (remainingKeys.length > 0) {
        const targetKey = remainingKeys[Math.min(oldIdx, remainingKeys.length - 1)];
        activeKey = targetKey;
        const st = fileStates.get(targetKey);
        dom.filename.textContent = st.name || "JSONL Viewer";
        dom.recordCount.textContent = `${st.totalRecords.toLocaleString()} records`;
        dom.recordCount.classList.remove("hidden");
        document.title = `${st.name} — JSONL Viewer`;
        dom.pageSize.value = st.pageSize;
        dom.filterInput.value = st.filterQuery;
        dom.fieldSelect.value = st.filterField;
        populateFieldSelect(st.availableFields);
        if (st.filterQuery) {
          dom.filterInfo.classList.remove("hidden");
        } else {
          dom.filterInfo.classList.add("hidden");
        }
        renderTabs();
        loadPage(st.currentPage);
      } else {
        activeKey = null;
        renderTabs();
      }
    } else {
      activeKey = null;
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

// ── File Browser Modal ─────────────────────────────────────────────────────
let modalCurrentDir = "";

function showFileBrowser() {
  dom.modalOverlay.classList.remove("hidden");
  dom.modalPathInput.value = "";
  if (!modalCurrentDir) {
    // Start from the active file's directory, or home
    const st = getState();
    if (st && st.path) {
      modalCurrentDir = st.path.substring(0, st.path.lastIndexOf("/")) || "/";
    } else {
      modalCurrentDir = "/Users";
    }
  }
  browseDir(modalCurrentDir);
}

function hideFileBrowser() {
  dom.modalOverlay.classList.add("hidden");
}

async function browseDir(dir) {
  modalCurrentDir = dir;
  dom.modalCurrentDir.textContent = dir;
  dom.modalFileList.innerHTML = '<div class="modal-empty">Loading...</div>';

  try {
    const data = await apiBrowse(dir);
    dom.modalCurrentDir.textContent = data.current_dir;
    modalCurrentDir = data.current_dir;
    renderFileList(data);
  } catch (err) {
    dom.modalFileList.innerHTML = `<div class="modal-empty">Error: ${err.message}</div>`;
  }
}

function renderFileList(data) {
  dom.modalFileList.innerHTML = "";

  if (data.dirs.length === 0 && data.files.length === 0) {
    dom.modalFileList.innerHTML =
      '<div class="modal-empty">No .jsonl files or subdirectories found here.</div>';
    return;
  }

  // Directories
  for (const d of data.dirs) {
    const item = document.createElement("div");
    item.className = "modal-item dir";
    item.innerHTML = `
      <span class="modal-item-icon">&#128193;</span>
      <span class="modal-item-name">${escapeHtml(d.name)}</span>
    `;
    item.addEventListener("click", () => browseDir(d.path));
    dom.modalFileList.appendChild(item);
  }

  // Files
  for (const f of data.files) {
    const item = document.createElement("div");
    item.className = "modal-item file";
    const sizeStr = formatSize(f.size);
    item.innerHTML = `
      <span class="modal-item-icon">&#128196;</span>
      <span class="modal-item-name">${escapeHtml(f.name)}</span>
      <span class="modal-item-size">${sizeStr}</span>
    `;
    item.addEventListener("click", () => openFileTab(f.path));
    dom.modalFileList.appendChild(item);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Field Select ───────────────────────────────────────────────────────────
function populateFieldSelect(fields) {
  dom.fieldSelect.innerHTML = '<option value="">All fields</option>';
  for (const f of fields || []) {
    if (f.startsWith("_")) continue;
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    dom.fieldSelect.appendChild(opt);
  }
}

// ── Load & Render ──────────────────────────────────────────────────────────
async function loadPage(page) {
  const st = getState();
  if (!st) return;

  dom.recordList.innerHTML =
    '<div class="center-message">Loading records...</div>';

  const limit = st.pageSize;
  const offset = (page - 1) * limit;

  try {
    const data = await apiFileRecords(
      activeKey,
      offset,
      limit,
      st.filterQuery,
      st.filterField,
      st.filterNegate
    );

    if (st.isFiltering) {
      st.filteredTotal = data.total;
      st.totalPages = Math.max(1, Math.ceil(data.total / limit));
    } else {
      st.totalPages = Math.max(1, Math.ceil(st.totalRecords / limit));
    }

    st.currentPage = page;
    st.cachedRecords = data.records;
    renderRecords(data.records);
    updatePagination();
    updateStatus(data);
    updateActionsBar();
    // Restore scroll position
    requestAnimationFrame(() => {
      dom.recordList.scrollTop = st.scrollTop || 0;
    });
  } catch (err) {
    dom.recordList.innerHTML = `<div class="center-message">Error: ${err.message}</div>`;
  }
}

function renderRecords(records) {
  dom.recordList.innerHTML = "";

  if (records.length === 0) {
    dom.recordList.innerHTML =
      '<div class="center-message">No records found. Try a different filter.</div>';
    return;
  }

  for (const rec of records) {
    const card = createRecordCard(rec);
    dom.recordList.appendChild(card);
  }
}

function createRecordCard(rec) {
  const card = document.createElement("div");
  card.className = "record-card";

  const idx = rec._index ?? "?";
  const header = document.createElement("div");
  header.className = "record-header";

  const left = document.createElement("div");
  left.className = "record-header-left";

  const st = getState();
  const checked = st && st.selectedIndices.has(idx);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "record-checkbox";
  checkbox.dataset.index = idx;
  checkbox.checked = checked;
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  checkbox.addEventListener("change", () => toggleSelect(idx));

  const idxSpan = document.createElement("span");
  idxSpan.className = "record-index";
  idxSpan.textContent = `#${idx.toLocaleString()}`;

  left.appendChild(checkbox);
  left.appendChild(idxSpan);

  const toggle = document.createElement("span");
  toggle.className = "record-toggle";
  toggle.innerHTML = "&#9660;";

  header.appendChild(left);
  header.appendChild(toggle);

  header.addEventListener("click", (e) => {
    if (e.target === checkbox) return;
    const body = card.querySelector(".record-body");
    const toggle = header.querySelector(".record-toggle");
    body.classList.toggle("collapsed");
    toggle.classList.toggle("collapsed");
  });

  const body = document.createElement("div");
  body.className = "record-body";
  renderJsonValue(rec, body, 0, 3);

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// ── JSON Rendering ─────────────────────────────────────────────────────────
function renderJsonValue(value, container, depth, maxDepth) {
  if (depth > maxDepth) {
    const span = document.createElement("span");
    span.className = "json-ellipsis";
    span.textContent = "...";
    container.appendChild(span);
    return;
  }

  if (value === null) {
    const span = document.createElement("span");
    span.className = "json-value-null";
    span.textContent = "null";
    container.appendChild(span);
  } else if (typeof value === "boolean") {
    const span = document.createElement("span");
    span.className = "json-value-boolean";
    span.textContent = value.toString();
    container.appendChild(span);
  } else if (typeof value === "number") {
    const span = document.createElement("span");
    span.className = "json-value-number";
    span.textContent = value.toString();
    container.appendChild(span);
  } else if (typeof value === "string") {
    renderStringValue(value, container);
  } else if (Array.isArray(value)) {
    renderArrayValue(value, container, depth, maxDepth);
  } else if (typeof value === "object") {
    renderObjectValue(value, container, depth, maxDepth);
  } else {
    container.appendChild(document.createTextNode(String(value)));
  }
}

function renderStringValue(str, container) {
  const hasNewlines = str.includes("\n");
  const isLong = str.length > 200;

  if (hasNewlines || (isLong && str.length > 500)) {
    const wrapper = document.createElement("span");
    wrapper.className = "json-value-string";

    if (str.length > 300) {
      const preview = str.substring(0, 300);
      const pre = document.createElement("div");
      pre.className = "json-value-multiline";
      pre.textContent = str;
      pre.style.display = "none";
      pre.id = `block-${Math.random().toString(36).slice(2)}`;

      const toggle = document.createElement("span");
      toggle.className = "json-collapse-toggle";
      toggle.textContent = `"${preview}"... [+${(str.length - 300).toLocaleString()} more chars, click to expand]`;
      toggle.addEventListener("click", () => {
        if (pre.style.display === "none") {
          pre.style.display = "block";
          toggle.textContent = `[${str.length.toLocaleString()} chars, click to collapse]`;
        } else {
          pre.style.display = "none";
          toggle.textContent = `"${preview}"... [+${(str.length - 300).toLocaleString()} more chars, click to expand]`;
        }
      });

      wrapper.appendChild(toggle);
      wrapper.appendChild(pre);
    } else {
      const pre = document.createElement("div");
      pre.className = "json-value-multiline";
      pre.textContent = str;
      wrapper.appendChild(pre);
    }

    container.appendChild(wrapper);
  } else {
    const span = document.createElement("span");
    span.className = "json-value-string";
    span.textContent = JSON.stringify(str);
    container.appendChild(span);
  }
}

function renderObjectValue(obj, container, depth, maxDepth) {
  const keys = Object.keys(obj);

  if (keys.length === 0) {
    const span = document.createElement("span");
    span.className = "json-bracket";
    span.textContent = "{}";
    container.appendChild(span);
    return;
  }

  const openBracket = document.createElement("span");
  openBracket.className = "json-bracket";
  openBracket.textContent = "{";
  container.appendChild(openBracket);

  const collapseId = `obj-${Math.random().toString(36).slice(2)}`;
  const wrapper = document.createElement("span");
  wrapper.id = collapseId;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key.startsWith("_")) continue;

    const val = obj[key];
    const row = document.createElement("div");
    row.className = `json-row indent-${Math.min(depth + 1, 4)}`;

    const keySpan = document.createElement("span");
    keySpan.className = "json-key";
    keySpan.textContent = key;
    row.appendChild(keySpan);

    const valSpan = document.createElement("span");

    if (key === "answer" && typeof val === "string") {
      valSpan.dataset.value = val;
    }

    renderJsonValue(val, valSpan, depth + 1, maxDepth);

    if (key === "answer") {
      row.classList.add("field-answer");
      if (typeof val === "string") {
        row.dataset.value = val;
      }
    }
    if (key === "question") row.classList.add("field-question");
    if (key === "difficulty") row.classList.add("field-difficulty");

    row.appendChild(valSpan);
    wrapper.appendChild(row);
  }

  container.appendChild(wrapper);

  const closeBracket = document.createElement("span");
  closeBracket.className = "json-bracket";
  closeBracket.textContent = "}";
  container.appendChild(closeBracket);

  if (keys.length > 8) {
    const toggle = document.createElement("span");
    toggle.className = "json-collapse-toggle";
    toggle.textContent = " [collapse]";
    toggle.addEventListener("click", () => {
      const w = document.getElementById(collapseId);
      if (w.style.display === "none") {
        w.style.display = "";
        toggle.textContent = " [collapse]";
      } else {
        w.style.display = "none";
        toggle.textContent = ` [expand — ${keys.length} keys]`;
      }
    });
    openBracket.after(toggle);
  }
}

function renderArrayValue(arr, container, depth, maxDepth) {
  if (arr.length === 0) {
    const span = document.createElement("span");
    span.className = "json-bracket";
    span.textContent = "[]";
    container.appendChild(span);
    return;
  }

  const openBracket = document.createElement("span");
  openBracket.className = "json-bracket";
  openBracket.textContent = "[";
  container.appendChild(openBracket);

  const collapseId = `arr-${Math.random().toString(36).slice(2)}`;
  const wrapper = document.createElement("span");
  wrapper.id = collapseId;

  for (let i = 0; i < arr.length; i++) {
    const row = document.createElement("div");
    row.className = `json-row indent-${Math.min(depth + 1, 4)}`;

    const idxSpan = document.createElement("span");
    idxSpan.className = "json-key";
    idxSpan.textContent = `${i}`;
    row.appendChild(idxSpan);

    const valSpan = document.createElement("span");
    renderJsonValue(arr[i], valSpan, depth + 1, maxDepth);
    row.appendChild(valSpan);
    wrapper.appendChild(row);
  }

  container.appendChild(wrapper);

  const closeBracket = document.createElement("span");
  closeBracket.className = "json-bracket";
  closeBracket.textContent = "]";
  container.appendChild(closeBracket);

  if (arr.length > 10) {
    const toggle = document.createElement("span");
    toggle.className = "json-collapse-toggle";
    toggle.textContent = " [collapse]";
    toggle.addEventListener("click", () => {
      const w = document.getElementById(collapseId);
      if (w.style.display === "none") {
        w.style.display = "";
        toggle.textContent = " [collapse]";
      } else {
        w.style.display = "none";
        toggle.textContent = ` [expand — ${arr.length} items]`;
      }
    });
    openBracket.after(toggle);
  }
}

// ── Pagination ─────────────────────────────────────────────────────────────
function updatePagination() {
  const st = getState();
  if (!st) {
    updatePaginationDisabled();
    return;
  }

  dom.pageInfo.textContent = `Page ${st.currentPage} of ${st.totalPages.toLocaleString()}`;
  dom.btnFirst.disabled = st.currentPage <= 1;
  dom.btnPrev.disabled = st.currentPage <= 1;
  dom.btnNext.disabled = st.currentPage >= st.totalPages;
  dom.btnLast.disabled = st.currentPage >= st.totalPages;
  dom.pageJump.max = st.totalPages;
  dom.pageJump.value = "";
  dom.pageJump.placeholder = `1-${st.totalPages}`;
}

function updatePaginationDisabled() {
  dom.pageInfo.textContent = "Page 0 of 0";
  dom.btnFirst.disabled = true;
  dom.btnPrev.disabled = true;
  dom.btnNext.disabled = true;
  dom.btnLast.disabled = true;
}

function updateStatus(data) {
  const st = getState();
  if (!st) return;

  let text;
  if (st.isFiltering) {
    const scanned = data.scanned ?? data.total;
    const prefix = st.filterNegate ? "NOT " : "";
    text = `${prefix}Filtered: ${data.total.toLocaleString()} matches (scanned ${scanned.toLocaleString()} records)`;
    dom.filterInfo.textContent = text;
    dom.filterInfo.classList.remove("hidden");
  } else {
    text = `${st.totalRecords.toLocaleString()} total records`;
    dom.filterInfo.classList.add("hidden");
  }
  dom.statusText.textContent = text;
}

function goToPage(page) {
  const st = getState();
  if (!st) return;
  const p = Math.max(1, Math.min(page, st.totalPages));
  loadPage(p);
  dom.recordList.scrollTop = 0;
}

// ── Event Listeners: Pagination ────────────────────────────────────────────
dom.btnFirst.addEventListener("click", () => {
  const st = getState();
  if (st) goToPage(1);
});
dom.btnPrev.addEventListener("click", () => {
  const st = getState();
  if (st) goToPage(st.currentPage - 1);
});
dom.btnNext.addEventListener("click", () => {
  const st = getState();
  if (st) goToPage(st.currentPage + 1);
});
dom.btnLast.addEventListener("click", () => {
  const st = getState();
  if (st) goToPage(st.totalPages);
});

dom.pageJump.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const page = parseInt(dom.pageJump.value, 10);
    const st = getState();
    if (st && page >= 1 && page <= st.totalPages) {
      goToPage(page);
    }
  }
});

// ── Event Listeners: Page Size ─────────────────────────────────────────────
dom.pageSize.addEventListener("change", () => {
  const st = getState();
  if (!st) return;
  st.pageSize = parseInt(dom.pageSize.value, 10);
  st.currentPage = 1;
  loadPage(1);
});

// ── Event Listeners: Filter ────────────────────────────────────────────────
dom.filterBtn.addEventListener("click", applyFilter);
dom.filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyFilter();
});
dom.clearFilterBtn.addEventListener("click", clearFilter);
dom.filterNegateBtn.addEventListener("click", toggleNegate);

function applyFilter() {
  const st = getState();
  if (!st) return;
  const query = dom.filterInput.value.trim();
  const field = dom.fieldSelect.value;
  st.filterQuery = query;
  st.filterField = field;
  st.isFiltering = query.length > 0;
  st.currentPage = 1;
  st.selectedIndices.clear();
  updateNegateButton();
  loadPage(1);
}

function clearFilter() {
  const st = getState();
  if (!st) return;
  dom.filterInput.value = "";
  dom.fieldSelect.value = "";
  st.filterQuery = "";
  st.filterField = "";
  st.filterNegate = false;
  st.isFiltering = false;
  st.currentPage = 1;
  st.selectedIndices.clear();
  updateNegateButton();
  loadPage(1);
}

function toggleNegate() {
  const st = getState();
  if (!st) return;
  st.filterNegate = !st.filterNegate;
  st.currentPage = 1;
  st.selectedIndices.clear();
  updateNegateButton();
  if (st.isFiltering) loadPage(1);
}

function updateNegateButton() {
  const st = getState();
  const btn = dom.filterNegateBtn;
  if (st && st.filterNegate) {
    btn.classList.add("active");
    btn.textContent = "≠";
    btn.title = "Exclude mode — showing records that do NOT match";
  } else {
    btn.classList.remove("active");
    btn.textContent = "=";
    btn.title = "Match mode — showing records that match";
  }
}

// ── Event Listeners: Selection & Export ────────────────────────────────────
dom.btnSelectPage.addEventListener("click", selectPage);
dom.btnClearSelection.addEventListener("click", clearSelection);
dom.btnExportSelected.addEventListener("click", exportSelected);
dom.btnExportFiltered.addEventListener("click", exportFiltered);

// ── Event Listeners: Tab Bar ───────────────────────────────────────────────
dom.tabAdd.addEventListener("click", showFileBrowser);

// ── Event Listeners: Modal ─────────────────────────────────────────────────
dom.modalCloseBtn.addEventListener("click", hideFileBrowser);
dom.modalOverlay.addEventListener("click", (e) => {
  if (e.target === dom.modalOverlay) hideFileBrowser();
});

dom.modalUpBtn.addEventListener("click", () => {
  // Go to parent directory
  const parent = modalCurrentDir.substring(0, modalCurrentDir.lastIndexOf("/")) || "/";
  browseDir(parent);
});

dom.modalOpenBtn.addEventListener("click", () => {
  const path = dom.modalPathInput.value.trim();
  if (path) {
    openFileTab(path);
  }
});

dom.modalPathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const path = dom.modalPathInput.value.trim();
    if (path) {
      openFileTab(path);
    }
  }
});

// ── Keyboard Shortcuts ─────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  // Don't trigger when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
    return;
  }
  const st = getState();
  if (e.key === "ArrowLeft" && !e.metaKey && !e.ctrlKey) {
    if (st) goToPage(st.currentPage - 1);
  } else if (e.key === "ArrowRight" && !e.metaKey && !e.ctrlKey) {
    if (st) goToPage(st.currentPage + 1);
  } else if (e.key === "/") {
    e.preventDefault();
    dom.filterInput.focus();
  } else if ((e.key === "t" || e.key === "T") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    showFileBrowser();
  }
});

// ── Escape key to close modal ──────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dom.modalOverlay.classList.contains("hidden")) {
    hideFileBrowser();
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    // Check if server already has a file open (from CLI arg)
    const data = await apiListFiles();
    if (data.files && data.files.length > 0) {
      // Server pre-loaded files
      for (const f of data.files) {
        const st = ensureState(f.key);
        st.totalRecords = f.total_records;
        st.name = f.name;
        st.path = f.path;
        st.currentPage = 1;

        // Fetch full metadata for fields
        try {
          const meta = await apiFileMeta(f.key);
          st.availableFields = meta.fields || [];
        } catch {
          // ignore
        }

        if (!activeKey) {
          activeKey = f.key;
          dom.filename.textContent = f.name;
          dom.recordCount.textContent = `${f.total_records.toLocaleString()} records`;
          dom.recordCount.classList.remove("hidden");
          document.title = `${f.name} — JSONL Viewer`;
          dom.pageSize.value = st.pageSize;
          populateFieldSelect(st.availableFields);
        }
      }

      renderTabs();
      if (activeKey) {
        loadPage(1);
      }
    } else {
      renderTabs();
    }
  } catch (err) {
    console.error("Init error:", err);
    dom.recordList.innerHTML = `<div class="center-message">Cannot connect to server: ${err.message}</div>`;
    dom.statusText.textContent = "Connection error";
  }
}

init();
