# Python ZeroMQ labs

Generate and run Python projects on `127.0.0.1`. Run each generation block from the repository root. Complete the repository setup, put Python 3.15.2 on `PATH`, and run `mkdir -p out` once. Use a new output directory for each generation. [Repository setup](../../README.md#how-to-install)

`READY` confirms that an application opened its local sockets. Before you change generated code, run `.venv/bin/python tests/integration_test.py` from the generated project. Exit code `0` means the test passed.

## REQ/REP with a request handler

Convert Celsius to Fahrenheit. REP binds to port `5568`. [Configuration](req-rep-handler-json.json)

```sh
node apps/cli/index.cjs examples/python/req-rep-handler-json.json out/req-rep-handler-json
cd out/req-rep-handler-json
./build.sh
```

In `app_rep.py`, add `import math` with the imports and this function before `behavior`.

```python
def convert_temperature(celsius):
    if type(celsius) in (int, float):
        fahrenheit = celsius * 1.8 + 32
        if math.isfinite(fahrenheit):
            return "response", {"fahrenheit": fahrenheit}
    return "error", {"code": "INVALID_TEMPERATURE"}
```

In `case "build-response"`, replace the `values["reply"]` assignment with these lines.

```python
request = values["request"]
reply_type, payload = convert_temperature(request["payload"])
values["reply"] = {"id": request["id"], "type": reply_type, "payload": payload}
```

Start REP with `.venv/bin/python app_rep.py`. Wait for `READY`. In a second terminal, run this client from the generated project.

```sh
.venv/bin/python - <<'PY'
import zmq

cases = [
    (25, "response", {"fahrenheit": 77}),
    ("25", "error", {"code": "INVALID_TEMPERATURE"}),
    (0, "response", {"fahrenheit": 32}),
]
with zmq.Context() as context, context.socket(zmq.REQ) as client:
    client.linger = 0
    client.sndtimeo = client.rcvtimeo = 2000
    client.connect("tcp://127.0.0.1:5568")
    for index, (celsius, reply_type, payload) in enumerate(cases, start=1):
        request_id = f"temperature-{index}"
        client.send_json({"id": request_id, "type": "request", "payload": celsius})
        reply = client.recv_json()
        assert reply == {"id": request_id, "type": reply_type, "payload": payload}, reply
        print(reply)
PY
```

The client checks the conversion, the error for a string, and the next valid reply. Press Ctrl+C to stop REP.

## REQ/REP with CBOR

Send a sensor reading with a binary field and receive it back. REP binds to port `5556`. [Configuration](req-rep-cbor.json)

```sh
node apps/cli/index.cjs examples/python/req-rep-cbor.json out/req-rep-cbor
cd out/req-rep-cbor
./build.sh
./run.sh
```

REQ sends `{'deviceId': 'sensor-01', 'samples': b'\x00\xff'}` in one CBOR frame. REP decodes `samples` as Python `bytes` and sends the payload back with the same request ID. The JSON log displays the bytes in hex. The launcher exits after the reply.

```json
{"event":"RESPONSE_RECEIVED","id":"msg-0001","type":"response","payload":{"deviceId":"sensor-01","samples":"00ff"}}
```

## REQ/REP timeouts

Compare send and receive timeouts when REP is offline. REP binds to port `5571`. [Configuration](req-rep-timeout-json.json)

```sh
node apps/cli/index.cjs examples/python/req-rep-timeout-json.json out/req-rep-timeout-json
cd out/req-rep-timeout-json
./build.sh
```

With REP stopped, run REQ with `immediate` enabled in the generated configuration, then disabled in a copy.

```sh
.venv/bin/python app_req.py || printf 'Exit %s\n' "$?"
.venv/bin/python - <<'PY'
import json
from pathlib import Path

config = json.loads(Path("config/zmq.json").read_text(encoding="utf-8"))
config["socketOptions"]["immediate"] = False
Path("config/queued.json").write_text(json.dumps(config), encoding="utf-8")
PY
.venv/bin/python app_req.py --config config/queued.json || printf 'Exit %s\n' "$?"
```

With `immediate` enabled, REQ waits for a connection before it can queue the request and logs `SEND_TIMEOUT`. With it disabled, REQ queues the request and logs `RECEIVE_TIMEOUT` while waiting for a reply. Both runs exit with code `1` after about 500 ms.

Run `./run.sh` to start REP and retry with a new REQ process. Look for `RESPONSE_RECEIVED` and exit code `0`.

## PUSH/PULL with JSON

Send tasks to a worker. PULL binds to port `5557`. [Configuration](push-pull-json.json)

```sh
node apps/cli/index.cjs examples/python/push-pull-json.json out/push-pull-json
cd out/push-pull-json
./build.sh
./run.sh
```

PUSH sends each task in one JSON frame. PULL decodes the payload and logs `TASK_PROCESSED` for each task. Press Ctrl+C to stop both applications.

```json
{"event":"TASK_PROCESSED","id":"msg-0001","type":"task","payload":{"value":42},"result":"processed"}
```

## PUSH/PULL with two workers

Distribute 20 tasks between two PULL processes. PUSH binds to port `5569`. [Configuration](push-pull-workers-json.json)

```sh
node apps/cli/index.cjs examples/python/push-pull-workers-json.json out/push-pull-workers-json
cd out/push-pull-workers-json
./build.sh
```

From the generated project, run `.venv/bin/python app_pull.py` in two terminals. Wait for `READY` in both. In a third terminal, run this producer from the same directory. It waits for both ZeroMQ handshakes before sending tasks.

```sh
.venv/bin/python - <<'PY'
import zmq
from zmq.utils.monitor import recv_monitor_message

with zmq.Context() as context, context.socket(zmq.PUSH) as producer:
    producer.linger = 1000
    producer.sndtimeo = 2000
    with producer.get_monitor_socket(events=zmq.EVENT_HANDSHAKE_SUCCEEDED) as monitor:
        producer.bind("tcp://127.0.0.1:5569")
        for _ in range(2):
            assert monitor.poll(5000), "A worker did not connect"
            recv_monitor_message(monitor)
        for number in range(1, 21):
            producer.send_json({
                "id": f"task-{number:02d}",
                "type": "task",
                "payload": {"value": number},
            })
PY
```

Both workers log `TASK_PROCESSED`. Check that each ID from `task-01` to `task-20` appears once across the two logs. Press Ctrl+C to stop both workers.

## PUB/SUB with JSON

Send each live event to several subscribers. PUB binds to port `5570`. [Configuration](pub-sub-json.json)

```sh
node apps/cli/index.cjs examples/python/pub-sub-json.json out/pub-sub-json
cd out/pub-sub-json
./build.sh
./run.sh
```

In a second terminal, open the generated project and run `.venv/bin/python app_sub.py`. Find a common `MESSAGE_RECEIVED` ID in the two logs. Then run the same subscriber command in a third terminal.

Find a later ID in all three logs. The early ID is absent from the third log. Press Ctrl+C in each terminal to stop the lab.

## PUB/SUB with CBOR and Last Value Caching

Replay the last reading on a topic to a late subscriber. Espresso logs publication and replay frames. The proxy receives publications on port `5558` and serves subscribers on `5559`. [Configuration](pub-sub-cache-cbor.json)

```sh
node apps/cli/index.cjs examples/python/pub-sub-cache-cbor.json out/pub-sub-cache-cbor
cd out/pub-sub-cache-cbor
./build.sh
./run.sh
```

The generated subscriber logs `MESSAGE_RECEIVED` with a topic such as `demo/a` and the payload `{"deviceId":"sensor-01","samples":"00ff"}`. The proxy logs `CAPTURE` with direction `publication` and two frames in hex, one for the topic and one for the CBOR event.

Keep the launcher running. In a second terminal, open the generated project and run this check. It sends two readings on one topic. The first subscriber checks both readings before the late subscriber connects.

```sh
.venv/bin/python - <<'PY'
from time import monotonic
from uuid import uuid4

import cbor2
import zmq


topic = f"lab/temperature/{uuid4().hex}".encode()
with zmq.Context() as context:
    with context.socket(zmq.XPUB) as publisher, context.socket(zmq.SUB) as first:
        publisher.linger = 0
        publisher.sndtimeo = 2000
        first.subscribe(topic)
        first.connect("tcp://127.0.0.1:5559")
        publisher.connect("tcp://127.0.0.1:5558")
        assert publisher.poll(5000), "Proxy did not subscribe"
        assert publisher.recv() == b"\x01"
        for reading_id, samples in (("reading-01", b"\x01\x02"), ("reading-02", b"\x00\xff")):
            event = {
                "id": reading_id,
                "type": "event",
                "payload": {"deviceId": "sensor-01", "samples": samples},
            }
            frames = [topic, cbor2.dumps(event)]
            publisher.send_multipart(frames)
            deadline = monotonic() + 5
            while monotonic() < deadline:
                if first.poll(100):
                    if first.recv_multipart() == frames:
                        break
                elif reading_id == "reading-01":
                    # Repeat until the first subscription reaches the proxy.
                    publisher.send_multipart(frames)
            else:
                raise TimeoutError(f"First subscriber did not receive {reading_id}")

    with context.socket(zmq.SUB) as late:
        late.subscribe(topic)
        late.connect("tcp://127.0.0.1:5559")
        assert late.poll(5000), "Late subscriber did not receive the replay"
        replay = late.recv_multipart()
        assert replay == frames
        event = cbor2.loads(replay[1])
        print(event["id"], event["payload"])
        print([frame.hex() for frame in replay])
PY
```

The late subscriber prints `reading-02 {'deviceId': 'sensor-01', 'samples': b'\x00\xff'}`. Its frame hex matches the proxy's `CAPTURE` record with direction `replay`. Press Ctrl+C in the launcher terminal to stop the lab.

## Clone with Binary Star

Read a stored value after the primary server stops. The primary uses ports `5560–5563`, the backup uses `5564–5567`, and the client reads keys under `/telemetry/`. Clone uses 12/CHP. [Configuration](clone-binary-star.json)

```sh
node apps/cli/index.cjs examples/python/clone-binary-star.json out/clone-binary-star
cd out/clone-binary-star
./build.sh
bash -c 'printf "Launcher PID %s\n" "$$"; exec ./run.sh'
```

Wait for `REPLICA_SYNCED` from the backup. The client writes `b"42"` under `/telemetry/demo`. A `CLONE_UPDATE` for that key or `CLONE_WRITE_CONFIRMED` confirms that the client received the value.

In a second terminal, run `ps -Ao pid,ppid,args`. Find `app_server.py` with a PPID equal to the printed launcher PID. Run `kill -TERM PID` with the server's PID. The backup and client continue running. Look for the following events. The row count and sequence depend on the run.

```json
{"event":"BINARY_STAR_STATE","role":"backup","state":"active"}
{"event":"CLONE_SNAPSHOT","server":1,"size":1,"sequence":"1"}
```

With the backup still running, run this check from the generated project in the second terminal. It reads the value from the backup's snapshot port.

```sh
.venv/bin/python - <<'PY'
import zmq

prefix = b"/telemetry/"
with zmq.Context() as context, context.socket(zmq.DEALER) as client:
    client.connect("tcp://127.0.0.1:5564")
    client.send_multipart([b"ICANHAZ?", prefix])
    rows = {}
    while True:
        assert client.poll(5000), "Backup did not finish the snapshot"
        key, sequence, uuid, properties, value = client.recv_multipart()
        if key == b"KTHXBAI":
            assert value == prefix
            break
        rows[key] = value
    key = b"/telemetry/demo"
    assert rows[key] == b"42"
    print(key.decode(), repr(rows[key]))
PY
```

The check prints `/telemetry/demo b'42'`. Press Ctrl+C in the launcher terminal to stop the backup and client.
