"""Range 요청을 지원하는 로컬 정적 서버.

PMTiles 는 HTTP Range 로 타일 조각만 읽어 온다. Python 기본 http.server 는
Range 를 무시하고 200 전체를 돌려주므로 PMTiles 가 동작하지 않는다.
GitHub Pages 는 Range 를 지원하므로 배포 환경과 맞추기 위한 개발용 서버다.

사용: python3 tools/serve.py [포트] [디렉토리]
"""
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if not m:
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404)
            return None
        size = os.fstat(f.fileno()).st_size
        s, e = m.group(1), m.group(2)
        if s == "":                      # bytes=-N  (마지막 N바이트)
            length = min(int(e or 0), size)
            start, end = size - length, size - 1
        else:
            start = int(s)
            end = min(int(e), size - 1) if e else size - 1
        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        f.seek(start)
        return _Slice(f, end - start + 1)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *a):
        sys.stderr.write("%s\n" % (fmt % a))


class _Slice:
    """copyfile 이 읽어갈 만큼만 내보내는 래퍼."""
    def __init__(self, f, n):
        self.f, self.left = f, n

    def read(self, n=-1):
        if self.left <= 0:
            return b""
        n = self.left if n < 0 else min(n, self.left)
        b = self.f.read(n)
        self.left -= len(b)
        return b

    def close(self):
        self.f.close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    root = sys.argv[2] if len(sys.argv) > 2 else "web"
    h = partial(RangeHandler, directory=root)
    print(f"http://127.0.0.1:{port}  (root={root}, Range 지원)")
    ThreadingHTTPServer(("127.0.0.1", port), h).serve_forever()
