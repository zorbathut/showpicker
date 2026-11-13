import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { syncCreate } from "../../app/static/sync.js";

// Edits whose PUT a test leaves unanswered never settle; route them through here so any rejection still fails the test.
const rejections = [];
function pending(promise) {
  promise.catch((e) => rejections.push(e));
  return promise;
}
afterEach(() => {
  assert.deepEqual(rejections.splice(0), []);
});

// A transport whose requests stay pending until the test answers them, so interleavings can be scripted.
function fakeServer() {
  const pending = [];
  const transport = (method, path, body) =>
    new Promise((resolve, reject) => {
      pending.push({ method, path, body, resolve, reject });
    });
  return {
    transport,
    pending,
    async answer(status, body) {
      const req = pending.shift();
      assert.ok(req, "no request pending");
      req.resolve({ status, body });
      await flush();
      return req;
    },
    async fail() {
      const req = pending.shift();
      req.reject(new TypeError("Failed to fetch"));
      await flush();
      return req;
    },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recorder() {
  const events = [];
  return {
    events,
    callbacks: {
      onAdopt: (keys) => events.push(["adopt", [...keys]]),
      onConflict: () => events.push(["conflict"]),
      onRefused: (message) => events.push(["refused", message]),
      onConnection: (ok) => events.push(["connection", ok]),
      onHidden: (map) => events.push(["hidden", structuredClone(map)]),
      onHideRefused: (message) => events.push(["hideRefused", message]),
    },
  };
}

const START = { instance: "i1", version: 5, keys: ["tmdb:movie:1"], hidden_version: 2, hidden: { "tmdb:movie:1": ["/a"] } };
const M = "tmdb:movie:1";

function hiddenReply(version, hidden, instance = "i1") {
  return { instance, hidden_version: version, hidden };
}

function setup() {
  const server = fakeServer();
  const rec = recorder();
  const sync = syncCreate(server.transport, rec.callbacks);
  sync.start(START);
  return { server, rec, sync };
}

test("an edit PUTs the new keys with the stamp it was based on", async () => {
  const { server, rec, sync } = setup();
  const done = sync.edit(["tmdb:movie:1", "tmdb:movie:2"]);
  const req = server.pending[0];
  assert.deepEqual([req.method, req.body], ["PUT", { base_instance: "i1", base_version: 5, keys: ["tmdb:movie:1", "tmdb:movie:2"] }]);
  await server.answer(200, { instance: "i1", version: 6, keys: req.body.keys });
  assert.equal(await done, true);
  assert.deepEqual(rec.events, []);
});

test("edits made while a PUT is in flight coalesce into one more PUT of the latest keys", async () => {
  const { server, sync } = setup();
  pending(sync.edit(["a"]));
  pending(sync.edit(["a", "b"]));
  pending(sync.edit(["a", "b", "c"]));
  assert.equal(server.pending.length, 1);
  await server.answer(200, { instance: "i1", version: 6, keys: ["a"] });
  assert.equal(server.pending.length, 1);
  assert.deepEqual(server.pending[0].body, { base_instance: "i1", base_version: 6, keys: ["a", "b", "c"] });
  await server.answer(200, { instance: "i1", version: 7, keys: ["a", "b", "c"] });
  assert.equal(server.pending.length, 0);
});

test("a 409 adopts the server's lineup and reports the conflict", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["mine"]));
  await server.answer(409, { instance: "i1", version: 6, keys: ["theirs"] });
  assert.deepEqual(rec.events, [["adopt", ["theirs"]], ["conflict"]]);
  assert.deepEqual(sync.keys(), ["theirs"]);
  pending(sync.edit(["theirs", "next"]));
  assert.equal(server.pending[0].body.base_version, 6);
});

test("a 409 whose keys match what this screen wanted is not reported as a conflict", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["same"]));
  await server.answer(409, { instance: "i1", version: 6, keys: ["same"] });
  assert.deepEqual(rec.events, []);
});

test("a poll that left before a local edit is dropped", async () => {
  const { server, rec, sync } = setup();
  const polled = sync.poll();
  pending(sync.edit(["mine"]));
  // The GET is answered with the pre-edit state at a newer version (another screen's edit), then the PUT conflicts.
  await server.answer(200, { instance: "i1", version: 6, keys: ["old"] });
  await polled;
  assert.deepEqual(rec.events, []);
  assert.deepEqual(sync.keys(), ["mine"]);
});

test("a poll that lands while a PUT is in flight is dropped", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["mine"]));
  const polled = sync.poll();
  const get = server.pending[1];
  server.pending.splice(1, 1);
  get.resolve({ status: 200, body: { instance: "i1", version: 9, keys: ["other"] } });
  await polled;
  assert.deepEqual(rec.events, []);
  await server.answer(200, { instance: "i1", version: 6, keys: ["mine"] });
  assert.deepEqual(sync.keys(), ["mine"]);
});

test("polls adopt newer versions and other instances, and ignore the current or older versions", async () => {
  const { server, rec, sync } = setup();
  for (const [version, instance, keys, adopted] of [
    [5, "i1", ["x"], false],
    [4, "i1", ["x"], false],
    [6, "i1", ["newer"], true],
    [0, "i2", [], true],
  ]) {
    const polled = sync.poll();
    await server.answer(200, { ...START, instance, version, keys });
    await polled;
    assert.equal(
      rec.events.some(([e]) => e === "adopt"),
      adopted,
      `version ${version} on ${instance}`,
    );
    rec.events.length = 0;
  }
  assert.deepEqual(sync.keys(), []);
});

test("a PUT that fails on the network is retried by the next poll, and connectivity is reported once each way", async () => {
  const { server, rec, sync } = setup();
  const done = sync.edit(["mine"]);
  await server.fail();
  assert.equal(await done, false);
  let polled = sync.poll();
  assert.equal(server.pending[0].method, "PUT");
  await server.fail();
  assert.equal(server.pending[0].method, "GET", "the poll still checks for other screens' changes");
  await server.fail();
  await polled;
  assert.deepEqual(rec.events, [["connection", false]]);
  polled = sync.poll();
  await server.answer(200, { instance: "i1", version: 6, keys: ["mine"] });
  await server.answer(200, { ...START, version: 6, keys: ["mine"] });
  await polled;
  assert.deepEqual(rec.events, [
    ["connection", false],
    ["connection", true],
  ]);
  polled = sync.poll();
  assert.equal(server.pending[0].method, "GET");
  await server.answer(200, { ...START, version: 6, keys: ["mine"] });
  await polled;
});

test("a refused edit is reported and the server's lineup is taken on the next poll even at the same version", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["tmdb:movie:1", "bogus"]));
  await server.answer(400, { detail: "Not a valid title key: 'bogus'" });
  assert.deepEqual(rec.events, [["refused", "Not a valid title key: 'bogus'"]]);
  const polled = sync.poll();
  await server.answer(200, START);
  await polled;
  assert.deepEqual(rec.events.at(-1), ["adopt", ["tmdb:movie:1"]]);
});

test("a server error on PUT is reported, retried, and doesn't stop polling", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["mine"]));
  await server.answer(502, { detail: "Bad Gateway" });
  assert.deepEqual(rec.events, [["connection", false]]);
  const polled = sync.poll();
  assert.deepEqual(server.pending[0].body.keys, ["mine"]);
  await server.answer(502, { detail: "Bad Gateway" });
  // Another screen's change still arrives (the lineup isn't adopted over the pending edit only because versions match).
  await server.answer(200, { ...START, hidden_version: 3, hidden: {} });
  await polled;
  assert.deepEqual(sync.hidden(), {});
  assert.deepEqual(sync.keys(), ["mine"]);
});

test("GET failures report a lost connection once until a poll succeeds", async () => {
  const { server, rec, sync } = setup();
  for (let i = 0; i < 3; i++) {
    const polled = sync.poll();
    await server.fail();
    await polled;
  }
  const polled = sync.poll();
  await server.answer(200, START);
  await polled;
  assert.deepEqual(rec.events, [
    ["connection", false],
    ["connection", true],
  ]);
});

// ---------------------------------------------------------------- hidden pictures

test("start exposes the server's hidden map", () => {
  const { sync } = setup();
  assert.deepEqual(sync.hidden(), { [M]: ["/a"] });
});

test("a hide applies locally at once and POSTs", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide(M, "/b", true));
  assert.deepEqual(rec.events, [["hidden", { [M]: ["/a", "/b"] }]]);
  const req = server.pending[0];
  assert.deepEqual([req.method, req.path, req.body], ["POST", "/api/hidden", { key: M, image: "/b", hidden: true }]);
  await server.answer(200, hiddenReply(3, { [M]: ["/a", "/b"] }));
  assert.equal(rec.events.length, 1, "confirming what's already shown changes nothing");
});

test("hide operations are sent one at a time, in order", async () => {
  const { server, sync } = setup();
  pending(sync.hide(M, "/b", true));
  pending(sync.hide(M, "/c", true));
  pending(sync.hide(M, "/a", false));
  assert.equal(server.pending.length, 1);
  await server.answer(200, hiddenReply(3, { [M]: ["/a", "/b"] }));
  assert.deepEqual(server.pending[0].body, { key: M, image: "/c", hidden: true });
  await server.answer(200, hiddenReply(4, { [M]: ["/a", "/b", "/c"] }));
  assert.deepEqual(server.pending[0].body, { key: M, image: "/a", hidden: false });
  await server.answer(200, hiddenReply(5, { [M]: ["/b", "/c"] }));
  assert.deepEqual(sync.hidden(), { [M]: ["/b", "/c"] });
});

test("a hide that fails on the network stays hidden and is resent by the next poll", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide(M, "/b", true));
  await server.fail();
  assert.deepEqual(sync.hidden(), { [M]: ["/a", "/b"] });
  const polled = sync.poll();
  assert.deepEqual([server.pending[0].method, server.pending[0].body.image], ["POST", "/b"]);
  await server.answer(200, hiddenReply(3, { [M]: ["/a", "/b"] }));
  await server.answer(200, { ...START, hidden_version: 3, hidden: { [M]: ["/a", "/b"] } });
  await polled;
  assert.deepEqual(
    rec.events.filter(([e]) => e === "hidden"),
    [["hidden", { [M]: ["/a", "/b"] }]],
  );
});

test("a server error on a hide is reported, keeps it queued, and doesn't stop polling", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide(M, "/b", true));
  await server.answer(502, { detail: "Bad Gateway" });
  assert.deepEqual(sync.hidden(), { [M]: ["/a", "/b"] });
  assert.deepEqual(rec.events.at(-1), ["connection", false]);
  const polled = sync.poll();
  assert.equal(server.pending[0].method, "POST");
  await server.answer(502, { detail: "Bad Gateway" });
  assert.equal(server.pending[0].method, "GET");
  await server.answer(200, { ...START, hidden_version: 3, hidden: { [M]: ["/a", "/z"] } });
  await polled;
  assert.deepEqual(sync.hidden(), { [M]: ["/a", "/z", "/b"] });
});

test("a poll with an older or equal hidden version changes nothing, a newer one is adopted", async () => {
  const { server, rec, sync } = setup();
  for (const [version, hidden, changes] of [
    [1, {}, false],
    [2, { [M]: ["/a"] }, false],
    [3, { [M]: ["/a", "/z"] }, true],
  ]) {
    const polled = sync.poll();
    await server.answer(200, { ...START, hidden_version: version, hidden });
    await polled;
    assert.equal(rec.events.length > 0, changes, `hidden_version ${version}`);
    rec.events.length = 0;
  }
});

test("pending hides stay on top of a newer map from the server", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide(M, "/b", true));
  rec.events.length = 0;
  const polled = sync.poll(); // the POST is still in flight, so this poll GETs
  await flush();
  const get = server.pending[1];
  server.pending.splice(1, 1);
  // Server history: our hide made version 3, then another screen hid /other (version 4); the poll sees 4 before our POST's response arrives.
  get.resolve({ status: 200, body: { ...START, hidden_version: 4, hidden: { [M]: ["/a", "/b", "/other"] } } });
  await polled;
  assert.deepEqual(sync.hidden(), { [M]: ["/a", "/other", "/b"] });
  // The POST's older response must not roll the map back to version 3 (which lacked /other).
  await server.answer(200, hiddenReply(3, { [M]: ["/a", "/b"] }));
  assert.deepEqual(sync.hidden()[M].toSorted(), ["/a", "/b", "/other"]);
});

test("a new server instance replaces the hidden map but keeps pending hides", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide(M, "/b", true));
  const polled = sync.poll(); // the POST is still in flight, so this poll GETs
  await flush();
  const get = server.pending[1];
  server.pending.splice(1, 1);
  // The server restarted: a fresh instance with nothing hidden.
  get.resolve({ status: 200, body: { instance: "i2", version: 0, keys: [], hidden_version: 0, hidden: {} } });
  await polled;
  assert.deepEqual(sync.hidden(), { [M]: ["/b"] }, "the old map is gone, the pending hide stays");
  assert.ok(rec.events.some(([e]) => e === "adopt"));
});

test("a refused hide is reported and dropped", async () => {
  const { server, rec, sync } = setup();
  pending(sync.hide("bogus", "/b", true));
  await server.answer(400, { detail: "Not a valid title key: 'bogus'" });
  assert.deepEqual(rec.events, [
    ["hidden", { [M]: ["/a"], bogus: ["/b"] }],
    ["hideRefused", "Not a valid title key: 'bogus'"],
    ["hidden", { [M]: ["/a"] }],
  ]);
});

test("unhide-all clears a title", async () => {
  const { server, sync } = setup();
  pending(sync.hide(M, null, false));
  assert.deepEqual(sync.hidden(), {});
  assert.deepEqual(server.pending[0].body, { key: M, image: null, hidden: false });
  await server.answer(200, hiddenReply(3, {}));
  assert.deepEqual(sync.hidden(), {});
});
