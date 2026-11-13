// Keeps this screen's copy of the shared lineup, and of the spoilers (pictures, taglines) hidden from it, in step with the server.
//
// The server holds one lineup with an (instance, version) stamp; a PUT must name the stamp it was based on or gets 409 with the current state (see `api_lineup_put` in app/main.py). This module serializes this screen's PUTs, polls for other screens' changes, and decides which server states to adopt.
//
// Hidden spoilers are idempotent per-item operations with their own version, so they never conflict. What this screen shows is the server's last map with this screen's unconfirmed operations applied on top: a hide that hasn't reached the server yet (offline, say) stays hidden here and is resent, rather than flickering back.
//
// `transport(method, path, body)` performs a request and resolves to {status, body}; it rejects only on network failure. Callbacks:
// - onAdopt(keys): the lineup was replaced from the server.
// - onConflict(): another screen changed the lineup first, so this screen's latest edit was dropped.
// - onRefused(message): the server refused a lineup edit (a bug or a bad import); the server's lineup is taken on the next poll.
// - onHidden(map): the effective hidden-pictures map ({title key: [image id]}) changed.
// - onHideRefused(message): the server refused a hide (dropped).
// - onConnection(ok, error): connectivity changed (reported on transitions only).

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
    hiddenServer: {}, // the last hidden map adopted from the server
    hiddenInstance: null,
    hiddenVersion: 0,
    hiddenOps: [], // this screen's unconfirmed {key, image, hidden} operations, oldest first
    hiddenSending: false,
    hiddenEffective: {}, // hiddenServer with hiddenOps applied
  };

  // Order-insensitive: the overlay appends pending hides while the server keeps insertion order, and a confirmation shouldn't count as a change.
  function hiddenSig(map) {
    return JSON.stringify(
      Object.keys(map)
        .sort()
        .map((k) => [k, [...map[k]].sort()]),
    );
  }

  function hiddenRecompute() {
    const map = Object.fromEntries(Object.entries(s.hiddenServer).map(([k, v]) => [k, [...v]]));
    for (const op of s.hiddenOps) {
      const list = map[op.key] ?? [];
      const rest = op.image === null ? [] : list.filter((image) => image !== op.image);
      const next = op.hidden ? [...rest, op.image] : rest;
      if (next.length) {
        map[op.key] = next;
      } else {
        delete map[op.key];
      }
    }
    if (hiddenSig(map) !== hiddenSig(s.hiddenEffective)) {
      s.hiddenEffective = map;
      callbacks.onHidden(map);
    }
  }

  // Responses can arrive out of order (a slow POST after a newer poll), so only move forward within one server instance.
  function hiddenAdopt(body) {
    if (body.instance !== s.hiddenInstance || body.hidden_version >= s.hiddenVersion) {
      s.hiddenInstance = body.instance;
      s.hiddenVersion = body.hidden_version;
      s.hiddenServer = body.hidden;
    }
  }

  // Sends queued hide operations one at a time. Network errors and server errors leave the operation queued for the next poll to resend.
  async function hiddenSend() {
    if (s.hiddenSending) {
      return;
    }
    s.hiddenSending = true;
    try {
      while (s.hiddenOps.length) {
        let res;
        try {
          res = await transport("POST", "/api/hidden", s.hiddenOps[0]);
        } catch (e) {
          connection(false, e);
          return;
        }
        if (res.status >= 500) {
          connection(false, new Error(`HTTP ${res.status}`));
          return;
        }
        connection(true);
        s.hiddenOps.shift();
        if (res.status === 200) {
          hiddenAdopt(res.body);
        } else {
          callbacks.onHideRefused(typeof res.body?.detail === "string" ? res.body.detail : `HTTP ${res.status}`);
        }
        hiddenRecompute();
      }
    } finally {
      s.hiddenSending = false;
    }
  }

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
    if (s.hiddenOps.length) {
      await hiddenSend();
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
    hiddenAdopt(res.body);
    hiddenRecompute();
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
      hiddenAdopt(server);
      s.hiddenEffective = s.hiddenServer;
    },
    keys: () => s.keys,
    hidden: () => s.hiddenEffective,
    // `image` null with `hidden` false unhides all of that title's pictures.
    hide(key, image, hidden) {
      s.hiddenOps.push({ key, image, hidden });
      hiddenRecompute();
      return hiddenSend();
    },
    edit(keys) {
      s.keys = [...keys];
      return push();
    },
    poll,
  };
}
