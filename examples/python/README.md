# Python ZeroMQ labs

Use these configurations to generate and run four projects on `127.0.0.1`. Run each command block from the repository root. Complete the repository setup, put Python 3.15.2 on `PATH`, and run `mkdir -p out` once. Use a new output directory for each generation. [Repository setup](../../README.md#how-to-install)

`READY` confirms that an application opened its local sockets. For a test with checks on the received data, stop the launcher and run `.venv/bin/python tests/integration_test.py` from the generated project. Exit code `0` means the test passed.

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

## PUB/SUB with CBOR and Last Value Caching

Replay the last reading on a topic to a late subscriber. Espresso logs publication and replay frames. The proxy receives publications on port `5558` and serves subscribers on `5559`. [Configuration](pub-sub-cache-cbor.json)

```sh
node apps/cli/index.cjs examples/python/pub-sub-cache-cbor.json out/pub-sub-cache-cbor
cd out/pub-sub-cache-cbor
./build.sh
./run.sh
```

The generated subscriber logs `MESSAGE_RECEIVED` with a topic such as `demo/a` and the payload `{"deviceId":"sensor-01","samples":"00ff"}`. The proxy logs `CAPTURE` with direction `publication` and two frames in hex, one for the topic and one for the CBOR event.

Keep the launcher running. In a second terminal, open the generated project and run this check. It sends one event on a separate topic. A first subscriber confirms delivery before the late subscriber connects.

```sh
.venv/bin/python - <<'PY'
import cbor2
import zmq

topic = b"lab/temperature"
event = {
    "id": "reading-01",
    "type": "event",
    "payload": {"deviceId": "sensor-01", "samples": b"\x00\xff"},
}
frames = [topic, cbor2.dumps(event)]

with zmq.Context() as context:
    with context.socket(zmq.XPUB) as publisher, context.socket(zmq.SUB) as first:
        publisher.connect("tcp://127.0.0.1:5558")
        first.subscribe(topic)
        first.connect("tcp://127.0.0.1:5559")
        assert publisher.poll(5000), "Proxy did not subscribe"
        assert publisher.recv() == b"\x01"
        publisher.send_multipart(frames)
        assert first.poll(5000), "First subscriber did not receive the event"
        assert first.recv_multipart() == frames

    with context.socket(zmq.SUB) as late:
        late.subscribe(topic)
        late.connect("tcp://127.0.0.1:5559")
        assert late.poll(5000), "Late subscriber did not receive the replay"
        replay = late.recv_multipart()
        assert replay == frames
        print(replay[0].decode(), cbor2.loads(replay[1])["payload"])
        print([frame.hex() for frame in replay])
PY
```

The late subscriber prints `lab/temperature {'deviceId': 'sensor-01', 'samples': b'\x00\xff'}`. Its frame hex matches the proxy's `CAPTURE` record with direction `replay`. Press Ctrl+C in the launcher terminal to stop the lab.

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
