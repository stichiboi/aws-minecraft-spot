#!/usr/bin/env python3
"""Collects server diagnostics (RCON, logs, RAM, disk) and prints JSON to stdout."""
import json, os, re, socket, struct, subprocess, sys

SERVER_DIR = "/opt/minecraft/data/server"
PROPS_FILE = os.path.join(SERVER_DIR, "server.properties")
DATA_MOUNT = "/opt/minecraft/data"


def rcon_exec(host, port, password, cmd):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect((host, port))

        def send(pid, ptype, body):
            payload = body.encode() + b'\x00'
            data = struct.pack('<iii', 4 + 4 + len(payload) + 1, pid, ptype) + payload + b'\x00'
            s.sendall(data)

        def recv():
            raw = b''
            while len(raw) < 4:
                chunk = s.recv(4 - len(raw))
                if not chunk:
                    raise OSError("connection closed")
                raw += chunk
            length = struct.unpack('<i', raw)[0]
            data = b''
            while len(data) < length:
                chunk = s.recv(length - len(data))
                if not chunk:
                    raise OSError("connection closed")
                data += chunk
            pid = struct.unpack('<i', data[0:4])[0]
            body = data[8:-2].decode('utf-8', errors='replace')
            return pid, body

        send(1, 3, password)
        pid, _ = recv()
        if pid == -1:
            raise RuntimeError("RCON auth failed")

        send(2, 2, cmd)
        _, resp = recv()
        return resp


def get_prop(key):
    try:
        with open(PROPS_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{key}="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return None


def collect_rcon():
    """Run /list via RCON; return dict with online, max, players or error."""
    if get_prop("enable-rcon") != "true":
        return {"error": "rcon disabled"}

    port = int(get_prop("rcon.port") or "25575")
    password = get_prop("rcon.password") or ""
    if not password:
        return {"error": "rcon.password not set"}

    try:
        resp = rcon_exec("127.0.0.1", port, password, "list")
    except Exception as e:
        return {"error": str(e)}

    # "There are X of a max of Y players online: p1, p2"
    m = re.search(r'There are (\d+) of a max of (\d+) players online:\s*(.*)', resp)
    if m:
        online = int(m.group(1))
        max_players = int(m.group(2))
        names = [n.strip() for n in m.group(3).split(",") if n.strip()] if online > 0 else []
        return {"online": online, "max": max_players, "players": names}

    # Fallback: at least grab the count
    m2 = re.search(r'There are (\d+)', resp)
    return {"online": int(m2.group(1)) if m2 else 0, "max": 0, "players": [], "raw": resp}


LOG_PATTERN = re.compile(r'\b(WARN|ERROR|FATAL|Exception)\b', re.IGNORECASE)

def collect_logs():
    """Return last 10 warning/error lines from minecraft.service journal."""
    try:
        out = subprocess.check_output(
            ["journalctl", "-u", "minecraft.service", "--no-pager", "-n", "500", "--output", "cat"],
            text=True, timeout=5, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        return {"error": str(e)}

    filtered = [line for line in out.splitlines() if LOG_PATTERN.search(line)]
    return {"lines": filtered[-10:]}


def collect_ram():
    """Return RAM usage in GB."""
    try:
        out = subprocess.check_output(["free", "-m"], text=True, timeout=5)
        for line in out.splitlines():
            if line.startswith("Mem:"):
                parts = line.split()
                total_gb = round(int(parts[1]) / 1024, 2)
                used_gb = round(int(parts[2]) / 1024, 2)
                return {"used_gb": used_gb, "total_gb": total_gb}
        return {"error": "could not parse free output"}
    except Exception as e:
        return {"error": str(e)}


def collect_disk():
    """Return disk usage of the data volume in GB."""
    try:
        if not os.path.ismount(DATA_MOUNT):
            return {"error": "data volume not mounted"}
        out = subprocess.check_output(
            ["df", "-BM", "--output=used,size", DATA_MOUNT],
            text=True, timeout=5,
        )
        line = out.strip().splitlines()[-1]
        parts = line.replace("M", "").split()
        used_gb = round(int(parts[0]) / 1024, 2)
        total_gb = round(int(parts[1]) / 1024, 2)
        return {"used_gb": used_gb, "total_gb": total_gb}
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    result = {
        "rcon": collect_rcon(),
        "logs": collect_logs(),
        "ram": collect_ram(),
        "disk": collect_disk(),
    }
    json.dump(result, sys.stdout, separators=(",", ":"))
