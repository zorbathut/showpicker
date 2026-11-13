// Keeps this screen's copy of the shared lineup in step with the server.
//
// The server holds one lineup with an (instance, version) stamp; a PUT must name the stamp it was based on or gets 409 with the current state (see `api_lineup_put` in app/main.py). This module serializes this screen's PUTs, polls for other screens' changes, and decides which server states to adopt.
//
// `transport(method, path, body)` performs a request and resolves to {status, body}; it rejects only on network failure. Callbacks:
// - onAdopt(keys): the lineup was replaced from the server.
// - onConflict(): another screen changed the lineup first, so this screen's latest edit was dropped.
// - onRefused(message): the server refused an edit (a bug or a bad import); the server's lineup is taken on the next poll.
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
  };

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
        if (res.status >= 500) {
          s.unsynced = true;
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
    if (s.unsynced) {
      await push();
      return;
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
    },
    keys: () => s.keys,
    edit(keys) {
      s.keys = [...keys];
      return push();
    },
    poll,
  };
}
