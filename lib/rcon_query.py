#!/usr/bin/env python3
"""Minimal RCON client: sends /list and prints the online player count."""
import socket, struct, sys, re

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
            pid  = struct.unpack('<i', data[0:4])[0]
            body = data[8:-2].decode('utf-8', errors='replace')
            return pid, body

        send(1, 3, password)          # login
        pid, _ = recv()
        if pid == -1:
            print("AUTH_FAIL", file=sys.stderr)
            sys.exit(1)

        send(2, 2, cmd)               # command
        _, resp = recv()
        return resp

port     = int(sys.argv[1])
password = sys.argv[2]
resp     = rcon_exec('127.0.0.1', port, password, 'list')
# "There are X of a max of Y players online: ..."
m = re.search(r'There are (\d+)', resp)
print(m.group(1) if m else '0')
