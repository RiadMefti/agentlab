/** Fixed Linux-only transport adapter. No policy, storage, credentials, or caller code executes here. */
export const linuxLedgerPeerHelper = String.raw`
import json, os, select, signal, socket, stat, struct, sys, time

config = json.loads(sys.argv[2])
limit = config["maximumBytes"]
duration = config["timeoutMs"] / 1000

def transfer(fd, data, count, deadline):
    result = bytearray()
    offset = 0
    while offset < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("deadline")
        readable, writable, _ = select.select([fd] if data is None else [], [fd] if data is not None else [], [], remaining)
        if not readable and not writable:
            raise TimeoutError("deadline")
        try:
            if data is None:
                chunk = os.read(fd, min(4096, count - offset))
                if not chunk:
                    raise EOFError("closed")
                result.extend(chunk)
                offset += len(chunk)
            else:
                offset += os.write(fd, data[offset:offset + 4096])
        except BlockingIOError:
            continue
    return bytes(result)

def read(fd, count, deadline):
    return transfer(fd, None, count, deadline)

def write(fd, data, deadline):
    transfer(fd, data, len(data), deadline)

def frame(fd, deadline):
    length = struct.unpack("!I", read(fd, 4, deadline))[0]
    if length < 1 or length > limit:
        raise ValueError("frame size")
    return read(fd, length, deadline)

def credentials(connection):
    # Linux ucred contains signed pid_t followed by unsigned uid_t and gid_t.
    return struct.unpack("iII", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII")))

def stop(signum, stack):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
os.set_blocking(0, False)
os.set_blocking(1, False)

def serve():
    path = config["socketPath"]
    parent = os.path.dirname(path)
    metadata = os.lstat(parent)
    if os.path.realpath(parent) != parent or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise ValueError("socket directory")
    allowed = set(config["allowedUids"])
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    owned = None
    try:
        os.umask(0o177)
        listener.bind(path) # Never replace an existing socket, including after an unclean stop.
        owned = os.lstat(path)
        os.chmod(path, 0o666) # Peers are authorized by kernel UID, never filesystem group alone.
        listener.listen(8)
        write(1, bytes(20), time.monotonic() + duration)
        sequence = 0
        while True:
            connection, _ = listener.accept()
            with connection:
                pid, uid, gid = credentials(connection)
                if uid not in allowed or pid <= 0:
                    continue
                connection.setblocking(False)
                deadline = time.monotonic() + duration
                try:
                    body = frame(connection.fileno(), deadline)
                except (OSError, EOFError, ValueError, TimeoutError):
                    continue
                sequence += 1
                if sequence > 0xffffffff:
                    raise RuntimeError("sequence exhausted")
                write(1, struct.pack("!IIIII", sequence, pid, uid, gid, len(body)) + body, deadline)
                # Parent failure is fatal: never associate a late response with another request.
                response_sequence, length = struct.unpack("!II", read(0, 8, deadline))
                if response_sequence != sequence or length < 1 or length > limit:
                    raise ValueError("response frame")
                response = read(0, length, deadline)
                try:
                    write(connection.fileno(), struct.pack("!I", length) + response, deadline)
                except (OSError, EOFError, TimeoutError):
                    pass # The application commit may have succeeded; callers must reconcile.
    finally:
        listener.close()
        if owned is not None:
            try:
                current = os.lstat(path)
                if current.st_ino == owned.st_ino and current.st_dev == owned.st_dev:
                    os.unlink(path)
            except FileNotFoundError:
                pass

def request():
    deadline = time.monotonic() + duration
    body = frame(0, deadline)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        connection.connect(config["socketPath"])
        pid, uid, gid = credentials(connection)
        if pid <= 0 or uid != config["serverUid"]:
            raise PermissionError("server identity")
        connection.setblocking(False)
        write(connection.fileno(), struct.pack("!I", len(body)) + body, deadline)
        response = frame(connection.fileno(), deadline)
        write(1, response, deadline)

try:
    if sys.argv[1] == "serve":
        serve()
    elif sys.argv[1] == "request":
        request()
    else:
        raise ValueError("mode")
except Exception:
    # Do not reflect request bytes, paths, or application exception text into diagnostics.
    sys.stderr.write("ledger peer transport failed\n")
    sys.exit(1)
`;
