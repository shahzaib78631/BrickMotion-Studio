"""Loopback-only upload/build/review service; one solver job at a time."""
from concurrent.futures import ThreadPoolExecutor
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import urlsplit
import uuid

from .build import ROOT, run, save_json

JOBS=ROOT/".cache/studio-builder/jobs"


def serve(port=8791):
    jobs={}
    lock=threading.Lock()
    executor=ThreadPoolExecutor(max_workers=1)
    JOBS.mkdir(parents=True,exist_ok=True)

    def launch(job,options,corrected=None):
        def log(event):
            with lock:
                job["progress"]=event
        def work():
            with lock:
                job.update(status="running",error=None,report=None)
            try:
                report=run(job["inputs"],JOBS/job["id"],observations=corrected,
                           limit=options.get("limit",256),selected=options.get("parts") or None,
                           log=log)
                with lock:
                    job.update(status="done",report=report)
            except Exception as error:
                with lock:
                    job.update(status="error",error=f"{type(error).__name__}: {error}")
        executor.submit(work)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass

        def respond(self,data,status=200):
            body=json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def local(self):
            expected={f"127.0.0.1:{port}",f"localhost:{port}"}
            if self.headers.get("Host") not in expected:
                self.respond({"error":"Local requests only"},403)
                return False
            origin=self.headers.get("Origin")
            if origin and urlsplit(origin).netloc not in expected:
                self.respond({"error":"Cross-origin requests are not accepted"},403)
                return False
            return True

        def do_GET(self):
            if not self.local():
                return
            route=urlsplit(self.path).path
            if route=="/":
                self.file(Path(__file__).with_name("index.html"))
            elif route.startswith("/api/jobs/"):
                ident=route.split("/")[-1]
                with lock:
                    job=jobs.get(ident)
                    data={k:v for k,v in job.items() if k!="inputs"} if job else None
                if data is None:
                    return self.respond({"error":"Build not found"},404)
                observations=JOBS/ident/"observations.json"
                if observations.exists() and data["status"] in ("done","error"):
                    data["observations"]=json.loads(observations.read_text())
                self.respond(data)
            elif route.startswith("/files/"):
                relative=route.removeprefix("/files/")
                target=(JOBS/relative).resolve()
                if not target.is_relative_to(JOBS.resolve()) or target.suffix not in (".png",".mpd",".json",".html"):
                    return self.respond({"error":"File not available"},404)
                self.file(target)
            else:
                self.respond({"error":"Not found"},404)

        def file(self,path):
            if not path.is_file():
                return self.respond({"error":"File not available"},404)
            body=path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type",mimetypes.guess_type(path)[0] or "application/octet-stream")
            self.send_header("X-Content-Type-Options","nosniff")
            self.send_header("Content-Length",str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not self.local():
                return
            try:
                size=int(self.headers.get("Content-Length","0"))
                if not 0<size<=128*1024*1024:
                    return self.respond({"error":"Upload must be smaller than 128 MB"},413)
                data=json.loads(self.rfile.read(size))
                route=urlsplit(self.path).path
                options=data.get("options",{})
                limit=options.get("limit",256)
                if type(limit) is not int or not 0<=limit<=40000:
                    raise ValueError("Invalid catalogue size")
                if options.get("parts") and (not isinstance(options["parts"],list) or len(options["parts"])>2000):
                    raise ValueError("Invalid candidate parts list")
                if route=="/api/jobs":
                    files=data.get("files",[])
                    if not 1<=len(files)<=200:
                        raise ValueError("Choose 1–200 PDF or image files")
                    ident=uuid.uuid4().hex
                    folder=JOBS/ident
                    folder.mkdir()
                    inputs=[]
                    for i,file in enumerate(files):
                        name=Path(file["name"]).name
                        if Path(name).suffix.lower() not in (".pdf",".png",".jpg",".jpeg",".webp"):
                            raise ValueError("Supported inputs: PDF, PNG, JPEG, WebP")
                        path=folder/f"input-{i+1:04d}{Path(name).suffix.lower()}"
                        path.write_bytes(base64.b64decode(file["data"],validate=True))
                        inputs.append(path)
                    job={"id":ident,"status":"queued","progress":{"stage":"queued"},"inputs":inputs,"options":options}
                    with lock:
                        jobs[ident]=job
                    launch(job,options)
                    self.respond({"id":ident},202)
                elif route.startswith("/api/rebuild/"):
                    ident=route.split("/")[-1]
                    if not isinstance(data.get("observations"),dict):
                        raise ValueError("Supply the corrected observations object")
                    with lock:
                        job=jobs.get(ident)
                        if not job or job["status"] not in ("done","error"):
                            raise ValueError("Wait for this build to finish before rebuilding")
                    path=JOBS/ident/"corrections.json"
                    save_json(path,data["observations"])
                    with lock:
                        job["status"]="queued"
                    launch(job,job["options"],path)
                    self.respond({"id":ident},202)
                else:
                    self.respond({"error":"Not found"},404)
            except (ValueError,KeyError,TypeError) as error:
                self.respond({"error":str(error)},400)
            except Exception as error:
                self.respond({"error":f"{type(error).__name__}: {error}"},500)

    server=ThreadingHTTPServer(("127.0.0.1",port),Handler)
    print(f"Studio model builder: http://127.0.0.1:{port}",flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        executor.shutdown(wait=True)
