// ========== Smart API base + UX states ==========
const statusEl  = document.getElementById('status');
const detailsEl = document.getElementById('details');
const toastEl   = document.getElementById('toast');
const overlayEl = document.getElementById('overlay');
const searchEl  = document.getElementById('search');
const autoEl    = document.getElementById('autorefresh');
const btnCenter = document.getElementById('btnCenter');
const btnTheme  = document.getElementById('btnTheme');
const btnClear  = document.getElementById('btnClear');

// Safe HTML escaping for details rendering
function esc(s){ return String(s).replace(/[&<>"']/g, m => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) }

function formatBytes(b){
  if (b == null) return '—';
  const u = ['B','KB','MB','GB','TB','PB']; let i=0, x=Number(b);
  while (x>=1024 && i<u.length-1){ x/=1024; i++; }
  return `${x.toFixed(x<10?2:1)} ${u[i]}`;
}

// Optional override in DevTools: localStorage.SYSMAP_API_BASE="http://127.0.0.1:8787"
const OVERRIDE = localStorage.getItem('SYSMAP_API_BASE') || '';
const CANDIDATES = [
  (p)=>`${location.protocol}//${location.hostname}:8787${p}`,
  (p)=>`http://127.0.0.1:8787${p}`,
  (p)=>`http://localhost:8787${p}`,
  (p)=>`http://[::1]:8787${p}`
];
let API = (p)=> (OVERRIDE ? `${OVERRIDE}${p}` : CANDIDATES[0](p));

async function tryFetch(url, ms=1500){
  const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); return r.ok ? r : null; }
  catch { return null; } finally { clearTimeout(t); }
}
async function resolveApiBase(){
  if (OVERRIDE && await tryFetch(`${OVERRIDE}/api/health`)) return OVERRIDE;
  for (const mk of CANDIDATES){
    if (await tryFetch(mk('/api/health'))){ const base = mk(''); localStorage.setItem('SYSMAP_API_BASE', base); API=(p)=>mk(p); return base; }
  }
  return null;
}
function toast(msg){ toastEl.textContent=msg; toastEl.classList.remove('hidden'); setTimeout(()=>toastEl.classList.add('hidden'), 1600); }

// ========== Graph setup ==========
const colorByType = { host:'#6b5b95', cpu:'#ff8c42', ram:'#58a6ff', disk:'#8fd694', process:'#c792ea', remote:'#ff6b6b' };
const Graph = ForceGraph3D()(document.getElementById('graph'))
  .nodeLabel(n => n?.data?.label ?? '')
  .nodeAutoColorBy(n => n?.data?.type ?? 'unknown')
  .nodeColor(n => colorByType[n?.data?.type] || '#aaa')
  .nodeThreeObjectExtend(true)
  .nodeVal(n => n?.data?.type === 'process' ? Math.max(2, Math.min(12, (n.data.mem_mb || 0)/50)) : 6)
  .linkColor(l => ({
  owns:  '#77aa22',
  parent:'#666666',
  runs:  '#33aadd',
  net:   '#ee6666',
  mount: '#5599cc'
}[l?.data?.kind] || '#888888'))

  .linkOpacity(0.65)
  .onNodeClick(async n => {
    if (!n?.data) return;
    renderDetails(n.data);
    highlight(n.data.id);
    if (n.data.id?.startsWith?.('pid:')) {
      try {
        const pid = n.data.id.split(':')[1];
        const r = await fetch(API(`/api/process/${pid}`));
       if (r?.ok) {
       const extra = await r.json();
       renderDetails({ ...n.data, process: extra });
     }
      } catch (e) { console.error(e); }
    }
  });

// initial settle then don’t auto-reheat
Graph.cooldownTicks?.(80);
setTimeout(()=>Graph.cooldownTicks?.(0), 2500);
Graph.d3Force('charge').strength(-70);
Graph.backgroundColor('#0b0d12');

// ========== Stable layout (no thump) ==========
let lastData = { nodes:[], links:[] };    // current graph (with positions)
let firstLoad = true;
let pauseUntil = 0; // pause refresh while user is interacting

const graphEl = document.getElementById('graph');
['pointerdown','wheel','touchstart'].forEach(ev =>
  graphEl.addEventListener(ev, () => { pauseUntil = Date.now() + 1200; })
);
 
function renderDetails(d){
  if (!d) { detailsEl.textContent = ''; return; }

  const lines = [];
  const kv = (k,v)=> lines.push(`${k}: ${v}`);

  switch(d.type){
    case 'cpu':
      kv('Cores', d.cores);
      kv('Usage', `${(d.usage_percent ?? 0).toFixed(1)}%`);
      if (d.freq_mhz) kv('Freq', `${Math.round(d.freq_mhz)} MHz`);
      kv('Load (1/5/15)', [d.load_1,d.load_5,d.load_15].map(x=>x?.toFixed?.(2)).join(' / '));
      break;
    case 'ram':
      kv('Used', `${formatBytes(d.used)} / ${formatBytes(d.total)} (${d.percent?.toFixed?.(0)}%)`);
      kv('Available', formatBytes(d.available));
      break;
    case 'disk':
      kv('Mount', d.label);
      kv('FS Type', d.fstype || '—');
      kv('Used', `${formatBytes(d.used)} / ${formatBytes(d.total)} (${d.percent?.toFixed?.(0)}%)`);
      break;
    case 'host':
      kv('Hostname', d.label);
      kv('OS', d.os || '—');
      if (d.boot_time) kv('Uptime', `${Math.floor((Date.now()/1000 - d.boot_time)/3600)}h`);
      break;
    case 'remote':
      kv('Remote IP', d.label);
      break;
    case 'process': {
      const P = d.process || {};
      const nameFromLabel = (d.label || '').replace(/\s*\(\d+\)\s*$/, '');
      const pidFromId = (d.id || '').split(':')[1] || P.pid;
      const rss = P.memory_info?.rss ?? (d.mem_mb ? d.mem_mb * 1e6 : undefined);
      kv('Process', P.name ?? nameFromLabel);
      kv('PID', P.pid ?? pidFromId ?? '—');
      if (P.username || d.user) kv('User', P.username || d.user);
      if (P.cpu_percent != null || d.cpu != null) kv('CPU %', ((P.cpu_percent ?? d.cpu) || 0).toFixed(1));
      if (rss != null) kv('Memory', `${(rss/1e6).toFixed(1)} MB`);
      if (P.cmdline?.length) kv('Command', P.cmdline.join(' '));
      if (P.exe) kv('Executable', P.exe);
      if (P.cwd) kv('CWD', P.cwd);
      if (P.create_time) kv('Started', new Date(P.create_time*1000).toLocaleString());
      break;
    }
    default:
      detailsEl.innerHTML = `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
      return;
  }

  detailsEl.innerHTML = `
    <div class="details-summary"><pre>${esc(lines.join('\\n'))}</pre></div>
    <details class="more">
      <summary>Advanced</summary>
      <pre>${esc(JSON.stringify(d, null, 2))}</pre>
    </details>
  `;
}



function indexById(arr){ const m = new Map(); arr.forEach(n=>m.set(n.id,n)); return m; }

function mergePositions(prev, next){
  const prevIdx = indexById(prev.nodes);
  const nodes = next.nodes.map(n => {
    const old = prevIdx.get(n.id);
    if (old && 'x' in old) { n.x=old.x; n.y=old.y; n.z=old.z; n.vx=0; n.vy=0; n.vz=0; }
    return n;
  });
  return { nodes, links: next.links };
}

function structureChanged(prev, next){
  if (prev.nodes.length !== next.nodes.length || prev.links.length !== next.links.length) return true;
  const ids = new Set(prev.nodes.map(n=>n.id));
  for (const n of next.nodes) if (!ids.has(n.id)) return true;

  const key = l => `${typeof l.source==='object'?l.source.id:l.source}->${typeof l.target==='object'?l.target.id:l.target}`;
  const prevL = new Set(prev.links.map(key));
  for (const l of next.links) if (!prevL.has(key(l))) return true;
  return false;
}

// selection highlight
let lastSel = null;
function highlight(id){
  const g = Graph.graphData();
  const nodes = new Set([id]);
  const links = [];
  g.links.forEach(l=>{
    const a = typeof l.source === 'object' ? l.source.id : l.source;
    const b = typeof l.target === 'object' ? l.target.id : l.target;
    if (a===id || b===id){ nodes.add(a); nodes.add(b); links.push(l); }
  });
  Graph.nodeColor(n => nodes.has(n.id) ? (colorByType[n.data.type] || '#fff') : '#394155');
  Graph.linkOpacity(l => links.includes(l) ? 0.9 : 0.12);
  lastSel = id;
}
function clearHighlight(){
  Graph.nodeColor(n => colorByType[n?.data?.type] || '#aaa');
  Graph.linkOpacity(0.65);
  lastSel = null;
}

// ========== Data + filtering ==========
let rawData = { nodes:[], links:[] };
function applyFilter(q){
  if(!q){ Graph.graphData(rawData); if (lastSel) highlight(lastSel); return; }
  const s = q.toLowerCase();
  const keep = new Set();
  rawData.nodes.forEach(n=>{
    const label = (n?.data?.label || '').toLowerCase();
    if (label.includes(s) || n.id.toLowerCase().includes(s)) keep.add(n.id);
  });
  const nodes = rawData.nodes.filter(n=>keep.has(n.id));
  const links = rawData.links.filter(l=>{
    const a = typeof l.source === 'object' ? l.source.id : l.source;
    const b = typeof l.target === 'object' ? l.target.id : l.target;
    return keep.has(a) && keep.has(b);
  });
  Graph.graphData({ nodes, links });
  if(nodes.length) highlight(nodes[0].id); else clearHighlight();
}
// ---------- gentle backoff when API fails ----------
let timer = null;            // <— declare before refresh() uses it
let backoffMs = 2000;
const MAX_BACKOFF = 15000;

async function refresh(){
  try{
    if (Date.now() < pauseUntil) return;
    overlayEl.classList.add('hidden');

    const r = await fetch(API('/api/topology'));
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const next = {
      nodes: (data.nodes||[]).map(n => ({ id:n.data.id, data:n.data })),
      links: (data.edges||[]).map(e => ({ source:e.data.source, target:e.data.target, data:e.data }))
    };

    if (firstLoad) {
      lastData = mergePositions(lastData, next);
      rawData = lastData;
      Graph.graphData(lastData);
      firstLoad = false;
    } else if (structureChanged(lastData, next)) {
      lastData = mergePositions(lastData, next);
      rawData = lastData;
      Graph.graphData(lastData);
      Graph.d3ReheatSimulation?.(); // tiny nudge only when structure changes
    } else {
      // in-place metadata update; keep positions & sim
      lastData.nodes.forEach(n => {
        const updated = next.nodes.find(x => x.id === n.id);
        if (updated) n.data = updated.data;
      });
      rawData = lastData;
      Graph.graphData(lastData);
    }

    const ts = (data.generated_at ?? (Date.now()/1000))*1000;
    statusEl.textContent = `updated ${new Date(ts).toLocaleTimeString()}`;
    backoffMs = 2000; // reset backoff on success
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'backend not reachable';
    overlayEl.classList.remove('hidden');
    overlayEl.textContent = 'Reconnecting…';

    // backoff tick (only if auto-refresh is on)
    clearInterval(timer);
    if (autoEl.checked) {
      setTimeout(() => { timer = setInterval(refresh, 2000); }, backoffMs);
    }
    backoffMs = Math.min(MAX_BACKOFF, Math.round(backoffMs * 1.6));
  }
}

// ---------- UI wiring ----------
autoEl.addEventListener('change', ()=>{
  if (autoEl.checked){
    clearInterval(timer);
    timer = setInterval(refresh, 2000);
    toast('Auto-refresh on');
  } else {
    clearInterval(timer);
    timer = null;
    toast('Auto-refresh off');
  }
});
searchEl.addEventListener('input', ()=> applyFilter(searchEl.value.trim()));
btnCenter.addEventListener('click', ()=> Graph.zoomToFit(800, 80, n => true));
btnTheme.addEventListener('click', ()=>{
  const root = document.documentElement;
  const isLight = root.classList.toggle('light');
  Graph.backgroundColor(isLight ? '#f4f6fb' : '#0b0d12');
});
btnClear.addEventListener('click', ()=> { detailsEl.textContent=''; if (lastSel) clearHighlight(); });
// ---- Camera persistence ----
const CAM_KEY = 'SYSMAP_CAM_V1';

function getCam(){
  const cam = Graph.camera();
  const ctrl = Graph.controls();
  const pos = cam?.position || {x:0,y:0,z:0};
  const tgt = ctrl?.target || {x:0,y:0,z:0};
  return { position:{x:pos.x,y:pos.y,z:pos.z}, target:{x:tgt.x,y:tgt.y,z:tgt.z} };
}
function setCam(snap, ms=0){
  if (!snap) return;
  const {position, target} = snap;
  const ctrl = Graph.controls();
  if (ctrl && target){ ctrl.target.set(target.x, target.y, target.z); ctrl.update(); }
  if (position){ Graph.cameraPosition({x:position.x,y:position.y,z:position.z}, target || undefined, ms); }
}
function saveCam(){ try{ localStorage.setItem(CAM_KEY, JSON.stringify(getCam())); }catch{} }
function loadCam(){ try{ return JSON.parse(localStorage.getItem(CAM_KEY) || 'null'); }catch{ return null } }

// Debounce save on orbit changes
let camDeb;
const controls = Graph.controls();
if (controls){
  controls.addEventListener('change', () => {
    clearTimeout(camDeb);
    camDeb = setTimeout(saveCam, 300);
  });
}

// ---------- boot ----------
(async () => {
  statusEl.textContent = 'probing backend…';
  const base = await resolveApiBase();
  if(!base){
    statusEl.textContent = 'backend not reachable';
    overlayEl.classList.remove('hidden');
    overlayEl.textContent = 'Backend not reachable';
    return;
  }
  statusEl.textContent = `connected to ${localStorage.getItem('SYSMAP_API_BASE') || base}`;

  await refresh();
const cam = loadCam();
if (cam) setCam(cam, 0);

if (autoEl.checked) timer = setInterval(refresh, 2000);
})();
