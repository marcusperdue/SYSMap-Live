from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import os, time, socket, platform
import psutil

app = FastAPI(title="SysMap Live 3D")

# CORS for frontend dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=True
)

@app.get("/api/health")
def health():
    return {"ok": True, "host": socket.gethostname(), "os": platform.platform()}

def hardware_nodes():
    cpu_count = psutil.cpu_count(logical=True) or 1
    vm = psutil.virtual_memory()

    # load averages (macOS/Linux)
    load1 = load5 = load15 = 0.0
    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        pass

    freq = getattr(psutil, "cpu_freq", lambda: None)()
    freq_mhz = getattr(freq, "current", None)

    nodes = [
        {"id": "host", "label": socket.gethostname(), "type": "host",
         "os": platform.platform(), "boot_time": psutil.boot_time()},
        {"id": "cpu", "label": f"CPU x{cpu_count}", "type": "cpu",
         "cores": cpu_count, "usage_percent": psutil.cpu_percent(interval=0.0),
         "load_1": load1, "load_5": load5, "load_15": load15,
         "freq_mhz": freq_mhz},
        {"id": "ram", "label": f"RAM {vm.total/1e9:.1f} GB", "type": "ram",
         "total": vm.total, "used": vm.used, "available": vm.available,
         "percent": vm.percent},
    ]

    for p in psutil.disk_partitions(all=False):
        try:
            du = psutil.disk_usage(p.mountpoint)
            nodes.append({
                "id": f"disk:{p.mountpoint}",
                "label": f"{p.mountpoint} ({p.fstype})",
                "type": "disk",
                "fstype": p.fstype,
                "total": du.total,
                "used": du.used,
                "percent": du.percent
            })
        except PermissionError:
            pass
    return nodes

def process_nodes_edges():
    nodes, edges = [], []
    seen = set()
    for proc in psutil.process_iter(attrs=["pid","ppid","name","username","memory_info","cpu_percent"]):
        info = proc.info
        pid = info["pid"]
        seen.add(pid)
        rss = getattr(info.get("memory_info"), "rss", 0) or 0
        nodes.append({
            "id": f"pid:{pid}",
            "label": f"{info.get('name','?')} ({pid})",
            "type": "process",
            "cpu": float(info.get("cpu_percent") or 0.0),
            "mem_mb": round(rss/1e6, 1),
            "user": info.get("username") or "?"
        })
    for n in nodes:
        try:
            pid = int(n["id"].split(":")[1])
            ppid = psutil.Process(pid).ppid()
            if ppid and ppid in seen:
                edges.append({"source": f"pid:{ppid}", "target": f"pid:{pid}", "kind": "parent"})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    for n in nodes:
        edges.append({"source": "cpu", "target": n["id"], "kind": "runs"})
    return nodes, edges

def net_nodes_edges():
    nodes, edges, ips = [], [], set()
    try:
        for c in psutil.net_connections(kind="inet"):
            if not c.raddr:
                continue
            rip = c.raddr.ip
            if rip not in ips:
                nodes.append({"id": f"ip:{rip}", "label": rip, "type": "remote"})
                ips.add(rip)
            if c.pid:
                edges.append({"source": f"pid:{c.pid}", "target": f"ip:{rip}", "kind": "net"})
            else:
                edges.append({"source": "host", "target": f"ip:{rip}", "kind": "net"})
    except Exception:
        pass
    return nodes, edges

def disk_edges():
    edges = [
        {"source": "host", "target": "cpu", "kind": "owns"},
        {"source": "host", "target": "ram", "kind": "owns"},
    ]
    for p in psutil.disk_partitions(all=False):
        edges.append({"source": "host", "target": f"disk:{p.mountpoint}", "kind": "mount"})
    return edges

@app.get("/api/topology")
def topology():
    hw = hardware_nodes()
    procs, p_edges = process_nodes_edges()
    net_n, net_e = net_nodes_edges()
    nodes = hw + procs + net_n
    edges = p_edges + net_e + disk_edges()
    return JSONResponse({
        "generated_at": int(time.time()),
        "nodes": [{"data": n} for n in nodes],
        "edges": [{"data": e} for e in edges]
    })

@app.get("/api/process/{pid}")
def process_details(pid: int):
    try:
        p = psutil.Process(pid)
        with p.oneshot():
            mi = p.memory_info()._asdict() if p.is_running() else {}
            return {
                "pid": p.pid, "ppid": p.ppid(), "name": p.name(),
                "exe": p.exe() if p.is_running() else "",
                "cmdline": p.cmdline(), "username": p.username(),
                "cpu_percent": p.cpu_percent(interval=0.0),
                "memory_info": mi, "cwd": p.cwd() if p.is_running() else "",
                "create_time": p.create_time()
            }
    except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
        raise HTTPException(404, str(e))
