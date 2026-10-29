import hashlib, urllib.request, urllib.error
base = "http://127.0.0.1:18080"
body = bytes(range(256)) * 4096
from pathlib import Path
p = Path("/srv/bweeep-updates/releases/benchmark/probe.bin")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_bytes(body)
try:
    req = urllib.request.Request(base + "/releases/benchmark/probe.bin", headers={"Range": "bytes=4096-8191"})
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.status == 206
        assert r.headers["Content-Range"] == "bytes 4096-8191/1048576"
        assert r.read() == body[4096:8192]
    for suffix in ["/", "/releases/", "/etc/passwd", "/releases/benchmark/missing.bin"]:
        try:
            urllib.request.urlopen(base + suffix, timeout=10)
            raise AssertionError("Unexpected success: " + suffix)
        except urllib.error.HTTPError as e:
            assert e.code in (403,404), (suffix,e.code)
    print("RANGE_AND_PATH_TESTS_PASS", hashlib.sha256(body).hexdigest())
finally:
    p.unlink(missing_ok=True)
    p.parent.rmdir()
