// Keeps this screen's copy of the shared lineup, and of the spoilers (pictures, taglines) hidden from it, in step with the server.
//
// The server holds one lineup with an (instance, version) stamp; a PUT must name the stamp it was based on or gets 409 with the current state (see `api_lineup_put` in app/main.py). This module serializes this screen's PUTs, polls for other screens' changes, and decides which server states to adopt.
//
// Hidden spoilers are a keyed store (see keyedStoreCreate): idempotent per-item operations with their own version, so they never conflict with lineup edits.
//
// `transport(method, path, body)` performs a request and resolves to {status, body}; it rejects only on network failure. Callbacks:
// - onAdopt(keys): the lineup was replaced from the server.
// - onConflict(): another screen changed the lineup first, so this screen's latest edit was dropped.
// - onRefused(message): the server refused a lineup edit (a bug or a bad import); the server's lineup is taken on the next poll.
// - onHidden(map): the effective hidden-pictures map ({title key: [image id]}) changed.
// - onHideRefused(message): the server refused a hide (dropped).
// - onConnection(ok, error): connectivity changed (reported on transitions only).

// A shared map {title key: [ids]} kept on the server with its own version: this screen sends idempotent operations (one at a time, resent after failures) and shows the server's last map with its own unconfirmed operations applied on top, so a change that hasn't reached the server yet never flickers back.
// spec: {path (POST endpoint), field and versionField (in server replies), apply(map, op) (mutates map), same(a, b) (whether two maps look the same to the user), onChange(map), onRefused(message)}; `connection(ok, error)` reports connectivity.
// A comparable signature of a {title key: [ids]} map, ignoring key order and, when `sortValues`, the order within each list.
function mapSig(map, sortValues) {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((key) => [key, sortValues ? [...map[key]].sort() : map[key]]),
  );
}

function keyedStoreCreate(spec, transport, connection) {
  const k = {
    server: {}, // the last map adopted from the server
    instance: null,
    version: 0,
    ops: [], // unconfirmed operations, oldest first
    sending: false,
    effective: {}, // server with ops applied
  };

  function recompute() {
    const map = Object.fromEntries(Object.entries(k.server).map(([key, v]) => [key, [...v]]));
    for (const op of k.ops) {
      spec.apply(map, op);
    }
    if (!spec.same(map, k.effective)) {
      k.effective = map;
      spec.onChange(map);
    }
  }

  // Responses can arrive out of order (a slow POST after a newer poll), so only move forward within one server instance.
  function adopt(body) {
    const version = body[spec.versionField] ?? 0;
    if (body.instance !== k.instance || version >= k.version) {
      k.instance = body.instance;
      k.version = version;
      k.server = body[spec.field] ?? {};
    }
  }

  // Network errors and server errors leave the operation queued for the next poll to resend.
  async function send() {
    if (k.sending) {
      return;
    }
    k.sending = true;
    try {
      while (k.ops.length) {
        let res;
        try {
          res = await transport("POST", spec.path, k.ops[0]);
        } catch (e) {
          connection(false, e);
          return;
        }
        if (res.status >= 500) {
          connection(false, new Error(`HTTP ${res.status}`));
          return;
        }
        connection(true);
        k.ops.shift();
        if (res.status === 200) {
          adopt(res.body);
        } else {
          spec.onRefused(typeof res.body?.detail === "string" ? res.body.detail : `HTTP ${res.status}`);
        }
        recompute();
      }
    } finally {
      k.sending = false;
    }
  }

  return {
    start(body) {
      adopt(body);
      k.effective = k.server;
    },
    map: () => k.effective,
    change(op) {
      k.ops.push(op);
      recompute();
      return send();
    },
    pending: () => k.ops.length > 0,
    send,
    adoptPolled(body) {
      adopt(body);
      recompute();
    },
  };
}

export function syncCreate(transport, callbacks) {
  const s = {
    instance: null,
    version: null,
    keys: [],
    pushing: false,
    dirty: false, // edits made while a PUT was in flight, to push once it lands
    unsynced: false, // a push failed for network/server reasons; the next poll retries it
    resync: false, // the server refused an edit; take its lineup on the next poll regardless of version
    connected: true,
  };

  const hidden = keyedStoreCreate(
    {
      path: "/api/hidden",
      field: "hidden",
      versionField: "hidden_version",
      apply(map, op) {
        const list = map[op.key] ?? [];
        const rest = op.image === null ? [] : list.filter((image) => image !== op.image);
        const next = op.hidden ? [...rest, op.image] : rest;
        if (next.length) {
          map[op.key] = next;
        } else {
          delete map[op.key];
        }
      },
      // Order-insensitive: the overlay appends pending hides while the server keeps insertion order, and a confirmation shouldn't count as a change.
      same: (a, b) => mapSig(a, true) === mapSig(b, true),
      onChange: (map) => callbacks.onHidden(map),
      onRefused: (message) => callbacks.onHideRefused(message),
    },
    transport,
    connection,
  );

  function connection(ok, error) {
    if (ok !== s.connected) {
      s.connected = ok;
      callbacks.onConnection(ok, error);
    }
  }

  function stamp(server) {
    s.instance = server.instance;
    s.version = server.version;
  }

  function adopt(server) {
    stamp(server);
    s.resync = false;
    if (server.keys.join(",") !== s.keys.join(",")) {
      s.keys = [...server.keys];
      callbacks.onAdopt(s.keys);
    }
  }

  // Resolves true once this screen's lineup (including this edit) is on the server; false if it was dropped, refused, or will be retried later.
  async function push() {
    if (s.pushing) {
      s.dirty = true;
      return false;
    }
    s.pushing = true;
    try {
      do {
        s.dirty = false;
        let res;
        try {
          res = await transport("PUT", "/api/lineup", { base_instance: s.instance, base_version: s.version, keys: s.keys });
        } catch (e) {
          s.unsynced = true;
          connection(false, e);
          return false;
        }
        if (res.status >= 500) {
          s.unsynced = true;
          connection(false, new Error(`HTTP ${res.status}`));
          return false;
        }
        connection(true);
        if (res.status === 409) {
          const sameKeys = res.body.keys.join(",") === s.keys.join(",");
          s.dirty = false;
          adopt(res.body);
          if (!sameKeys) {
            callbacks.onConflict();
          }
          return false;
        }
        if (res.status !== 200) {
          s.resync = true;
          callbacks.onRefused(typeof res.body?.detail === "string" ? res.body.detail : `HTTP ${res.status}`);
          return false;
        }
        stamp(res.body);
      } while (s.dirty);
      s.unsynced = false;
      return true;
    } finally {
      s.pushing = false;
    }
  }

  async function poll() {
    // Resend whatever failed before, then fetch fresh state either way, so a request the server keeps refusing with 5xx can't stop this screen from seeing other screens' changes.
    if (s.unsynced) {
      await push();
    }
    if (hidden.pending()) {
      await hidden.send();
    }
    let res;
    try {
      res = await transport("GET", "/api/lineup", null);
    } catch (e) {
      connection(false, e);
      return;
    }
    if (res.status !== 200) {
      connection(false, new Error(`HTTP ${res.status}`));
      return;
    }
    connection(true);
    hidden.adoptPolled(res.body);
    // Expected race: this screen's PUT is in flight, so adopting now would briefly overwrite its edit; that PUT's own response (or its 409) settles the state. A GET that left before an edit needs no guard: it can only carry the stamp that edit was based on, or a newer one that makes the PUT 409.
    if (s.pushing) {
      return;
    }
    const server = res.body;
    if (s.resync || server.instance !== s.instance || server.version > s.version) {
      adopt(server);
    }
  }

  return {
    start(server) {
      stamp(server);
      s.keys = [...server.keys];
      hidden.start(server);
    },
    keys: () => s.keys,
    hidden: () => hidden.map(),
    // `image` null with `hidden` false unhides all of that title's pictures.
    hide(key, image, isHidden) {
      return hidden.change({ key, image, hidden: isHidden });
    },
    edit(keys) {
      s.keys = [...keys];
      return push();
    },
    poll,
  };
}
